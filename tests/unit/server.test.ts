import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { StreamHub } from '../../src/main/streamHub';
import { LocalServer } from '../../src/main/server';
import { SessionManager } from '../../src/main/sessions';
import { CredentialStore } from '../../src/main/settings';
import { Fmp4Muxer } from '../../src/shared/fmp4';
import { MockAirPlayReceiver } from '../mocks/airplayReceiver';
import { MockCastReceiver } from '../mocks/castReceiver';
import type { Device } from '../../src/shared/types';

const AVCC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x05, 0x67, 0x64, 0x00, 0x28, 0xac, 0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80]);

function feed(hub: StreamHub, seconds: number): void {
  hub.setMeta({ encoder: { videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2', width: 640, height: 360, frameRate: 30, videoBitrate: 2_000_000, audioBitrate: 128000 }, codecs: 'avc1.640028,mp4a.40.2', mime: 'video/mp4; codecs="avc1.640028,mp4a.40.2"', audioOnly: false });
  const muxer = new Fmp4Muxer({
    video: { codec: 'avc', width: 640, height: 360, description: AVCC },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, description: new Uint8Array([0x11, 0x90]) },
    onData: (d, i) => hub.push(Buffer.from(d), i),
  });
  muxer.start();
  const frames = Math.round(seconds * 30);
  for (let i = 0; i <= frames; i++) {
    muxer.addVideoSample(new Uint8Array([0, 0, 0, 1, i % 30 === 0 ? 0x65 : 0x41]), i * 33333, i % 30 === 0);
    if (i % 2 === 0) muxer.addAudioSample(new Uint8Array([1, 2, 3]), i * 33333, 21333);
  }
}

describe('local server + stream hub', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airwing-'));
  writeFileSync(join(dir, 'movie.mp4'), Buffer.alloc(5000, 7));
  const hub = new StreamHub();
  const server = new LocalServer({ port: 0, bindAddress: '127.0.0.1', hub, staticDir: join(process.cwd(), 'resources'), requireCode: () => false, deviceName: () => 'Test PC' });
  let base = '';
  beforeAll(async () => {
    const port = await server.start();
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => {
    hub.end();
    server.stop();
  });

  it('serves the receiver pages and info', async () => {
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('AirWing receiver');
    const remote = await (await fetch(base + '/remote')).text();
    expect(remote).toContain('remote');
    const info: any = await (await fetch(base + '/api/info')).json();
    expect(info).toMatchObject({ name: 'Test PC', streaming: false, hlsReady: false });
  });

  it('returns 404 for HLS until enough segments exist, then a valid playlist', async () => {
    expect((await fetch(base + '/hls/live.m3u8')).status).toBe(404);
    feed(hub, 8);
    expect(hub.segmenter.ready).toBe(true);
    const res = await fetch(base + '/hls/live.m3u8');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const playlist = await res.text();
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
    const seg = /seg-(\d+)\.m4s/.exec(playlist)![1];
    const segRes = await fetch(`${base}/hls/seg-${seg}.m4s`);
    expect(segRes.status).toBe(200);
    expect((await segRes.arrayBuffer()).byteLength).toBeGreaterThan(100);
    const init = await fetch(base + '/hls/init.mp4');
    expect(init.status).toBe(200);
    expect(Buffer.from(await init.arrayBuffer()).subarray(4, 8).toString()).toBe('ftyp');
    const info: any = await (await fetch(base + '/api/info')).json();
    expect(info.streaming).toBe(true);
    expect(info.codecs).toBe('avc1.640028,mp4a.40.2');
  });

  it('tells receivers to start behind the live edge so they can build a buffer', async () => {
    const playlist = await (await fetch(base + '/hls/live.m3u8')).text();
    // Without a cushion a Chromecast sits at the edge and rebuffers continuously.
    const m = /#EXT-X-START:TIME-OFFSET=-([0-9.]+)/.exec(playlist);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(playlist).toContain('#EXT-X-TARGETDURATION:1');
  });

  it('flags the capturing machine so its own browser page mutes and cannot feed back', async () => {
    // The test client is on loopback, i.e. the same machine that is capturing.
    const info: any = await (await fetch(base + '/api/info')).json();
    expect(info.sameMachine).toBe(true);
    expect(server.isSameMachine('192.168.99.99')).toBe(false);
    expect(server.isSameMachine('::ffff:127.0.0.1')).toBe(true);
  });

  it('serves a multivariant master playlist naming codecs, resolution and frame rate', async () => {
    const res = await fetch(base + '/hls/master.m3u8');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const master = await res.text();
    expect(master).toContain('#EXTM3U');
    expect(master).toContain('#EXT-X-STREAM-INF:');
    expect(master).toContain('CODECS="avc1.640028,mp4a.40.2"');
    expect(master).toContain('RESOLUTION=640x360');
    expect(master).toContain('FRAME-RATE=30.000');
    // The single variant points at the media playlist.
    expect(master.trim().split('\n').pop()).toBe('live.m3u8');
  });

  it('streams init + GOP + live fragments to WebSocket viewers with a binary header', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/view');
    const frames: Array<{ kind: number; key: number; len: number }> = [];
    let meta: any = null;
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          meta = JSON.parse(data.toString());
          return;
        }
        const buf = data as Buffer;
        frames.push({ kind: buf[0], key: buf[1], len: buf.length - 10 });
        if (frames.length > 5) resolve();
      });
      ws.on('error', reject);
    });
    expect(meta.type).toBe('meta');
    expect(meta.mime).toContain('avc1.640028');
    expect(frames[0].kind).toBe(0); // init first
    expect(frames[1].kind === 1 && frames[1].key === 1).toBe(true); // then the keyframe that starts the GOP
    // Live fragment arrives after the snapshot
    const before = frames.length;
    hub.push(Buffer.from([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66]), { kind: 'video', keyframe: false, timestampUs: 99, durationUs: 33333, sequence: 999 });
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.length).toBe(before + 1);
    expect(hub.viewers).toBe(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(hub.viewers).toBe(0);
  });

  it('serves media files with range requests', async () => {
    const media = server.registerMedia(join(dir, 'movie.mp4'));
    const url = server.mediaUrl('127.0.0.1', media);
    expect(url).toMatch(/\/media\/[0-9a-f]+\.mp4$/);
    const full = await fetch(url);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect((await full.arrayBuffer()).byteLength).toBe(5000);
    const part = await fetch(url, { headers: { Range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/5000');
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const bad = await fetch(url, { headers: { Range: 'bytes=9999-' } });
    expect(bad.status).toBe(416);
  });

  it('SessionManager streams the live HLS URL to AirPlay and Cast receivers and plays files directly', async () => {
    const airplay = new MockAirPlayReceiver({ allowTransient: true });
    await airplay.start();
    const cast = new MockCastReceiver();
    await cast.start();
    const sessions = new SessionManager({ hub, server, credentials: new CredentialStore(dir), senderName: () => 'Test PC' });
    const changes: number[] = [];
    sessions.on('change', (l) => changes.push(l.length));
    const atv: Device = { id: 'airplay:mock', kind: 'airplay', name: 'Mock TV', host: '127.0.0.1', port: airplay.port, txt: { features: '0x5A7FDFD5,0x3C175FDE', flags: '0x244' }, lastSeen: 0, caps: { video: true, audio: true, pairingRequired: false, transientPairing: true, paired: false } };
    const cc: Device = { id: 'cast:mock', kind: 'cast', name: 'Mock Cast', host: '127.0.0.1', port: cast.port, txt: {}, lastSeen: 0, caps: { video: true, audio: true, pairingRequired: false, transientPairing: false, paired: true } };
    try {
      const s1 = await sessions.connect(atv, { type: 'live' });
      expect(s1.state).toBe('streaming');
      expect(airplay.playedUrls[0]).toBe(`http://127.0.0.1:${server.port}/hls/master.m3u8`);
      const s2 = await sessions.connect(cc, { type: 'live' });
      expect(s2.state).toBe('streaming');
      expect(cast.loaded[0].contentId).toBe(`http://127.0.0.1:${server.port}/hls/master.m3u8`);
      expect(cast.loaded[0].streamType).toBe('LIVE');
      expect(sessions.count).toBe(2);
      await sessions.mediaControl('cast:mock', { type: 'volume', volume: 0.4 });
      expect(cast.volume.level).toBe(0.4);
      await sessions.disconnect('airplay:mock');
      expect(airplay.stopped).toBe(1);
      const s3 = await sessions.connect(cc, { type: 'file', path: join(dir, 'movie.mp4') });
      expect(s3.state).toBe('streaming');
      expect(s3.transport).toBe('cast-file');
      expect(cast.loaded[cast.loaded.length - 1]).toMatchObject({ contentType: 'video/mp4', streamType: 'BUFFERED' });
      await sessions.disconnectAll();
      expect(sessions.count).toBe(0);
      expect(changes.length).toBeGreaterThan(3);
    } finally {
      airplay.stop();
      cast.stop();
    }
  });
});
