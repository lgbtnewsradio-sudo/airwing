/**
 * Mock Google Cast receiver: speaks the CASTV2 protocol over TLS using the castv2
 * Server class and emulates the Default Media Receiver (connection, heartbeat,
 * receiver and media namespaces).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from 'castv2';

const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};

export class MockCastReceiver {
  private server: Server | null = null;
  port = 0;
  readonly log: string[] = [];
  loaded: any[] = [];
  playerState = 'IDLE';
  volume = { level: 1, muted: false };
  currentTime = 0;
  private app: { appId: string; sessionId: string; transportId: string } | null = null;
  private mediaSessionId = 0;
  stopRequests = 0;

  async start(): Promise<number> {
    const dir = join(__dirname);
    const server = new Server({ key: readFileSync(join(dir, 'cast-key.pem')), cert: readFileSync(join(dir, 'cast-cert.pem')) });
    this.server = server;
    server.on('message', (clientId: string, sourceId: string, destinationId: string, namespace: string, data: any) => {
      const msg = typeof data === 'string' ? JSON.parse(data) : data;
      this.log.push(`${namespace.split('.').pop()}:${msg.type}`);
      const reply = (ns: string, payload: any) => server.send(clientId, destinationId, sourceId, ns, JSON.stringify(payload));
      switch (msg.type) {
        case 'CONNECT':
          break;
        case 'PING':
          reply(NS.heartbeat, { type: 'PONG' });
          break;
        case 'GET_STATUS':
          if (namespace === NS.receiver) reply(NS.receiver, { type: 'RECEIVER_STATUS', requestId: msg.requestId, status: this.receiverStatus() });
          else reply(NS.media, { type: 'MEDIA_STATUS', requestId: msg.requestId, status: this.mediaStatus() });
          break;
        case 'LAUNCH':
          this.app = { appId: msg.appId, sessionId: 'session-1', transportId: 'transport-1' };
          reply(NS.receiver, { type: 'RECEIVER_STATUS', requestId: msg.requestId, status: this.receiverStatus() });
          break;
        case 'STOP':
          if (namespace === NS.receiver) {
            this.stopRequests++;
            this.app = null;
            this.playerState = 'IDLE';
            reply(NS.receiver, { type: 'RECEIVER_STATUS', requestId: msg.requestId, status: this.receiverStatus() });
          } else {
            this.playerState = 'IDLE';
            reply(NS.media, { type: 'MEDIA_STATUS', requestId: msg.requestId, status: this.mediaStatus('FINISHED') });
          }
          break;
        case 'LOAD':
          this.loaded.push(msg.media);
          this.mediaSessionId++;
          this.playerState = 'PLAYING';
          reply(NS.media, { type: 'MEDIA_STATUS', requestId: msg.requestId, status: this.mediaStatus() });
          // Real receivers also broadcast the new status to every connected sender.
          reply(NS.media, { type: 'MEDIA_STATUS', requestId: 0, status: this.mediaStatus() });
          break;
        case 'PAUSE':
          this.playerState = 'PAUSED';
          reply(NS.media, { type: 'MEDIA_STATUS', requestId: msg.requestId, status: this.mediaStatus() });
          break;
        case 'PLAY':
          this.playerState = 'PLAYING';
          reply(NS.media, { type: 'MEDIA_STATUS', requestId: msg.requestId, status: this.mediaStatus() });
          break;
        case 'SEEK':
          this.currentTime = msg.currentTime;
          reply(NS.media, { type: 'MEDIA_STATUS', requestId: msg.requestId, status: this.mediaStatus() });
          break;
        case 'SET_VOLUME':
          this.volume = { ...this.volume, ...msg.volume };
          reply(NS.receiver, { type: 'RECEIVER_STATUS', requestId: msg.requestId, status: this.receiverStatus() });
          break;
        case 'CLOSE':
          break;
        default:
          reply(namespace, { type: 'INVALID_REQUEST', requestId: msg.requestId, reason: 'unknown' });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.port = ((server as any).server.address() as { port: number }).port;
    return this.port;
  }

  private receiverStatus(): any {
    return {
      volume: this.volume,
      applications: this.app
        ? [{ appId: this.app.appId, displayName: 'Default Media Receiver', sessionId: this.app.sessionId, transportId: this.app.transportId, namespaces: [{ name: NS.media }], statusText: 'Ready' }]
        : [],
    };
  }

  private mediaStatus(idleReason?: string): any[] {
    return [
      {
        mediaSessionId: this.mediaSessionId,
        playbackRate: 1,
        playerState: this.playerState,
        currentTime: this.currentTime,
        supportedMediaCommands: 15,
        volume: this.volume,
        idleReason,
        media: this.loaded.length ? { ...this.loaded[this.loaded.length - 1], duration: 60 } : undefined,
      },
    ];
  }

  stop(): void {
    this.server?.close();
  }
}
