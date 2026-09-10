/**
 * Live network test (opt-in): discovers AirPlay receivers on the LAN and performs a full
 * AirPlay 2 control-session handshake (transient pairing, encrypted channel, SETUP,
 * RECORD, feedback, TEARDOWN) against speakers that allow transient pairing.
 * It never sends /play, so nothing is shown or heard on the receiver.
 *
 *   AIRWING_LIVE=1 npx vitest run tests/live
 */

import { describe, it, expect } from 'vitest';
import { Discovery } from '../../src/main/discovery';
import { AirPlayClient, PairingRequiredError } from '../../src/main/airplay/client';
import type { Device } from '../../src/shared/types';

const live = process.env.AIRWING_LIVE === '1';

describe.skipIf(!live)('live AirPlay receivers', () => {
  it('discovers receivers and completes a transient AirPlay 2 session with speakers', async () => {
    const d = new Discovery();
    d.start();
    await new Promise((r) => setTimeout(r, 6000));
    d.stop();
    const devices = d.list().filter((x): x is Device => x.kind === 'airplay');
    console.log('discovered:', devices.map((x) => `${x.name} [${x.model}] ${x.host}:${x.port} v${x.caps.airplayVersion} transient=${x.caps.transientPairing} pin=${x.caps.pairingRequired}`).join('\n  '));
    expect(devices.length).toBeGreaterThan(0);
    for (const dev of devices) {
      const client = new AirPlayClient({ host: dev.host, port: dev.port, name: dev.name, txt: dev.txt, senderName: 'AirWing live test' });
      await client.connect();
      console.log(`${dev.name}: /info ok, model=${client.info?.model} sourceVersion=${client.info?.sourceVersion} statusFlags=0x${Number(client.info?.statusFlags ?? 0).toString(16)}`);
      expect(client.info?.model).toBeTruthy();
      if (!dev.caps.video && dev.caps.transientPairing) {
        // Speaker (HomePod): transient pairing needs no on-screen code and nothing is audible.
        await client.authenticate();
        console.log(`${dev.name}: transient pairing + encryption OK`);
        const setup = await (client as any).setupV2();
        void setup;
        const rec = await (client as any).rtsp('RECORD', null, undefined, true);
        console.log(`${dev.name}: SETUP ok, RECORD -> ${rec.code}, event channel=${(client as any).eventSocket ? 'connected' : 'none'}`);
        expect(rec.code).toBeLessThan(500);
        await new Promise((r) => setTimeout(r, 2500));
        const info = await client.playbackInfo();
        console.log(`${dev.name}: playback-info ->`, JSON.stringify(info.raw).slice(0, 200));
        await (client as any).rtsp('TEARDOWN', null, undefined, true);
      } else {
        console.log(`${dev.name}: video receiver requiring an on-screen code; handshake skipped to avoid showing a PIN dialog`);
        expect(dev.caps.pairingRequired || dev.caps.transientPairing).toBe(true);
      }
      client.close();
    }
  }, 60000);

  it('reports PairingRequiredError type is exported', () => {
    expect(PairingRequiredError.name).toBe('PairingRequiredError');
  });
});
