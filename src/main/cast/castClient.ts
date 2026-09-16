/**
 * Google Cast sender built on castv2-client. Launches the Default Media Receiver and
 * loads our live HLS stream (fMP4 segments) or a media file URL.
 */

import { EventEmitter } from 'node:events';
import { Client, DefaultMediaReceiver } from 'castv2-client';
import { log } from '../logger';
import { MirroringApp, MirroringSender, OfferAnswerChannel, type MirroringVideoConfig } from './mirroring';

export interface CastMedia {
  url: string;
  contentType: string;
  /** 'LIVE' for screen mirroring, 'BUFFERED' for files. */
  streamType: 'LIVE' | 'BUFFERED';
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  /** HLS segment container: fmp4 or ts. */
  hlsSegmentFormat?: 'fmp4' | 'ts';
  duration?: number;
}

export interface CastStatus {
  playerState?: string;
  currentTime?: number;
  duration?: number;
  volume?: number;
  muted?: boolean;
  idleReason?: string;
  /** LIVE streams only: the window of the stream the receiver can currently seek within. */
  liveSeekableRange?: { start: number; end: number };
}

export interface CastClientOptions {
  host: string;
  port?: number;
  name: string;
  /** Custom receiver application id; defaults to the Default Media Receiver. */
  appId?: string;
}

function promisify<T>(fn: (cb: (err: Error | null, result?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result as T)));
  });
}

export class CastClient extends EventEmitter {
  private client: any = null;
  private player: any = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private mirroringApp: any = null;
  status: CastStatus = {};
  connected = false;

  constructor(readonly opts: CastClientOptions) {
    super();
  }

  private get scope(): string {
    return `cast:${this.opts.name}`;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const client = new Client();
    this.client = client;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`connection to ${this.opts.host} timed out`)), 10000);
      client.on('error', (err: Error) => {
        clearTimeout(timer);
        log.warn(this.scope, `client error: ${err.message}`);
        this.connected = false;
        this.emit('error', err);
        reject(err);
      });
      client.on('close', () => {
        this.connected = false;
        this.stopStatusPolling();
        this.emit('close');
      });
      client.connect({ host: this.opts.host, port: this.opts.port ?? 8009 }, () => {
        clearTimeout(timer);
        this.connected = true;
        log.info(this.scope, `connected to ${this.opts.host}`);
        resolve();
      });
    });
  }

  private async launch(): Promise<void> {
    if (this.player) return;
    const app = this.opts.appId ? Object.assign(class extends DefaultMediaReceiver {}, { APP_ID: this.opts.appId }) : DefaultMediaReceiver;
    // Re-use a running Default Media Receiver session if present, otherwise launch.
    const sessions: any[] = await promisify((cb) => this.client.getSessions(cb));
    const existing = sessions.find((s) => s.appId === (app as any).APP_ID);
    if (existing) {
      this.player = await promisify((cb) => this.client.join(existing, app, cb));
      log.debug(this.scope, 'joined existing receiver session');
    } else {
      this.player = await promisify((cb) => this.client.launch(app, cb));
      log.debug(this.scope, 'launched receiver app');
    }
    this.player.on('status', (status: any) => this.onStatus(status));
    this.player.on('close', () => {
      // Stop polling before dropping the player, otherwise the 2 s status timer keeps
      // running forever against a session that no longer exists.
      this.stopStatusPolling();
      this.player = null;
      this.emit('ended');
    });
  }

  private lastLoggedState = '';

  private onStatus(status: any): void {
    if (!status) return;
    const signature = `${status.playerState}/${status.idleReason ?? ''}`;
    if (signature !== this.lastLoggedState) {
      this.lastLoggedState = signature;
      log.info(this.scope, `player ${status.playerState}${status.idleReason ? ` (${status.idleReason})` : ''} at ${(status.currentTime ?? 0).toFixed(1)}s`);
    }
    this.status = {
      playerState: status.playerState,
      currentTime: status.currentTime,
      duration: status.media?.duration,
      volume: status.volume?.level,
      muted: status.volume?.muted,
      idleReason: status.idleReason,
      liveSeekableRange: status.liveSeekableRange ? { start: status.liveSeekableRange.start, end: status.liveSeekableRange.end } : undefined,
    };
    this.emit('status', this.status);
    if (status.playerState === 'IDLE' && status.idleReason && status.idleReason !== 'INTERRUPTED') {
      if (status.idleReason === 'ERROR') {
        // Surface exactly why the receiver refused the media (codec/container/level etc.).
        log.warn(this.scope, `receiver LOAD error status: ${JSON.stringify(status).slice(0, 600)}`);
      }
      this.emit('idle', status.idleReason);
    }
    this.maybeCatchUpToLive();
  }

  private liveCatchUp: { targetLagSec: number; maxLagSec: number } | null = null;
  private lastCatchUpSeekAt = 0;
  private readonly minCatchUpIntervalMs = 6000;

  /**
   * For a LIVE Cast session: periodically seek back toward the live edge if playback has
   * drifted too far behind it. Left alone, the Default Media Receiver's own rebuffer-avoidance
   * grows that gap over the course of a session rather than holding it steady — measured
   * against a Sony Bravia, a stream that started ~3 s behind live drifted past 5 s within a
   * minute with zero rebuffering, i.e. the receiver was deliberately falling further back. A
   * playlist cushion alone cannot counteract a drift that keeps growing, so this actively
   * corrects it instead.
   */
  enableLiveCatchUp(targetLagSec: number, maxLagSec: number): void {
    this.liveCatchUp = { targetLagSec, maxLagSec };
  }

  private maybeCatchUpToLive(): void {
    const cfg = this.liveCatchUp;
    if (!cfg || !this.player) return;
    const { playerState, currentTime, liveSeekableRange } = this.status;
    // Only correct while genuinely playing: seeking during BUFFERING would fight whatever
    // recovery the receiver is already attempting.
    if (playerState !== 'PLAYING' || currentTime === undefined || !liveSeekableRange) return;
    const lag = liveSeekableRange.end - currentTime;
    if (lag <= cfg.maxLagSec) return;
    const now = Date.now();
    if (now - this.lastCatchUpSeekAt < this.minCatchUpIntervalMs) return;
    this.lastCatchUpSeekAt = now;
    const target = Math.max(liveSeekableRange.start, liveSeekableRange.end - cfg.targetLagSec);
    log.info(this.scope, `catching up to live: lag ${lag.toFixed(1)}s > ${cfg.maxLagSec}s, seeking ${currentTime.toFixed(1)}s -> ${target.toFixed(1)}s`);
    this.seek(target).catch((err) => log.warn(this.scope, `live catch-up seek failed: ${(err as Error).message}`));
  }

  /**
   * Connect and launch (or join) the receiver app without loading media. Idempotent, and
   * separate from load() because launching alone can take ~20 s on some TVs — callers that
   * time the receiver's response must start their clock after this, not before.
   */
  async prepare(): Promise<void> {
    await this.connect();
    await this.launch();
  }

  /**
   * Launch (or join) the Chrome Mirroring receiver app and negotiate a real-time Cast
   * Streaming session for it — the low-latency path Chrome/Edge use for tab and desktop
   * casting, separate from the Default Media Receiver's HLS-URL playback session. See
   * ./mirroring for the wire format.
   */
  async startMirroring(video: MirroringVideoConfig): Promise<MirroringSender> {
    await this.connect();
    if (!this.mirroringApp) {
      const sessions: any[] = await promisify((cb) => this.client.getSessions(cb));
      const existing = sessions.find((s) => s.appId === MirroringApp.APP_ID);
      this.mirroringApp = existing
        ? await promisify((cb) => this.client.join(existing, MirroringApp, cb))
        : await promisify((cb) => this.client.launch(MirroringApp, cb));
      log.info(this.scope, `${existing ? 'joined' : 'launched'} Chrome Mirroring receiver app`);
    }
    const offerAnswer = new OfferAnswerChannel(this.mirroringApp.webrtc);
    const sender = new MirroringSender(this.opts.host, offerAnswer);
    await sender.start(video);
    return sender;
  }

  async load(media: CastMedia): Promise<void> {
    await this.connect();
    await this.launch();
    const mediaInfo: Record<string, unknown> = {
      contentId: media.url,
      contentUrl: media.url,
      contentType: media.contentType,
      streamType: media.streamType,
      metadata: {
        type: 0,
        metadataType: 0,
        title: media.title ?? 'AirWing',
        subtitle: media.subtitle,
        images: media.imageUrl ? [{ url: media.imageUrl }] : [],
      },
    };
    if (media.hlsSegmentFormat) {
      mediaInfo.hlsSegmentFormat = media.hlsSegmentFormat;
      mediaInfo.hlsVideoSegmentFormat = media.hlsSegmentFormat;
    }
    if (media.duration) mediaInfo.duration = media.duration;
    const status = await promisify<any>((cb) => this.player.load(mediaInfo, { autoplay: true }, cb));
    this.onStatus(status);
    // Make sure the controller knows the media session even if the receiver's broadcast is late.
    await promisify<any>((cb) => this.player.getStatus(cb)).then((s) => this.onStatus(s)).catch(() => undefined);
    this.startStatusPolling();
    log.info(this.scope, `loaded ${media.url} (${media.contentType}, ${media.streamType})`);
  }

  private startStatusPolling(): void {
    this.stopStatusPolling();
    this.statusTimer = setInterval(() => {
      if (!this.player) return;
      this.player.getStatus((err: Error | null, status: any) => {
        if (!err && status) this.onStatus(status);
      });
    }, 2000);
  }

  private stopStatusPolling(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  async play(): Promise<void> {
    if (this.player) await promisify((cb) => this.player.play(cb));
  }

  async pause(): Promise<void> {
    if (this.player) await promisify((cb) => this.player.pause(cb));
  }

  async seek(seconds: number): Promise<void> {
    if (this.player) await promisify((cb) => this.player.seek(seconds, cb));
  }

  async setVolume(level: number): Promise<void> {
    if (this.client) await promisify((cb) => this.client.setVolume({ level: Math.max(0, Math.min(1, level)) }, cb));
  }

  async setMuted(muted: boolean): Promise<void> {
    if (this.client) await promisify((cb) => this.client.setVolume({ muted }, cb));
  }

  async stop(): Promise<void> {
    this.stopStatusPolling();
    try {
      if (this.player) {
        await promisify((cb) => this.player.stop(cb)).catch(() => undefined);
        await promisify((cb) => this.client.stop(this.player, cb)).catch(() => undefined);
      }
    } finally {
      this.close();
    }
  }

  close(): void {
    this.stopStatusPolling();
    try {
      this.mirroringApp?.close();
    } catch {
      /* ignore */
    }
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    this.player = null;
    this.mirroringApp = null;
    this.client = null;
    this.connected = false;
  }
}
