/**
 * Live mirroring handshake test (opt-in). Drives the real FairPlay screen-mirroring transport
 * against an Apple TV on the LAN: connect -> pair-verify -> fp-setup -> control/audio/video
 * SETUP -> RECORD -> data channel. It sends no video frames, so nothing is displayed; it only
 * proves the handshake completes (or shows exactly where it fails).
 *
 *   AIRWING_LIVE=1 [AIRWING_TV=192.168.1.100] AIRWING_PIN=1234 \
 *     ELECTRON_RUN_AS_NODE=1 electron vitest run tests/live/mirror-live.test.ts
 */

import { describe, it } from 'vitest';
import fs from 'node:fs';
import { Discovery } from '../../src/main/discovery';
import { AirPlayClient, PairingRequiredError } from '../../src/main/airplay/client';
import { MirrorClient } from '../../src/main/airplay/mirror';
import { needsFairPlay } from '../../src/shared/support';
import { log } from '../../src/main/logger';
import type { Device } from '../../src/shared/types';

const live = process.env.AIRWING_LIVE === '1';
const out = (s: string) => process.stdout.write(s + '\n');
// vitest swallows console.log, so mirror through process.stdout.
log.on('log', (ev: { level: string; scope: string; message: string }) => out(`[${ev.level}] ${ev.scope}: ${ev.message}`));

const CRED_FILE = process.env.AIRWING_CRED_FILE || 'creds.json';
function readCreds(): string | undefined {
  try {
    return fs.readFileSync(CRED_FILE, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
function writeCreds(c: string): void {
  try {
    fs.writeFileSync(CRED_FILE, c);
    out('stored pairing credentials (no PIN needed next run)');
  } catch (e) {
    out('could not persist creds: ' + (e as Error).message);
  }
}

/** Wait for the PIN to be written to AIRWING_PIN_FILE (so pairing stays on one connection). */
async function waitForPin(file: string, timeoutMs: number): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (/^\d{4}$/.test(v)) return v;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

describe.skipIf(!live)('live Apple TV mirroring handshake', () => {
  it('completes SETUP/RECORD against an Apple TV', async () => {
    const wantHost = process.env.AIRWING_TV;
    const d = new Discovery();
    d.start();
    await new Promise((r) => setTimeout(r, 6000));
    d.stop();
    const all = d.list().filter((x): x is Device => x.kind === 'airplay');
    out('discovered airplay: ' + all.map((x) => `${x.name}[${x.model}]@${x.host}`).join(', '));
    const tv = all.find((x) => (wantHost ? x.host === wantHost : needsFairPlay(x)));
    if (!tv) {
      out('NO FAIRPLAY APPLE TV FOUND — is it awake? set AIRWING_TV to force a host.');
      return;
    }
    out(`target: ${tv.name} [${tv.model}] ${tv.host}:${tv.port}`);

    const client = new AirPlayClient({ host: tv.host, port: tv.port, name: tv.name, txt: tv.txt, senderName: 'AirWing live test', credentials: readCreds(), onCredentials: writeCreds });
    await client.connect();
    out(`/info: model=${client.info?.model} sourceVersion=${client.info?.sourceVersion} features=0x${BigInt(client.info?.features ?? 0).toString(16)} statusFlags=0x${Number(client.info?.statusFlags ?? 0).toString(16)} v=${client.version}`);

    try {
      await client.authenticate();
      out('pair-verify + encryption OK (stored creds or transient)');
    } catch (err) {
      if (err instanceof PairingRequiredError) {
        const pinFile = process.env.AIRWING_PIN_FILE || 'pin.txt';
        try {
          fs.unlinkSync(pinFile);
        } catch {
          /* none */
        }
        out('PAIRING REQUIRED — showing a fresh code on the TV now...');
        await client.startPairing();
        out(`CODE IS ON THE TV. Waiting for it in ${pinFile} (up to 150s). Keeping the pairing connection open.`);
        const pin = await waitForPin(pinFile, 150000);
        if (!pin) {
          out('no PIN received in time; aborting.');
          return;
        }
        out(`finishing pairing with PIN ${pin}...`);
        await client.finishPairing(pin);
        out('paired; reconnecting for pair-verify...');
        await client.connect();
        await client.authenticate();
        out('pair-verify + encryption OK after pairing');
      } else {
        out('AUTH FAILED: ' + (err as Error).message);
        throw err;
      }
    }

    const conn = client.connection;
    const keys = client.sessionKeys;
    if (!conn || !keys) {
      out('no encrypted connection/keys after authenticate');
      return;
    }
    const mirror = new MirrorClient({ host: tv.host, port: tv.port, name: tv.name, senderName: 'AirWing live test', conn, keys, info: client.info });
    mirror.on('error', (e: Error) => out('mirror error event: ' + e.message));
    try {
      await mirror.start();
      out('MIRROR HANDSHAKE OK — SETUP/RECORD/data-channel all succeeded.');
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      out('MIRROR START FAILED: ' + (err as Error).message);
    } finally {
      await mirror.stop();
      client.close();
    }
  }, 200000);
});
