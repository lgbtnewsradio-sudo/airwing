import { describe, it, expect, afterEach } from 'vitest';
import { MockCastReceiver } from '../mocks/castReceiver';
import { CastClient } from '../../src/main/cast/castClient';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A live Cast session's playback lag behind the live edge is not something a static HLS
 * playlist cushion can hold steady: the Default Media Receiver's own rebuffer-avoidance grows
 * that gap over a session (measured against a Sony Bravia: ~3s drifting past 5s within a
 * minute with zero rebuffering). enableLiveCatchUp actively corrects it with a seek instead.
 */
describe('Cast live catch-up', () => {
  const clients: CastClient[] = [];
  const receivers: MockCastReceiver[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.stop().catch(() => undefined)));
    receivers.splice(0).forEach((r) => r.stop());
  });

  async function setup(): Promise<{ client: CastClient; rx: MockCastReceiver }> {
    const rx = new MockCastReceiver();
    receivers.push(rx);
    await rx.start();
    const client = new CastClient({ host: '127.0.0.1', port: rx.port, name: 'catchup-test' });
    clients.push(client);
    await client.load({ url: 'http://x/live.m3u8', contentType: 'application/x-mpegURL', streamType: 'LIVE' });
    return { client, rx };
  }

  it('does not seek while drift stays within the tolerance', async () => {
    const { client, rx } = await setup();
    client.enableLiveCatchUp(1, 1.5); // target 1s behind, correct only past 1.5s
    rx.setLivePosition(9, 10); // 1s behind: under the 1.5s threshold
    await sleep(2200); // outlast one status-poll cycle (2s)
    expect(rx.seeks.length).toBe(0);
  }, 10000);

  it('seeks to (live edge - target) once drift exceeds the threshold', async () => {
    const { client, rx } = await setup();
    client.enableLiveCatchUp(1, 1.5);
    rx.setLivePosition(5, 10); // 5s behind: well past the 1.5s threshold
    await sleep(2200);
    expect(rx.seeks.length).toBe(1);
    expect(rx.seeks[0]).toBeCloseTo(9, 1); // end(10) - target(1)
  }, 10000);

  it('never seeks while the receiver is buffering, only while playing', async () => {
    const { client, rx } = await setup();
    client.enableLiveCatchUp(1, 1.5);
    rx.playerState = 'BUFFERING';
    rx.setLivePosition(2, 10); // 8s behind, far past threshold, but not playing
    await sleep(2200);
    expect(rx.seeks.length).toBe(0);
  }, 10000);

  it('rate-limits corrections instead of seeking on every poll', async () => {
    const { client, rx } = await setup();
    client.enableLiveCatchUp(1, 1.5);
    rx.setLivePosition(5, 10);
    await sleep(2200); // first correction
    expect(rx.seeks.length).toBe(1);
    rx.setLivePosition(5, 10.1); // still far behind on the very next poll
    await sleep(2200); // well under the 6s minimum interval since the first seek
    expect(rx.seeks.length).toBe(1);
  }, 10000);
});
