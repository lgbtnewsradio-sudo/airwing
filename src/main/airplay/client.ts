/**
 * AirPlay client: plays a URL (our live HLS stream or a media file) on an AirPlay
 * receiver. Supports:
 *  - AirPlay 2 (HAP transient pairing or stored credentials, encrypted control channel,
 *    SETUP/RECORD/play flow) - Apple TV, HomePod, Roku, Fire TV, Samsung/LG TVs
 *  - AirPlay 1 legacy /play - Reflector, older Apple TVs, third-party receivers
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import bplistCreate from 'bplist-creator';
import { parseBuffer as parseBplist } from 'bplist-parser';
import { AirPlayConnection, type AirPlayResponse, AirPlayError } from './connection';
import {
  HapPairSetup,
  pairVerify,
  transientPairVerify,
  deriveKeys,
  parseCredentials,
  serializeCredentials,
  EVENTS_SALT,
  EVENTS_READ,
  EVENTS_WRITE,
  type SessionKeys,
} from './hap';
import { HapFramer, randomId } from './crypto';
import { TimingServer } from './timing';
import { parseFeatures } from '../discovery';
import { log } from '../logger';

const BPLIST = 'application/x-apple-binary-plist';

export interface AirPlayClientOptions {
  host: string;
  port: number;
  name: string;
  txt?: Record<string, string>;
  /** Stored credentials (serialized) if the receiver was paired before. */
  credentials?: string;
  /** Called when pairing produced new credentials that should be persisted. */
  onCredentials?: (serialized: string) => void;
  /** Force protocol generation instead of auto-detecting from features. */
  forceVersion?: 1 | 2;
  senderName?: string;
}

export interface PlaybackInfo {
  duration?: number;
  position?: number;
  rate?: number;
  readyToPlay?: boolean;
  playbackBufferEmpty?: boolean;
  error?: { code?: number; domain?: string };
  raw?: Record<string, unknown>;
}

export interface PlayOptions {
  position?: number;
  volume?: number;
  /** Whether to keep polling /playback-info and emit 'playback' events. */
  monitor?: boolean;
}

function toPlist(obj: Record<string, unknown>): Buffer {
  return bplistCreate(obj as any);
}

function fromPlist(body: Buffer): Record<string, any> | null {
  if (!body.length) return null;
  try {
    const parsed = parseBplist(body);
    return (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, any>;
  } catch {
    return null;
  }
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

export class AirPlayClient extends EventEmitter {
  private conn: AirPlayConnection | null = null;
  private keys: SessionKeys | null = null;
  private timing = new TimingServer();
  private eventSocket: net.Socket | null = null;
  private feedbackTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private cseq = 0;
  private readonly sessionId = randomBytes(4).readUInt32BE(0);
  private readonly dacpId = randomBytes(8).toString('hex').toUpperCase();
  private readonly activeRemote = randomBytes(4).readUInt32BE(0);
  private readonly playUuid = randomId();
  private readonly httpSessionId = randomId();
  private pairSetup: HapPairSetup | null = null;
  version: 1 | 2 = 2;
  info: Record<string, any> | null = null;
  playing = false;
  /** Use the plain /play video flow (no SETUP/RECORD/timing). */
  videoPlayback = false;

  constructor(readonly opts: AirPlayClientOptions) {
    super();
    const features = parseFeatures(opts.txt?.features ?? opts.txt?.ft);
    const v2 = (features & ((1n << 48n) | (1n << 46n) | (1n << 43n) | (1n << 49n))) !== 0n;
    this.version = opts.forceVersion ?? (v2 ? 2 : 1);
  }

  get supportsTransient(): boolean {
    const features = parseFeatures(this.opts.txt?.features ?? this.opts.txt?.ft);
    return (features & ((1n << 43n) | (1n << 48n))) !== 0n;
  }

  get hasCredentials(): boolean {
    return !!this.opts.credentials;
  }

  /** The (encrypted, once authenticated) control connection, for the mirroring transport. */
  get connection(): AirPlayConnection | null {
    return this.conn;
  }

  /** Pair-verify session keys (incl. the X25519 `shared` secret) for the mirroring transport. */
  get sessionKeys(): SessionKeys | null {
    return this.keys;
  }

  private get scope(): string {
    return `airplay:${this.opts.name}`;
  }

  async connect(): Promise<void> {
    if (this.conn?.isOpen) return;
    const conn = new AirPlayConnection(this.opts.host, this.opts.port, this.scope);
    await conn.connect();
    conn.on('close', () => {
      this.playing = false;
      this.emit('close');
    });
    this.conn = conn;
    try {
      const resp = await conn.get('/info', { headers: { 'User-Agent': 'AirPlay/377.40', 'Content-Type': BPLIST }, allowError: true, timeoutMs: 5000 });
      if (resp.code === 200) {
        this.info = fromPlist(resp.body);
        const feat = this.info?.features;
        if (typeof feat === 'bigint' || typeof feat === 'number') {
          const f = BigInt(feat);
          if (!this.opts.forceVersion) this.version = (f & ((1n << 48n) | (1n << 46n) | (1n << 43n) | (1n << 49n))) !== 0n ? 2 : 1;
        }
      }
    } catch (err) {
      log.debug(this.scope, `/info failed: ${(err as Error).message}`);
    }
  }

  /**
   * Establish an authenticated (and, for AirPlay 2, encrypted) control session.
   * Throws PairingRequiredError when the receiver needs an on-screen PIN first.
   */
  async authenticate(): Promise<void> {
    if (!this.conn) await this.connect();
    const conn = this.conn!;
    if (this.version === 1) return;
    if (this.keys) return;
    if (this.opts.credentials) {
      try {
        this.keys = await pairVerify(conn, parseCredentials(this.opts.credentials));
        log.info(this.scope, 'pair-verify succeeded with stored credentials');
      } catch (err) {
        log.warn(this.scope, `pair-verify failed: ${(err as Error).message}`);
        if (!this.supportsTransient) throw new PairingRequiredError(`Stored pairing rejected by ${this.opts.name}; re-pair required`);
      }
    }
    if (!this.keys) {
      if (!this.supportsTransient) throw new PairingRequiredError(`${this.opts.name} requires pairing with the on-screen code`);
      try {
        this.keys = await transientPairVerify(conn);
        log.info(this.scope, 'transient pairing succeeded');
      } catch (err) {
        const msg = (err as Error).message;
        if (err instanceof AirPlayError && (err.code === 470 || err.code === 403 || err.code === 401)) {
          throw new PairingRequiredError(`${this.opts.name} requires pairing with the on-screen code`);
        }
        if (/authentication|back off|max/i.test(msg)) throw new PairingRequiredError(`${this.opts.name} requires pairing with the on-screen code (${msg})`);
        throw err;
      }
    }
    conn.enableEncryption(this.keys.outKey, this.keys.inKey);
  }

  /** Start PIN pairing: the receiver shows a code on screen. */
  async startPairing(): Promise<void> {
    if (!this.conn) await this.connect();
    this.pairSetup = new HapPairSetup(this.conn!);
    await this.pairSetup.start();
  }

  /** Finish PIN pairing with the code shown on the receiver; stores credentials. */
  async finishPairing(pin: string): Promise<string> {
    if (!this.pairSetup) throw new Error('pairing not started');
    const creds = await this.pairSetup.finish(pin, this.opts.senderName ?? 'AirWing');
    const serialized = serializeCredentials(creds);
    this.opts.credentials = serialized;
    this.opts.onCredentials?.(serialized);
    this.pairSetup = null;
    // Pairing happens on a fresh connection; drop this one so verify starts clean.
    this.conn?.close();
    this.conn = null;
    this.keys = null;
    return serialized;
  }

  private rtspHeaders(extra: Record<string, string | number> = {}): Record<string, string | number> {
    return {
      CSeq: this.cseq++,
      'DACP-ID': this.dacpId,
      'Active-Remote': this.activeRemote,
      'Client-Instance': this.dacpId,
      'User-Agent': 'AirPlay/550.10',
      ...extra,
    };
  }

  private get rtspUri(): string {
    return `rtsp://${this.conn?.localAddress || '127.0.0.1'}/${this.sessionId}`;
  }

  private async rtsp(method: string, uri: string | null, body?: Record<string, unknown>, allowError = false): Promise<AirPlayResponse> {
    const headers = this.rtspHeaders(body ? { 'Content-Type': BPLIST } : {});
    return this.conn!.request(method, uri ?? this.rtspUri, {
      protocol: 'RTSP/1.0',
      headers,
      body: body ? toPlist(body) : undefined,
      allowError,
    });
  }

  private async setupV2(): Promise<void> {
    const conn = this.conn!;
    await this.timing.start(conn.localAddress || '0.0.0.0');
    const setupResp = await this.rtsp('SETUP', null, {
      deviceID: 'AA:BB:CC:DD:EE:FF',
      sessionUUID: randomId().toUpperCase(),
      timingPort: this.timing.port,
      timingProtocol: 'NTP',
      isMultiSelectAirPlay: true,
      groupContainsGroupLeader: false,
      macAddress: 'AA:BB:CC:DD:EE:FF',
      model: 'iPhone14,3',
      name: this.opts.senderName ?? 'AirWing',
      osBuildVersion: '20F66',
      osName: 'iPhone OS',
      osVersion: '16.5',
      senderSupportsRelay: false,
      sourceVersion: '690.7.1',
      statsCollectionEnabled: false,
    });
    const setup = fromPlist(setupResp.body) ?? {};
    const eventPort = toNumber(setup.eventPort) ?? 0;
    log.debug(this.scope, `SETUP ok, eventPort=${eventPort}`);
    if (eventPort > 0 && this.keys) {
      await this.connectEventChannel(eventPort);
    }
    this.startFeedback();
  }

  private async connectEventChannel(port: number): Promise<void> {
    const keys = deriveKeys(this.keys!.shared, EVENTS_SALT, EVENTS_READ, EVENTS_WRITE);
    const framer = new HapFramer(keys.outKey, keys.inKey);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const sock = net.createConnection({ host: this.opts.host, port }, () => resolve());
          sock.on('error', (err) => {
            if (!this.eventSocket) reject(err);
          });
          let eventRx = Buffer.alloc(0);
          sock.on('data', (data) => {
            try {
              const plain = framer.decrypt(data);
              if (!plain.length) return;
              eventRx = Buffer.concat([eventRx, plain]);
              // The receiver may batch several requests in one packet; answer each one
              // (pyatv-style 200 OK with Audio-Latency) so the session stays alive.
              for (;;) {
                const headEnd = eventRx.indexOf('\r\n\r\n');
                if (headEnd < 0) break;
                const headText = eventRx.subarray(0, headEnd).toString('utf8');
                const contentLength = parseInt(/content-length:\s*(\d+)/i.exec(headText)?.[1] ?? '0', 10) || 0;
                const total = headEnd + 4 + contentLength;
                if (eventRx.length < total) break;
                const body = eventRx.subarray(headEnd + 4, total);
                eventRx = eventRx.subarray(total);
                this.logEvent(headText, body);
                const m = /^(\w+) \S+ (HTTP|RTSP)\/([0-9.]+)/.exec(headText);
                if (m) {
                  const cseq = /CSeq:\s*(\d+)/i.exec(headText)?.[1];
                  const server = /Server:\s*(.+)/i.exec(headText)?.[1];
                  const reply = `${m[2]}/${m[3]} 200 OK\r\n${cseq ? `CSeq: ${cseq}\r\n` : ''}${server ? `Server: ${server}\r\n` : ''}Audio-Latency: 0\r\nContent-Length: 0\r\n\r\n`;
                  sock.write(framer.encrypt(Buffer.from(reply)));
                }
              }
            } catch (err) {
              log.debug(this.scope, `event channel decrypt error: ${(err as Error).message}`);
            }
          });
          sock.on('close', () => {
            if (this.eventSocket === sock) this.eventSocket = null;
          });
          this.eventSocket = sock;
        });
        return;
      } catch (err) {
        log.debug(this.scope, `event channel connect failed (${attempt + 1}/5): ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  }

  private logEvent(headText: string, body: Buffer): void {
    try {
      const parsed = body.length ? fromPlist(body) : null;
      const json = parsed ? JSON.stringify(parsed, (_k, v) => (typeof v === 'bigint' ? Number(v) : Buffer.isBuffer(v) ? `<${v.length}B>` : v)).slice(0, 600) : '';
      log.debug(this.scope, `event: ${headText.split('\r\n').join(' | ')}${json ? ` body=${json}` : body.length ? ` body=${body.length}B` : ''}`);
    } catch (err) {
      log.debug(this.scope, `event parse failed: ${(err as Error).message}`);
    }
  }

  private startFeedback(): void {
    this.stopFeedback();
    this.feedbackTimer = setInterval(() => {
      if (!this.conn?.isOpen) return;
      this.rtsp('POST', '/feedback', undefined, true).catch((err) => log.debug(this.scope, `feedback failed: ${err.message}`));
    }, 2000);
  }

  private stopFeedback(): void {
    if (this.feedbackTimer) clearInterval(this.feedbackTimer);
    this.feedbackTimer = null;
  }

  /** Play a URL on the receiver. Resolves once the receiver accepted the request. */
  async play(url: string, opts: PlayOptions = {}): Promise<void> {
    await this.authenticate();
    const conn = this.conn!;
    const position = opts.position ?? 0;
    let resp: AirPlayResponse;
    // Video URL playback uses the /play endpoint directly. SETUP/RECORD belong to the
    // realtime audio (RAOP) path; sending RECORD here makes Apple TV drop the connection.
    if (this.version === 2 && !this.videoPlayback) {
      await this.setupV2();
      await this.rtsp('RECORD', null, undefined, true);
      resp = await conn.post('/play', {
        headers: {
          'User-Agent': 'AirPlay/550.10',
          'Content-Type': BPLIST,
          'X-Apple-ProtocolVersion': '1',
          'X-Apple-Session-ID': this.httpSessionId,
          'X-Apple-Stream-ID': '1',
        },
        body: toPlist({
          'Content-Location': url,
          'Start-Position-Seconds': new bplistCreate.Real(position),
          uuid: this.playUuid,
          streamType: 1,
          mediaType: 'file',
          mightSupportStorePastisKeyRequests: true,
          playbackRestrictions: 0,
          secureConnectionMs: 22,
          volume: new bplistCreate.Real(opts.volume ?? 1.0),
          infoMs: 122,
          connectMs: 18,
          authMs: 0,
          bonjourMs: 0,
          referenceRestrictions: 3,
          SenderMACAddress: 'AA:BB:CC:DD:EE:FF',
          model: 'iPhone14,3',
          postAuthMs: 0,
          clientBundleID: 'dev.airwing.app',
          clientProcName: 'AirWing',
          osBuildVersion: '20G1116',
          rate: new bplistCreate.Real(1.0),
        }),
        allowError: true,
        timeoutMs: 15000,
      });
      if (resp.code < 400) {
        await this.rtsp('PUT', '/setProperty?isInterestedInDateRange', { value: true }, true);
        await this.rtsp('PUT', '/setProperty?actionAtItemEnd', { value: 0 }, true);
        await this.rtsp('POST', '/rate?value=1.000000', undefined, true);
        const zeroTime = { flags: 0, value: 0, epoch: 0, timescale: 0 };
        await this.rtsp('PUT', '/setProperty?forwardEndTime', { value: zeroTime }, true);
        await this.rtsp('PUT', '/setProperty?reverseEndTime', { value: zeroTime }, true);
      }
    } else {
      resp = await conn.post('/play', {
        headers: {
          'User-Agent': 'MediaControl/1.0',
          'Content-Type': BPLIST,
          'X-Apple-Session-ID': this.httpSessionId,
        },
        body: toPlist({
          'Content-Location': url,
          'Start-Position': new bplistCreate.Real(position),
          'X-Apple-Session-ID': this.httpSessionId,
        }),
        allowError: true,
        timeoutMs: 15000,
      });
    }
    if (resp.code >= 400) {
      if (resp.code === 470 || resp.code === 401 || resp.code === 403) {
        throw new PairingRequiredError(`${this.opts.name} refused playback (${resp.code}); pairing required`);
      }
      throw new AirPlayError(`play failed: ${resp.code} ${resp.message}`, resp.code, resp);
    }
    this.playing = true;
    if (opts.monitor !== false) this.startMonitor();
  }

  private startMonitor(): void {
    this.stopMonitor();
    let emptyPolls = 0;
    this.monitorTimer = setInterval(async () => {
      if (!this.conn?.isOpen) return;
      try {
        const info = await this.playbackInfo();
        this.emit('playback', info);
        if (info.error) {
          this.emit('error', new Error(`receiver playback error ${info.error.code ?? ''} ${info.error.domain ?? ''}`.trim()));
          return;
        }
        if (info.duration === undefined && info.position === undefined) {
          emptyPolls++;
          if (emptyPolls > 8 && this.playing) {
            this.playing = false;
            this.emit('ended');
          }
        } else emptyPolls = 0;
      } catch (err) {
        log.debug(this.scope, `playback-info failed: ${(err as Error).message}`);
      }
    }, 1500);
  }

  private stopMonitor(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  async playbackInfo(): Promise<PlaybackInfo> {
    const resp = await this.conn!.get('/playback-info', {
      headers: { 'User-Agent': 'AirPlay/550.10', 'X-Apple-Session-ID': this.httpSessionId },
      allowError: true,
      timeoutMs: 5000,
    });
    const raw = fromPlist(resp.body) ?? {};
    return {
      duration: toNumber(raw.duration),
      position: toNumber(raw.position),
      rate: toNumber(raw.rate),
      readyToPlay: raw.readyToPlay === true,
      playbackBufferEmpty: raw.playbackBufferEmpty === true,
      error: raw.error ? { code: toNumber(raw.error.code), domain: raw.error.domain } : undefined,
      raw,
    };
  }

  async setRate(rate: number): Promise<void> {
    if (!this.conn?.isOpen) return;
    if (this.version === 2) await this.rtsp('POST', `/rate?value=${rate.toFixed(6)}`, undefined, true);
    else await this.conn.post(`/rate?value=${rate.toFixed(6)}`, { headers: { 'User-Agent': 'MediaControl/1.0', 'X-Apple-Session-ID': this.httpSessionId }, allowError: true });
  }

  async scrub(position: number): Promise<void> {
    if (!this.conn?.isOpen) return;
    if (this.version === 2) await this.rtsp('POST', `/scrub?position=${position.toFixed(3)}`, undefined, true);
    else await this.conn.post(`/scrub?position=${position.toFixed(3)}`, { headers: { 'User-Agent': 'MediaControl/1.0', 'X-Apple-Session-ID': this.httpSessionId }, allowError: true });
  }

  /** Volume 0..1 */
  async setVolume(volume: number): Promise<void> {
    if (!this.conn?.isOpen) return;
    const clamped = Math.max(0, Math.min(1, volume));
    const db = clamped <= 0 ? -144 : -30 + clamped * 30;
    if (this.version === 2) {
      await this.conn.request('SET_PARAMETER', this.rtspUri, {
        protocol: 'RTSP/1.0',
        headers: this.rtspHeaders({ 'Content-Type': 'text/parameters' }),
        body: `volume: ${db.toFixed(6)}\r\n`,
        allowError: true,
      });
    } else {
      await this.conn.request('PUT', '/setProperty?volume', {
        headers: { 'User-Agent': 'MediaControl/1.0', 'Content-Type': BPLIST },
        body: toPlist({ value: new bplistCreate.Real(clamped) }),
        allowError: true,
      });
    }
  }

  async stop(): Promise<void> {
    this.stopMonitor();
    this.stopFeedback();
    const conn = this.conn;
    if (conn?.isOpen) {
      try {
        await conn.post('/stop', { headers: { 'User-Agent': 'MediaControl/1.0', 'X-Apple-Session-ID': this.httpSessionId }, allowError: true, timeoutMs: 3000 });
        if (this.version === 2) await this.rtsp('TEARDOWN', null, undefined, true).catch(() => undefined);
      } catch (err) {
        log.debug(this.scope, `stop failed: ${(err as Error).message}`);
      }
    }
    this.playing = false;
    this.close();
  }

  close(): void {
    this.stopMonitor();
    this.stopFeedback();
    this.timing.close();
    this.eventSocket?.destroy();
    this.eventSocket = null;
    this.conn?.close();
    this.conn = null;
    this.keys = null;
  }
}

export class PairingRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingRequiredError';
  }
}
