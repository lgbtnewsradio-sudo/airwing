/**
 * Google Cast sender built on castv2-client. Launches the Default Media Receiver and
 * loads our live HLS stream (fMP4 segments) or a media file URL.
 */

import { EventEmitter } from 'node:events';
import { Client, DefaultMediaReceiver } from 'castv2-client';
import { log } from '../logger';

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
      this.player = null;
      this.emit('ended');
    });
  }

  private onStatus(status: any): void {
    if (!status) return;
    this.status = {
      playerState: status.playerState,
      currentTime: status.currentTime,
      duration: status.media?.duration,
      volume: status.volume?.level,
      muted: status.volume?.muted,
      idleReason: status.idleReason,
    };
    this.emit('status', this.status);
    if (status.playerState === 'IDLE' && status.idleReason && status.idleReason !== 'INTERRUPTED') {
      this.emit('idle', status.idleReason);
    }
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
      this.client?.close();
    } catch {
      /* ignore */
    }
    this.player = null;
    this.client = null;
    this.connected = false;
  }
}
