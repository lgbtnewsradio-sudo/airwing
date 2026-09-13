import { describe, it, expect } from 'vitest';
import { HlsSegmenter, initUri } from '../../src/shared/hls';
import { StreamHub } from '../../src/main/streamHub';
import { Fmp4Muxer, type FragmentInfo } from '../../src/shared/fmp4';

const AVCC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x05, 0x67, 0x64, 0x00, 0x28, 0xac, 0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80]);

/**
 * Regressions for two ways a live HLS playlist could hand a receiver the wrong bytes:
 *  - capture restarting reset the media sequence to 0, so a receiver still polling saw
 *    "seg-0" again with completely different content and sat on a frozen frame;
 *  - a new encoder configuration replaced init.mp4 in place while the EXT-X-MAP URI
 *    stayed the same, so new segments were decoded against the old moov (green blocks).
 */

function frag(kind: FragmentInfo['kind'], keyframe: boolean, timestampUs: number, durationUs: number): FragmentInfo {
  return { kind, keyframe, timestampUs, durationUs, sequence: 0 };
}

/** Feed `frames` 30 fps video frames, keyframe every 30, starting at `startFrame`. */
function feed(seg: HlsSegmenter, frames: number, startFrame = 0): void {
  for (let i = startFrame; i < startFrame + frames; i++) {
    seg.push(new Uint8Array([i & 0xff]), frag('video', i % 30 === 0, i * 33333, 33333));
  }
}

const mediaSequenceOf = (playlist: string) => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(playlist)![1]);

describe('HLS across a capture restart', () => {
  it('never lets the media sequence go backwards when capture restarts', () => {
    const first = new HlsSegmenter({ targetDurationSec: 1, windowSize: 8 });
    first.push(new Uint8Array([1]), frag('init', true, 0, 0));
    feed(first, 180); // ~6 s
    const lastSequence = first.segments[first.segments.length - 1].sequence;
    expect(lastSequence).toBeGreaterThan(0);

    // Capture restarts: StreamHub builds a fresh segmenter from the old one's counters.
    const next = new HlsSegmenter({ targetDurationSec: 1, windowSize: 8, ...first.continuation });
    next.push(new Uint8Array([2]), frag('init', true, 0, 0));
    feed(next, 90);

    expect(next.segments[0].sequence).toBeGreaterThan(lastSequence);
    expect(mediaSequenceOf(next.playlist())).toBeGreaterThan(lastSequence);
  });

  it('publishes a changed init under a new URI with a discontinuity', () => {
    const seg = new HlsSegmenter({ targetDurationSec: 1, windowSize: 8 });
    const initA = new Uint8Array([0xaa]);
    const initB = new Uint8Array([0xbb]);

    seg.push(initA, frag('init', true, 0, 0));
    feed(seg, 90); // three segments on init A
    const versionA = seg.currentInitVersion;

    // The encoder re-initialises (new resolution or a source switch).
    seg.push(initB, frag('init', true, 0, 0));
    feed(seg, 90, 90);
    const versionB = seg.currentInitVersion;

    expect(versionB).toBe(versionA + 1);
    expect(seg.getInit(versionA)).toEqual(initA);
    expect(seg.getInit(versionB)).toEqual(initB);

    const playlist = seg.playlist();
    // Both init segments are referenced, under distinct URIs.
    expect(playlist).toContain(`#EXT-X-MAP:URI="${initUri(versionA)}"`);
    expect(playlist).toContain(`#EXT-X-MAP:URI="${initUri(versionB)}"`);
    expect(initUri(versionA)).not.toBe(initUri(versionB));
    // The switch is marked, and the marker comes before the second MAP.
    expect(playlist).toContain('#EXT-X-DISCONTINUITY');
    const lines = playlist.split('\n');
    expect(lines.indexOf('#EXT-X-DISCONTINUITY')).toBeLessThan(lines.indexOf(`#EXT-X-MAP:URI="${initUri(versionB)}"`));
  });

  it('counts discontinuities that scroll out of the window', () => {
    const seg = new HlsSegmenter({ targetDurationSec: 1, windowSize: 3 });
    seg.push(new Uint8Array([1]), frag('init', true, 0, 0));
    feed(seg, 60);
    seg.push(new Uint8Array([2]), frag('init', true, 0, 0));
    feed(seg, 240, 60); // push well past the window so the discontinuity is evicted
    const playlist = seg.playlist();
    expect(Number(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(playlist)![1])).toBeGreaterThan(0);
    // Once the old init's segments are gone it is dropped from memory too.
    expect(seg.getInit(1)).toBeUndefined();
  });

  it('carries the sequence across a StreamHub restart, not just within one segmenter', () => {
    // The hub builds a brand-new segmenter every time capture starts, which is exactly
    // where the counters used to be lost.
    const hub = new StreamHub();
    const run = (seconds: number) => {
      hub.setMeta({
        encoder: { videoCodec: 'avc1.640028', audioCodec: '', width: 640, height: 360, frameRate: 30, videoBitrate: 2_000_000, audioBitrate: 0 },
        codecs: 'avc1.640028',
        mime: 'video/mp4; codecs="avc1.640028"',
        audioOnly: false,
      });
      const muxer = new Fmp4Muxer({
        video: { codec: 'avc', width: 640, height: 360, description: AVCC },
        onData: (d, i) => hub.push(Buffer.from(d), i),
      });
      muxer.start();
      const frames = Math.round(seconds * 30);
      for (let i = 0; i <= frames; i++) muxer.addVideoSample(new Uint8Array([i & 0xff]), i * 33333, i % 30 === 0);
      muxer.flush();
    };

    run(6);
    const firstLast = hub.segmenter.segments[hub.segmenter.segments.length - 1].sequence;
    expect(firstLast).toBeGreaterThan(0);
    hub.end();

    run(6);
    expect(hub.segmenter.segments[0].sequence).toBeGreaterThan(firstLast);
    // And the new init is published under its own URI rather than reusing the old one.
    expect(hub.segmenter.currentInitVersion).toBeGreaterThan(1);
    hub.end();
  });

  it('keeps only one MAP when the init never changes', () => {
    const seg = new HlsSegmenter({ targetDurationSec: 1, windowSize: 8 });
    seg.push(new Uint8Array([1]), frag('init', true, 0, 0));
    feed(seg, 150);
    const playlist = seg.playlist();
    expect(playlist.match(/#EXT-X-MAP:/g)).toHaveLength(1);
    expect(playlist).not.toContain('#EXT-X-DISCONTINUITY\n');
  });
});
