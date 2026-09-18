/**
 * Google Cast Streaming (the "mirroring" protocol) sender.
 *
 * This is the real-time transport Chrome/Edge use for tab and desktop casting — the reason
 * that path shows a sub-second picture while AirWing's other Cast path (casting an HLS URL
 * to the Default Media Receiver) is a segment-and-playlist protocol built for VOD/live-TV
 * delivery, with multi-second latency baked into the design.
 *
 * Sequence: launch the "Chrome Mirroring" receiver app (0F5096E8) -> OFFER/ANSWER on the
 * `urn:x-cast:com.google.cast.webrtc` namespace (JSON, over the already-encrypted CastV2
 * channel) -> the answer gives a UDP port -> encoded VP8 frames are AES-128-CTR encrypted
 * and sent as Cast RTP packets directly over UDP, no HTTP/segmenting involved. A periodic
 * RTCP Sender Report on the same socket maps the RTP clock to real time, which is what lets
 * the receiver pace playout tightly instead of falling back to a large safety buffer — the
 * first working version omitted this and played 4-5s behind live despite the real-time
 * transport, even though the handshake, encryption and framing were all already correct.
 *
 * Sending itself goes through RtpPacingQueue (./rtpPacingQueue): a fixed ~33ms wall-clock
 * pacing loop with a small bounded queue, rather than sending each frame the instant it's
 * encoded. RTP timestamps are derived from elapsed wall-clock time at the moment of actual
 * send, not from capture timestamps or a fixed per-frame increment, so the RTP clock can't
 * drift out of sync with real time no matter how irregular VP8 encoder output timing is
 * upstream — and the queue sheds toward the newest frame under any backlog instead of
 * growing, since this stream has no retransmission and an unbounded queue is itself
 * indistinguishable from added lag once it's deep enough.
 *
 * Protocol reverse-engineered from Google's own open-sourced reference implementation
 * (github.com/google/openscreen, cast/streaming/*) — the same wire format Chrome speaks,
 * not a private/undocumented one. This module implements the sender half only; the receiver
 * (Chrome Mirroring app) already ships on every Chromecast/Google TV device.
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { randomBytes, createCipheriv } from 'node:crypto';
import { Application, JsonController } from 'castv2-client';
import { log } from '../logger';
import { RtpPacingQueue, type RtpQueuedFrame } from './rtpPacingQueue';

export const MIRRORING_APP_ID = '0F5096E8';
export const WEBRTC_NAMESPACE = 'urn:x-cast:com.google.cast.webrtc';

/** Max UDP payload per Cast RTP packet, leaving headroom under common MTUs. */
const MAX_PACKET_PAYLOAD = 1200;
/**
 * Cast RTP header: 12-byte standard RTP header, then a 7-byte Cast frame header and Chromium's
 * 4-byte Adaptive Latency extension. The extension is not cosmetic: without its explicit
 * playout target, Google TV falls back to its conservative multi-second jitter buffer even when
 * the sender is delivering frames in real time.
 */
const RTP_HEADER_SIZE = 23;
const CAST_FRAME_HEADER_SIZE = 7;
/** Chrome normally advertises 0x0320 (800 ms). This leaves room for Wi-Fi jitter while staying
 * comfortably under AirWing's 2-second live-mirroring goal. */
const CAST_PLAYOUT_DELAY_MS = 800;
/** Cast RTP extension wire id for Adaptive Latency, followed by its two-byte payload length. */
const CAST_ADAPTIVE_LATENCY_EXTENSION_TYPE = 0x04;
const CAST_ADAPTIVE_LATENCY_EXTENSION_SIZE = 0x02;
/** video_source stream, matches a real captured Chrome OFFER (rtpPayloadType 96, not 101). */
const VIDEO_RTP_PAYLOAD_TYPE = 96;
const VIDEO_TIME_BASE_HZ = 90000;
/** RFC 3550 §4: seconds between the NTP epoch (1900) and the Unix epoch (1970). */
const NTP_UNIX_EPOCH_OFFSET = 2208988800;
/** How often to send an RTCP Sender Report once streaming has started. */
const RTCP_SR_INTERVAL_MS = 1000;
/** RFC 3550 RTCP packet type for a Sender Report. Cast's own RtcpPacketType enum uses the
 *  same names/semantics (kSenderReport/kReceiverReport), so the numeric value is standard. */
const RTCP_PT_SENDER_REPORT = 200;
/** RFC 3550 RTCP packet type for a Receiver Report — what comes back on this socket. */
const RTCP_PT_RECEIVER_REPORT = 201;
/** Above this fraction lost (RFC 3550 §6.4.2, an 8-bit fixed-point fraction), treat the queue
 *  as carrying frames the receiver is unlikely to want and drop toward the newest one. */
const RTCP_LOSS_DROP_THRESHOLD = 0.05;
/** Throttle for the periodic diagnostic log lines below — frequent enough to see a trend
 *  forming within a few seconds, infrequent enough not to flood the log file. */
const DIAG_LOG_INTERVAL_MS = 2000;

/** aesKey/aesIvMask are lowercase hex in the wire format, not base64 — confirmed against a
 *  real captured Chrome OFFER. Sending base64 there is why the first live attempt against
 *  the Bravia got total silence back: the receiver could not parse the offer at all. */
function hex(buf: Buffer): string {
  return buf.toString('hex');
}

/**
 * A minimal request/response pairing for the webrtc namespace: Cast Streaming correlates by
 * `seqNum` in the JSON body, not by the `requestId` field castv2-client's own
 * RequestResponseController injects — so this talks to the channel directly.
 */
class OfferAnswerChannel extends EventEmitter {
  private seq = 0;
  constructor(private readonly channel: { send: (data: unknown) => void; on: (ev: 'message', cb: (data: any) => void) => void }) {
    super();
    this.channel.on('message', (data) => this.emit('message', data));
  }

  request(body: Record<string, unknown>, timeoutMs = 8000): Promise<any> {
    const seqNum = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('message', onMessage);
        reject(new Error(`webrtc channel request (seqNum ${seqNum}) timed out`));
      }, timeoutMs);
      const onMessage = (msg: any) => {
        if (msg?.seqNum !== seqNum) return;
        clearTimeout(timer);
        this.removeListener('message', onMessage);
        if (msg.result === 'error') reject(new Error(`receiver rejected request: ${msg.error?.description ?? JSON.stringify(msg.error)}`));
        else resolve(msg);
      };
      this.on('message', onMessage);
      this.channel.send({ ...body, seqNum });
    });
  }
}

/**
 * castv2-client Application for the "Chrome Mirroring" receiver. Exactly the pattern
 * DefaultMediaReceiver uses (see castv2-client/lib/senders/default-media-receiver.js), just
 * bound to the webrtc namespace instead of the media one.
 */
export class MirroringApp extends Application {
  static APP_ID = MIRRORING_APP_ID;
  webrtc: { send: (data: unknown) => void; on: (ev: 'message', cb: (data: any) => void) => void };

  constructor(client: unknown, session: unknown) {
    super(client, session);
    this.webrtc = this.createController(JsonController, WEBRTC_NAMESPACE);
  }
}

export interface MirroringVideoConfig {
  width: number;
  height: number;
  frameRateHint: number;
  maxBitrate: number;
}

/**
 * Owns one Cast Streaming session: OFFER/ANSWER, then a UDP socket carrying encrypted,
 * packetized VP8 frames paced by RtpPacingQueue. Video-only for now; see NOTICE-worthy
 * follow-up for Opus audio.
 */
export class MirroringSender extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private remotePort = 0;
  private pacing: RtpPacingQueue | null = null;
  private readonly videoSsrc = randomBytes(4).readUInt32BE(0) >>> 1; // keep < 2^31, some receivers treat ssrc as signed
  private readonly videoKey = randomBytes(16);
  private readonly videoIvMask = randomBytes(16);
  private seqCounter = Math.floor(Math.random() * 0x10000);
  // Chromium's Cast sender starts the 8-bit wire frame-id sequence at zero. Some legacy
  // receiver implementations reconstruct references from that initial value.
  private frameCounter = -1;
  private firstFrameDispatched = false;
  private packetsSent = 0;
  private octetsSent = 0;
  private rtcpTimer: NodeJS.Timeout | null = null;
  /** NTP "middle 32 bits" of the most recently sent SR, for RTT from the next RR's LSR/DLSR. */
  private lastSrNtpMiddle32: number | null = null;
  private lastQueueLogAtMs = 0;
  private lastClockLogAtMs = 0;
  private lastRtcpLogAtMs = 0;
  private closed = false;

  constructor(
    private readonly host: string,
    private readonly channel: OfferAnswerChannel,
  ) {
    super();
  }

  private get scope(): string {
    return `castmirror:${this.host}`;
  }

  async start(video: MirroringVideoConfig): Promise<void> {
    const offer = {
      castMode: 'mirroring',
      supportedStreams: [
        {
          index: 0,
          type: 'video_source',
          codecName: 'vp8',
          rtpProfile: 'cast',
          rtpPayloadType: VIDEO_RTP_PAYLOAD_TYPE,
          ssrc: this.videoSsrc,
          storeTime: 400,
          targetDelay: 400,
          aesKey: hex(this.videoKey),
          aesIvMask: hex(this.videoIvMask),
          timeBase: `1/${VIDEO_TIME_BASE_HZ}`,
          maxFrameRate: `${Math.round(video.frameRateHint * 1000)}/1000`,
          // maxBitRate is kilobits/sec on the wire (a real captured OFFER used 5000 for
          // 720p, i.e. 5 Mbps — 5000 bps would be unusably low), not bits/sec.
          maxBitRate: Math.round(video.maxBitrate / 1000),
          resolutions: [{ width: video.width, height: video.height }],
          receiverRtcpEventLog: true,
        },
      ],
    };
    log.info(this.scope, `sending OFFER: vp8 ${video.width}x${video.height}@${video.frameRateHint}`);
    const answerMsg = await this.channel.request({ type: 'OFFER', offer });
    const answer = answerMsg.answer;
    const udpPort: number | undefined = answer?.udpPort;
    if (!udpPort) throw new Error(`ANSWER had no udpPort: ${JSON.stringify(answerMsg).slice(0, 300)}`);
    const sendIndexes: number[] = answer.sendIndexes ?? [];
    if (!sendIndexes.includes(0)) throw new Error(`receiver did not accept the video stream: ${JSON.stringify(answerMsg).slice(0, 300)}`);
    this.remotePort = udpPort;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => {
      log.warn(this.scope, `UDP socket error: ${err.message}`);
      this.emit('error', err);
    });
    // Cast RTCP/receiver reports arrive on the same socket; log the first one as a liveness
    // signal (proof the receiver is actually processing what we send), and parse every one
    // for the jitter/RTT/loss diagnostics below.
    let sawReceiverTraffic = false;
    this.socket.on('message', (msg) => {
      if (!sawReceiverTraffic) {
        sawReceiverTraffic = true;
        log.info(this.scope, `receiver sent its first packet back (${msg.length} bytes) — session is live`);
      }
      this.handleIncomingRtcp(msg);
    });
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('error', reject);
      this.socket!.bind(0, () => resolve());
    });
    this.pacing = new RtpPacingQueue(
      Math.floor(Math.random() * 0x100000000),
      (frame, rtpTimestamp) => this.dispatchFrame(frame, rtpTimestamp),
      (depth, oldestAgeMs) => this.onQueueSample(depth, oldestAgeMs),
      () => this.emit('keyframe-needed'),
    );
    this.pacing.start();
    log.info(this.scope, `mirroring session established, receiver UDP port ${udpPort}`);
  }

  /** Encrypt, packetize and hand off one VP8 frame to the pacing queue; actual sending happens
   *  on the queue's own wall-clock tick, not synchronously here. */
  sendVideoFrame(vp8: Uint8Array, isKeyFrame: boolean): void {
    if (!this.pacing || this.closed) return;
    this.frameCounter++;
    const frameId = this.frameCounter;
    // Per encoded_frame.h: "if this frame does not require any other frame in order to
    // become decodable (e.g., key frames), referenced_frame_id must equal frame_id." A delta
    // frame here always depends on the one immediately before it (simple linear GOP, no SVC).
    const referencedFrameId = isKeyFrame ? frameId : frameId - 1;
    this.pacing.enqueue({ data: vp8, keyFrame: isKeyFrame, frameId, referencedFrameId });
  }

  /** Called by the pacing queue at send time with the wall-clock-derived RTP timestamp for
   *  this tick; this is the only place packets actually go out on the wire. */
  private dispatchFrame(frame: RtpQueuedFrame, rtpTimestamp: number): void {
    if (!this.socket || this.closed) return;
    const encrypted = this.encryptFrame(Buffer.from(frame.data), frame.frameId);
    const packets = this.packetize(encrypted, {
      keyFrame: frame.keyFrame,
      frameId: frame.frameId,
      referencedFrameId: frame.referencedFrameId,
      rtpTimestamp,
    });
    for (const packet of packets) {
      this.socket.send(packet, this.remotePort, this.host, (err) => {
        if (err) log.debug(this.scope, `send error: ${err.message}`);
      });
      this.packetsSent++;
      this.octetsSent += packet.length - RTP_HEADER_SIZE; // RFC 3550: payload octets only
    }
    this.logClockSample(rtpTimestamp);
    // Start RTCP after the first frame's own packets so its Sender Report already reflects
    // real, non-zero counts rather than reporting zero for the "as of now" cumulative fields.
    if (!this.firstFrameDispatched) {
      this.firstFrameDispatched = true;
      this.startRtcp();
    }
  }

  private onQueueSample(depth: number, oldestAgeMs: number): void {
    const now = performance.now();
    if (now - this.lastQueueLogAtMs < DIAG_LOG_INTERVAL_MS) return;
    this.lastQueueLogAtMs = now;
    log.info(this.scope, `[rtpqueue] depth=${depth} oldestAge=${oldestAgeMs.toFixed(0)}ms`);
  }

  /** (sendWallTime, rtpTimestamp) pairs, throttled — plot these to confirm or rule out RTP
   *  clock drift relative to wall-clock time. */
  private logClockSample(rtpTimestamp: number): void {
    const now = performance.now();
    if (now - this.lastClockLogAtMs < DIAG_LOG_INTERVAL_MS) return;
    this.lastClockLogAtMs = now;
    log.info(this.scope, `[rtpclock] sendWallMs=${now.toFixed(0)} rtpTimestamp=${rtpTimestamp}`);
  }

  /**
   * Start sending RTCP Sender Reports once media flows, so the receiver can map our RTP
   * clock to real time and pace playout against it instead of guessing.
   */
  private startRtcp(): void {
    if (this.rtcpTimer) return;
    this.sendSenderReport(); // immediately, not after the first full interval
    this.rtcpTimer = setInterval(() => this.sendSenderReport(), RTCP_SR_INTERVAL_MS);
  }

  /** RFC 3550 §6.4.1: a bare Sender Report (no reception report blocks — we send, not receive). */
  private sendSenderReport(): void {
    if (!this.socket || this.closed || !this.pacing) return;
    const nowMs = Date.now();
    const ntpSeconds = Math.floor(nowMs / 1000) + NTP_UNIX_EPOCH_OFFSET;
    const ntpFraction = Math.round(((nowMs % 1000) / 1000) * 0x100000000);
    this.lastSrNtpMiddle32 = this.ntpMiddle32(ntpSeconds, ntpFraction);
    // Drawn from the same wall-clock-anchored mapping used for data packets, so the clock
    // this SR advertises can never disagree with what's actually on the wire.
    const rtpTimestamp = this.pacing.currentRtpTimestamp();

    const sr = Buffer.alloc(28);
    sr[0] = 0x80; // V=2, P=0, RC=0 (no report blocks)
    sr[1] = RTCP_PT_SENDER_REPORT;
    sr.writeUInt16BE(6, 2); // packet length in 32-bit words, minus one: (28/4)-1
    sr.writeUInt32BE(this.videoSsrc, 4);
    sr.writeUInt32BE(ntpSeconds >>> 0, 8);
    sr.writeUInt32BE(ntpFraction >>> 0, 12);
    sr.writeUInt32BE(rtpTimestamp, 16);
    sr.writeUInt32BE(this.packetsSent >>> 0, 20);
    sr.writeUInt32BE(this.octetsSent >>> 0, 24);
    this.socket.send(sr, this.remotePort, this.host, (err) => {
      if (err) log.debug(this.scope, `RTCP SR send error: ${err.message}`);
    });
  }

  private ntpMiddle32(ntpSeconds: number, ntpFraction: number): number {
    return (((ntpSeconds & 0xffff) << 16) | (ntpFraction >>> 16)) >>> 0;
  }

  /**
   * Parse an incoming RTCP Receiver Report (RFC 3550 §6.4.2) for the three fields that bear
   * on latency: jitter (the receiver's own view of our timing), RTT (from LSR/DLSR against
   * the most recent Sender Report), and loss. High loss sheds the pacing queue toward the
   * newest frame immediately rather than waiting for the age-based drop to catch up, since
   * this stream has no retransmission and a stale queued frame is worth less than a fresh one
   * once loss is real. All three are also logged, throttled, for offline analysis.
   */
  private handleIncomingRtcp(msg: Buffer): void {
    if (msg.length < 8 + 24) return;
    if (msg[1] !== RTCP_PT_RECEIVER_REPORT) return;
    if ((msg[0] & 0x1f) < 1) return; // report count: need at least one report block
    const block = msg.subarray(8, 8 + 24);
    const fractionLost = block[4] / 256;
    const jitterTicks = block.readUInt32BE(12);
    const jitterMs = (jitterTicks / VIDEO_TIME_BASE_HZ) * 1000;
    const lsr = block.readUInt32BE(16);
    const dlsr = block.readUInt32BE(20);
    let rttMs: number | null = null;
    if (lsr !== 0 && this.lastSrNtpMiddle32 !== null) {
      const nowMs = Date.now();
      const nowNtpSeconds = Math.floor(nowMs / 1000) + NTP_UNIX_EPOCH_OFFSET;
      const nowNtpFraction = Math.round(((nowMs % 1000) / 1000) * 0x100000000);
      const nowMiddle32 = this.ntpMiddle32(nowNtpSeconds, nowNtpFraction);
      const rtt65536ths = (nowMiddle32 - lsr - dlsr) >>> 0;
      rttMs = (rtt65536ths / 65536) * 1000;
    }
    if (fractionLost > RTCP_LOSS_DROP_THRESHOLD) this.pacing?.dropToNewest();
    const now = performance.now();
    if (now - this.lastRtcpLogAtMs >= DIAG_LOG_INTERVAL_MS) {
      this.lastRtcpLogAtMs = now;
      const rttLabel = rttMs !== null ? `${rttMs.toFixed(1)}ms` : 'unknown';
      log.info(this.scope, `[rtcprr] jitter=${jitterMs.toFixed(1)}ms rtt=${rttLabel} loss=${(fractionLost * 100).toFixed(1)}%`);
    }
  }

  /** AES-128-CTR over the whole frame as one continuous keystream (matches libcast). */
  private encryptFrame(data: Buffer, frameId: number): Buffer {
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(frameId >>> 0, 8); // frame id (low 32 bits) at bytes 8-11, big-endian
    for (let i = 0; i < 16; i++) iv[i] ^= this.videoIvMask[i];
    const cipher = createCipheriv('aes-128-ctr', this.videoKey, iv);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }

  private packetize(
    encrypted: Buffer,
    opts: { keyFrame: boolean; frameId: number; referencedFrameId: number; rtpTimestamp: number },
  ): Buffer[] {
    const totalPackets = Math.max(1, Math.ceil(encrypted.length / MAX_PACKET_PAYLOAD));
    const packets: Buffer[] = [];
    for (let i = 0; i < totalPackets; i++) {
      const chunk = encrypted.subarray(i * MAX_PACKET_PAYLOAD, (i + 1) * MAX_PACKET_PAYLOAD);
      const header = Buffer.alloc(RTP_HEADER_SIZE);
      header[0] = 0x80; // V=2, P=0, X=0, CC=0
      header[1] = (i === totalPackets - 1 ? 0x80 : 0) | (VIDEO_RTP_PAYLOAD_TYPE & 0x7f); // marker on the last packet of the frame
      header.writeUInt16BE(this.seqCounter & 0xffff, 2);
      this.seqCounter++;
      header.writeUInt32BE(opts.rtpTimestamp, 4);
      header.writeUInt32BE(this.videoSsrc, 8);
      // Real senders always set the "reference frame id provided" bit (0x40), for every
      // frame including keyframes, and include one Adaptive Latency extension (low five bits).
      header[12] = (opts.keyFrame ? 0x80 : 0x00) | 0x40 | 0x01;
      header[13] = opts.frameId & 0xff;
      header.writeUInt16BE(i, 14); // packet id
      header.writeUInt16BE(totalPackets - 1, 16); // max packet id
      header[18] = opts.referencedFrameId & 0xff;
      // Chromium's Cast packetizer serializes this extension on each packet. Google TV uses it
      // to set playout instead of guessing an overly-safe 4–6-second buffer.
      header[12 + CAST_FRAME_HEADER_SIZE] = CAST_ADAPTIVE_LATENCY_EXTENSION_TYPE;
      header[13 + CAST_FRAME_HEADER_SIZE] = CAST_ADAPTIVE_LATENCY_EXTENSION_SIZE;
      header.writeUInt16BE(CAST_PLAYOUT_DELAY_MS, 14 + CAST_FRAME_HEADER_SIZE);
      packets.push(Buffer.concat([header, chunk]));
    }
    return packets;
  }

  close(): void {
    this.closed = true;
    if (this.rtcpTimer) clearInterval(this.rtcpTimer);
    this.rtcpTimer = null;
    this.pacing?.stop();
    this.pacing = null;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

export { OfferAnswerChannel };
