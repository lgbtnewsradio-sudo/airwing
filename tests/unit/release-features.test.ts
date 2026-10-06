import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDecipheriv } from 'node:crypto';
import { CredentialStore } from '../../src/main/settings';
import { redactText, sanitizeDiagnostics } from '../../src/shared/privacy';
import { AdaptiveCastBitrate } from '../../src/main/cast/adaptiveBitrate';
import { CastAudioTransport } from '../../src/main/cast/audioTransport';
import { MirroringSender, OfferAnswerChannel } from '../../src/main/cast/mirroring';
import dgram from 'node:dgram';

describe('privacy-safe diagnostics', () => {
  it('removes tokens, crypto fields, pairing keys and media paths', () => {
    const input = { token: 'very-secret', aesKey: '012345', clientLTSK: 'key-secret', stream: { mediaPath: 'C:\\media\\private.mp4' },
      log: 'http://192.168.1.2/remote?token=private-token&mode=play password="private-password"', version: '1.2.0' };
    const json = JSON.stringify(sanitizeDiagnostics(input));
    for (const secret of ['very-secret', '012345', 'key-secret', 'private.mp4', 'private-token', 'private-password']) expect(json).not.toContain(secret);
    expect(json).toContain('1.2.0');
  });
  it('does not export Windows user paths', () => {
    expect(redactText('opening C:\\Users\\Example\\Downloads\\personal.mp4')).not.toContain('Example');
    expect(redactText('opening C:\\Users\\Example\\Downloads\\personal.mp4')).not.toContain('personal.mp4');
  });
});

describe('protected pairing storage', () => {
  const encryption = { isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s.split('').reverse().join('')),
    decryptString: (b: Buffer) => b.toString().split('').reverse().join('') };
  it('migrates legacy plaintext, reloads and forgets without affecting other keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airwing-secrets-'));
    const file = join(dir, 'credentials.json');
    writeFileSync(file, JSON.stringify({ tv: 'pairing-secret', speaker: 'speaker-secret' }));
    const store = new CredentialStore(dir, encryption); store.migrate();
    expect(readFileSync(file, 'utf8')).not.toContain('pairing-secret');
    const reload = new CredentialStore(dir, encryption);
    expect(reload.get('tv')).toBe('pairing-secret'); reload.remove('tv');
    const third = new CredentialStore(dir, encryption);
    expect(third.get('tv')).toBeUndefined(); expect(third.get('speaker')).toBe('speaker-secret');
  });
  it('never writes new plaintext when protected storage is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airwing-secrets-unavailable-'));
    const store = new CredentialStore(dir, { ...encryption, isEncryptionAvailable: () => false });
    store.set('tv', 'not-on-disk'); expect(store.get('tv')).toBe('not-on-disk');
    expect(new CredentialStore(dir, encryption).get('tv')).toBeUndefined();
  });
});

describe('adaptive Cast bitrate', () => {
  it('reduces under sustained loss, throttles changes and gradually recovers', () => {
    const control = new AdaptiveCastBitrate(4_000_000);
    expect(control.sample(0.1, 0)).toBe(3_200_000);
    expect(control.sample(0.1, 1000)).toBeNull();
    expect(control.sample(0.1, 5000)).toBe(2_560_000);
    expect(control.sample(0, 6000)).toBeNull();
    expect(control.sample(0, 21000)).toBe(2_816_000);
  });
  it('does not exceed ceiling or accept malformed feedback', () => {
    const control = new AdaptiveCastBitrate(600_000);
    expect(control.sample(1, 0)).toBeNull();
    expect(control.sample(Number.NaN, 1)).toBeNull();
    expect(control.sample(0, 20000)).toBeNull();
  });
});

describe('Cast Opus transport', () => {
  it('negotiates the correct units and round-trips encrypted frame zero', () => {
    const packets: Buffer[] = [];
    const audio = new CastAudioTransport((packet) => packets.push(packet));
    const offer = audio.offer({ sampleRate: 48000, channels: 2, bitrate: 160000 });
    expect(offer.bitRate).toBe(160000); expect(offer.timeBase).toBe('1/48000'); expect(offer.index).toBe(1);
    expect(offer.rtpPayloadType).toBe(127);
    const data = Buffer.alloc(2600, 0x33); audio.sendFrame(data, 12345);
    expect(packets).toHaveLength(3); expect(packets[0][13]).toBe(0); expect(packets[0][18]).toBe(0);
    expect(packets[0].readUInt32BE(4)).toBe(12345); expect(packets[0].readUInt32BE(8)).toBe(audio.ssrc);
    const iv = Buffer.from(audio.ivMask);
    const decipher = createDecipheriv('aes-128-ctr', audio.key, iv);
    const decoded = Buffer.concat([decipher.update(Buffer.concat(packets.map((p) => p.subarray(19)))), decipher.final()]);
    expect(decoded).toEqual(data); expect(audio.packetsSent).toBe(3); expect(audio.octetsSent).toBe(data.length);
    audio.sendFrame(data, 12345); expect(packets).toHaveLength(3);
  });
  it('repairs missing encrypted fragments and ignores another stream', () => {
    const packets: Buffer[] = []; const audio = new CastAudioTransport((packet) => packets.push(packet));
    audio.sendFrame(Buffer.alloc(1300, 0x22), 1000);
    const feedback = Buffer.alloc(24); feedback[0] = 0x8f; feedback[1] = 206; feedback.writeUInt16BE(5, 2);
    feedback.writeUInt32BE(audio.ssrc, 8); feedback.writeUInt32BE(0x43415354, 12); feedback[17] = 1;
    feedback.writeUInt16BE(1, 21);
    audio.feedback(feedback); expect(packets).toHaveLength(3);
    expect(packets[2].subarray(4)).toEqual(packets[1].subarray(4));
    feedback.writeUInt32BE(audio.ssrc ^ 1, 8); audio.feedback(feedback); expect(packets).toHaveLength(3);
  });
});

describe('Cast audio/video synchronization', () => {
  it('negotiates both streams and publishes clocks on a shared sender-report timeline', async () => {
    const receiver = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => receiver.bind(0, '127.0.0.1', resolve));
    const packets: Buffer[] = []; receiver.on('message', (packet) => packets.push(packet));
    let onMessage: (data: unknown) => void = () => undefined;
    let offer: any;
    const channel = new OfferAnswerChannel({ on: (_event, callback) => { onMessage = callback; }, send: (data: any) => {
      offer = data.offer;
      queueMicrotask(() => onMessage({ type: 'ANSWER', seqNum: data.seqNum, result: 'ok', answer: { udpPort: receiver.address().port, sendIndexes: [0, 1] } }));
    } });
    const sender = new MirroringSender('127.0.0.1', channel);
    try {
      await sender.start({ width: 1280, height: 720, frameRateHint: 30, maxBitrate: 3000000, audio: { sampleRate: 48000, channels: 2, bitrate: 160000 } });
      expect(sender.audioAccepted).toBe(true); expect(offer.supportedStreams).toHaveLength(2);
      sender.sendVideoFrame(Buffer.from('synthetic video'), true, 1_000_000);
      await expect.poll(() => packets.filter((p) => (p[1] & 0x7f) === 96).length).toBe(1);
      sender.sendAudioFrame(Buffer.from('synthetic opus'), 1_020_000);
      await expect.poll(() => packets.filter((p) => (p[1] & 0x7f) === 127).length).toBe(1);
      const audioPacket = packets.find((p) => (p[1] & 0x7f) === 127)!;
      const videoPacket = packets.find((p) => (p[1] & 0x7f) === 96)!;
      expect(audioPacket.readUInt32BE(8)).not.toBe(videoPacket.readUInt32BE(8));
      (sender as any).sendSenderReport();
      await expect.poll(() => packets.filter((p) => p[1] === 200).length).toBeGreaterThanOrEqual(4);
      const reports = packets.filter((p) => p[1] === 200).slice(-2);
      expect(reports[0].subarray(8, 16)).toEqual(reports[1].subarray(8, 16));
      const anchor = (sender as any).syncAnchor;
      const audioOrigin = (sender as any).audio.rtpOrigin;
      expect(((audioPacket.readUInt32BE(4) - audioOrigin) | 0)).toBe(960);
      const videoTicks = (reports[0].readUInt32BE(16) - anchor.videoRtp) | 0;
      const audioTicks = (reports[1].readUInt32BE(16) - audioOrigin) | 0;
      expect(Math.abs(audioTicks / 48000 - videoTicks / 90000)).toBeLessThan(1 / 48000);
      sender.sendAudioFrame(Buffer.from('stale opus'), 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(packets.filter((p) => (p[1] & 0x7f) === 127)).toHaveLength(1);
    } finally { sender.close(); receiver.close(); }
  });
});
