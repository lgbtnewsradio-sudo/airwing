import { describe, it, expect } from 'vitest';
import { createDecipheriv } from 'node:crypto';
import { MirroringSender } from '../../src/main/cast/mirroring';

/**
 * Pure, hardware-free checks for the Cast Streaming (mirroring) wire format: the RTP header
 * layout and the AES-128-CTR frame encryption. These are exactly the two things that were
 * silently wrong on the first live attempt (base64 instead of hex keys, wrong payload type),
 * and a receiver gives no error for a malformed packet — it just never plays anything — so
 * this is the only way to catch a regression here before burning a live test on it.
 */

// Sends aren't observable from outside MirroringSender, so build one against a channel stub
// that captures the OFFER, then drive sendVideoFrame through a fake bound UDP socket by
// reaching into the module's own packetize/encrypt logic via a second, minimal harness that
// mirrors the real byte layout. Since packetize/encryptFrame are private, re-derive the wire
// bytes the same way a receiver would: decrypt with the key/IV this test controls and parse
// the header fields by fixed offset, matching mirroring.ts's own layout documentation.

function fakeChannel(answer: Record<string, unknown>) {
  let sent: Record<string, unknown> | null = null;
  return {
    send: (data: Record<string, unknown>) => {
      sent = data;
    },
    on: (_ev: 'message', cb: (data: any) => void) => {
      // Reply on the next microtask once a request is captured, mimicking the receiver.
      queueMicrotask(() => {
        if (sent) cb({ ...answer, seqNum: (sent as any).seqNum, type: 'ANSWER', result: 'ok' });
      });
    },
  };
}

describe('Cast Streaming OFFER', () => {
  it('sends hex (not base64) aesKey/aesIvMask and the real captured payload type', async () => {
    let offerSent: any = null;
    const channel = {
      send: (data: any) => {
        offerSent = data;
        queueMicrotask(() => onMessage?.({ type: 'ANSWER', seqNum: data.seqNum, result: 'ok', answer: { udpPort: 12345, sendIndexes: [0], ssrcs: [1, 2] } }));
      },
      on: (_ev: 'message', cb: (data: any) => void) => {
        onMessage = cb;
      },
    };
    let onMessage: ((data: any) => void) | null = null;
    const { OfferAnswerChannel } = await import('../../src/main/cast/mirroring');
    const sender = new MirroringSender('127.0.0.1', new OfferAnswerChannel(channel));
    try {
      await sender.start({ width: 1920, height: 1080, frameRateHint: 30, maxBitrate: 6_000_000 });
    } finally {
      sender.close();
    }
    expect(offerSent).toBeTruthy();
    const stream = offerSent.offer.supportedStreams[0];
    expect(stream.codecName).toBe('vp8');
    expect(stream.rtpPayloadType).toBe(96); // matches a real captured Chrome OFFER, not 101
    // Hex, not base64: exactly 32 lowercase hex characters for a 16-byte key.
    expect(stream.aesKey).toMatch(/^[0-9a-f]{32}$/);
    expect(stream.aesIvMask).toMatch(/^[0-9a-f]{32}$/);
    // maxBitRate is kbit/s on the wire: 6,000,000 bps in must become 6000, not 6000000.
    expect(stream.maxBitRate).toBe(6000);
    expect(stream.resolutions).toEqual([{ width: 1920, height: 1080 }]);
  });

  it('fails with a clear error when the receiver never answers', async () => {
    const { OfferAnswerChannel } = await import('../../src/main/cast/mirroring');
    const silentChannel = { send: () => undefined, on: () => undefined };
    const sender = new MirroringSender('127.0.0.1', new OfferAnswerChannel(silentChannel));
    await expect(sender.start({ width: 1280, height: 720, frameRateHint: 30, maxBitrate: 4_000_000 })).rejects.toThrow(/timed out/);
  }, 10000);
});

describe('Cast RTP frame layout and encryption', () => {
  // Re-implements only enough of the receiver side to verify the sender's wire format:
  // decrypt with AES-128-CTR using the documented IV construction, and read the Cast RTP
  // extension header at the fixed byte offsets mirroring.ts documents.
  function decodeFrame(packets: Buffer[], key: Buffer, ivMask: Buffer) {
    const payload = Buffer.concat(packets.map((p) => p.subarray(19)));
    const first = packets[0];
    const frameId = first[13];
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(frameId, 8);
    for (let i = 0; i < 16; i++) iv[i] ^= ivMask[i];
    const decipher = createDecipheriv('aes-128-ctr', key, iv);
    const plain = Buffer.concat([decipher.update(payload), decipher.final()]);
    return {
      plain,
      keyFrame: (first[12] & 0x80) !== 0,
      hasReferenceFrameId: (first[12] & 0x40) !== 0,
      frameId,
      referencedFrameId: first[18],
      packetIds: packets.map((p) => p.readUInt16BE(14)),
      maxPacketId: first.readUInt16BE(16),
      payloadTypes: packets.map((p) => p[1] & 0x7f),
      markerOnLast: (packets[packets.length - 1][1] & 0x80) !== 0,
      ssrc: first.readUInt32BE(8),
    };
  }

  async function harness() {
    let onMessage: ((data: any) => void) | null = null;
    let answerPort = 0;
    const sent: Buffer[] = [];
    const channel = {
      send: (data: any) => {
        queueMicrotask(() => onMessage?.({ type: 'ANSWER', seqNum: data.seqNum, result: 'ok', answer: { udpPort: answerPort, sendIndexes: [0], ssrcs: [1] } }));
      },
      on: (_ev: 'message', cb: (data: any) => void) => {
        onMessage = cb;
      },
    };
    const { OfferAnswerChannel } = await import('../../src/main/cast/mirroring');
    const dgram = await import('node:dgram');
    const listener = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => listener.bind(0, resolve));
    answerPort = (listener.address() as any).port;
    listener.on('message', (msg) => sent.push(msg));
    const sender = new MirroringSender('127.0.0.1', new OfferAnswerChannel(channel));
    await sender.start({ width: 640, height: 360, frameRateHint: 30, maxBitrate: 2_000_000 });
    return { sender, listener, sent, offerAnswer: new OfferAnswerChannel(channel) };
  }

  /** Sender starts an immediate RTCP Sender Report alongside the first video frame — a fixed
   *  28-byte RTCP packet (PT=200), unambiguously distinct from any real video packet in these
   *  tests. Filter it out where a test only cares about the video/RTP packets themselves. */
  const isVideoPacket = (p: Buffer) => !(p.length === 28 && p[1] === 200);

  it('round-trips a small (single-packet) keyframe intact through encrypt+packetize', async () => {
    const { sender, listener, sent: raw } = await harness();
    try {
      const au = Buffer.from('a fake vp8 keyframe payload, well under one packet');
      sender.sendVideoFrame(au, true, 0);
      await new Promise((r) => setTimeout(r, 200));
      const sent = raw.filter(isVideoPacket);
      expect(sent.length).toBe(1);
      // The size field a real receiver reads isn't in this frame's own header (Cast RTP has
      // no explicit payload-length field; UDP datagram length serves that role) — verify
      // structure and content instead.
      const key = (sender as any).videoKey as Buffer;
      const ivMask = (sender as any).videoIvMask as Buffer;
      const decoded = decodeFrame(sent, key, ivMask);
      expect(decoded.plain).toEqual(au);
      expect(decoded.keyFrame).toBe(true);
      expect(decoded.frameId).toBe(1); // first frame
      expect(decoded.packetIds).toEqual([0]);
      expect(decoded.maxPacketId).toBe(0);
      expect(decoded.markerOnLast).toBe(true);
      expect(decoded.payloadTypes).toEqual([96]);
      // Real senders always set this bit; per encoded_frame.h a keyframe self-references.
      expect(decoded.hasReferenceFrameId).toBe(true);
      expect(decoded.referencedFrameId).toBe(decoded.frameId);
    } finally {
      sender.close();
      listener.close();
    }
  });

  it('splits a large frame across multiple packets and reassembles it correctly', async () => {
    const { sender, listener, sent: raw } = await harness();
    try {
      // ~3.5x the 1200-byte packet payload cap -> 4 packets.
      const au = Buffer.alloc(4200);
      for (let i = 0; i < au.length; i++) au[i] = i & 0xff;
      sender.sendVideoFrame(au, false, 0);
      await new Promise((r) => setTimeout(r, 200));
      const sent = raw.filter(isVideoPacket);
      expect(sent.length).toBe(4);
      const key = (sender as any).videoKey as Buffer;
      const ivMask = (sender as any).videoIvMask as Buffer;
      const decoded = decodeFrame(sent, key, ivMask);
      expect(decoded.plain).toEqual(au);
      expect(decoded.keyFrame).toBe(false);
      expect(decoded.packetIds).toEqual([0, 1, 2, 3]);
      expect(decoded.maxPacketId).toBe(3);
      expect(decoded.markerOnLast).toBe(true);
      // Marker bit must NOT be set on any packet before the last one in the frame.
      expect((sent[0][1] & 0x80) !== 0).toBe(false);
      expect((sent[1][1] & 0x80) !== 0).toBe(false);
      expect((sent[2][1] & 0x80) !== 0).toBe(false);
      // Every packet of the frame (not just the first) must carry the RFID bit + byte.
      for (const p of sent) expect((p[12] & 0x40) !== 0).toBe(true);
    } finally {
      sender.close();
      listener.close();
    }
  });

  it('always sets the "reference frame id provided" bit and byte, matching real Chrome senders (cast/streaming/impl/rtp_packetizer.cc always sets it, for every frame including keyframes) — the missing byte here caused delta frames to misbehave on real hardware', async () => {
    const { sender, listener, sent: raw } = await harness();
    try {
      sender.sendVideoFrame(Buffer.from('keyframe payload'), true, 0);
      await new Promise((r) => setTimeout(r, 100));
      sender.sendVideoFrame(Buffer.from('delta frame payload'), false, 33333);
      await new Promise((r) => setTimeout(r, 100));
      const [key, delta] = raw.filter(isVideoPacket);
      const decodedKey = decodeFrame([key], (sender as any).videoKey, (sender as any).videoIvMask);
      const decodedDelta = decodeFrame([delta], (sender as any).videoKey, (sender as any).videoIvMask);
      expect(decodedKey.hasReferenceFrameId).toBe(true);
      expect(decodedKey.referencedFrameId).toBe(decodedKey.frameId); // keyframe self-references
      expect(decodedDelta.hasReferenceFrameId).toBe(true);
      expect(decodedDelta.frameId).toBe(decodedKey.frameId + 1);
      expect(decodedDelta.referencedFrameId).toBe(decodedKey.frameId); // depends on the keyframe before it
    } finally {
      sender.close();
      listener.close();
    }
  });

  it('sends an RTCP Sender Report immediately once media starts, then periodically', async () => {
    const { sender, listener, sent } = await harness();
    try {
      sender.sendVideoFrame(Buffer.from('first frame'), true, 0);
      await new Promise((r) => setTimeout(r, 150));
      // First datagram after a video frame's own packet(s) should be a Sender Report,
      // sent immediately rather than waiting a full interval.
      const rtcp = sent.find((p) => p.length === 28 && p[1] === 200);
      expect(rtcp).toBeTruthy();
      const sr = rtcp!;
      expect(sr[0]).toBe(0x80); // V=2, P=0, RC=0
      expect(sr.readUInt16BE(2)).toBe(6); // length words - 1, for a 28-byte SR
      const ssrc = sr.readUInt32BE(4);
      expect(ssrc).toBe((sender as any).videoSsrc);
      const ntpSeconds = sr.readUInt32BE(8);
      // NTP seconds (epoch 1900) should correspond to roughly "now" (epoch 1970).
      const NTP_UNIX_OFFSET = 2208988800;
      const impliedUnixMs = (ntpSeconds - NTP_UNIX_OFFSET) * 1000;
      expect(Math.abs(impliedUnixMs - Date.now())).toBeLessThan(5000);
      expect(sr.readUInt32BE(20)).toBeGreaterThan(0); // packet count
      expect(sr.readUInt32BE(24)).toBeGreaterThan(0); // octet count
    } finally {
      sender.close();
      listener.close();
    }
  }, 10000);

  it('gives consecutive frames distinct ciphertext via the frame-id-derived IV', async () => {
    const { sender, listener, sent: raw } = await harness();
    try {
      const au = Buffer.from('identical payload bytes sent twice in a row');
      sender.sendVideoFrame(au, true, 0);
      await new Promise((r) => setTimeout(r, 100));
      sender.sendVideoFrame(au, false, 33333);
      await new Promise((r) => setTimeout(r, 100));
      const sent = raw.filter(isVideoPacket);
      expect(sent.length).toBe(2);
      const cipher1 = sent[0].subarray(19);
      const cipher2 = sent[1].subarray(19);
      expect(cipher1.equals(cipher2)).toBe(false); // same plaintext, different frame id -> different keystream
      const key = (sender as any).videoKey as Buffer;
      const ivMask = (sender as any).videoIvMask as Buffer;
      expect(decodeFrame([sent[0]], key, ivMask).plain).toEqual(au);
      expect(decodeFrame([sent[1]], key, ivMask).plain).toEqual(au);
    } finally {
      sender.close();
      listener.close();
    }
  });
});
