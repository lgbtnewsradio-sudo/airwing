/**
 * SessionManager: one Session per connected receiver. Every session is fed from the
 * same StreamHub (screen mirror / audio / transcoded media) or plays a registered
 * media file directly. Supports many simultaneous receivers.
 */

import { EventEmitter } from 'node:events';
import type { Device, MediaControlAction, SessionInfo, SessionState } from '@shared/types';
import { AirPlayClient, PairingRequiredError } from './airplay/client';
import { CastClient } from './cast/castClient';
import type { StreamHub } from './streamHub';
import type { LocalServer, RegisteredMedia } from './server';
import type { CredentialStore } from './settings';
import { deviceKey } from './discovery';
import { addressReaching } from './net';
import { log } from './logger';

export type SessionTarget = { type: 'live' } | { type: 'file'; path: string };

interface Session {
  info: SessionInfo;
  target: SessionTarget;
  airplay?: AirPlayClient;
  cast?: CastClient;
  media?: RegisteredMedia;
  stopping?: boolean;
}

export interface SessionManagerOptions {
  hub: StreamHub;
  server: LocalServer;
  credentials: CredentialStore;
  senderName: () => string;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private pairingClients = new Map<string, AirPlayClient>();

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

  get count(): number {
    return this.sessions.size;
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
      else if (reason === 'ERROR') this.setState(session, 'error', 'receiver reported a playback error');
      else void this.disconnect(device.id, `receiver idle (${reason})`);
    });
    client.on('close', () => {
      if (!session.stopping && this.sessions.get(device.id) === session) this.setState(session, 'error', 'connection closed by receiver');
    });
    client.on('error', (err: Error) => {
      if (!session.stopping) this.setState(session, 'error', err.message);
    });
    const live = session.target.type === 'live';
    await client.load({
      url,
      contentType: live ? 'application/x-mpegURL' : mime,
      streamType: live ? 'LIVE' : 'BUFFERED',
      title: live ? `${this.opts.senderName()} screen` : session.media?.name,
      subtitle: 'AirWing',
      hlsSegmentFormat: live ? 'fmp4' : undefined,
    });
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
    try {
      if (session.cast) await session.cast.stop();
      if (session.airplay) await session.airplay.stop();
    } catch (err) {
      log.debug('session', `cleanup error: ${(err as Error).message}`);
    }
    session.cast = undefined;
    session.airplay = undefined;
  }

  /** Called when a live session's receiver dropped; retry when the stream restarts. */
  hasLiveSessions(): boolean {
    return [...this.sessions.values()].some((s) => s.target.type === 'live');
  }
}
