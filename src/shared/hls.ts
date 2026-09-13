/**
 * Live HLS segmenter. Consumes fragments produced by Fmp4Muxer (one per sample)
 * and groups them into keyframe-aligned media segments for HLS receivers
 * (Chromecast Default Media Receiver, AirPlay video, Roku, Fire TV...).
 * Pure TypeScript with no Node/DOM dependencies so it can be unit tested.
 */

import type { FragmentInfo } from './fmp4';

export interface HlsSegment {
  sequence: number;
  durationSec: number;
  data: Uint8Array;
  createdAt: number;
  /** Which init segment this media segment must be decoded against. */
  initVersion: number;
  /** True when this segment is the first one after an encoder re-initialisation. */
  discontinuity: boolean;
}

export interface SegmenterOptions {
  /** Target segment duration in seconds. Segments are cut at the first keyframe after this. */
  targetDurationSec?: number;
  /** Segments kept in the playlist window. */
  windowSize?: number;
  /** Stream has no video track: cut purely on duration. */
  audioOnly?: boolean;
  /** How far behind the live edge receivers should start, in seconds. */
  startOffsetSec?: number;
  /**
   * Continue numbering from a previous segmenter. HLS requires the media sequence to
   * never go backwards for a given playlist URL, and capture can stop and restart under
   * a receiver that is still polling, so the counters have to survive a restart.
   */
  startSequence?: number;
  startDiscontinuitySequence?: number;
  startInitVersion?: number;
  onSegment?: (segment: HlsSegment) => void;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function initUri(version: number): string {
  return `init-${version}.mp4`;
}

export class HlsSegmenter {
  readonly targetDurationSec: number;
  readonly windowSize: number;
  readonly audioOnly: boolean;
  readonly startOffsetSec: number;
  private readonly onSegment?: (segment: HlsSegment) => void;
  private init: Uint8Array | null = null;
  /** Every init segment still referenced by the window, keyed by version. */
  private inits = new Map<number, Uint8Array>();
  private initVersion: number;
  private pendingDiscontinuity = false;
  private pending: Uint8Array[] = [];
  private pendingDurationUs = 0;
  private pendingVideoDurationUs = 0;
  private pendingHasVideo = false;
  private nextSequence: number;
  readonly segments: HlsSegment[] = [];
  /** Number of discontinuities that have already scrolled out of the window. */
  private discontinuitySequence: number;
  private producedSec = 0;

  constructor(opts: SegmenterOptions = {}) {
    this.targetDurationSec = opts.targetDurationSec ?? 1;
    this.windowSize = opts.windowSize ?? 8;
    this.audioOnly = !!opts.audioOnly;
    this.startOffsetSec = opts.startOffsetSec ?? 0;
    this.nextSequence = opts.startSequence ?? 0;
    this.discontinuitySequence = opts.startDiscontinuitySequence ?? 0;
    this.initVersion = opts.startInitVersion ?? 0;
    this.onSegment = opts.onSegment;
  }

  /** Counters a successor segmenter must continue from after a capture restart. */
  get continuation(): { startSequence: number; startDiscontinuitySequence: number; startInitVersion: number } {
    return {
      startSequence: this.nextSequence,
      startDiscontinuitySequence: this.discontinuitySequence,
      startInitVersion: this.initVersion,
    };
  }

  /** Total media currently advertised in the playlist. */
  get totalDurationSec(): number {
    return this.segments.reduce((sum, s) => sum + s.durationSec, 0);
  }

  /** Media timeline position of the live edge, counting segments already evicted. */
  get liveEdgeSec(): number {
    return this.producedSec;
  }

  get initSegment(): Uint8Array | null {
    return this.init;
  }

  get currentInitVersion(): number {
    return this.initVersion;
  }

  /** The init segment for a specific version, so a changed init never reuses a URI. */
  getInit(version: number): Uint8Array | undefined {
    return this.inits.get(version);
  }

  get maxSegmentDurationSec(): number {
    return this.segments.reduce((m, s) => Math.max(m, s.durationSec), this.targetDurationSec);
  }

  push(data: Uint8Array, info: FragmentInfo): void {
    if (info.kind === 'init') {
      if (this.init && this.pending.length) this.cut();
      // A new init means new decoder configuration. It must be published under its own
      // URI with a discontinuity, otherwise receivers keep decoding new segments against
      // the old moov and show green blocks or stall.
      if (this.init) this.pendingDiscontinuity = true;
      this.initVersion++;
      this.init = data;
      this.inits.set(this.initVersion, data);
      this.pruneInits();
      return;
    }
    const isVideoKey = info.kind === 'video' && info.keyframe;
    const currentDur = this.audioOnly ? this.pendingDurationUs : this.pendingVideoDurationUs;
    const shouldCut = this.pending.length > 0 && currentDur >= this.targetDurationSec * 1e6 * 0.98 && (this.audioOnly || isVideoKey);
    if (shouldCut) this.cut();
    this.pending.push(data);
    this.pendingDurationUs += info.kind === 'audio' && !this.audioOnly ? 0 : info.durationUs;
    if (info.kind === 'video') {
      this.pendingVideoDurationUs += info.durationUs;
      this.pendingHasVideo = true;
    }
  }

  private cut(): void {
    if (!this.pending.length) return;
    const durationUs = this.audioOnly || !this.pendingHasVideo ? this.pendingDurationUs : this.pendingVideoDurationUs;
    const segment: HlsSegment = {
      sequence: this.nextSequence++,
      durationSec: Math.max(0.001, durationUs / 1e6),
      data: concat(this.pending),
      createdAt: Date.now(),
      initVersion: this.initVersion,
      discontinuity: this.pendingDiscontinuity,
    };
    this.pendingDiscontinuity = false;
    this.pending = [];
    this.pendingDurationUs = 0;
    this.pendingVideoDurationUs = 0;
    this.pendingHasVideo = false;
    this.producedSec += segment.durationSec;
    this.segments.push(segment);
    while (this.segments.length > this.windowSize) {
      const dropped = this.segments.shift()!;
      // EXT-X-DISCONTINUITY-SEQUENCE counts the discontinuity tags that have scrolled
      // off the front of the playlist.
      if (dropped.discontinuity) this.discontinuitySequence++;
    }
    this.pruneInits();
    this.onSegment?.(segment);
  }

  /** Drop init segments no longer referenced by anything in the window. */
  private pruneInits(): void {
    const live = new Set(this.segments.map((s) => s.initVersion));
    live.add(this.initVersion);
    for (const version of [...this.inits.keys()]) {
      if (!live.has(version)) this.inits.delete(version);
    }
  }

  /** Force-cut whatever is pending (used when the stream ends). */
  flush(): void {
    this.cut();
  }

  getSegment(sequence: number): HlsSegment | undefined {
    return this.segments.find((s) => s.sequence === sequence);
  }

  /** Number of segments available to advertise. */
  get ready(): boolean {
    return !!this.init && this.segments.length >= 2;
  }

  playlist(baseUrl = ''): string {
    // Start playback a few segments behind the live edge. Pinned to the edge, a receiver
    // has no headroom and rebuffers continuously (Chromecast oscillates PLAYING/BUFFERING
    // and shows a frozen picture); a small cushion makes it play smoothly.
    const cushion = Math.min(this.startOffsetSec, Math.max(0, this.totalDurationSec - this.targetDurationSec));
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${Math.ceil(this.maxSegmentDurationSec)}`,
      `#EXT-X-MEDIA-SEQUENCE:${this.segments[0]?.sequence ?? this.nextSequence}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${this.discontinuitySequence}`,
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ];
    if (cushion > 0) lines.push(`#EXT-X-START:TIME-OFFSET=-${cushion.toFixed(3)},PRECISE=NO`);
    let currentInit = -1;
    for (const s of this.segments) {
      if (s.discontinuity && currentInit !== -1) lines.push('#EXT-X-DISCONTINUITY');
      if (s.initVersion !== currentInit) {
        lines.push(`#EXT-X-MAP:URI="${baseUrl}${initUri(s.initVersion)}"`);
        currentInit = s.initVersion;
      }
      lines.push(`#EXTINF:${s.durationSec.toFixed(3)},`);
      lines.push(`${baseUrl}seg-${s.sequence}.m4s`);
    }
    return lines.join('\n') + '\n';
  }

  reset(): void {
    this.init = null;
    this.inits.clear();
    this.pending = [];
    this.pendingDurationUs = 0;
    this.pendingVideoDurationUs = 0;
    this.pendingHasVideo = false;
    this.pendingDiscontinuity = false;
    this.segments.length = 0;
    this.producedSec = 0;
  }
}
