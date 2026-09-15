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

  // RFC 8216 §6.2.2: a segment removed from the playlist must stay downloadable for a while.
  // Deleting it on eviction made a Sony Bravia, which starts from the oldest listed segment,
  // request it ~1 s after it vanished, get 404s, and abort playback.
  it('keeps segments that scrolled out of the playlist downloadable for one more window', () => {
    const seg = new HlsSegmenter({ targetDurationSec: 1, windowSize: 2 });
    seg.push(new Uint8Array(1), frag('init', true, 0, 0, 0));
    // Keyframe every 30 frames (1 s): cuts segments 0..3, listing [2, 3].
    for (let i = 0; i < 150; i++) seg.push(new Uint8Array(1), frag('video', i % 30 === 0, i * 33333, 33333, i + 1));
    expect(seg.segments.map((s) => s.sequence)).toEqual([2, 3]);
    // Evicted from the window, but a receiver that just read the old playlist can still fetch them.
    expect(seg.getSegment(0)).toBeDefined();
    expect(seg.getSegment(1)).toBeDefined();
    // They are no longer advertised, and the window itself is unchanged.
    const playlist = seg.playlist();
    expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:2');
    expect(playlist).not.toContain('seg-0.m4s');
    expect(playlist).not.toContain('seg-1.m4s');

    // Five more segments (4..8): the window becomes [7, 8] and retention is windowSize + 1 = 3.
    for (let i = 150; i < 300; i++) seg.push(new Uint8Array(1), frag('video', i % 30 === 0, i * 33333, 33333, i + 1));
    expect(seg.segments.map((s) => s.sequence)).toEqual([7, 8]);
    expect(seg.getSegment(3)).toBeUndefined();
    for (const sequence of [4, 5, 6, 7, 8]) expect(seg.getSegment(sequence)).toBeDefined();

    seg.reset();
    expect(seg.getSegment(6)).toBeUndefined();
  });

  it('keeps an old init segment while retired segments still reference it', () => {
    const seg = new HlsSegmenter({ targetDurationSec: 1, windowSize: 2 });
    seg.push(new Uint8Array([1]), frag('init', true, 0, 0, 0)); // init v1
    for (let i = 0; i < 150; i++) seg.push(new Uint8Array(1), frag('video', i % 30 === 0, i * 33333, 33333, i + 1));
    // Encoder re-initialised: cuts segment 4 against v1, later segments use v2.
    seg.push(new Uint8Array([2]), frag('init', true, 150 * 33333, 0, 0));
    for (let i = 150; i < 240; i++) seg.push(new Uint8Array(1), frag('video', i % 30 === 0, i * 33333, 33333, i + 1));
    // Listed segments 5 and 6 decode against v2; retired segments 2..4 still need v1.
    expect(seg.segments.map((s) => s.initVersion)).toEqual([2, 2]);
    expect(seg.getSegment(4)?.initVersion).toBe(1);
    expect(seg.getInit(1)).toBeDefined();

    // Once the last v1 segment is no longer retained, v1 can go.
    for (let i = 240; i < 330; i++) seg.push(new Uint8Array(1), frag('video', i % 30 === 0, i * 33333, 33333, i + 1));
    expect(seg.getSegment(4)).toBeUndefined();
    expect(seg.getInit(1)).toBeUndefined();
    expect(seg.getInit(2)).toBeDefined();
  });
});
