/**
 * AirPlay 2 real-time screen mirroring sender (the low-latency path AirParrot uses).
 *
 * Encoded H.264 access units are pushed straight down a TCP data channel, each behind a
 * 128-byte header, with no HLS segment buffering. A modern Apple TV gates this behind
 * Apple's FairPlay SAP handshake (see ./fairplay) plus a HAP-encrypted control channel.
 *
 * Sequence for a modern (encrypted, PTP) receiver:
 *   pair-verify (caller) -> POST /fp-setup m1/m3 -> control SETUP (anchors PTP clock)
 *   -> RECORD -> audio SETUP (type 96 descriptor, no packets in video-only mode)
 *   -> video SETUP (type 110) -> connect TCP data port -> stream codec + video frames.
 *
 * This is a faithful TypeScript port of the GPL-3.0 doubletake project's MirrorSession for
 * the encrypted/PTP/ChaCha20-Poly1305/H.264 path; see NOTICE. It is validated end-to-end
 * only against a live Apple TV, so it logs each protocol step under scope "mirror:*".
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes, hkdfSync, createHash } from 'node:crypto';
import bplistCreator from 'bplist-creator';
import { parseBuffer as parseBplist } from 'bplist-parser';
import type { AirPlayConnection, AirPlayResponse } from './connection';
import { deriveKeys, EVENTS_SALT, EVENTS_READ, EVENTS_WRITE, type SessionKeys } from './hap';
import { newFPSAPSession, byteSource } from './fairplay';
import { aeadEncrypt } from './chacha20poly1305';
import { HapFramer, randomId } from './crypto';
import { log } from '../logger';

const BPLIST = 'application/x-apple-binary-plist';
/** SourceVersion that selects the modern (ChaCha) receiver behaviour. */
const MODERN_SOURCE_VERSION = '980.71.1';
/** Playout lead: doubletake's defaultVideoLatencyNormal. */
const VIDEO_BIAS_MS = 75;

/** Positive 53-bit ids so they round-trip losslessly through a JS-number binary plist. */
function newStreamConnectionID(): number {
  return Math.floor(Math.random() * 0x1fffffffffffff) + 1;
}

/** NTP-style 64-bit fixed point from milliseconds: (seconds << 32) | fractional. */
function compactTimestamp(ms: number): bigint {
  if (ms < 0) ms = 0;
  const sec = BigInt(Math.floor(ms / 1000));
  const frac = BigInt(Math.floor(((ms % 1000) / 1000) * 0x100000000));
  return ((sec << 32n) | frac) & 0xffffffffffffffffn;
}

function u64le(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  return b;
}

function putFloat32LE(buf: Buffer, offset: number, value: number): void {
  buf.writeFloatLE(value, offset);
}

// bplist-creator ships without types in this project; wrap the untyped call once.
function toPlist(obj: Record<string, unknown>): Buffer {
  return (bplistCreator as unknown as (o: unknown) => Buffer)(obj);
}

function fromPlist(body: Buffer): Record<string, any> | null {
  if (!body || !body.length) return null;
  try {
    const parsed = parseBplist(body);
    return (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, any>;
  } catch {
    return null;
  }
}

function plistUint64(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function plistInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return 0;
}

/** Split a WebCodecs avcC (AVCDecoderConfigurationRecord) into raw SPS/PPS. */
export function spsPpsFromAvcC(avcC: Uint8Array): { sps: Uint8Array; pps: Uint8Array } | null {
  if (avcC.length < 7 || avcC[0] !== 0x01) return null;
  let off = 5;
  const numSps = avcC[off++] & 0x1f;
  if (numSps < 1) return null;
  const spsLen = (avcC[off] << 8) | avcC[off + 1];
  off += 2;
  const sps = avcC.subarray(off, off + spsLen);
  off += spsLen;
  const numPps = avcC[off++];
  if (numPps < 1 || off + 2 > avcC.length) return null;
  const ppsLen = (avcC[off] << 8) | avcC[off + 1];
  off += 2;
  const pps = avcC.subarray(off, off + ppsLen);
  if (sps.length !== spsLen || pps.length !== ppsLen) return null;
  return { sps, pps };
}

/** avcC record with the 4-byte trailer observed in iPhone captures (matches doubletake). */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Buffer {
  const avcCLen = 6 + 2 + sps.length + 1 + 2 + pps.length;
  const out = Buffer.alloc(avcCLen + 4);
  out[0] = 0x01;
  out[1] = sps[1];
  out[2] = sps[2];
  out[3] = sps[3];
  out[4] = 0xff; // 4-byte NALU lengths
  out[5] = 0xe1; // 1 SPS
  out.writeUInt16BE(sps.length, 6);
  Buffer.from(sps).copy(out, 8);
  const off = 8 + sps.length;
  out[off] = 0x01; // 1 PPS
  out.writeUInt16BE(pps.length, off + 1);
  Buffer.from(pps).copy(out, off + 3);
  out[avcCLen] = 0x02; // trailer
  return out;
}

/** Parse width/height out of an H.264 SPS. Best-effort. */
export function spsDimensions(sps: Uint8Array): { width: number; height: number } | null {
  if (sps.length < 5 || (sps[0] & 0x1f) !== 7) return null; // must be an SPS NAL
  try {
    const rbsp = unescapeEmulation(sps.subarray(1)); // drop NAL header byte
    const r = new BitReader(rbsp);
    const profileIdc = r.u(8);
    r.u(8); // constraint flags + reserved
    r.u(8); // level_idc
    r.ue(); // seq_parameter_set_id
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      const chromaFormat = r.ue();
      if (chromaFormat === 3) r.u(1);
      r.ue(); // bit_depth_luma
      r.ue(); // bit_depth_chroma
      r.u(1); // qpprime
      if (r.u(1)) {
        for (let i = 0; i < 8; i++) if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
    r.ue(); // log2_max_frame_num
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
      r.u(1);
      r.se();
      r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.u(1); // gaps_in_frame_num_value_allowed
    const widthMbs = r.ue() + 1;
    const heightMapUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1); // mb_adaptive_frame_field
    r.u(1); // direct_8x8_inference
    let cropL = 0;
    let cropR = 0;
    let cropT = 0;
    let cropB = 0;
    if (r.u(1)) {
      cropL = r.ue();
      cropR = r.ue();
      cropT = r.ue();
      cropB = r.ue();
    }
    const width = widthMbs * 16 - (cropL + cropR) * 2;
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (cropT + cropB) * 2;
    // Reject implausible sizes (truncated/garbage SPS drives the Exp-Golomb reader off the end).
    if (width > 0 && height > 0 && width <= 16384 && height <= 16384) return { width, height };
  } catch {
    /* fall through */
  }
  return null;
}

function unescapeEmulation(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i >= 2 && data[i] === 0x03 && data[i - 1] === 0x00 && data[i - 2] === 0x00 && (data[i + 1] ?? 0) <= 0x03) continue;
    out.push(data[i]);
  }
  return Uint8Array.from(out);
}

function skipScalingList(r: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

class BitReader {
  private bit = 0;
  constructor(private readonly data: Uint8Array) {}
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.bit >> 3] ?? 0;
      const b = (byte >> (7 - (this.bit & 7))) & 1;
      v = (v << 1) | b;
      this.bit++;
    }
    return v >>> 0;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0 && zeros < 32) zeros++;
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.u(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  }
}

/**
 * PTP-lite media clock. The receiver's timeline id and an anchor timestamp come from the
 * control SETUP response; frame timestamps are then anchor + local-elapsed + playout bias.
 * No IEEE-1588 daemon is needed (doubletake closes its timing socket on this path).
 */
class MediaClock {
  private anchorLocalMs = 0;
  private anchorTimestamp = 0n;
  timelineID = 0n;

  configureFromSetup(response: Record<string, any> | null, headers: Record<string, string>, receivedAtMs: number): boolean {
    const peer = response?.timingPeerInfo as Record<string, any> | undefined;
    this.timelineID = plistUint64(peer?.ClockID ?? peer?.clockID);
    if (this.timelineID === 0n) return false;
    const received = parseInt(headers['x-apple-requestreceivedtimestamp'] ?? '', 10);
    const processing = parseInt(headers['x-apple-processingtime'] ?? '', 10);
    if (!Number.isFinite(received)) return false;
    this.anchorTimestamp = compactTimestamp(received + (Number.isFinite(processing) ? processing : 0));
    this.anchorLocalMs = receivedAtMs;
    return true;
  }

  reanchor(headers: Record<string, string>, receivedAtMs: number): void {
    const received = parseInt(headers['x-apple-requestreceivedtimestamp'] ?? '', 10);
    const processing = parseInt(headers['x-apple-processingtime'] ?? '', 10);
    if (!Number.isFinite(received) || this.anchorLocalMs === 0) return;
    let ts = compactTimestamp(received + (Number.isFinite(processing) ? processing : 0));
    // Never move the clock backward: a delayed feedback response can look older than live.
    if (receivedAtMs >= this.anchorLocalMs) {
      const projected = (this.anchorTimestamp + compactTimestamp(receivedAtMs - this.anchorLocalMs)) & 0xffffffffffffffffn;
      if (ts < projected) ts = projected;
    }
    this.anchorTimestamp = ts;
    this.anchorLocalMs = receivedAtMs;
  }

  now(biasMs: number): bigint | null {
    if (this.anchorLocalMs === 0 || this.timelineID === 0n) return null;
    const elapsed = Date.now() - this.anchorLocalMs + biasMs;
    return (this.anchorTimestamp + compactTimestamp(elapsed)) & 0xffffffffffffffffn;
  }
}

export interface MirrorOptions {
  host: string;
  port: number;
  name: string;
  senderName: string;
  /** The encrypted HAP control connection, already pair-verified. */
  conn: AirPlayConnection;
  /** Keys from pair-verify; `shared` is the X25519 secret used as the ChaCha IKM. */
  keys: SessionKeys;
  /** Receiver /info dictionary. */
  info: Record<string, any> | null;
}

/**
 * Owns a live mirroring session: performs FairPlay + SETUP + RECORD, then accepts encoded
 * H.264 access units (avcC framing) and ships them to the receiver.
 */
export class MirrorClient extends EventEmitter {
  private readonly conn: AirPlayConnection;
  private readonly keys: SessionKeys;
  private dataConn: net.Socket | null = null;
  private eventConn: net.Socket | null = null;
  private cseq = 0;
  private readonly sessionUUID = randomId().toUpperCase();
  private readonly deviceID = macFromRandom();
  private readonly dacpId = randomBytes(8).toString('hex').toUpperCase();
  private readonly activeRemote = randomBytes(4).readUInt32BE(0);
  private audioURI = '';
  private videoConnId = 0;
  private chachaKey: Buffer | null = null;
  private chachaCounter = 0n;
  private frameSeq = 0;
  private clock = new MediaClock();
  private lastTimestamp = 0n;
  private sentConfig = false;
  private videoWidth = 1920;
  private videoHeight = 1080;
  private feedbackTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private firstFrameSent = false;
  private closed = false;
  private pendingAvcC: Buffer | null = null;
  // FairPlay stream key material carried in the video descriptor.
  private fpKey: Buffer | null = null;
  private fpIV: Buffer | null = null;

  constructor(private readonly opts: MirrorOptions) {
    super();
    this.conn = opts.conn;
    this.keys = opts.keys;
  }

  private get scope(): string {
    return `mirror:${this.opts.name}`;
  }

  // --------------------------------------------------------------------- setup

  async start(): Promise<void> {
    await this.fairPlaySetup();

    // 1) Control SETUP creates the session and anchors the PTP clock.
    const audioConnId = newStreamConnectionID();
    this.audioURI = `rtsp://${this.opts.host}:${this.opts.port}/${audioConnId}`;
    const t0 = Date.now();
    const ctrl = await this.rtsp('SETUP', this.audioURI, toPlist(this.controlPlist()));
    if (ctrl.code !== 200) throw new Error(`control SETUP failed: ${ctrl.code} ${ctrl.message}`);
    const ctrlResp = fromPlist(ctrl.body);
    log.info(this.scope, `control SETUP -> ${ctrl.code}; resp keys: [${ctrlResp ? Object.keys(ctrlResp).join(', ') : 'none'}]; eventPort=${ctrlResp?.eventPort ?? '-'} skipRecord=${ctrlResp?.skipRecord ?? '-'}`);
    if (!this.clock.configureFromSetup(ctrlResp, ctrl.headers, t0)) {
      throw new Error('control SETUP did not return a PTP timeline (timingPeerInfo.ClockID)');
    }
    log.info(this.scope, `control SETUP ok; PTP timeline 0x${this.clock.timelineID.toString(16)}`);

    // 1b) Connect the reverse event channel the receiver advertised. The modern Apple TV
    //     will not answer RECORD until this is up, so it must happen before RECORD.
    const eventPort = plistInt(ctrlResp?.eventPort);
    if (eventPort > 0) await this.connectEvent(eventPort);

    // 2) RECORD starts the session (session-first receivers).
    if (!ctrlResp?.skipRecord) {
      const rec = await this.rtsp('RECORD', this.audioURI, undefined, undefined, { Session: this.sessionUUID, Range: 'npt=0-', 'RTP-Info': 'seq=0;rtptime=0' });
      if (rec.code !== 200) log.warn(this.scope, `RECORD -> ${rec.code} (continuing)`);
    }

    // 3) Audio SETUP (type 96). The descriptor must exist for the receiver to reach ready
    //    state even though this video-only session sends no audio packets.
    const audioChaChaKey = randomBytes(32);
    const audioStream: Record<string, unknown> = {
      type: 96,
      streamConnectionID: audioConnId,
      ct: 2,
      spf: 352,
      sr: 44100,
      audioFormat: 0x40000,
      audioMode: 'default',
      usingScreen: true,
      latencyMin: 0,
      latencyMax: 88200,
      isMedia: false,
      supportsDynamicStreamID: true,
      shk: audioChaChaKey,
      streamConnections: {
        streamConnectionTypeRTP: { streamConnectionKeyUseStreamEncryptionKey: true },
        streamConnectionTypeRTCP: { streamConnectionKeyPort: 0 },
      },
    };
    const aresp = await this.rtsp('SETUP', this.audioURI, toPlist({ streams: [audioStream] }));
    if (aresp.code !== 200) log.warn(this.scope, `audio SETUP -> ${aresp.code} (continuing video-only)`);

    // 4) Video SETUP (type 110). shk/shiv carry the FairPlay stream key material.
    this.videoConnId = newStreamConnectionID();
    const videoURI = `rtsp://${this.opts.host}:${this.opts.port}/${this.videoConnId}`;
    const videoStream: Record<string, unknown> = {
      type: 110,
      streamConnectionID: this.videoConnId,
      latencyMs: VIDEO_BIAS_MS,
      timestampInfo: [{ name: 'SubSu' }, { name: 'BePxT' }, { name: 'AfPxT' }, { name: 'BefEn' }, { name: 'EmEnc' }],
      shk: this.fpKey,
      shiv: this.fpIV,
    };
    const vresp = await this.rtsp('SETUP', videoURI, toPlist({ streams: [videoStream] }));
    if (vresp.code !== 200) throw new Error(`video SETUP failed: ${vresp.code} ${vresp.message}`);
    const vbody = fromPlist(vresp.body);
    let dataPort = 0;
    for (const s of (vbody?.streams ?? []) as Record<string, any>[]) {
      if (plistInt(s.type) === 110) dataPort = plistInt(s.dataPort);
    }
    if (!dataPort) throw new Error('video SETUP response had no data port');
    log.info(this.scope, `video SETUP ok, data port ${dataPort}`);

    // 5) ChaCha20-Poly1305 video key: HKDF-SHA512(IKM = pair-verify shared secret).
    const salt = Buffer.from(`DataStream-Salt${this.videoConnId}`);
    const info = Buffer.from('DataStream-Output-Encryption-Key');
    this.chachaKey = Buffer.from(hkdfSync('sha512', this.keys.shared, salt, info, 32));

    // 6) Connect the TCP data channel.
    await this.connectData(dataPort);

    // 7) Volume to 0 dB (full scale), twice, as real senders do.
    const vol = Buffer.from('volume: 0.000000\r\n');
    await this.rtsp('SET_PARAMETER', this.audioURI, vol, 'text/parameters').catch(() => undefined);
    await this.rtsp('SET_PARAMETER', this.audioURI, vol, 'text/parameters').catch(() => undefined);

    this.startFeedback();
    log.info(this.scope, 'mirror session established (video-only)');
  }

  /** POST /fp-setup m1/m3, then wrap a random key and derive the stream master key. */
  private async fairPlaySetup(): Promise<void> {
    const session = newFPSAPSession(byteSource(randomBytes(126)));
    const fpHeaders = { 'User-Agent': 'AirPlay/550.10', 'Content-Type': 'application/octet-stream', 'X-Apple-ET': 32 };
    const m1 = session.message1();
    const r2 = await this.conn.post('/fp-setup', { headers: fpHeaders, body: Buffer.from(m1), allowError: true, timeoutMs: 8000 });
    if (r2.code !== 200) throw new Error(`fp-setup m1 -> ${r2.code}`);
    const m3 = session.exchangeM3(r2.body);
    const r4 = await this.conn.post('/fp-setup', { headers: fpHeaders, body: Buffer.from(m3), allowError: true, timeoutMs: 8000 });
    if (r4.code !== 200) throw new Error(`fp-setup m3 -> ${r4.code}`);
    session.confirmM4(r4.body);
    const fpAesKey = randomBytes(16);
    session.wrapKey(fpAesKey, byteSource(randomBytes(16))); // proves the handshake (ekey unused for encrypted receivers)
    this.fpIV = randomBytes(16);
    // HAP-paired receivers mix the pair-verify secret: SHA-512(fpAesKey || sharedSecret)[:16].
    this.fpKey = createHash('sha512').update(fpAesKey).update(this.keys.shared).digest().subarray(0, 16);
    log.info(this.scope, 'FairPlay SAP handshake complete');
  }

  private controlPlist(): Record<string, unknown> {
    return { ...this.sessionPlist(), updateSessionRequest: false, combinedGetInfoWithControlSetup: true };
  }

  private sessionPlist(): Record<string, unknown> {
    const local = this.conn.localAddress || '0.0.0.0';
    const peer = { ID: randomId().toUpperCase(), SupportsClockPortMatchingOverride: true, DeviceType: 0, Addresses: [local] };
    return {
      deviceID: this.deviceID,
      macAddress: this.deviceID,
      sessionUUID: this.sessionUUID,
      sourceVersion: MODERN_SOURCE_VERSION,
      isScreenMirroringSession: true,
      timingProtocol: 'PTP',
      osBuildVersion: '13F69',
      model: 'AirWing1,1',
      name: this.opts.senderName,
      timingPeerInfo: peer,
      timingPeerList: [peer],
    };
  }

  private rtsp(method: string, uri: string, body?: Buffer, contentType?: string, extra: Record<string, string | number> = {}): Promise<AirPlayResponse> {
    const headers: Record<string, string | number> = {
      CSeq: this.cseq++,
      'DACP-ID': this.dacpId,
      'Active-Remote': this.activeRemote,
      'Client-Instance': this.dacpId,
      'User-Agent': 'AirPlay/550.10',
      ...extra,
    };
    if (body) headers['Content-Type'] = contentType ?? BPLIST;
    return this.conn.request(method, uri, { protocol: 'RTSP/1.0', headers, body, allowError: true, timeoutMs: 10000 });
  }

  /**
   * Connect the receiver's reverse event channel (encrypted with Events-* keys derived from
   * the pair-verify secret) and answer each request it sends with 200 OK, so the session
   * stays alive. Modern Apple TVs gate RECORD on this channel existing.
   */
  private connectEvent(port: number): Promise<void> {
    const keys = deriveKeys(this.keys.shared, EVENTS_SALT, EVENTS_READ, EVENTS_WRITE);
    const framer = new HapFramer(keys.outKey, keys.inKey);
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const sock = net.createConnection({ host: this.opts.host, port }, () => {
        this.eventConn = sock;
        log.info(this.scope, `event channel connected to ${this.opts.host}:${port}`);
        done();
      });
      let rx = Buffer.alloc(0);
      sock.on('data', (data) => {
        try {
          const plain = framer.decrypt(data);
          if (!plain.length) return;
          rx = Buffer.concat([rx, plain]);
          for (;;) {
            const headEnd = rx.indexOf('\r\n\r\n');
            if (headEnd < 0) break;
            const headText = rx.subarray(0, headEnd).toString('utf8');
            const contentLength = parseInt(/content-length:\s*(\d+)/i.exec(headText)?.[1] ?? '0', 10) || 0;
            const total = headEnd + 4 + contentLength;
            if (rx.length < total) break;
            rx = rx.subarray(total);
            const m = /^(\w+) \S+ (HTTP|RTSP)\/([0-9.]+)/.exec(headText);
            if (m) {
              const cseq = /CSeq:\s*(\d+)/i.exec(headText)?.[1];
              const reply = `${m[2]}/${m[3]} 200 OK\r\n${cseq ? `CSeq: ${cseq}\r\n` : ''}Audio-Latency: 0\r\nContent-Length: 0\r\n\r\n`;
              sock.write(framer.encrypt(Buffer.from(reply)));
            }
          }
        } catch (err) {
          log.debug(this.scope, `event channel decrypt error: ${(err as Error).message}`);
        }
      });
      sock.on('error', (err) => {
        log.warn(this.scope, `event channel error: ${err.message}`);
        done();
      });
      sock.on('close', () => {
        if (this.eventConn === sock) this.eventConn = null;
      });
      sock.setTimeout(6000, () => {
        if (!this.eventConn) {
          log.warn(this.scope, 'event channel connect timed out (continuing)');
          done();
        }
      });
    });
  }

  private connectData(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port }, () => {
        sock.setNoDelay(true);
        this.dataConn = sock;
        log.info(this.scope, `data channel connected to ${this.opts.host}:${port}`);
        resolve();
      });
      sock.on('error', (err) => {
        if (!this.dataConn) reject(err);
        else this.fail(`data channel error: ${err.message}`);
      });
      sock.on('close', () => {
        if (!this.closed) this.fail('data channel closed by receiver');
      });
      sock.setTimeout(8000, () => {
        if (!this.dataConn) reject(new Error('data channel connect timed out'));
      });
    });
  }

  // ------------------------------------------------------------------- streaming

  /** Provide the encoder's avcC (WebCodecs decoderConfig.description). */
  setCodecConfig(avcC: Uint8Array): void {
    const parts = spsPpsFromAvcC(avcC);
    if (!parts) {
      log.warn(this.scope, 'could not parse avcC decoder config');
      return;
    }
    this.pendingAvcC = buildAvcC(parts.sps, parts.pps);
    const dims = spsDimensions(parts.sps);
    if (dims) {
      this.videoWidth = dims.width;
      this.videoHeight = dims.height;
    }
  }

  /**
   * Send one H.264 access unit (avcC framing: 4-byte-length-prefixed NALUs, no start codes,
   * exactly what WebCodecs produces with avc format 'avc'). The first keyframe is preceded
   * by the unencrypted codec (avcC) frame.
   */
  sendAccessUnit(au: Uint8Array, isKeyframe: boolean): void {
    if (!this.dataConn || this.closed) return;
    const ts = this.frameTimestamp();
    if (isKeyframe && !this.sentConfig && this.pendingAvcC) {
      this.sendCodecFrame(this.pendingAvcC, ts);
      this.sentConfig = true;
    }
    if (!this.sentConfig) return; // wait for a keyframe + config before any VCL data
    this.sendVideoFrame(Buffer.from(au), isKeyframe, ts);
    if (!this.firstFrameSent) {
      this.firstFrameSent = true;
      this.startHeartbeat();
    }
  }

  /** anchor + elapsed + bias, clamped monotonic. */
  private frameTimestamp(): bigint {
    let ts = this.clock.now(VIDEO_BIAS_MS) ?? 0n;
    if (ts <= this.lastTimestamp) ts = this.lastTimestamp + 1n;
    this.lastTimestamp = ts;
    return ts;
  }

  private sendCodecFrame(payload: Buffer, ts: bigint): void {
    this.frameSeq++;
    const header = Buffer.alloc(128);
    header.writeUInt32LE(payload.length, 0);
    header[4] = 0x01; // codec config
    header[5] = 0x00;
    header[6] = 0x16; // H.264 avcC generic format
    header[7] = 0x01;
    u64le(ts).copy(header, 8);
    putFloat32LE(header, 16, this.videoWidth);
    putFloat32LE(header, 20, this.videoHeight);
    putFloat32LE(header, 40, this.videoWidth);
    putFloat32LE(header, 44, this.videoHeight);
    putFloat32LE(header, 56, this.videoWidth);
    putFloat32LE(header, 60, this.videoHeight);
    this.write(Buffer.concat([header, payload]));
    log.debug(this.scope, `codec frame sent (${payload.length} bytes, ${this.videoWidth}x${this.videoHeight})`);
  }

  private sendVideoFrame(au: Buffer, isKeyframe: boolean, ts: bigint): void {
    this.frameSeq++;
    const header = Buffer.alloc(128);
    // The size field includes the 16-byte Poly1305 tag, and the whole header is the AAD, so
    // it must be fully populated BEFORE encryption.
    const payloadSize = this.chachaKey ? au.length + 16 : au.length;
    header.writeUInt32LE(payloadSize, 0);
    header[4] = 0x00; // encrypted video
    header[5] = isKeyframe ? 0x10 : 0x00;
    // header[6:8] = 0x00 0x00 for encrypted packets
    u64le(ts).copy(header, 8);
    u64le(this.clock.timelineID).copy(header, 40);
    let payload = au;
    if (this.chachaKey) {
      const nonce = Buffer.alloc(12); // [0,0,0,0] + LE64(counter)
      nonce.writeBigUInt64LE(this.chachaCounter, 4);
      this.chachaCounter++;
      payload = Buffer.from(aeadEncrypt(this.chachaKey, nonce, au, header));
    }
    this.write(Buffer.concat([header, payload]));
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.dataConn || this.closed) return;
      const header = Buffer.alloc(128);
      header[4] = 0x02;
      header[6] = 0x1e;
      this.write(header);
    }, 1000);
  }

  private startFeedback(): void {
    const tick = () => {
      if (this.closed) return;
      const t0 = Date.now();
      this.rtsp('POST', '/feedback')
        .then((r) => {
          if (r.code === 200) this.clock.reanchor(r.headers, t0);
        })
        .catch(() => undefined);
    };
    tick(); // immediate first feedback, as real senders do
    this.feedbackTimer = setInterval(tick, 2000);
  }

  private write(buf: Buffer): void {
    try {
      this.dataConn?.write(buf);
    } catch (err) {
      this.fail(`data write failed: ${(err as Error).message}`);
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    log.warn(this.scope, reason);
    this.emit('error', new Error(reason));
    this.close();
  }

  async stop(): Promise<void> {
    if (!this.closed) {
      await this.rtsp('TEARDOWN', this.audioURI).catch(() => undefined);
    }
    this.close();
  }

  close(): void {
    this.closed = true;
    if (this.feedbackTimer) clearInterval(this.feedbackTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.feedbackTimer = null;
    this.heartbeatTimer = null;
    this.dataConn?.destroy();
    this.dataConn = null;
    this.eventConn?.destroy();
    this.eventConn = null;
  }
}

function macFromRandom(): string {
  const b = randomBytes(6);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
}
