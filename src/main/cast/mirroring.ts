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

export const MIRRORING_APP_ID = '0F5096E8';
export const WEBRTC_NAMESPACE = 'urn:x-cast:com.google.cast.webrtc';

/** Max UDP payload per Cast RTP packet, leaving headroom under common MTUs. */
const MAX_PACKET_PAYLOAD = 1200;
/**
 * Cast RTP header: 12-byte standard RTP header + 7-byte Cast extension (flags, frame id,
 * packet id, max packet id, referenced frame id). Real senders (verified against the literal
 * Chromium source, cast/streaming/impl/rtp_packetizer.cc) ALWAYS set the "reference frame id
 * provided" bit and ALWAYS include this byte — the 18-byte "no RFID" form is spec-legal but
 * effectively never produced by a real sender, and appears to be why delta frames misbehaved:
 * the receiver's no-RFID code path is presumably far less exercised in the field.
 */
const RTP_HEADER_SIZE = 19;
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
 * packetized VP8 frames. Video-only for now; see NOTICE-worthy follow-up for Opus audio.
 */
export class MirroringSender extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private remotePort = 0;
  private readonly videoSsrc = randomBytes(4).readUInt32BE(0) >>> 1; // keep < 2^31, some receivers treat ssrc as signed
  private readonly videoKey = randomBytes(16);
  private readonly videoIvMask = randomBytes(16);
  private seqCounter = Math.floor(Math.random() * 0x10000);
  private frameCounter = 0;
  private rtpTimestampOrigin = Math.floor(Math.random() * 0x100000000);
  private firstFrameAtUs: number | null = null;
  /** Wall-clock instant corresponding to firstFrameAtUs, needed to build Sender Reports. */
  private firstFrameWallMs: number | null = null;
  private packetsSent = 0;
  private octetsSent = 0;
  private rtcpTimer: NodeJS.Timeout | null = null;
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
    // signal (proof the receiver is actually processing what we send), otherwise ignore.
    let sawReceiverTraffic = false;
    this.socket.on('message', (msg) => {
      if (!sawReceiverTraffic) {
        sawReceiverTraffic = true;
        log.info(this.scope, `receiver sent its first packet back (${msg.length} bytes) — session is live`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('error', reject);
      this.socket!.bind(0, () => resolve());
    });
    log.info(this.scope, `mirroring session established, receiver UDP port ${udpPort}`);
  }

  /** Encrypt and packetize one VP8 frame, then send it as a burst of Cast RTP/UDP packets. */
  sendVideoFrame(vp8: Uint8Array, isKeyFrame: boolean, timestampUs: number): void {
    if (!this.socket || this.closed) return;
    const isFirstFrame = this.firstFrameAtUs === null;
    if (isFirstFrame) {
      this.firstFrameAtUs = timestampUs;
      this.firstFrameWallMs = Date.now();
    }
    this.frameCounter++;
    const frameId = this.frameCounter; // wire carries the low 8 bits; receiver expands it.
    // Per encoded_frame.h: "if this frame does not require any other frame in order to
    // become decodable (e.g., key frames), referenced_frame_id must equal frame_id." A delta
    // frame here always depends on the one immediately before it (simple linear GOP, no SVC).
    const referencedFrameId = isKeyFrame ? frameId : frameId - 1;
    const encrypted = this.encryptFrame(Buffer.from(vp8), frameId);
    const rtpTimestamp = (this.rtpTimestampOrigin + Math.round(((timestampUs - this.firstFrameAtUs!) * VIDEO_TIME_BASE_HZ) / 1e6)) >>> 0;
    const packets = this.packetize(encrypted, { keyFrame: isKeyFrame, frameId, referencedFrameId, rtpTimestamp });
    for (const packet of packets) {
      this.socket.send(packet, this.remotePort, this.host, (err) => {
        if (err) log.debug(this.scope, `send error: ${err.message}`);
      });
      this.packetsSent++;
      this.octetsSent += packet.length - RTP_HEADER_SIZE; // RFC 3550: payload octets only
    }
    // Start RTCP after the first frame's own packets so its Sender Report already reflects
    // real, non-zero counts rather than reporting zero for the "as of now" cumulative fields.
    if (isFirstFrame) this.startRtcp();
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
    if (!this.socket || this.closed || this.firstFrameAtUs === null || this.firstFrameWallMs === null) return;
    const nowMs = Date.now();
    const ntpSeconds = Math.floor(nowMs / 1000) + NTP_UNIX_EPOCH_OFFSET;
    const ntpFraction = Math.round(((nowMs % 1000) / 1000) * 0x100000000);
    const elapsedMs = nowMs - this.firstFrameWallMs;
    const rtpTimestamp = (this.rtpTimestampOrigin + Math.round((elapsedMs * VIDEO_TIME_BASE_HZ) / 1000)) >>> 0;

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
      // frame including keyframes — confirmed against the literal Chromium packetizer.
      header[12] = (opts.keyFrame ? 0x80 : 0x00) | 0x40;
      header[13] = opts.frameId & 0xff;
      header.writeUInt16BE(i, 14); // packet id
      header.writeUInt16BE(totalPackets - 1, 16); // max packet id
      header[18] = opts.referencedFrameId & 0xff;
      packets.push(Buffer.concat([header, chunk]));
    }
    return packets;
  }

  close(): void {
    this.closed = true;
    if (this.rtcpTimer) clearInterval(this.rtcpTimer);
    this.rtcpTimer = null;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

export { OfferAnswerChannel };
