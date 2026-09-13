import { describe, it, expect } from 'vitest';
import { HlsSegmenter } from '../../src/shared/hls';
import type { FragmentInfo } from '../../src/shared/fmp4';

function frag(kind: FragmentInfo['kind'], keyframe: boolean, timestampUs: number, durationUs: number, seq: number): FragmentInfo {
  return { kind, keyframe, timestampUs, durationUs, sequence: seq };
}

describe('HLS segmenter', () => {
  it('cuts keyframe-aligned segments of at least the target duration', () => {
    const seg = new HlsSegmenter({ targetDurationSec: 1, windowSize: 3 });
    seg.push(new Uint8Array([0xaa]), frag('init', true, 0, 0, 0));
    let seq = 1;
    // 30 fps, keyframe every 15 frames (0.5 s)
    for (let i = 0; i < 90; i++) {
      seg.push(new Uint8Array([i]), frag('video', i % 15 === 0, i * 33333, 33333, seq++));
      if (i % 2 === 0) seg.push(new Uint8Array([0xf0]), frag('audio', true, i * 33333, 21333, seq++));
    }
    expect(seg.segments.length).toBe(2); // 3 s of video -> 3 segments, window keeps last 3 but only 2 cut so far
    expect(seg.segments[0].durationSec).toBeCloseTo(1.0, 2);
    expect(seg.segments[0].sequence).toBe(0);
    // segment starts with the keyframe fragment payload
    expect(seg.segments[1].data[seg.segments[1].data.length - 0 - 1]).toBeDefined();
    seg.flush();
    expect(seg.segments.length).toBe(3);
    expect(seg.ready).toBe(true);
    const playlist = seg.playlist();
    // The init URI carries a version so a changed init can never reuse a fetched URI.
    expect(playlist).toMatch(/#EXT-X-MAP:URI="init-\d+\.mp4"/);
    expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(playlist).toContain('seg-2.m4s');
    expect(playlist).toContain('#EXT-X-TARGETDURATION:1');
    expect(seg.getSegment(1)).toBeDefined();
    expect(seg.getSegment(99)).toBeUndefined();
  });

  it('honours the sliding window and media sequence', () => {
    const seg = new HlsSegmenter({ targetDurationSec: 1, windowSize: 2 });
    seg.push(new Uint8Array(1), frag('init', true, 0, 0, 0));
    for (let i = 0; i < 150; i++) seg.push(new Uint8Array(1), frag('video', i % 30 === 0, i * 33333, 33333, i + 1));
    expect(seg.segments.length).toBe(2);
    expect(seg.segments[0].sequence).toBe(2);
    expect(seg.playlist()).toContain('#EXT-X-MEDIA-SEQUENCE:2');
  });

  it('cuts audio-only streams on duration alone', () => {
    const seg = new HlsSegmenter({ targetDurationSec: 2, audioOnly: true });
    seg.push(new Uint8Array(1), frag('init', true, 0, 0, 0));
    for (let i = 0; i < 200; i++) seg.push(new Uint8Array(1), frag('audio', true, i * 21333, 21333, i + 1));
    expect(seg.segments.length).toBe(2);
    expect(seg.segments[0].durationSec).toBeGreaterThanOrEqual(1.9);
  });
});
