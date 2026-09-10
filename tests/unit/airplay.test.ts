import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockAirPlayReceiver } from '../mocks/airplayReceiver';
import { AirPlayClient, PairingRequiredError } from '../../src/main/airplay/client';

const TXT_V2 = { features: '0x5A7FDFD5,0x3C175FDE', flags: '0x244', model: 'MockTV1,1', pi: 'mock-pi' };

describe('AirPlay client against mock receiver', () => {
  let transientRx: MockAirPlayReceiver;
  let pinRx: MockAirPlayReceiver;
  beforeAll(async () => {
    transientRx = new MockAirPlayReceiver({ allowTransient: true });
    await transientRx.start();
    pinRx = new MockAirPlayReceiver({ allowTransient: false, pin: '4321' });
    await pinRx.start();
  });
  afterAll(() => {
    transientRx.stop();
    pinRx.stop();
  });

  it('streams a URL over an encrypted AirPlay 2 session using transient pairing', async () => {
    const client = new AirPlayClient({ host: '127.0.0.1', port: transientRx.port, name: 'mock', txt: TXT_V2 });
    await client.connect();
    expect(client.version).toBe(2);
    expect(client.info?.model).toBe('MockTV1,1');
    const playback: any[] = [];
    client.on('playback', (p) => playback.push(p));
    await client.play('http://127.0.0.1:1234/hls/live.m3u8', { monitor: true });
    expect(transientRx.playedUrls).toEqual(['http://127.0.0.1:1234/hls/live.m3u8']);
    expect(transientRx.rate).toBe(1);
    expect(transientRx.log).toContain('SETUP rtsp://127.0.0.1/' + (client as any).sessionId + ' (enc)');
    expect(transientRx.log.some((l) => l.startsWith('RECORD'))).toBe(true);
    expect(transientRx.log).toContain('POST /play (enc)');
    await new Promise((r) => setTimeout(r, 1800));
    expect(playback.length).toBeGreaterThan(0);
    expect(playback[0].duration).toBe(120);
    expect(playback[0].position).toBe(3.5);
    const info = await client.playbackInfo();
    expect(info.rate).toBe(1);
    await client.setRate(0);
    expect(transientRx.rate).toBe(0);
    await client.setVolume(0.5);
    expect(transientRx.log.some((l) => l.startsWith('SET_PARAMETER'))).toBe(true);
    expect(transientRx.eventConnections).toBe(1);
    await client.stop();
    expect(transientRx.stopped).toBe(1);
  });

  it('requires PIN pairing when transient pairing is refused, then streams with stored credentials', async () => {
    let stored: string | undefined;
    const client = new AirPlayClient({ host: '127.0.0.1', port: pinRx.port, name: 'mock-pin', txt: TXT_V2, onCredentials: (c) => (stored = c) });
    await client.connect();
    await expect(client.play('http://x/y.m3u8')).rejects.toBeInstanceOf(PairingRequiredError);
    client.close();

    const pairer = new AirPlayClient({ host: '127.0.0.1', port: pinRx.port, name: 'mock-pin', txt: TXT_V2, onCredentials: (c) => (stored = c) });
    await pairer.connect();
    await pairer.startPairing();
    await expect(pairer.finishPairing('0000')).rejects.toThrow(/wrong PIN|authentication|proof/i);
    pairer.close();

    const pairer2 = new AirPlayClient({ host: '127.0.0.1', port: pinRx.port, name: 'mock-pin', txt: TXT_V2, onCredentials: (c) => (stored = c) });
    await pairer2.connect();
    await pairer2.startPairing();
    const creds = await pairer2.finishPairing('4321');
    expect(creds.split(':').length).toBe(4);
    expect(stored).toBe(creds);
    expect(pinRx.pairedClients.size).toBe(1);

    const client2 = new AirPlayClient({ host: '127.0.0.1', port: pinRx.port, name: 'mock-pin', txt: TXT_V2, credentials: creds });
    await client2.connect();
    await client2.play('http://127.0.0.1:1234/hls/live.m3u8', { monitor: false });
    expect(pinRx.playedUrls).toEqual(['http://127.0.0.1:1234/hls/live.m3u8']);
    expect(pinRx.log).toContain('POST /pair-verify');
    expect(pinRx.log).toContain('POST /play (enc)');
    await client2.stop();
  });

  it('falls back to the legacy AirPlay 1 /play flow for v1 receivers', async () => {
    const legacy = new MockAirPlayReceiver({});
    await legacy.start();
    try {
      const client = new AirPlayClient({ host: '127.0.0.1', port: legacy.port, name: 'legacy', txt: { features: '0x5A7FFFF7', flags: '0x4' }, forceVersion: 1 });
      await client.connect();
      expect(client.version).toBe(1);
      await client.play('http://127.0.0.1:1234/movie.mp4', { monitor: false });
      expect(legacy.playedUrls).toEqual(['http://127.0.0.1:1234/movie.mp4']);
      expect(legacy.log).toContain('POST /play');
      await client.scrub(10);
      await client.stop();
      expect(legacy.stopped).toBe(1);
    } finally {
      legacy.stop();
    }
  });
});
