import { describe, it, expect } from 'vitest';
import dgram from 'node:dgram';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { AirPlayAudioSender, encodeAlac, audioPacket, audioTimeAnnounce, AIRPLAY_AUDIO_LATENCY } from '../../src/main/airplay/audio';
import { AirPlayPcmFramer } from '../../src/shared/airplayPcm';
import { compactWindowBounds } from '../../src/main/windowPlacement';

function decodeAlac(frame: Buffer): Buffer {
  let bit = 0;
  const read = (size: number) => {
    let value = 0;
    for (let n = 0; n < size; n++, bit++) value = value * 2 + ((frame[bit >> 3] >> (7 - (bit & 7))) & 1);
    return value;
  };
  expect(read(3)).toBe(1); expect(read(4)).toBe(0); expect(read(12)).toBe(0);
  expect(read(1)).toBe(1); expect(read(2)).toBe(0); expect(read(1)).toBe(1);
  const samples = read(32);
  expect(samples).toBe(352);
  const pcm = Buffer.alloc(samples * 4);
  for (let index = 0; index < pcm.length; index += 2) pcm.writeUInt16LE(read(16), index);
  expect(read(3)).toBe(7);
  return pcm;
}

function decrypt(packet: Buffer, key: Buffer): Buffer {
  const nonce = Buffer.alloc(12); packet.subarray(-8).copy(nonce, 4);
  const cipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  cipher.setAAD(packet.subarray(4, 12), { plaintextLength: packet.length - 36 }); cipher.setAuthTag(packet.subarray(-24, -8));
  return Buffer.concat([cipher.update(packet.subarray(12, -24)), cipher.final()]);
}

describe('AirPlay ALAC and encrypted RTP', () => {
  it('preserves every signed stereo sample in a verbatim ALAC frame', () => {
    const pcm = randomBytes(1408);
    expect(decodeAlac(encodeAlac(pcm))).toEqual(pcm);
    expect(() => encodeAlac(new Uint8Array(12))).toThrow();
  });
  it('matches native authenticated encryption, includes nonce and fits one UDP datagram', () => {
    const key = randomBytes(32); const payload = encodeAlac(randomBytes(1408));
    const packet = audioPacket(payload, key, 65537, 0x12345678, 0x9abcdef0, 257n);
    expect(packet.length).toBeLessThanOrEqual(1472);
    expect(packet.readUInt16BE(2)).toBe(1);
    expect(packet.readUInt32BE(4)).toBe(0x12345678);
    expect(packet.readBigUInt64LE(packet.length - 8)).toBe(257n);
    expect(decrypt(packet, key)).toEqual(payload);
    packet[4] ^= 1;
    expect(() => decrypt(packet, key)).toThrow();
  });
  it('maps both PTP RTP fields to the same latency-adjusted playhead', () => {
    const packet = audioTimeAnnounce(10000, (3n << 32n) + 0x80000000n, 0x123456789abcdef0n, true);
    expect(packet.length).toBe(28); expect(packet[0]).toBe(0x90); expect(packet[1]).toBe(0xd7);
    expect(packet.readUInt16BE(2)).toBe(4);
    expect(packet.readUInt32BE(4)).toBe(10000 - AIRPLAY_AUDIO_LATENCY);
    expect(packet.readUInt32BE(16)).toBe(packet.readUInt32BE(4));
    expect(packet.readBigUInt64BE(8)).toBe(3500000000n);
    expect(packet.readBigUInt64BE(20)).toBe(0x123456789abcdef0n);
  });
  it('sends real UDP audio and retransmits the original encrypted packet on request', async () => {
    const data = dgram.createSocket('udp4'); const control = dgram.createSocket('udp4');
    const bind = (socket: dgram.Socket) => new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    await bind(data); await bind(control);
    const errors: Error[] = [];
    const sender = new AirPlayAudioSender('127.0.0.1', () => ({ time: 3n << 32n, timeline: 1n }), (error) => errors.push(error));
    try {
      const localControl = await sender.bind();
      sender.connect(data.address().port, control.address().port);
      const received = new Promise<Buffer>((resolve) => data.once('message', resolve));
      sender.enqueue(new Uint8Array(1408), Date.now());
      const packet = await received;
      expect(decodeAlac(decrypt(packet, sender.key))).toEqual(Buffer.alloc(1408));
      const retransmitted = new Promise<Buffer>((resolve) => control.on('message', (message) => { if (message[1] === 0xd6) resolve(message); }));
      const request = Buffer.alloc(8); request[0] = 0x80; request[1] = 0xd5;
      request.writeUInt16BE(4321, 2);
      request.writeUInt16BE(packet.readUInt16BE(2), 4); request.writeUInt16BE(1, 6);
      control.send(request, localControl, '127.0.0.1');
      const recovered = await retransmitted;
      expect(recovered.readUInt16BE(2)).toBe(4321);
      expect(recovered.subarray(4)).toEqual(packet);
      expect(errors).toEqual([]);
    } finally { sender.close(); data.close(); control.close(); }
  });
  it('rejects invalid destination ports', () => {
    const sender = new AirPlayAudioSender('127.0.0.1', () => null, () => {});
    try { expect(() => sender.connect(0, 1)).toThrow(); expect(() => sender.connect(100, 65536)).toThrow(); }
    finally { sender.close(); }
  });
});

describe('PCM capture framing', () => {
  it.each([44100, 48000])('converts one second at %i Hz without block-boundary loss', (rate) => {
    const framer = new AirPlayPcmFramer();
    const packets: Array<{ pcm: Uint8Array; capturedAtMs: number }> = [];
    for (let offset = 0; offset < rate;) {
      const frames = Math.min(480, rate - offset);
      const input = new Float32Array(frames * 2); input.fill(0.5, 0, frames); input.fill(-0.5, frames);
      packets.push(...framer.push(input, frames, 2, rate, 1000 + offset * 1000 / rate)); offset += frames;
    }
    expect(packets.length).toBe(Math.floor((44100 - 1) / 352));
    for (let index = 0; index < packets.length; index++) {
      expect(packets[index].capturedAtMs).toBeCloseTo(1000 + index * 352000 / 44100, 5);
      const data = new DataView(packets[index].pcm.buffer);
      for (let sample = 0; sample < 352; sample++) {
        expect(data.getInt16(sample * 4, true)).toBe(16384);
        expect(data.getInt16(sample * 4 + 2, true)).toBe(-16384);
      }
    }
  });
  it('duplicates mono, clamps clipping and tolerates invalid samples', () => {
    const framer = new AirPlayPcmFramer(); const input = new Float32Array(353).fill(2); input[0] = NaN;
    const packet = framer.push(input, 353, 1, 44100, 1000)[0]; const view = new DataView(packet.pcm.buffer);
    expect(view.getInt16(0, true)).toBe(0); expect(view.getInt16(4, true)).toBe(32767);
    expect(view.getInt16(6, true)).toBe(32767);
  });
  it('discards partial stale audio after a capture discontinuity', () => {
    const framer = new AirPlayPcmFramer();
    expect(framer.push(new Float32Array(100), 100, 1, 44100, 1000)).toEqual([]);
    const packets = framer.push(new Float32Array(353), 353, 1, 44100, 2000);
    expect(packets.length).toBe(1); expect(packets[0].capturedAtMs).toBe(2000);
  });
});

describe('compact window placement', () => {
  it.each([{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1920, y: -200, width: 1920, height: 1080 }])('opens at the right edge of the usable display', (area) => {
    const bounds = compactWindowBounds(area);
    expect(bounds.width).toBe(375); expect(bounds.height).toBe(720);
    expect(bounds.x + bounds.width).toBe(area.x + area.width - 16); expect(bounds.y).toBe(area.y + 16);
  });
  it('fits smaller work areas', () => {
    const area = { x: 20, y: 30, width: 350, height: 600 }; const bounds = compactWindowBounds(area);
    expect(bounds.width).toBeLessThan(area.width); expect(bounds.height).toBeLessThan(area.height);
    expect(bounds.x).toBeGreaterThanOrEqual(area.x); expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height);
  });
});
