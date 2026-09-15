import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockCastReceiver, type MockCastReceiverOptions } from '../mocks/castReceiver';
import { SessionManager } from '../../src/main/sessions';
import { StreamHub } from '../../src/main/streamHub';
import { LocalServer } from '../../src/main/server';
import { CredentialStore } from '../../src/main/settings';
import type { Device } from '../../src/shared/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The "receiver cannot reach this PC" watchdog must judge a receiver from the moment the LOAD
 * command goes out. Starting the clock before the receiver app launched made a Sony Bravia
 * (19 s app launch) look unreachable, and the session was torn down while the TV was already
 * fetching segments. It must still catch a receiver that genuinely never fetches anything.
 */
describe('cast reachability watchdog', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airwing-reach-'));
  const media = join(dir, 'clip.mp4');
  writeFileSync(media, Buffer.alloc(4096));
  const credentials = new CredentialStore(dir);

  /**
   * A fresh server per test. The fetch counter is keyed by client address and every mock here
   * is 127.0.0.1, so a late request from one test would otherwise satisfy another's watchdog.
   */
  async function harness(rxOpts: MockCastReceiverOptions, reachTimeoutMs: number) {
    const hub = new StreamHub();
    const server = new LocalServer({ port: 0, bindAddress: '127.0.0.1', hub, staticDir: join(process.cwd(), 'resources'), requireCode: () => false, deviceName: () => 'PC' });
    await server.start();
    const rx = new MockCastReceiver(rxOpts);
    await rx.start();
    const sessions = new SessionManager({ hub, server, credentials, senderName: () => 'PC', reachTimeoutMs });
    const device: Device = {
      id: `cast:${rx.port}`,
      kind: 'cast',
      name: 'Mock Cast',
      host: '127.0.0.1',
      port: rx.port,
      txt: {},
      lastSeen: 0,
      caps: { video: true, audio: true, pairingRequired: false, transientPairing: false, paired: false },
    };
    const close = async () => {
      await sessions.disconnect(device.id);
      rx.stop();
      server.stop();
    };
    return { rx, sessions, device, close };
  }

  it('does not call a slow-launching receiver unreachable once it fetches the stream', async () => {
    // Launch takes longer than the whole watchdog window, like the Bravia did.
    const { rx, sessions, device, close } = await harness({ launchDelayMs: 600, fetchOnLoad: true }, 250);
    try {
      const info = await sessions.connect(device, { type: 'file', path: media });
      expect(info.error).toBeUndefined();
      expect(info.state).toBe('streaming');
      // Outlast the watchdog: a receiver that fetched the stream must stay connected.
      await sleep(700);
      expect(rx.fetched.length).toBeGreaterThan(0);
      expect(sessions.get(device.id)?.state).toBe('streaming');
      expect(sessions.get(device.id)?.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('still reports a receiver that never fetches anything as unreachable', async () => {
    const { sessions, device, close } = await harness({ fetchOnLoad: false }, 250);
    try {
      await sessions.connect(device, { type: 'file', path: media });
      await sleep(700);
      const info = sessions.get(device.id);
      expect(info?.state).toBe('error');
      expect(info?.error).toMatch(/cannot reach AirWing/);
    } finally {
      await close();
    }
  });
});
