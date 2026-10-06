/**
 * SessionManager: one Session per connected receiver. Every session is fed from the
 * same StreamHub (screen mirror / audio / transcoded media) or plays a registered
 * media file directly. Supports many simultaneous receivers.
 */

import { EventEmitter } from 'node:events';
import type { CastEncoderInfo, Device, MediaControlAction, SessionInfo, SessionState } from '@shared/types';
import { AirPlayClient, PairingRequiredError } from './airplay/client';
import { MirrorClient } from './airplay/mirror';
import { CastClient } from './cast/castClient';
import type { MirroringSender } from './cast/mirroring';
import { AdaptiveCastBitrate } from './cast/adaptiveBitrate';
import type { StreamHub } from './streamHub';
import type { LocalServer, RegisteredMedia } from './server';
import type { CredentialStore } from './settings';
import { deviceKey } from './discovery';
import { unsupportedReason, needsFairPlay } from '@shared/support';
import { addressReaching } from './net';
import { log } from './logger';

export type SessionTarget = { type: 'live' } | { type: 'file'; path: string };

interface Session {
  info: SessionInfo;
  target: SessionTarget;
  airplay?: AirPlayClient;
  mirror?: MirrorClient;
  cast?: CastClient;
  castMirror?: MirroringSender;
  media?: RegisteredMedia;
  stopping?: boolean;
  /** Set when the receiver accepted the stream but never fetched it from this PC. */
  unreachable?: string;
  reachTimer?: NodeJS.Timeout;
}

/**
 * A receiver that accepts a stream and then never requests a single byte from us cannot
 * reach this PC. That is almost always Windows Firewall blocking inbound connections for the
 * network type in use, not a codec or receiver fault — so say so instead of hanging.
 */
function unreachableMessage(name: string, port: number): string {
  return (
    `${name} accepted the stream but never fetched it from this PC, so it cannot reach AirWing on port ${port}. ` +
    'This is usually Windows Firewall blocking incoming connections: allow AirWing for Private networks ' +
    '(Windows Security → Firewall & network protection → Allow an app through firewall → tick Private for AirWing). ' +
    'AirPlay mirroring is unaffected because those connections go outward.'
  );
}

/** How long to wait for a receiver to fetch the stream before calling it unreachable. */
const REACH_TIMEOUT_MS = 12000;

interface CastMirrorProbeSample {
  data: Uint8Array;
  keyframe: boolean;
  timestampUs: number;
  width: number;
  height: number;
}


export interface SessionManagerOptions {
  hub: StreamHub;
  server: LocalServer;
  credentials: CredentialStore;
  senderName: () => string;
  /** How long after LOAD a receiver has to request the stream before it is called unreachable. */
  reachTimeoutMs?: number;
  /** Ask the renderer's Cast Streaming (VP8) tap for a fresh keyframe right now. */
  requestCastMirrorKeyframe?: () => void;
  adaptiveCastEnabled?: () => boolean;
  requestCastBitrate?: (bitrate: number) => void;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private pairingClients = new Map<string, AirPlayClient>();
  /** Active mirror sessions fed from the renderer's raw-H.264 tap. */
  private mirrorClients = new Map<string, MirrorClient>();
  /** Active low-latency Cast Streaming sessions fed from the renderer's VP8 tap. */
  private castMirrorClients = new Map<string, MirroringSender>();
  private castMirrorProbing = false;
  private castMirrorTapActive = false;
  private castMirrorProbe: { resolve: (sample: CastMirrorProbeSample | null) => void } | null = null;
  private castEncoder: CastEncoderInfo | null = null;
  private readonly castBitrates = new Map<string, number>();

  constructor(private readonly opts: SessionManagerOptions) {
    super();
    opts.hub.on('end', () => {
      for (const s of this.sessions.values()) {
        if (s.target.type === 'live') void this.disconnect(s.info.device.id, 'stream ended');
      }
    });
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }));
  }

  get(deviceId: string): SessionInfo | undefined {
    return this.sessions.get(deviceId)?.info;
  }

  /**
   * Receivers actually being streamed to. Failed sessions stay in the list so the user can
   * see why, but they must not count as watchers: that inflated the tray label and made
   * the capture auto-restart on behalf of a receiver that never connected.
   */
  get count(): number {
    return [...this.sessions.values()].filter((s) => s.info.state !== 'error' && s.info.state !== 'stopped').length;
  }

  private update(session: Session, patch: Partial<SessionInfo>): void {
    Object.assign(session.info, patch);
    this.emit('change', this.list());
  }

  private setState(session: Session, state: SessionState, error?: string): void {
    this.update(session, { state, error });
    if (error) log.warn('session', `${session.info.device.name}: ${error}`);
  }

  private credentialKey(device: Device): string {
    return deviceKey(device.kind, device.txt, device.host);
  }

  async connect(device: Device, target: SessionTarget): Promise<SessionInfo> {
    const existing = this.sessions.get(device.id);
    if (existing) await this.disconnect(device.id, 'reconnecting');
    const session: Session = {
      target,
      info: {
        id: device.id,
        device,
        state: 'connecting',
        startedAt: Date.now(),
        transport: device.kind === 'cast' ? 'cast-hls' : 'airplay-hls',
      },
    };
    this.sessions.set(device.id, session);
    this.emit('change', this.list());
    try {
      // Modern Apple TVs (FairPlay-gated) can be driven through the real-time mirroring
      // transport when it is enabled; otherwise refuse up front rather than after a 12 s
      // spinner on the TV, since the /play path will never load for them.
      if (target.type === 'live' && needsFairPlay(device)) {
        session.info.transport = 'airplay2-mirror';
        if (!(await this.opts.hub.waitForActive())) throw new Error('the capture did not start; check the Logs tab');
        // The mirror pushes video the instant its data channel opens; wait for the encoder to
        // actually be producing video first, or the receiver closes the idle channel (~30s)
        // and we only recover on a reconnect. Audio-only sources skip this.
        if (this.opts.hub.meta?.audioOnly === false || !this.opts.hub.meta) {
          await this.opts.hub.waitForVideo();
        }
        await this.connectMirror(session);
        this.setState(session, 'streaming');
        log.info('session', `${device.name}: mirroring via experimental FairPlay transport`);
        return { ...session.info };
      }
      const unsupported = unsupportedReason(device);
      if (unsupported) throw new Error(unsupported);
      const host = addressReaching(device.host);
      let url: string;
      let mime = 'application/vnd.apple.mpegurl';
      if (target.type === 'file') {
        session.media = this.opts.server.registerMedia(target.path);
        url = this.opts.server.mediaUrl(host, session.media);
        mime = session.media.mime;
        session.info.transport = device.kind === 'cast' ? 'cast-file' : 'airplay-file';
      } else {
        // The encoder may still be starting up when the receiver is picked.
        if (!(await this.opts.hub.waitForActive())) throw new Error('the capture did not start; check the Logs tab');
        const ready = await this.opts.hub.waitForHls();
        if (!ready) throw new Error('stream did not produce segments in time');
        url = this.opts.server.hlsUrl(host);
      }
      if (device.kind === 'cast') await this.connectCast(session, url, mime);
      else if (device.kind === 'airplay' || device.kind === 'raop') await this.connectAirPlay(session, url);
      else throw new Error(`unsupported receiver type ${device.kind}`);
      this.setState(session, 'streaming');
      log.info('session', `${device.name}: streaming ${url}`);
    } catch (err) {
      if (err instanceof PairingRequiredError) {
        this.setState(session, 'pairing', err.message);
        this.emit('pairing-required', { deviceId: device.id, deviceName: device.name, message: err.message });
      } else {
        this.setState(session, 'error', (err as Error).message);
        this.cleanup(session);
      }
    }
    return { ...session.info };
  }

  private async connectCast(session: Session, url: string, mime: string): Promise<void> {
    const device = session.info.device;
    const client = new CastClient({ host: device.host, port: device.port, name: device.name });
    session.cast = client;
    client.on('status', (status) => {
      this.update(session, {
        position: status.currentTime,
        duration: status.duration,
        playing: status.playerState === 'PLAYING',
        volume: status.volume,
      });
    });
    client.on('idle', (reason: string) => {
      if (session.stopping) return;
      if (reason === 'FINISHED') void this.disconnect(device.id, 'finished');
      else if (reason === 'ERROR') this.setState(session, 'error', session.unreachable ?? 'receiver reported a playback error');
      else void this.disconnect(device.id, `receiver idle (${reason})`);
    });
    client.on('close', () => {
      if (!session.stopping && this.sessions.get(device.id) === session) this.setState(session, 'error', 'connection closed by receiver');
    });
    // The receiver app closed (someone cast something else from their phone, or the TV
    // switched input). Without this the session stayed listed as streaming forever and a
    // status poll kept ticking against a receiver that had moved on.
    client.on('ended', () => {
      if (!session.stopping && this.sessions.get(device.id) === session) void this.disconnect(device.id, 'receiver ended the session');
    });
    client.on('error', (err: Error) => {
      if (!session.stopping) this.setState(session, 'error', err.message);
    });
    const live = session.target.type === 'live';
    if (live) {
      // Chrome/Edge's own tab-casting reaches Chromecast/Google TV with well under a second
      // of lag because it never touches HLS at all — it speaks Google's real-time "Cast
      // Streaming" protocol (the "Chrome Mirroring" receiver app, 0F5096E8) directly. Try
      // that path first; only fall back to the HLS/Default-Media-Receiver flow below if the
      // receiver or this Chromium build cannot do it.
      if (await this.tryConnectCastMirroring(session, client)) {
        session.info.transport = 'cast-mirroring';
        return;
      }
      log.info('session', `${device.name}: low-latency Cast mirroring unavailable, falling back to HLS`);
    }
    // Launch (or join) the receiver app before starting the reachability clock. On a Sony
    // Bravia the launch alone took ~19 s; a clock started before it declared a perfectly
    // reachable TV unreachable and tore down a session that was already fetching segments.
    await client.prepare();
    // Arm the watchdog as the LOAD command goes out. It runs alongside load() rather than
    // after it, because when a receiver genuinely cannot reach us load() blocks for ~40 s.
    const baseline = this.opts.server.hlsFetchCount(device.host);
    const reached = () => this.opts.server.hlsFetchCount(device.host) > baseline;
    const reachTimeoutMs = this.opts.reachTimeoutMs ?? REACH_TIMEOUT_MS;
    session.reachTimer = setTimeout(() => {
      if (session.stopping || this.sessions.get(device.id) !== session || reached()) return;
      session.unreachable = unreachableMessage(device.name, this.opts.server.port);
      log.warn('session', `${device.name}: no stream request ${reachTimeoutMs / 1000}s after LOAD — receiver cannot reach this PC`);
      this.setState(session, 'error', session.unreachable);
    }, reachTimeoutMs);
    await client.load({
      url,
      contentType: live ? 'application/x-mpegURL' : mime,
      streamType: live ? 'LIVE' : 'BUFFERED',
      title: live ? `${this.opts.senderName()} screen` : session.media?.name,
      subtitle: 'AirWing',
      hlsSegmentFormat: live ? 'fmp4' : undefined,
    });
    if (live) {
      // Correct for the receiver's own buffering drift instead of only setting the initial
      // playlist cushion; see enableLiveCatchUp for why a static offset alone is not enough.
      const target = Number(process.env.AIRWING_CAST_CATCHUP_TARGET ?? 2);
      const max = Number(process.env.AIRWING_CAST_CATCHUP_MAX ?? target + 1.5);
      client.enableLiveCatchUp(target, max);
    }
    // Decide on evidence, not on a flag that may be stale: a receiver whose first request
    // arrived after the watchdog fired is a working session, not an unreachable one.
    if (reached()) {
      session.unreachable = undefined;
    } else if (session.unreachable) {
      throw new Error(session.unreachable);
    }
  }

  /**
   * Attempt the low-latency Cast Streaming transport for a live cast: probe whether this
   * Chromium build can encode VP8 at all, then OFFER/ANSWER against the Chrome Mirroring
   * receiver app. Returns false (never throws) on any failure so the caller falls back to
   * the proven HLS path — this is a strict upgrade attempt, not a required one.
   */
  private async tryConnectCastMirroring(session: Session, client: CastClient): Promise<boolean> {
    const device = session.info.device;
    try {
      if (!(await this.opts.hub.waitForActive())) return false;
      await this.opts.hub.waitForVideo();
      const probe = await this.probeCastMirrorSupport();
      if (!probe) {
        log.info('session', `${device.name}: VP8 encoding is not available in this build`);
        return false;
      }
      const meta = this.opts.hub.meta;
      const sender = await client.startMirroring({
        width: probe.width,
        height: probe.height,
        frameRateHint: this.castEncoder?.fps ?? Math.min(30, meta?.encoder?.frameRate || 30),
        maxBitrate: this.castEncoder?.bitrate ?? 3_000_000,
        audio: this.castEncoder?.audio,
      });
      session.castMirror = sender;
      const ceiling = this.castEncoder?.bitrate ?? 3_000_000;
      const adaptive = new AdaptiveCastBitrate(ceiling);
      let lastReceiverReportAt = -Infinity;
      const adjust = (pressure: number) => {
        if (this.opts.adaptiveCastEnabled?.() === false || session.stopping) return;
        const bitrate = adaptive.sample(pressure, performance.now());
        if (bitrate !== null) {
          this.castBitrates.set(device.id, bitrate);
          this.opts.requestCastBitrate?.(Math.min(...this.castBitrates.values()));
        }
      };
      this.castBitrates.set(device.id, ceiling);
      session.info.health = { width: probe.width, height: probe.height, fps: 0, bitrate: ceiling,
        audio: sender.audioAccepted ? 'opus' : this.castEncoder?.audioRequested ? 'unavailable' : 'off', status: 'starting' };
      sender.on('health', (sample) => {
        if (session.stopping || !session.info.health) return;
        this.update(session, { health: { ...session.info.health, ...sample,
          status: sample.queueAgeMs > 100 || (session.info.health.lossPercent ?? 0) >= 3 ? 'recovering' : 'healthy' } });
      });
      sender.on('feedback', (feedback: { loss: number; jitterMs: number; rttMs: number | null }) => {
        if (session.stopping || !session.info.health) return;
        lastReceiverReportAt = performance.now();
        this.update(session, { health: { ...session.info.health, lossPercent: feedback.loss * 100,
          jitterMs: feedback.jitterMs, rttMs: feedback.rttMs ?? undefined,
          status: feedback.loss >= 0.03 ? 'recovering' : 'healthy' } });
        adjust(feedback.loss);
      });
      sender.on('repair-window', ({ pressure }: { pressure: number }) => {
        if (session.stopping || !session.info.health) return;
        this.update(session, { health: { ...session.info.health, repairPercent: pressure * 100,
          status: pressure >= 0.03 ? 'recovering' : 'healthy' } });
        if (performance.now() - lastReceiverReportAt > 5000) adjust(pressure);
      });
      sender.on('error', (err: Error) => {
        if (session.stopping) return;
        this.unregisterCastMirror(device.id);
        this.setState(session, 'error', err.message);
        this.cleanup(session);
      });
      // A bounded sender queue intentionally abandons an undecodable delta chain rather than
      // letting it turn into latency. Ask WebCodecs for a clean recovery frame immediately.
      sender.on('keyframe-needed', () => this.opts.requestCastMirrorKeyframe?.());
      this.registerCastMirror(device.id, sender);
      // The probe frame predates the OFFER/ANSWER handshake and was never sent anywhere;
      // get a fresh keyframe now so the receiver has something to decode from the start.
      this.opts.requestCastMirrorKeyframe?.();
      log.info('session', `${device.name}: Cast Streaming (low-latency) session established`);
      return true;
    } catch (err) {
      log.warn('session', `${device.name}: Cast Streaming negotiation failed: ${(err as Error).message}`);
      return false;
    } finally {
      this.setCastMirrorProbing(false);
    }
  }

  /**
   * Turn the renderer's VP8 tap on just long enough to learn whether this Chromium build can
   * encode VP8, resolving with the first chunk it produces (which tells us the real encoded
   * resolution) or null if it can't / nothing arrives in time.
   */
  private probeCastMirrorSupport(timeoutMs = 4000): Promise<CastMirrorProbeSample | null> {
    this.setCastMirrorProbing(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.castMirrorProbe = null;
        resolve(null);
      }, timeoutMs);
      this.castMirrorProbe = {
        resolve: (sample) => {
          clearTimeout(timer);
          resolve(sample);
        },
      };
    });
  }

  /** Renderer reports it has no VP8 encoder at all; resolve any pending probe as a failure. */
  markCastMirrorUnavailable(): void {
    this.castMirrorProbe?.resolve(null);
    this.castMirrorProbe = null;
  }

  /** Fan a VP8 chunk out to active low-latency Cast sessions, or satisfy a pending probe. */
  pushCastMirrorFrame(chunk: Uint8Array, keyframe: boolean, timestampUs: number, width: number, height: number): void {
    if (this.castMirrorProbe) {
      const resolve = this.castMirrorProbe.resolve;
      this.castMirrorProbe = null;
      resolve({ data: chunk, keyframe, timestampUs, width, height });
      return;
    }
    for (const s of this.castMirrorClients.values()) s.sendVideoFrame(chunk, keyframe, timestampUs);
  }

  setCastEncoder(info: NonNullable<SessionManager['castEncoder']>): void {
    this.castEncoder = info;
    for (const session of this.sessions.values()) if (session.castMirror && session.info.health) {
      this.update(session, { health: { ...session.info.health, width: info.width, height: info.height, bitrate: info.bitrate,
        audio: session.castMirror.audioAccepted && info.audio ? 'opus' : info.audioRequested ? 'unavailable' : 'off' } });
    }
  }

  pushCastAudioFrame(data: Uint8Array, timestampUs: number): void {
    for (const sender of this.castMirrorClients.values()) sender.sendAudioFrame(data, timestampUs);
  }

  private setCastMirrorProbing(probing: boolean): void {
    this.castMirrorProbing = probing;
    this.syncCastMirrorTap();
  }

  private registerCastMirror(id: string, s: MirroringSender): void {
    this.castMirrorClients.set(id, s);
    this.syncCastMirrorTap();
  }

  private unregisterCastMirror(id: string): void {
    this.castMirrorClients.delete(id);
    this.castBitrates.delete(id);
    if (this.castBitrates.size && this.opts.adaptiveCastEnabled?.() !== false) this.opts.requestCastBitrate?.(Math.min(...this.castBitrates.values()));
    this.syncCastMirrorTap();
  }

  /** The renderer's VP8 tap should be on exactly while probing or while any session needs it. */
  private syncCastMirrorTap(): void {
    const shouldBeActive = this.castMirrorProbing || this.castMirrorClients.size > 0;
    if (shouldBeActive === this.castMirrorTapActive) return;
    this.castMirrorTapActive = shouldBeActive;
    if (!shouldBeActive) this.castEncoder = null;
    this.emit('castMirror-tap', shouldBeActive);
  }

  private async connectAirPlay(session: Session, url: string): Promise<void> {
    const device = session.info.device;
    const key = this.credentialKey(device);
    const client = new AirPlayClient({
      host: device.host,
      port: device.port,
      name: device.name,
      txt: device.txt,
      credentials: this.opts.credentials.get(key),
      onCredentials: (c) => this.opts.credentials.set(key, c),
      senderName: this.opts.senderName(),
    });
    session.airplay = client;
    // Video URL playback uses the plain /play flow; SETUP/RECORD is the audio path.
    client.videoPlayback = device.caps.video;
    let readyPolls = 0;
    client.on('playback', (info) => {
      this.update(session, { position: info.position, duration: info.duration, playing: (info.rate ?? 0) > 0 });
      if (info.duration === undefined && !info.readyToPlay) {
        // Some receivers (current tvOS) accept /play from a third-party sender but never
        // load it, because they require Apple's proprietary FairPlay handshake.
        if (++readyPolls === 8 && session.info.state === 'streaming') {
          this.setState(
            session,
            'error',
            `${device.name} accepted the stream but never started playing. This receiver appears to require Apple's FairPlay authentication, which AirWing cannot provide. Use the Browser tab to watch on this TV instead.`,
          );
        }
      } else readyPolls = 0;
    });
    client.on('ended', () => {
      if (!session.stopping) void this.disconnect(device.id, 'playback ended');
    });
    client.on('close', () => {
      if (!session.stopping && this.sessions.get(device.id) === session && session.info.state === 'streaming') {
        this.setState(session, 'error', 'connection closed by receiver');
      }
    });
    client.on('error', (err: Error) => {
      if (!session.stopping) this.setState(session, 'error', err.message);
    });
    await client.connect();
    session.info.transport = client.version === 2 ? session.info.transport.replace('airplay', 'airplay2') : session.info.transport;
    await client.play(url, { position: 0 });
  }

  /**
   * Connect a modern Apple TV via the real-time screen-mirroring transport (FairPlay). Reuses
   * AirPlayClient for connect + pair-verify (and PIN pairing when required), then hands its
   * encrypted connection to a MirrorClient. Frames arrive from the renderer's raw-H.264 tap.
   */
  private async connectMirror(session: Session): Promise<void> {
    const device = session.info.device;
    const key = this.credentialKey(device);
    const client = new AirPlayClient({
      host: device.host,
      port: device.port,
      name: device.name,
      txt: device.txt,
      credentials: this.opts.credentials.get(key),
      onCredentials: (c) => this.opts.credentials.set(key, c),
      senderName: this.opts.senderName(),
    });
    session.airplay = client;
    client.on('close', () => {
      if (!session.stopping && this.sessions.get(device.id) === session && session.info.state === 'streaming') {
        this.setState(session, 'error', 'connection closed by receiver');
        this.cleanup(session);
      }
    });
    await client.connect();
    await client.authenticate(); // pair-verify + channel encryption; throws PairingRequiredError
    const conn = client.connection;
    const keys = client.sessionKeys;
    if (!conn || !keys) throw new Error('pair-verify did not establish an encrypted session (is this an AirPlay 2 receiver?)');
    const mirror = new MirrorClient({
      host: device.host,
      port: device.port,
      name: device.name,
      senderName: this.opts.senderName(),
      conn,
      keys,
      info: client.info,
      audioEnabled: Boolean(this.opts.hub.meta?.encoder.audioCodec),
    });
    session.mirror = mirror;
    mirror.on('error', (err: Error) => {
      if (session.stopping) return;
      this.unregisterMirror(device.id);
      this.setState(session, 'error', err.message);
      this.cleanup(session);
    });
    await mirror.start();
    // Only start pulling frames once SETUP/RECORD succeeded, so the renderer tap turns on
    // exactly when there is a live receiver to consume it.
    this.registerMirror(device.id, mirror);
  }

  private registerMirror(id: string, m: MirrorClient): void {
    const wasEmpty = this.mirrorClients.size === 0;
    this.mirrorClients.set(id, m);
    if (wasEmpty) this.emit('mirror-tap', true);
  }

  private unregisterMirror(id: string): void {
    if (this.mirrorClients.delete(id) && this.mirrorClients.size === 0) this.emit('mirror-tap', false);
  }

  /** Fan a raw H.264 access unit (from the renderer tap) out to every active mirror session. */
  pushMirrorFrame(au: Uint8Array, keyframe: boolean, config?: Uint8Array): void {
    for (const m of this.mirrorClients.values()) {
      if (config) m.setCodecConfig(config);
      m.sendAccessUnit(au, keyframe);
    }
  }

  pushMirrorAudio(pcm: Uint8Array, capturedAtMs: number): void {
    for (const mirror of this.mirrorClients.values()) mirror.sendAudioFrame(pcm, capturedAtMs);
  }

  /** Begin PIN pairing with an AirPlay receiver (shows a code on its screen). */
  async startPairing(device: Device): Promise<void> {
    const key = this.credentialKey(device);
    const client = new AirPlayClient({
      host: device.host,
      port: device.port,
      name: device.name,
      txt: device.txt,
      onCredentials: (c) => this.opts.credentials.set(key, c),
      senderName: this.opts.senderName(),
    });
    this.pairingClients.get(device.id)?.close();
    this.pairingClients.set(device.id, client);
    await client.connect();
    await client.startPairing();
  }

  async finishPairing(device: Device, pin: string): Promise<void> {
    const client = this.pairingClients.get(device.id);
    if (!client) {
      // The previous attempt was consumed (rejected code or closed connection). Ask the
      // receiver for a fresh code so the caller can simply prompt again.
      await this.startPairing(device);
      throw new Error('the previous pairing code expired');
    }
    try {
      await client.finishPairing(pin);
      log.info('session', `${device.name}: paired successfully`);
    } catch (err) {
      log.warn('session', `${device.name}: pairing failed: ${(err as Error).message}`);
      throw err;
    } finally {
      client.close();
      this.pairingClients.delete(device.id);
    }
    const session = this.sessions.get(device.id);
    if (session && session.info.state === 'pairing') {
      const target = session.target;
      this.sessions.delete(device.id);
      await this.connect(device, target);
    }
  }

  cancelPairing(deviceId: string): void {
    this.pairingClients.get(deviceId)?.close();
    this.pairingClients.delete(deviceId);
    const session = this.sessions.get(deviceId);
    if (session && session.info.state === 'pairing') void this.disconnect(deviceId, 'pairing cancelled');
  }

  forgetCredentials(device: Device): void {
    this.opts.credentials.remove(this.credentialKey(device));
  }

  async mediaControl(deviceId: string, action: MediaControlAction): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (!session) throw new Error('no session for device');
    if (session.mirror) {
      if (action.type === 'volume') { session.info.volume = action.volume; return session.mirror.setVolume(action.volume); }
      if (action.type === 'mute') return session.mirror.setVolume(action.muted ? 0 : session.info.volume ?? 0.6);
      if (action.type === 'stop') return this.disconnect(deviceId, 'stopped');
      return;
    }
    if (session.cast) {
      const c = session.cast;
      switch (action.type) {
        case 'play': return c.play();
        case 'pause': return c.pause();
        case 'seek': return c.seek(action.position);
        case 'volume': return c.setVolume(action.volume);
        case 'mute': return c.setMuted(action.muted);
        case 'stop': return this.disconnect(deviceId, 'stopped');
      }
    }
    if (session.airplay) {
      const a = session.airplay;
      switch (action.type) {
        case 'play': return a.setRate(1);
        case 'pause': return a.setRate(0);
        case 'seek': return a.scrub(action.position);
        case 'volume': return a.setVolume(action.volume);
        case 'mute': return a.setVolume(action.muted ? 0 : session.info.volume ?? 1);
        case 'stop': return this.disconnect(deviceId, 'stopped');
      }
    }
  }

  async disconnect(deviceId: string, reason = 'disconnected'): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (!session) return;
    session.stopping = true;
    this.sessions.delete(deviceId);
    log.info('session', `${session.info.device.name}: ${reason}`);
    this.emit('change', this.list());
    await this.cleanupAsync(session);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id, 'stopped')));
  }

  private cleanup(session: Session): void {
    void this.cleanupAsync(session);
  }

  private async cleanupAsync(session: Session): Promise<void> {
    if (session.reachTimer) {
      clearTimeout(session.reachTimer);
      session.reachTimer = undefined;
    }
    try {
      if (session.mirror) {
        this.unregisterMirror(session.info.device.id);
        await session.mirror.stop();
      }
      if (session.castMirror) {
        this.unregisterCastMirror(session.info.device.id);
        session.castMirror.close();
      }
      if (session.cast) await session.cast.stop();
      if (session.airplay) await session.airplay.stop();
    } catch (err) {
      log.debug('session', `cleanup error: ${(err as Error).message}`);
    }
    session.cast = undefined;
    session.airplay = undefined;
    session.mirror = undefined;
    session.castMirror = undefined;
  }

  /** Called when a live session's receiver dropped; retry when the stream restarts. */
  hasLiveSessions(): boolean {
    return [...this.sessions.values()].some((s) => s.target.type === 'live');
  }
}
