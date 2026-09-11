/**
 * Local HTTP + WebSocket server:
 *  - /hls/*            live HLS (fMP4) for Chromecast / AirPlay / smart TVs
 *  - /                 browser receiver page (MSE over WebSocket, ~1 frame latency)
 *  - /remote           phone-friendly remote control page
 *  - /media/:id        media files with HTTP range support
 *  - /ws/view          binary fragment stream for browser receivers
 *  - /ws/remote        JSON control channel for the remote page
 */

import http from 'node:http';
import { createReadStream, promises as fs, statSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { StreamHub } from './streamHub';
import type { FragmentInfo } from '@shared/fmp4';
import { localAddresses } from './net';
import { log } from './logger';

export const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

export interface RegisteredMedia {
  id: string;
  path: string;
  name: string;
  mime: string;
  size: number;
}

export interface ServerOptions {
  port: number;
  bindAddress?: string;
  hub: StreamHub;
  /** Directory containing receiver/index.html, remote.html. */
  staticDir: string;
  requireCode: () => boolean;
  deviceName: () => string;
}

export interface RemoteCommand {
  type: string;
  [key: string]: unknown;
}

export class LocalServer extends EventEmitter {
  private server: http.Server | null = null;
  private wssView = new WebSocketServer({ noServer: true });
  private wssRemote = new WebSocketServer({ noServer: true });
  private media = new Map<string, RegisteredMedia>();
  readonly code = String(Math.floor(100000 + Math.random() * 900000));
  readonly remoteToken = randomBytes(8).toString('hex');
  port = 0;
  private viewers = new Set<WebSocket>();
  private remotes = new Set<WebSocket>();

  constructor(private readonly opts: ServerOptions) {
    super();
    const hub = opts.hub;
    hub.on('meta', () => this.broadcastMeta());
    hub.on('init', (data: Buffer) => this.broadcastBinary(data, { kind: 'init', keyframe: true, timestampUs: 0, durationUs: 0, sequence: 0 }));
    hub.on('chunk', (data: Buffer, info: FragmentInfo) => this.broadcastBinary(data, info));
    hub.on('end', () => this.broadcastJson({ type: 'end' }));
    hub.on('paused', (paused: boolean) => this.broadcastJson({ type: 'paused', paused }));
    hub.on('stats', () => this.broadcastRemoteState());
  }

  async start(): Promise<number> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/ws/view') {
        if (this.opts.requireCode() && url.searchParams.get('code') !== this.code) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wssView.handleUpgrade(req, socket, head, (ws) => this.onViewer(ws, req.socket.remoteAddress));
      } else if (url.pathname === '/ws/remote') {
        if (url.searchParams.get('token') !== this.remoteToken) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wssRemote.handleUpgrade(req, socket, head, (ws) => this.onRemote(ws));
      } else {
        socket.destroy();
      }
    });
    const ports = [this.opts.port, this.opts.port + 1, this.opts.port + 2, 0];
    for (const port of ports) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, this.opts.bindAddress || '0.0.0.0', () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        log.info('server', `listening on ${this.opts.bindAddress || '0.0.0.0'}:${this.port}`);
        return this.port;
      } catch (err) {
        log.warn('server', `port ${port} unavailable: ${(err as Error).message}`);
      }
    }
    throw new Error('could not bind local server');
  }

  stop(): void {
    for (const ws of this.viewers) ws.close();
    for (const ws of this.remotes) ws.close();
    this.server?.close();
    this.server = null;
  }

  registerMedia(path: string): RegisteredMedia {
    for (const m of this.media.values()) if (m.path === path) return m;
    const st = statSync(path);
    const id = randomBytes(6).toString('hex');
    const ext = extname(path).toLowerCase();
    const item: RegisteredMedia = { id, path, name: basename(path), mime: MIME[ext] ?? 'application/octet-stream', size: st.size };
    this.media.set(id, item);
    return item;
  }

  mediaUrl(host: string, media: RegisteredMedia): string {
    return `http://${host}:${this.port}/media/${media.id}${extname(media.path).toLowerCase()}`;
  }

  hlsUrl(host: string): string {
    return `http://${host}:${this.port}/hls/master.m3u8`;
  }

  receiverUrl(host: string): string {
    return `http://${host}:${this.port}/${this.opts.requireCode() ? `?code=${this.code}` : ''}`;
  }

  remoteUrl(host: string): string {
    return `http://${host}:${this.port}/remote?token=${this.remoteToken}`;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  private cors(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    this.cors(res);
    // Log what receivers actually fetch. A receiver that stalls is usually asking for a
    // segment we already dropped, and without this there is no way to see it.
    if (path.startsWith('/hls/') || path.startsWith('/media/')) {
      const started = Date.now();
      let bytes = 0;
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      res.write = ((chunk: any, ...rest: any[]) => {
        if (chunk) bytes += Buffer.byteLength(chunk);
        return (origWrite as any)(chunk, ...rest);
      }) as typeof res.write;
      res.end = ((chunk?: any, ...rest: any[]) => {
        if (chunk && typeof chunk !== 'function') bytes += Buffer.byteLength(chunk);
        const from = req.socket.remoteAddress?.replace('::ffff:', '') ?? '?';
        log.debug('http', `${from} ${req.method} ${path}${url.search} -> ${res.statusCode} ${bytes}B ${Date.now() - started}ms`);
        if (res.statusCode >= 400) log.warn('http', `${from} asked for ${path} and got ${res.statusCode}`);
        return (origEnd as any)(chunk, ...rest);
      }) as typeof res.end;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (path === '/' || path === '/index.html') return await this.serveStatic(res, 'receiver/index.html');
      if (path === '/remote' || path === '/remote.html') return await this.serveStatic(res, 'receiver/remote.html');
      if (path === '/api/info') return this.json(res, this.infoPayload(req.socket.remoteAddress));
      if (path === '/hls/master.m3u8') return this.serveMaster(res);
      if (path === '/hls/live.m3u8') return this.servePlaylist(res);
      if (path === '/hls/init.mp4') return this.serveInit(res);
      if (path.startsWith('/hls/seg-')) return this.serveSegment(res, path);
      if (path.startsWith('/media/')) return await this.serveMedia(req, res, path);
      if (path === '/healthz') return this.json(res, { ok: true });
      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      log.error('server', `request ${path} failed: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  /** True when the viewer is the very machine doing the capturing. */
  isSameMachine(remote?: string): boolean {
    if (!remote) return false;
    const ip = remote.replace('::ffff:', '');
    if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
    return localAddresses().some((a) => a.address === ip);
  }

  infoPayload(remote?: string): Record<string, unknown> {
    const hub = this.opts.hub;
    return {
      name: this.opts.deviceName(),
      app: 'AirWing',
      streaming: hub.active,
      paused: hub.paused,
      codecs: hub.meta?.codecs,
      mime: hub.meta?.mime,
      audioOnly: hub.meta?.audioOnly ?? false,
      encoder: hub.meta?.encoder,
      viewers: this.viewers.size,
      hlsReady: hub.segmenter.ready,
      liveEdgeSec: Number(hub.segmenter.liveEdgeSec.toFixed(3)),
      requireCode: this.opts.requireCode(),
      // The page mutes itself in this case: playing our own captured audio back on the
      // capturing machine feeds straight into the loopback capture.
      sameMachine: this.isSameMachine(remote),
    };
  }

  private json(res: http.ServerResponse, body: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async serveStatic(res: http.ServerResponse, rel: string): Promise<void> {
    const file = `${this.opts.staticDir}/${rel}`;
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  }

  private servePlaylist(res: http.ServerResponse): void {
    const seg = this.opts.hub.segmenter;
    if (!this.opts.hub.active || !seg.ready) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    res.end(seg.playlist());
  }

  /**
   * Multivariant (master) playlist. Apple TV's AirPlay player expects the /play
   * Content-Location to be a master playlist that names its variant's codecs,
   * resolution and frame rate; handed a bare media playlist it errors out.
   */
  private serveMaster(res: http.ServerResponse): void {
    const hub = this.opts.hub;
    if (!hub.active || !hub.segmenter.ready) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const enc = hub.meta?.encoder;
    const codecs = hub.meta?.codecs ?? 'avc1.640028,mp4a.40.2';
    const bandwidth = Math.round((enc?.videoBitrate ?? 6_000_000) + (enc?.audioBitrate ?? 160_000)) + 200_000;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ];
    if (hub.meta?.audioOnly) {
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${codecs}"`, 'live.m3u8');
    } else {
      const res2 = enc ? `,RESOLUTION=${enc.width}x${enc.height}` : '';
      const fr = enc?.frameRate ? `,FRAME-RATE=${enc.frameRate.toFixed(3)}` : '';
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${bandwidth}${res2}${fr},CODECS="${codecs}"`, 'live.m3u8');
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    res.end(lines.join('\n') + '\n');
  }

  private serveInit(res: http.ServerResponse): void {
    const init = this.opts.hub.segmenter.initSegment;
    if (!init) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Content-Length': init.length });
    res.end(Buffer.from(init));
  }

  private serveSegment(res: http.ServerResponse, path: string): void {
    const m = /^\/hls\/seg-(\d+)\.m4s$/.exec(path);
    const seg = m ? this.opts.hub.segmenter.getSegment(parseInt(m[1], 10)) : undefined;
    if (!seg) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/iso.segment', 'Cache-Control': 'no-store', 'Content-Length': seg.data.length });
    res.end(Buffer.from(seg.data));
  }

  private async serveMedia(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
    const id = path.slice('/media/'.length).split('.')[0];
    const media = this.media.get(id);
    if (!media) {
      res.writeHead(404);
      res.end();
      return;
    }
    const st = await fs.stat(media.path);
    const size = st.size;
    const range = req.headers.range;
    const headers: Record<string, string | number> = {
      'Content-Type': media.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (!m || Number.isNaN(start) || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      end = Math.min(end, size - 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(media.path, { start, end }).pipe(res);
      return;
    }
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(media.path).pipe(res);
  }

  // ----------------------------------------------------------------------- viewers

  private onViewer(ws: WebSocket, remote?: string): void {
    (ws as unknown as { __remote?: string }).__remote = remote;
    this.viewers.add(ws);
    this.opts.hub.viewers = this.viewers.size;
    log.info('server', `browser viewer connected (${this.viewers.size} total)`);
    this.emit('viewer', this.viewers.size);
    this.sendMeta(ws);
    const snap = this.opts.hub.snapshot();
    if (snap && this.opts.hub.active) {
      ws.send(this.frame(snap.init, { kind: 'init', keyframe: true, timestampUs: 0, durationUs: 0, sequence: 0 }));
      for (const f of snap.fragments) ws.send(this.frame(f.data, f.info));
    }
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => {
      this.viewers.delete(ws);
      this.opts.hub.viewers = this.viewers.size;
      this.emit('viewer', this.viewers.size);
      log.info('server', `browser viewer disconnected (${this.viewers.size} left)`);
    });
    ws.on('error', () => ws.close());
  }

  /** Binary frame: 1 byte kind (0 init, 1 video, 2 audio), 1 byte flags (bit0 keyframe), 8 bytes timestamp us (LE double), then payload. */
  private frame(data: Buffer | Uint8Array, info: FragmentInfo): Buffer {
    const header = Buffer.alloc(10);
    header[0] = info.kind === 'init' ? 0 : info.kind === 'video' ? 1 : 2;
    header[1] = info.keyframe ? 1 : 0;
    header.writeDoubleLE(info.timestampUs, 2);
    return Buffer.concat([header, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
  }

  private sendMeta(ws: WebSocket, remote?: string): void {
    ws.send(JSON.stringify({ type: 'meta', ...this.infoPayload(remote ?? (ws as any).__remote) }));
  }

  private broadcastMeta(): void {
    for (const ws of this.viewers) this.sendMeta(ws);
    this.broadcastRemoteState();
  }

  private broadcastJson(msg: unknown): void {
    const s = JSON.stringify(msg);
    for (const ws of this.viewers) if (ws.readyState === WebSocket.OPEN) ws.send(s);
    this.broadcastRemoteState();
  }

  private waitingForKey = new WeakSet<WebSocket>();

  private broadcastBinary(data: Buffer, info: FragmentInfo): void {
    if (!this.viewers.size) return;
    const frame = this.frame(data, info);
    for (const ws of this.viewers) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      // Backpressure: if a viewer falls > 2 MB behind, drop until the next keyframe.
      if (ws.bufferedAmount > 2_000_000) {
        this.waitingForKey.add(ws);
        continue;
      }
      if (this.waitingForKey.has(ws)) {
        if (info.kind === 'video' && info.keyframe) this.waitingForKey.delete(ws);
        else if (info.kind !== 'init') continue;
      }
      ws.send(frame);
    }
  }

  // ----------------------------------------------------------------------- remote

  private onRemote(ws: WebSocket): void {
    this.remotes.add(ws);
    ws.on('message', (raw) => {
      try {
        const cmd = JSON.parse(raw.toString()) as RemoteCommand;
        this.emit('remote', cmd, (reply: unknown) => ws.send(JSON.stringify({ type: 'reply', id: cmd.id, ...(reply as object) })));
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => this.remotes.delete(ws));
    this.emit('remote-state-request');
  }

  private remoteStateProvider: (() => unknown) | null = null;

  setRemoteStateProvider(fn: () => unknown): void {
    this.remoteStateProvider = fn;
  }

  broadcastRemoteState(): void {
    if (!this.remotes.size || !this.remoteStateProvider) return;
    const s = JSON.stringify({ type: 'state', ...(this.remoteStateProvider() as object) });
    for (const ws of this.remotes) if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}
