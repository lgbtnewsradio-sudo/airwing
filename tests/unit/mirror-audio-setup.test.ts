import { describe, it, expect, vi } from 'vitest';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import { randomBytes } from 'node:crypto';
import { MirrorClient } from '../../src/main/airplay/mirror';
import type { AirPlayConnection } from '../../src/main/airplay/connection';

describe('mirroring audio negotiation', () => {
  it.each(['modern', 'legacy', 'rejected', 'disabled'])('handles %s audio setup without changing video setup', async (mode) => {
    const requests: Array<{ method: string; body: Record<string, any> | null; text: string }> = [];
    const connection = {
      localAddress: '127.0.0.1',
      post: async () => ({ code: 404, message: 'Not found', body: Buffer.alloc(0), headers: {} }),
      request: async (method: string, _uri: string, options: { body?: Buffer }) => {
        let body: Record<string, any> | null = null;
        if (options.body?.subarray(0, 6).toString() === 'bplist') body = parseBuffer(options.body)[0];
        requests.push({ method, body, text: body ? '' : options.body?.toString() ?? '' });
        let response: Record<string, unknown> = {};
        let code = 200;
        if (method === 'SETUP') {
          const type = body?.streams?.[0]?.type;
          if (!type) response = { skipRecord: true, timingPeerInfo: { ClockID: 1 } };
          if (type === 96) {
            if (mode === 'rejected') code = 400;
            else if (mode === 'modern') response = { streams: [{ type: 96, streamConnections: {
              streamConnectionTypeRTP: { streamConnectionKeyPort: 12345 }, streamConnectionTypeRTCP: { streamConnectionKeyPort: 12346 },
            } }] };
            else response = { streams: [{ type: 96, dataPort: 12345, controlPort: 12346 }] };
          }
          if (type === 110) response = { streams: [{ type: 110, dataPort: 12347 }] };
        }
        return { code, message: 'OK', headers: {}, body: bplistCreator(response) };
      },
    };
    const connectVideo = vi.spyOn(MirrorClient.prototype as unknown as { connectData: (port: number) => Promise<void> }, 'connectData').mockResolvedValue();
    const mirror = new MirrorClient({ host: '127.0.0.1', port: 7000, name: 'test', senderName: 'test',
      conn: connection as unknown as AirPlayConnection, keys: { shared: randomBytes(32), outKey: randomBytes(32), inKey: randomBytes(32) }, info: null, audioEnabled: mode !== 'disabled' });
    try {
      await mirror.start();
      const audio = requests.find((request) => request.body?.streams?.[0]?.type === 96)!.body!.streams[0];
      expect(audio.ct).toBe(2); expect(audio.spf).toBe(352); expect(audio.sr).toBe(44100);
      expect(audio.latencyMax).toBe(mode === 'disabled' ? 88200 : 3748);
      expect(audio.shk.length).toBe(32); expect(audio.isMedia).toBe(false); expect(audio.usingScreen).toBe(true);
      expect(audio.streamConnections.streamConnectionTypeRTCP.streamConnectionKeyPort > 0).toBe(mode !== 'disabled');
      expect(connectVideo).toHaveBeenCalledWith(12347);
      const volumeCalls = requests.filter((request) => request.method === 'SET_PARAMETER');
      expect(volumeCalls.length).toBe(mode === 'modern' || mode === 'legacy' ? 1 : 0);
      if (volumeCalls.length) expect(volumeCalls[0].text).toContain('-12.000000');
    } finally { mirror.close(); connectVideo.mockRestore(); }
  });
});
