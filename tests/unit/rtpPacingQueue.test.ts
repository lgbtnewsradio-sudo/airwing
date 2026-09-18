import { describe, it, expect } from 'vitest';
import { RtpPacingQueue } from '../../src/main/cast/rtpPacingQueue';

/**
 * The bounded-queue/wall-clock-timestamp guarantees are the whole point of this module: an
 * unbounded queue silently turns encoder backlog into accumulating lag, and timestamps that
 * drift from real time make the receiver's own playout-buffer defenses kick in. Both failure
 * modes are invisible from outside a running session (no error, just growing delay), so they're
 * worth pinning down here rather than only on real hardware.
 */
describe('RtpPacingQueue', () => {
  it('breaks an overloaded delta chain and requests a keyframe instead of sending a frame whose reference was dropped', () => {
    let keyframeRequests = 0;
    const queue = new RtpPacingQueue(0, () => undefined, undefined, () => keyframeRequests++);
    for (let i = 1; i <= 10; i++) {
      queue.enqueue({ data: new Uint8Array([i]), keyFrame: false, frameId: i, referencedFrameId: i - 1 });
    }
    expect((queue as any).queue.length).toBe(0);
    expect(keyframeRequests).toBe(1);
    // Deltas are ignored until a clean reference frame arrives.
    queue.enqueue({ data: new Uint8Array([11]), keyFrame: false, frameId: 11, referencedFrameId: 10 });
    expect((queue as any).queue.length).toBe(0);
    queue.enqueue({ data: new Uint8Array([12]), keyFrame: true, frameId: 12, referencedFrameId: 12 });
    expect((queue as any).queue.map((f: any) => f.frameId)).toEqual([12]);
  });

  it('clears the queue when a keyframe is enqueued', () => {
    const queue = new RtpPacingQueue(0, () => undefined);
    queue.enqueue({ data: new Uint8Array([1]), keyFrame: false, frameId: 1, referencedFrameId: 0 });
    queue.enqueue({ data: new Uint8Array([2]), keyFrame: false, frameId: 2, referencedFrameId: 1 });
    queue.enqueue({ data: new Uint8Array([3]), keyFrame: true, frameId: 3, referencedFrameId: 3 });
    expect((queue as any).queue.length).toBe(1);
    expect((queue as any).queue[0].frameId).toBe(3);
  });

  it('drops a stale dependency chain and requests a new keyframe', async () => {
    const dispatched: number[] = [];
    let keyframeRequests = 0;
    const queue = new RtpPacingQueue(0, (frame) => dispatched.push(frame.frameId), undefined, () => keyframeRequests++);
    queue.enqueue({ data: new Uint8Array([1]), keyFrame: true, frameId: 1, referencedFrameId: 1 });
    await new Promise((r) => setTimeout(r, 250)); // well past the 150ms age bound
    queue.enqueue({ data: new Uint8Array([2]), keyFrame: false, frameId: 2, referencedFrameId: 1 });
    queue.start();
    await new Promise((r) => setTimeout(r, 150));
    queue.stop();
    expect(dispatched).toEqual([]);
    expect(keyframeRequests).toBe(1);
  });

  it('produces strictly increasing, wall-clock-derived RTP timestamps across dispatches', async () => {
    const timestamps: number[] = [];
    const queue = new RtpPacingQueue(0, (_frame, rtpTimestamp) => timestamps.push(rtpTimestamp));
    queue.start();
    try {
      for (let i = 1; i <= 3; i++) {
        queue.enqueue({ data: new Uint8Array([i]), keyFrame: i === 1, frameId: i, referencedFrameId: i === 1 ? i : i - 1 });
        await new Promise((r) => setTimeout(r, 40));
      }
    } finally {
      queue.stop();
    }
    expect(timestamps.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
  });

  it('reports the current RTP timestamp for RTCP use even with an empty queue', async () => {
    const queue = new RtpPacingQueue(1000, () => undefined);
    expect(queue.currentRtpTimestamp()).toBe(1000); // not running yet: holds at the origin
    queue.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(queue.currentRtpTimestamp()).toBeGreaterThan(1000);
    queue.stop();
  });
});
