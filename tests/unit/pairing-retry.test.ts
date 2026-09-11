import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAirPlayReceiver } from '../mocks/airplayReceiver';
import { SessionManager } from '../../src/main/sessions';
import { StreamHub } from '../../src/main/streamHub';
import { LocalServer } from '../../src/main/server';
import { CredentialStore } from '../../src/main/settings';
import type { Device } from '../../src/shared/types';

describe('pairing retry after a rejected code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airwing-pair-'));
  const hub = new StreamHub();
  const server = new LocalServer({ port: 0, bindAddress: '127.0.0.1', hub, staticDir: join(process.cwd(), 'resources'), requireCode: () => false, deviceName: () => 'PC' });
  const rx = new MockAirPlayReceiver({ allowTransient: false, pin: '2468' });
  beforeAll(async () => {
    await server.start();
    await rx.start();
  });
  afterAll(() => {
    rx.stop();
    server.stop();
  });

  it('requests a new code after a wrong one and then pairs', async () => {
    const sessions = new SessionManager({ hub, server, credentials: new CredentialStore(dir), senderName: () => 'PC' });
    const dev: Device = { id: 'airplay:mock', kind: 'airplay', name: 'Mock TV', host: '127.0.0.1', port: rx.port, txt: { features: '0x5A7FDFD5,0x3C175FDE', flags: '0x244' }, lastSeen: 0, caps: { video: true, audio: true, pairingRequired: true, transientPairing: true, paired: false } };
    await sessions.startPairing(dev);
    await expect(sessions.finishPairing(dev, '0000')).rejects.toThrow(/wrong PIN|authentication/i);
    // A stale second submit must not crash; it re-arms pairing and tells the caller.
    await expect(sessions.finishPairing(dev, '0000')).rejects.toThrow(/expired/);
    // The re-armed session accepts the correct code.
    await sessions.finishPairing(dev, '2468');
    expect(rx.pairedClients.size).toBe(1);
    // Pairing again is idempotent from the UI's perspective: start then finish.
    await sessions.startPairing(dev);
    await sessions.finishPairing(dev, '2468');
    expect(rx.pairedClients.size).toBe(2);
  });
});
