import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockCastReceiver } from '../mocks/castReceiver';
import { CastClient } from '../../src/main/cast/castClient';

describe('Cast client against mock receiver', () => {
  let rx: MockCastReceiver;
  beforeAll(async () => {
    rx = new MockCastReceiver();
    await rx.start();
  });
  afterAll(() => rx.stop());

  it('launches the Default Media Receiver and loads a live HLS stream', async () => {
    const client = new CastClient({ host: '127.0.0.1', port: rx.port, name: 'mock-cast' });
    const statuses: any[] = [];
    client.on('status', (s) => statuses.push(s));
    await client.load({ url: 'http://127.0.0.1:1234/hls/live.m3u8', contentType: 'application/x-mpegURL', streamType: 'LIVE', title: 'AirWing screen', hlsSegmentFormat: 'fmp4' });
    expect(rx.loaded.length).toBe(1);
    expect(rx.loaded[0]).toMatchObject({ contentId: 'http://127.0.0.1:1234/hls/live.m3u8', contentType: 'application/x-mpegURL', streamType: 'LIVE', hlsSegmentFormat: 'fmp4', hlsVideoSegmentFormat: 'fmp4' });
    expect(rx.loaded[0].metadata.title).toBe('AirWing screen');
    expect(rx.log).toContain('receiver:LAUNCH');
    expect(rx.log).toContain('media:LOAD');
    expect(statuses[0].playerState).toBe('PLAYING');
    await client.pause();
    expect(rx.playerState).toBe('PAUSED');
    await client.play();
    expect(rx.playerState).toBe('PLAYING');
    await client.seek(12);
    expect(rx.currentTime).toBe(12);
    await client.setVolume(0.3);
    expect(rx.volume.level).toBe(0.3);
    await client.setMuted(true);
    expect(rx.volume.muted).toBe(true);
    await client.stop();
    expect(rx.stopRequests).toBe(1);
    expect(client.connected).toBe(false);
  });

  it('joins an already running receiver session instead of relaunching', async () => {
    const a = new CastClient({ host: '127.0.0.1', port: rx.port, name: 'a' });
    await a.load({ url: 'http://x/1.mp4', contentType: 'video/mp4', streamType: 'BUFFERED' });
    const launches = rx.log.filter((l) => l === 'receiver:LAUNCH').length;
    const b = new CastClient({ host: '127.0.0.1', port: rx.port, name: 'b' });
    await b.load({ url: 'http://x/2.mp4', contentType: 'video/mp4', streamType: 'BUFFERED' });
    expect(rx.log.filter((l) => l === 'receiver:LAUNCH').length).toBe(launches);
    expect(rx.loaded.length).toBe(3);
    a.close();
    await b.stop();
  });
});
