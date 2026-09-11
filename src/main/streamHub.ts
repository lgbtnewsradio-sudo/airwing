/**
 * Central fan-out point for the live stream produced by the renderer's capture
 * pipeline. Keeps the init segment and the current GOP so new MSE viewers can
 * start immediately, and feeds the HLS segmenter for Cast/AirPlay receivers.
 */

import { EventEmitter } from 'node:events';
import type { FragmentInfo } from '@shared/fmp4';
import { HlsSegmenter } from '@shared/hls';
import type { StreamMeta, StreamStats } from '@shared/types';
import { log } from './logger';

export interface StoredFragment {
  data: Buffer;
  info: FragmentInfo;
}

export class StreamHub extends EventEmitter {
  meta: StreamMeta | null = null;
  init: Buffer | null = null;
  /** Fragments since (and including) the last video keyframe. */
  gop: StoredFragment[] = [];
  segmenter = new HlsSegmenter({ targetDurationSec: 1, windowSize: 10 });
  active = false;
  paused = false;
  startedAt = 0;
  private frameCount = 0;
  private byteCount = 0;
  private windowStart = Date.now();
  fps = 0;
  kbps = 0;
  encodedFrames = 0;
  droppedFrames = 0;
  viewers = 0;

  setMeta(meta: StreamMeta): void {
    this.meta = meta;
    // HLS tuning, measured against a Chromecast (Sony Bravia). A receiver pinned to the
    // live edge rebuffers forever, and a deep window lets it start far back, so both the
    // window and the start cushion are kept small: this combination played for 98 s with
    // no rebuffering at roughly 8 s behind live. A 4-segment window rebuffered 22 times,
    // and no cushion at all was worse still (the receiver picks its own drifting start).
    // Browser viewers are fed per frame over WebSocket and are unaffected by any of this.
    this.segmenter = new HlsSegmenter({
      targetDurationSec: Number(process.env.AIRWING_HLS_SEG ?? 1),
      windowSize: Number(process.env.AIRWING_HLS_WINDOW ?? 8),
      audioOnly: meta.audioOnly,
      startOffsetSec: Number(process.env.AIRWING_HLS_CUSHION ?? 1),
    });
    this.init = null;
    this.gop = [];
    this.active = true;
    this.paused = false;
    this.startedAt = Date.now();
    this.encodedFrames = 0;
    this.droppedFrames = 0;
    log.info('stream', `stream started: ${meta.encoder.width}x${meta.encoder.height}@${meta.encoder.frameRate} ${meta.codecs} (${Math.round(meta.encoder.videoBitrate / 1000)} kbps)`);
    this.emit('meta', meta);
  }

  push(data: Buffer, info: FragmentInfo): void {
    if (!this.active) return;
    if (info.kind === 'init') {
      this.init = data;
      this.gop = [];
      this.segmenter.push(data, info);
      this.emit('init', data);
      return;
    }
    if (info.kind === 'video') {
      this.encodedFrames++;
      this.frameCount++;
      if (info.keyframe) this.gop = [];
    }
    this.byteCount += data.length;
    // Bound the GOP buffer for audio-only or long-GOP streams (~4 s of frames at 60 fps).
    if (this.gop.length > 600) this.gop.shift();
    this.gop.push({ data, info });
    this.segmenter.push(data, info);
    const now = Date.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 1000) {
      this.fps = Math.round((this.frameCount * 1000) / elapsed);
      this.kbps = Math.round((this.byteCount * 8) / elapsed);
      this.frameCount = 0;
      this.byteCount = 0;
      this.windowStart = now;
      this.emit('stats', this.stats());
    }
    this.emit('chunk', data, info);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.emit('paused', paused);
  }

  end(): void {
    if (!this.active) return;
    this.active = false;
    this.paused = false;
    this.segmenter.flush();
    this.segmenter.reset();
    this.init = null;
    this.gop = [];
    log.info('stream', 'stream ended');
    this.emit('end');
  }

  reportDropped(n: number): void {
    this.droppedFrames = n;
  }

  /** Everything a new MSE viewer needs to start decoding right away. */
  snapshot(): { init: Buffer; fragments: StoredFragment[] } | null {
    if (!this.init) return null;
    const firstKey = this.gop.findIndex((f) => f.info.kind === 'video' && f.info.keyframe);
    const fragments = this.meta?.audioOnly ? this.gop.slice(-50) : firstKey >= 0 ? this.gop.slice(firstKey) : [];
    return { init: this.init, fragments };
  }

  stats(sinks = 0): StreamStats {
    return {
      active: this.active,
      paused: this.paused,
      encoder: this.meta?.encoder,
      fps: this.fps,
      kbps: this.kbps,
      droppedFrames: this.droppedFrames,
      encodedFrames: this.encodedFrames,
      uptimeSec: this.active ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      sinks,
      viewers: this.viewers,
    };
  }

  /**
   * Wait for the encoder's first output. The renderer reports capture as active as soon
   * as it opens the capture stream, but the hub only becomes active once the first
   * encoded frame arrives, so a receiver picked immediately would otherwise be refused.
   */
  waitForActive(timeoutMs = 15000): Promise<boolean> {
    if (this.active) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.active) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 100);
    });
  }

  /** Wait until HLS has enough segments for a receiver to start. */
  waitForHls(timeoutMs = 12000): Promise<boolean> {
    if (this.segmenter.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (this.segmenter.ready) {
          clearInterval(timer);
          resolve(true);
        } else if (!this.active || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(this.segmenter.ready);
        }
      };
      const timer = setInterval(check, 100);
    });
  }
}
