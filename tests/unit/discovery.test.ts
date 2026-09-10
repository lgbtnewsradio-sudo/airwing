import { describe, it, expect } from 'vitest';
import { Discovery, airplayCaps, castCaps, parseFeatures, parseTxt, deviceKey } from '../../src/main/discovery';

describe('discovery', () => {
  it('parses 64-bit AirPlay feature strings', () => {
    expect(parseFeatures('0x5A7FDFD5,0x3C175FDE')).toBe(0x3c175fde5a7fdfd5n);
    expect(parseFeatures('0x7F8AD0')).toBe(0x7f8ad0n);
    expect(parseFeatures(undefined)).toBe(0n);
  });

  it('derives capabilities for an Apple TV, a HomePod and a Roku', () => {
    const atv = airplayCaps({ features: '0x5A7FDFD5,0x3C175FDE', flags: '0x118644', model: 'AppleTV5,3' }, false);
    expect(atv.video).toBe(true);
    expect(atv.airplayVersion).toBe(2);
    expect(atv.transientPairing).toBe(true);
    expect(atv.pairingRequired).toBe(true);
    const homepod = airplayCaps({ features: '0x4A7FCA00,0x3C356BD0', flags: '0x98404', model: 'AudioAccessory5,1' }, false);
    expect(homepod.video).toBe(false);
    expect(homepod.pairingRequired).toBe(false);
    expect(homepod.transientPairing).toBe(true);
    const roku = airplayCaps({ features: '0x7F8AD0,0x38BCF46', flags: '0x244', model: 'C158X' }, true);
    expect(roku.video).toBe(true);
    expect(roku.paired).toBe(true);
    const legacy = airplayCaps({ features: '0x5A7FFFF7', flags: '0x4', model: 'AppleTV3,2' }, false);
    expect(legacy.airplayVersion).toBe(1);
  });

  it('derives Cast capabilities', () => {
    expect(castCaps({ ca: '4101', md: 'Chromecast' }).video).toBe(true);
    expect(castCaps({ ca: '2052', md: 'Google Home Mini' }).video).toBe(false);
  });

  it('parses TXT records and builds device keys', () => {
    expect(parseTxt([Buffer.from('fn=Living Room TV'), Buffer.from('ca=4101'), Buffer.from('flag')])).toEqual({ fn: 'Living Room TV', ca: '4101', flag: '' });
    expect(deviceKey('airplay', { pi: 'abc' }, '1.2.3.4')).toBe('airplay:abc');
    expect(deviceKey('cast', { id: 'xyz' }, '1.2.3.4')).toBe('cast:xyz');
    expect(deviceKey('airplay', {}, '1.2.3.4')).toBe('airplay:1.2.3.4');
  });

  it('assembles devices from PTR/SRV/TXT/A records across packets', () => {
    const d = new Discovery({ isPaired: () => false, interfaces: [] });
    const changes: number[] = [];
    d.on('change', (list) => changes.push(list.length));
    d.onResponse({ answers: [{ name: '_airplay._tcp.local', type: 'PTR', data: "Dallas's Apple TV._airplay._tcp.local" }] }, '192.168.1.67');
    expect(d.list().length).toBe(0);
    d.onResponse(
      {
        answers: [
          { name: "Dallas's Apple TV._airplay._tcp.local", type: 'SRV', data: { target: 'Dallass-Apple-TV.local', port: 7000 } },
          { name: "Dallas's Apple TV._airplay._tcp.local", type: 'TXT', data: [Buffer.from('features=0x5A7FDFD5,0x3C175FDE'), Buffer.from('flags=0x118644'), Buffer.from('model=AppleTV5,3'), Buffer.from('pi=c032716b')] },
        ],
        additionals: [{ name: 'Dallass-Apple-TV.local', type: 'A', data: '192.168.1.67' }],
      },
      '192.168.1.67',
    );
    const list = d.list();
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ kind: 'airplay', name: "Dallas's Apple TV", host: '192.168.1.67', port: 7000, model: 'AppleTV5,3' });
    expect(list[0].caps.video).toBe(true);
    // Cast device using fn/id
    d.onResponse(
      {
        answers: [
          { name: '_googlecast._tcp.local', type: 'PTR', data: 'Chromecast-abc._googlecast._tcp.local' },
          { name: 'Chromecast-abc._googlecast._tcp.local', type: 'SRV', data: { target: 'abc.local', port: 8009 } },
          { name: 'Chromecast-abc._googlecast._tcp.local', type: 'TXT', data: [Buffer.from('id=abc'), Buffer.from('fn=Bedroom TV'), Buffer.from('md=Chromecast Ultra'), Buffer.from('ca=4101')] },
          { name: 'abc.local', type: 'A', data: '192.168.1.50' },
        ],
      },
      '192.168.1.50',
    );
    const cast = d.list().find((x) => x.kind === 'cast')!;
    expect(cast).toMatchObject({ id: 'cast:abc', name: 'Bedroom TV', host: '192.168.1.50', port: 8009, model: 'Chromecast Ultra' });
    expect(changes.length).toBeGreaterThanOrEqual(2);
    // RAOP-only device is hidden when the same host has an _airplay record
    d.onResponse(
      {
        answers: [
          { name: '_raop._tcp.local', type: 'PTR', data: "AAA126A44DF1@Dallas's Apple TV._raop._tcp.local" },
          { name: "AAA126A44DF1@Dallas's Apple TV._raop._tcp.local", type: 'SRV', data: { target: 'Dallass-Apple-TV.local', port: 7000 } },
          { name: "AAA126A44DF1@Dallas's Apple TV._raop._tcp.local", type: 'TXT', data: [Buffer.from('am=AppleTV5,3')] },
        ],
      },
      '192.168.1.67',
    );
    expect(d.list().filter((x) => x.kind === 'raop').length).toBe(0);
    d.stop();
  });
});
