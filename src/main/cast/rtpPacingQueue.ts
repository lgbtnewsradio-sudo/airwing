export interface RtpQueuedFrame {
  data: Uint8Array;
  keyFrame: boolean;
  frameId: number;
  referencedFrameId: number;
  enqueuedAtMs: number;
  captureTimestampUs?: number;
}

/** Wall-clock cadence the queue drains at: 30fps, matching the stream's target frame rate. */
const FRAME_INTERVAL_MS = 1000 / 30;
const RTP_CLOCK_HZ = 90000;
/** Never hold more than this many frames — past this we'd rather drop than add delay. */
const MAX_QUEUE_DEPTH = 4;
/** Never hold a frame older than this. At 30fps ~4-5 frames and 150ms land in the same place;
 *  age is the more direct measure of what actually matters (added latency), so it's enforced
 *  directly rather than only approximated via a frame count. */
const MAX_QUEUE_AGE_MS = 150;
const RESYNC_THRESHOLD_MS = FRAME_INTERVAL_MS * 4;

/**
 * Sends one queued frame per wall-clock tick at a fixed ~33ms cadence, deriving each frame's
 * RTP timestamp from elapsed wall-clock time since streaming began — not from capture
 * timestamps, and not from a fixed per-frame increment — so the RTP clock cannot drift out of
 * sync with real time regardless of how irregular production is upstream. The queue is bounded
 * by both count and age: under any backlog it sheds toward the newest frame rather than
 * growing, since an unbounded queue is itself indistinguishable from added lag once it's deep
 * enough. A stale unsent frame is worth less than a fresh one even though already-sent frames
 * can now be repaired from the retransmission cache.
 */
export class RtpPacingQueue {
  private readonly queue: RtpQueuedFrame[] = [];
  private timer: NodeJS.Timeout | null = null;
  private nextSendAtMs = 0;
  private running = false;
  private readonly rtpOrigin: number;
  private originWallMs = 0;
  private lastRtpTimestamp: number;
  /** Once a delta chain is broken, only a new keyframe is safe to send. */
  private waitingForKeyframe = false;

  constructor(
    rtpOrigin: number,
    private readonly onDequeue: (frame: RtpQueuedFrame, rtpTimestamp: number) => void,
    private readonly onQueueSample?: (depth: number, oldestAgeMs: number) => void,
    private readonly onKeyframeNeeded?: () => void,
  ) {
    this.rtpOrigin = rtpOrigin >>> 0;
    this.lastRtpTimestamp = this.rtpOrigin;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.originWallMs = performance.now();
    this.nextSendAtMs = this.originWallMs;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
  }

  enqueue(frame: Omit<RtpQueuedFrame, 'enqueuedAtMs'>): void {
    const queued: RtpQueuedFrame = { ...frame, enqueuedAtMs: performance.now() };
    if (frame.keyFrame) {
      this.queue.length = 0;
      this.waitingForKeyframe = false;
    } else if (this.waitingForKeyframe) {
      return;
    } else if (this.queue.length >= MAX_QUEUE_DEPTH) {
      // The next delta frame refers to the one we would remove. Sending it anyway forces the
      // receiver to wait for a future keyframe, creating exactly the multi-second latency this
      // queue exists to prevent. Drop the whole undecodable chain and obtain a fresh keyframe.
      this.breakDependencyChain();
      return;
    }
    this.queue.push(queued);
  }

  /** Called when RTCP reports meaningful loss: shed backlog immediately instead of waiting for
   *  the age-based drop, since stale frames are actively counterproductive once loss is real. */
  dropToNewest(): void {
    if (this.queue.length > 1) this.breakDependencyChain();
  }

  /** The RTP timestamp corresponding to right now — used for RTCP Sender Reports too, so the
   *  clock mapping they advertise can never disagree with what's actually on data packets. */
  currentRtpTimestamp(): number {
    if (!this.running) return this.lastRtpTimestamp;
    const elapsedMs = performance.now() - this.originWallMs;
    return (this.rtpOrigin + Math.round((elapsedMs * RTP_CLOCK_HZ) / 1000)) >>> 0;
  }

  private dropExpired(): void {
    const now = performance.now();
    if (this.queue.length > 1 && now - this.queue[0].enqueuedAtMs > MAX_QUEUE_AGE_MS) this.breakDependencyChain();
  }

  private breakDependencyChain(): void {
    this.queue.length = 0;
    if (this.waitingForKeyframe) return;
    this.waitingForKeyframe = true;
    this.onKeyframeNeeded?.();
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const delay = Math.max(0, this.nextSendAtMs - performance.now());
    this.timer = setTimeout(() => this.sendNext(), delay);
  }

  private sendNext(): void {
    this.nextSendAtMs += FRAME_INTERVAL_MS;
    this.dropExpired();
    const frame = this.queue.shift();
    const oldestAgeMs = this.queue.length > 0 ? performance.now() - this.queue[0].enqueuedAtMs : 0;
    this.onQueueSample?.(this.queue.length, oldestAgeMs);
    if (frame) {
      let rtpTimestamp = this.currentRtpTimestamp();
      if (rtpTimestamp === this.lastRtpTimestamp) rtpTimestamp = (rtpTimestamp + 1) >>> 0;
      this.lastRtpTimestamp = rtpTimestamp;
      this.onDequeue(frame, rtpTimestamp);
    }
    if (performance.now() - this.nextSendAtMs > RESYNC_THRESHOLD_MS) {
      this.nextSendAtMs = performance.now();
    }
    this.scheduleNext();
  }
}
