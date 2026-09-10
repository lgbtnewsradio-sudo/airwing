/**
 * Persistent HTTP/RTSP connection to an AirPlay receiver (port 7000) with optional
 * HAP (ChaCha20-Poly1305) transport encryption after pair-verify.
 * Requests are serialized; unsolicited requests from the receiver are answered with 200 OK.
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { HapFramer } from './crypto';
import { log } from '../logger';

export interface AirPlayResponse {
  protocol: string;
  code: number;
  message: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface RequestOptions {
  headers?: Record<string, string | number>;
  body?: Buffer | string;
  protocol?: 'HTTP/1.1' | 'RTSP/1.0';
  timeoutMs?: number;
  /** Do not reject on 4xx/5xx. */
  allowError?: boolean;
}

interface Pending {
  resolve: (r: AirPlayResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  path: string;
}

export class AirPlayError extends Error {
  constructor(message: string, readonly code?: number, readonly response?: AirPlayResponse) {
    super(message);
    this.name = 'AirPlayError';
  }
}

export class AirPlayConnection extends EventEmitter {
  private socket: net.Socket | null = null;
  private framer: HapFramer | null = null;
  private rx = Buffer.alloc(0);
  private queue: Pending[] = [];
  private closed = false;
  localAddress = '';
  remoteAddress = '';

  constructor(readonly host: string, readonly port: number, readonly scope = 'airplay') {
    super();
  }

  get encrypted(): boolean {
    return !!this.framer;
  }

  get isOpen(): boolean {
    return !!this.socket && !this.closed;
  }

  connect(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy(new Error(`connection to ${this.host}:${this.port} timed out`));
      }, timeoutMs);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10000);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.localAddress = socket.localAddress ?? '';
        this.remoteAddress = socket.remoteAddress ?? this.host;
        log.debug(this.scope, `connected to ${this.host}:${this.port} from ${this.localAddress}`);
        resolve();
      });
      socket.on('data', (data) => this.onData(data));
      socket.on('error', (err) => {
        clearTimeout(timer);
        if (!this.socket) reject(err);
        this.failAll(err);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        this.closed = true;
        this.failAll(new Error('connection closed'));
        this.emit('close');
      });
    });
  }

  enableEncryption(outKey: Buffer, inKey: Buffer): void {
    this.framer = new HapFramer(outKey, inKey);
    log.debug(this.scope, 'transport encryption enabled');
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
  }

  private failAll(err: Error): void {
    const pending = this.queue;
    this.queue = [];
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  request(method: string, path: string, opts: RequestOptions = {}): Promise<AirPlayResponse> {
    if (!this.socket || this.closed) return Promise.reject(new Error('not connected'));
    const body = opts.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body);
    const protocol = opts.protocol ?? 'HTTP/1.1';
    const lines = [`${method} ${path} ${protocol}`];
    const headers: Record<string, string | number> = { ...opts.headers };
    if (body.length || method === 'POST' || method === 'PUT') headers['Content-Length'] = body.length;
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf8');
    let packet: Buffer = Buffer.concat([head, body]);
    if (this.framer) packet = this.framer.encrypt(packet);
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        method,
        path,
        resolve: (r) => {
          if (!opts.allowError && r.code >= 400) reject(new AirPlayError(`${method} ${path} failed: ${r.code} ${r.message}`, r.code, r));
          else resolve(r);
        },
        reject,
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(pending);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new Error(`${method} ${path} timed out`));
        }, opts.timeoutMs ?? 10000),
      };
      this.queue.push(pending);
      log.debug(this.scope, `>> ${method} ${path} (${body.length} bytes${this.framer ? ', encrypted' : ''})`);
      this.socket!.write(packet);
    });
  }

  get(path: string, opts: RequestOptions = {}): Promise<AirPlayResponse> {
    return this.request('GET', path, opts);
  }

  post(path: string, opts: RequestOptions = {}): Promise<AirPlayResponse> {
    return this.request('POST', path, opts);
  }

  private onData(data: Buffer): void {
    let plain: Buffer;
    try {
      plain = this.framer ? this.framer.decrypt(data) : data;
    } catch (err) {
      log.error(this.scope, `decrypt failed: ${(err as Error).message}`);
      this.close();
      return;
    }
    if (!plain.length) return;
    this.rx = Buffer.concat([this.rx, plain]);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const headEnd = this.rx.indexOf('\r\n\r\n');
      if (headEnd < 0) return;
      const headText = this.rx.subarray(0, headEnd).toString('utf8');
      const headerLines = headText.split('\r\n');
      const first = headerLines.shift() ?? '';
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const contentLength = parseInt(headers['content-length'] ?? '0', 10) || 0;
      const total = headEnd + 4 + contentLength;
      if (this.rx.length < total) return;
      const body = Buffer.from(this.rx.subarray(headEnd + 4, total));
      this.rx = this.rx.subarray(total);
      const respMatch = /^(HTTP|RTSP)\/([0-9.]+) (\d{3}) ?(.*)$/.exec(first);
      if (respMatch) {
        const response: AirPlayResponse = {
          protocol: `${respMatch[1]}/${respMatch[2]}`,
          code: parseInt(respMatch[3], 10),
          message: respMatch[4] ?? '',
          headers,
          body,
        };
        const pending = this.queue.shift();
        if (pending) {
          clearTimeout(pending.timer);
          log.debug(this.scope, `<< ${response.code} ${response.message} for ${pending.method} ${pending.path} (${body.length} bytes)`);
          pending.resolve(response);
        } else {
          log.debug(this.scope, `<< unsolicited response ${response.code}`);
        }
        continue;
      }
      const reqMatch = /^([A-Z_]+) (\S+) (HTTP|RTSP)\/([0-9.]+)$/.exec(first);
      if (reqMatch) {
        // Receiver-initiated request on our connection (reverse HTTP). Acknowledge it.
        log.debug(this.scope, `<< incoming ${reqMatch[1]} ${reqMatch[2]}`);
        this.emit('request', { method: reqMatch[1], path: reqMatch[2], headers, body });
        const reply = [`${reqMatch[3]}/${reqMatch[4]} 200 OK`];
        if (headers.cseq) reply.push(`CSeq: ${headers.cseq}`);
        reply.push('Content-Length: 0', '', '');
        let out: Buffer = Buffer.from(reply.join('\r\n'));
        if (this.framer) out = this.framer.encrypt(out);
        this.socket?.write(out);
        continue;
      }
      log.warn(this.scope, `unparseable message: ${first.slice(0, 80)}`);
      this.rx = Buffer.alloc(0);
      return;
    }
  }
}
