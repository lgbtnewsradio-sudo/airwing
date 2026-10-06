import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { aeadEncrypt } from './chacha20poly1305';

export const AIRPLAY_AUDIO_SAMPLES = 352;
export const AIRPLAY_AUDIO_RATE = 44100;
export const AIRPLAY_AUDIO_LATENCY = Math.floor(AIRPLAY_AUDIO_RATE * 0.085);

/** Verbatim ALAC stereo frame: CPE, explicit sample count, signed 16-bit samples. */
export function encodeAlac(pcm: Uint8Array): Buffer {
  if (pcm.byteLength !== AIRPLAY_AUDIO_SAMPLES * 4) throw new Error('ALAC requires 352 stereo PCM samples');
  const out = Buffer.alloc(Math.ceil((55 + pcm.length * 8 + 3) / 8));
  let bit = 0;
  const write = (value: number, size: number) => {
    for (let shift = size - 1; shift >= 0; shift--, bit++) out[bit >> 3] |= ((value >>> shift) & 1) << (7 - (bit & 7));
  };
  write(1, 3); write(0, 4); write(0, 12); write(1, 1); write(0, 2); write(1, 1);
  write(AIRPLAY_AUDIO_SAMPLES, 32);
  for (let index = 0; index < pcm.length; index += 2) write(pcm[index] | (pcm[index + 1] << 8), 16);
  write(7, 3);
  return out;
}

export function audioPacket(payload: Uint8Array, key: Uint8Array, sequence: number, timestamp: number, ssrc: number, counter: bigint): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; header[1] = 0x60;
  header.writeUInt16BE(sequence & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4); header.writeUInt32BE(ssrc >>> 0, 8);
  const nonce = Buffer.alloc(12); nonce.writeBigUInt64LE(counter, 4);
  return Buffer.concat([header, Buffer.from(aeadEncrypt(key, nonce, payload, header.subarray(4))), nonce.subarray(4)]);
}

export function audioTimeAnnounce(timestamp: number, networkTime: bigint, timeline: bigint, first: boolean): Buffer {
  const packet = Buffer.alloc(28);
  packet[0] = first ? 0x90 : 0x80; packet[1] = 0xd7; packet.writeUInt16BE(4, 2);
  const playhead = (timestamp - AIRPLAY_AUDIO_LATENCY) >>> 0;
  packet.writeUInt32BE(playhead, 4);
  const ns = (networkTime >> 32n) * 1_000_000_000n + ((networkTime & 0xffffffffn) * 1_000_000_000n >> 32n);
  packet.writeBigUInt64BE(ns & 0xffffffffffffffffn, 8);
  packet.writeUInt32BE(playhead, 16); packet.writeBigUInt64BE(timeline, 20);
  return packet;
}

export class AirPlayAudioSender {
  private control = dgram.createSocket('udp4');
  private data = dgram.createSocket('udp4');
  private dataPort = 0;
  private remoteControlPort = 0;
  private sequence = randomBytes(2).readUInt16BE();
  private epoch = randomBytes(4).readUInt32BE();
  private ssrc = randomBytes(4).readUInt32BE();
  private counter = 0n;
  private queue: Array<{ pcm: Uint8Array; capturedAtMs: number; due: number }> = [];
  private history = new Map<number, Buffer>();
  private timer: NodeJS.Timeout | null = null;
  private anchorWall = 0;
  private anchorMono = 0;
  private syncTimer: NodeJS.Timeout | null = null;
  private closed = false;
  readonly key = randomBytes(32);

  constructor(private host: string, private clockAt: (wallMs: number) => { time: bigint; timeline: bigint } | null, private onError: (error: Error) => void) {
    this.control.on('error', onError); this.data.on('error', onError);
    this.control.on('message', (packet, from) => {
      if (this.closed || !this.remoteControlPort || from.address !== host || packet.length < 8 || (packet[0] >> 6) !== 2 || (packet[1] & 0x7f) !== 0x55) return;
      const start = packet.readUInt16BE(4); const count = Math.min(packet.readUInt16BE(6), 128);
      const requestSequence = packet.readUInt16BE(2);
      for (let index = 0; index < count; index++) {
        const seq = (start + index) & 0xffff; const original = this.history.get(seq);
        const header = Buffer.from([0x80, 0xd6, requestSequence >> 8, requestSequence & 255]);
        if (!original) {
          const expired = Buffer.alloc(8); header.copy(expired); expired.writeUInt16BE(seq, 4);
          this.control.send(expired, from.port, this.host);
          break;
        }
        this.control.send(Buffer.concat([header, original]), from.port, this.host);
      }
    });
  }

  async bind(): Promise<number> {
    const bindSocket = (socket: dgram.Socket) => new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      socket.once('error', fail);
      socket.bind(0, () => { socket.off('error', fail); resolve(); });
    });
    await bindSocket(this.control); await bindSocket(this.data);
    return this.control.address().port;
  }

  connect(dataPort: number, controlPort: number): void {
    if (![dataPort, controlPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535)) throw new Error('Invalid AirPlay audio ports');
    this.dataPort = dataPort; this.remoteControlPort = controlPort;
  }

  enqueue(pcm: Uint8Array, capturedAtMs: number): void {
    if (this.closed || !this.dataPort || pcm.length !== 1408 || !Number.isFinite(capturedAtMs)) return;
    const now = performance.now();
    if (!this.anchorWall) { this.anchorWall = capturedAtMs; this.anchorMono = now - Math.max(0, Date.now() - capturedAtMs); }
    const due = this.anchorMono + capturedAtMs - this.anchorWall;
    if (now - due > 100 || due - now > 100) return;
    this.queue.push({ pcm: pcm.slice(), capturedAtMs, due });
    if (this.queue.length > 16) this.queue.shift();
    if (!this.timer) this.schedule();
  }

  private schedule(): void {
    if (this.closed || !this.queue.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const frame = this.queue.shift()!;
      const now = performance.now();
      if (now - frame.due <= 100) {
        const rtp = (this.epoch + Math.round((frame.capturedAtMs - this.anchorWall) * AIRPLAY_AUDIO_RATE / 1000)) >>> 0;
        if (!this.syncTimer) {
          this.announce(frame.capturedAtMs, true);
          this.syncTimer = setInterval(() => this.announce(Date.now(), false), 1000);
        }
        const packet = audioPacket(encodeAlac(frame.pcm), this.key, this.sequence, rtp, this.ssrc, this.counter++);
        this.history.set(this.sequence, packet);
        if (this.history.size > 512) this.history.delete(this.history.keys().next().value!);
        this.sequence = (this.sequence + 1) & 0xffff;
        this.data.send(packet, this.dataPort, this.host);
      }
      this.schedule();
    }, Math.max(0, this.queue[0].due - performance.now()));
  }

  private announce(wallMs: number, first: boolean): void {
    if (this.closed || !this.remoteControlPort) return;
    const clock = this.clockAt(wallMs);
    if (!clock) return;
    const rtp = (this.epoch + Math.round((wallMs - this.anchorWall) * AIRPLAY_AUDIO_RATE / 1000)) >>> 0;
    this.control.send(audioTimeAnnounce(rtp, clock.time, clock.timeline, first), this.remoteControlPort, this.host);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.timer = null; this.queue = []; this.history.clear();
    try { this.control.close(); } catch { /* not bound */ }
    try { this.data.close(); } catch { /* not bound */ }
  }
}
