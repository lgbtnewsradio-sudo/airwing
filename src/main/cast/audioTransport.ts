import { createCipheriv, randomBytes } from 'node:crypto';

// Matches the legacy Android TV assignment paired with video PT 96.
// openscreen/cast/streaming/impl/rtp_defines.h: kAudioHackForAndroidTV.
const AUDIO_PAYLOAD_TYPE = 127;

export interface CastAudioConfig { sampleRate: number; channels: number; bitrate: number }
export class CastAudioTransport {
  readonly ssrc = randomBytes(4).readUInt32BE(0) >>> 1;
  readonly key = randomBytes(16);
  readonly ivMask = randomBytes(16);
  readonly rtpOrigin = randomBytes(4).readUInt32BE(0);
  packetsSent = 0;
  octetsSent = 0;
  private frameId = -1;
  private sequence = randomBytes(2).readUInt16BE(0);
  private lastTimestamp: number | null = null;
  private readonly cache = new Map<number, { packets: Buffer[]; sentAt: number; repairedAt: number[] }>();
  constructor(private readonly send: (packet: Buffer) => void) {}

  offer(config: CastAudioConfig): Record<string, unknown> {
    return { index: 1, type: 'audio_source', codecName: 'opus', rtpProfile: 'cast',
      rtpPayloadType: AUDIO_PAYLOAD_TYPE, ssrc: this.ssrc, channels: config.channels, bitRate: config.bitrate,
      sampleRate: 48000, timeBase: '1/48000', storeTime: 400, targetDelay: 400,
      aesKey: this.key.toString('hex'), aesIvMask: this.ivMask.toString('hex') };
  }

  sendFrame(data: Uint8Array, timestamp: number): void {
    timestamp >>>= 0;
    if (this.lastTimestamp !== null && ((timestamp - this.lastTimestamp) | 0) <= 0) return;
    this.lastTimestamp = timestamp;
    const frameId = ++this.frameId;
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(frameId >>> 0, 8);
    for (let i = 0; i < 16; i++) iv[i] ^= this.ivMask[i];
    const cipher = createCipheriv('aes-128-ctr', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const count = Math.max(1, Math.ceil(encrypted.length / 1200));
    const packets: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const header = Buffer.alloc(19);
      header[0] = 0x80; header[1] = AUDIO_PAYLOAD_TYPE | (i === count - 1 ? 0x80 : 0);
      header.writeUInt16BE(this.sequence++ & 0xffff, 2);
      header.writeUInt32BE(timestamp, 4); header.writeUInt32BE(this.ssrc, 8);
      header[12] = 0xc0; header[13] = frameId & 0xff;
      header.writeUInt16BE(i, 14); header.writeUInt16BE(count - 1, 16); header[18] = frameId & 0xff;
      const packet = Buffer.concat([header, encrypted.subarray(i * 1200, (i + 1) * 1200)]);
      packets.push(packet); this.sendPacket(packet);
    }
    this.cache.set(frameId & 0xff, { packets, sentAt: performance.now(), repairedAt: packets.map(() => -Infinity) });
    while (this.cache.size > 240) this.cache.delete(this.cache.keys().next().value!);
  }

  feedback(packet: Buffer): void {
    if (packet.length < 20 || packet.readUInt32BE(8) !== this.ssrc || packet.readUInt32BE(12) !== 0x43415354) return;
    if (packet.length < 20 + packet[17] * 4) return;
    for (let i = 0; i < packet[17]; i++) {
      const cursor = 20 + i * 4;
      const frame = this.cache.get(packet[cursor]);
      if (!frame || performance.now() - frame.sentAt > 1500) continue;
      const first = packet.readUInt16BE(cursor + 1);
      const ids = first === 0xffff ? frame.packets.map((_, index) => index) : [first];
      if (first !== 0xffff) for (let bit = 0; bit < 8; bit++) if (packet[cursor + 3] & (1 << bit)) ids.push(first + bit + 1);
      for (const id of ids) if (frame.packets[id]) {
        if (performance.now() - frame.repairedAt[id] < 5) continue;
        frame.repairedAt[id] = performance.now();
        const copy = Buffer.from(frame.packets[id]); copy.writeUInt16BE(this.sequence++ & 0xffff, 2); this.sendPacket(copy);
      }
    }
  }

  private sendPacket(packet: Buffer): void {
    this.send(packet); this.packetsSent++; this.octetsSent += packet.length - 19;
  }
}
