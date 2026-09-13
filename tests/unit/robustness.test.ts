import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { StreamHub } from '../../src/main/streamHub';
import { LocalServer } from '../../src/main/server';

/**
 * These cover two faults that used to take the whole app down. Both are in-process, so if
 * the fix regresses the unhandled 'error' propagates and fails the run rather than passing
 * quietly.
 *
 *  - a read error part way through serving a media file (drive unplugged, file moved)
 *    reached `createReadStream(...).pipe(res)` with no error handler;
 *  - a phone remote dropping off Wi-Fi emitted 'error' on a socket with no listener.
 */
describe('server survives faults that used to kill the app', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airwing-robust-'));
  const hub = new StreamHub();
  const server = new LocalServer({
    port: 0,
    bindAddress: '127.0.0.1',
    hub,
    staticDir: join(process.cwd(), 'resources'),
    requireCode: () => false,
    deviceName: () => 'Test PC',
  });
  let base = '';

  beforeAll(async () => {
    const port = await server.start();
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    hub.end();
    server.stop();
  });

  it('stays up when a media file cannot be read mid-transfer', async () => {
    // A directory passes the stat/size checks but fails on read (EISDIR), which is the
    // same shape as a drive disappearing part way through a cast.
    const unreadable = join(dir, 'gone');
    mkdirSync(unreadable, { recursive: true });
    const media = server.registerMedia(unreadable);

    await fetch(server.mediaUrl('127.0.0.1', media)).then(
      (r) => r.arrayBuffer().catch(() => undefined),
      () => undefined,
    );

    // The important assertion: the process is still alive and still serving.
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });

  it('stays up when a phone remote drops its connection abruptly', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/remote?token=${server.remoteToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // Rip the TCP socket out from under it, the way a phone leaving Wi-Fi does.
    const raw = (ws as unknown as { _socket?: { destroy(err?: Error): void } })._socket;
    raw?.destroy(new Error('connection reset'));
    await new Promise((r) => setTimeout(r, 400));

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
  });

  it('rejects a phone remote with the wrong token', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/remote?token=not-the-token`);
    const failed = await new Promise<boolean>((resolve) => {
      ws.once('open', () => resolve(false));
      ws.once('error', () => resolve(true));
      ws.once('close', () => resolve(true));
    });
    expect(failed).toBe(true);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
