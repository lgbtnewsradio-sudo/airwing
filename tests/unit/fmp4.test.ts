import { describe, it, expect } from 'vitest';
import { Fmp4Muxer, buildInitSegment, parseBoxes, findBox, avcCodecString, opusHeadToDops, defaultAsc, type FragmentInfo } from '../../src/shared/fmp4';

const AVCC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x05, 0x67, 0x64, 0x00, 0x28, 0xac, 0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80]);
const ASC = new Uint8Array([0x11, 0x90]); // AAC-LC 48 kHz stereo

function types(buf: Uint8Array): string[] {
  return parseBoxes(buf).map((b) => b.type);
}

describe('fMP4 muxer', () => {
  it('builds a well-formed init segment with video + audio tracks', () => {
    const init = buildInitSegment({ codec: 'avc', width: 1280, height: 720, description: AVCC }, { codec: 'aac', sampleRate: 48000, channels: 2, description: ASC });
    expect(types(init)).toEqual(['ftyp', 'moov']);
    const moov = parseBoxes(init).find((b) => b.type === 'moov')!;
    const children = types(moov.payload);
    expect(children).toEqual(['mvhd', 'trak', 'trak', 'mvex']);
    expect(findBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1', 'avcC'])).toBeDefined();
    const avcC = findBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1', 'avcC'])!;
    expect(Array.from(avcC.payload)).toEqual(Array.from(AVCC));
    const mvex = parseBoxes(moov.payload).find((b) => b.type === 'mvex')!;
    expect(types(mvex.payload)).toEqual(['trex', 'trex']);
    // second trak must be the audio track with an mp4a entry
    const traks = parseBoxes(moov.payload).filter((b) => b.type === 'trak');
    const stsd = findBox(traks[1].payload, ['mdia', 'minf', 'stbl', 'stsd'])!;
    expect(types(stsd.payload.subarray(8))).toEqual(['mp4a']);
    const mp4a = parseBoxes(stsd.payload.subarray(8))[0];
    expect(types(mp4a.payload.subarray(28))).toEqual(['esds']);
  });

  it('emits init then one fragment per sample with correct sizes and flags', () => {
    const out: Array<{ data: Uint8Array; info: FragmentInfo }> = [];
    const muxer = new Fmp4Muxer({
      video: { codec: 'avc', width: 640, height: 360, description: AVCC },
      audio: { codec: 'aac', sampleRate: 48000, channels: 2, description: ASC },
      onData: (data, info) => out.push({ data, info }),
    });
    muxer.start();
    expect(out[0].info.kind).toBe('init');
    const key = new Uint8Array([0, 0, 0, 4, 0x65, 1, 2, 3]);
    const delta = new Uint8Array([0, 0, 0, 4, 0x41, 1, 2, 3]);
    muxer.addVideoSample(key, 1_000_000, true);
    expect(out.length).toBe(1); // held until next sample for exact duration
    muxer.addVideoSample(delta, 1_033_333, false);
    expect(out.length).toBe(2);
    const frag = out[1];
    expect(frag.info.kind).toBe('video');
    expect(frag.info.keyframe).toBe(true);
    expect(frag.info.timestampUs).toBe(0);
    expect(frag.info.durationUs).toBe(33333);
    expect(types(frag.data)).toEqual(['moof', 'mdat']);
    const moof = parseBoxes(frag.data)[0];
    const traf = parseBoxes(moof.payload).find((b) => b.type === 'traf')!;
    const trun = parseBoxes(traf.payload).find((b) => b.type === 'trun')!;
    const dv = new DataView(trun.payload.buffer, trun.payload.byteOffset);
    expect(dv.getUint32(4)).toBe(1); // sample count
    expect(dv.getUint32(8)).toBe(moof.size + 8); // data offset points at mdat payload
    expect(dv.getUint32(12)).toBe(3000); // duration in 90 kHz ticks
    expect(dv.getUint32(16)).toBe(key.length);
    expect(dv.getUint32(20)).toBe(0x02000000); // sync sample
    const mdat = parseBoxes(frag.data)[1];
    expect(Array.from(mdat.payload)).toEqual(Array.from(key));
    muxer.addAudioSample(new Uint8Array([9, 9, 9]), 1_000_000, 21333);
    const audio = out[2];
    expect(audio.info.kind).toBe('audio');
    const atraf = parseBoxes(parseBoxes(audio.data)[0].payload).find((b) => b.type === 'traf')!;
    const tfhd = parseBoxes(atraf.payload).find((b) => b.type === 'tfhd')!;
    expect(new DataView(tfhd.payload.buffer, tfhd.payload.byteOffset).getUint32(4)).toBe(2); // audio track id
    muxer.flush();
    expect(out.length).toBe(4);
    expect(out[3].info.keyframe).toBe(false);
  });

  it('keeps baseMediaDecodeTime locked to timestamps across samples', () => {
    const out: Array<{ data: Uint8Array; info: FragmentInfo }> = [];
    const muxer = new Fmp4Muxer({ video: { codec: 'avc', width: 64, height: 64, description: AVCC }, onData: (d, i) => out.push({ data: d, info: i }) });
    const ts = [0, 33333, 66667, 100000, 133333];
    for (const t of ts) muxer.addVideoSample(new Uint8Array([1]), 5_000_000 + t, t === 0);
    muxer.flush();
    const decodeTimes = out
      .filter((o) => o.info.kind === 'video')
      .map((o) => {
        const traf = parseBoxes(parseBoxes(o.data)[0].payload).find((b) => b.type === 'traf')!;
        const tfdt = parseBoxes(traf.payload).find((b) => b.type === 'tfdt')!;
        const dv = new DataView(tfdt.payload.buffer, tfdt.payload.byteOffset);
        return dv.getUint32(8); // low 32 bits of 64-bit base time
      });
    expect(decodeTimes).toEqual(ts.map((t) => Math.round((t * 90000) / 1e6)));
  });

  it('leaves no hole in the timeline when frames are dropped', () => {
    // Regression: a fixed per-frame duration left a gap whenever the encoder dropped a
    // frame, and MSE stalls forever at a gap. Durations must come from the next timestamp.
    const out: Array<{ data: Uint8Array; info: FragmentInfo }> = [];
    const muxer = new Fmp4Muxer({ video: { codec: 'avc', width: 64, height: 64, description: AVCC }, onData: (d, i) => out.push({ data: d, info: i }) });
    // 30 fps grid with frames 3,4,5 and 9 dropped, as happens when the encoder is busy.
    // The odd timestamps also exercise rounding into the 90 kHz timescale.
    const kept = [0, 1, 2, 6, 7, 8, 10, 11, 12];
    for (const n of kept) muxer.addVideoSample(new Uint8Array([n]), n * 33333, n === 0);
    muxer.flush();
    const frags = out.filter((o) => o.info.kind === 'video');
    expect(frags.length).toBe(kept.length);
    const ts = 90000;
    let prevEnd: number | null = null;
    for (const f of frags) {
      const traf = parseBoxes(parseBoxes(f.data)[0].payload).find((b) => b.type === 'traf')!;
      const tfdt = parseBoxes(traf.payload).find((b) => b.type === 'tfdt')!;
      const trun = parseBoxes(traf.payload).find((b) => b.type === 'trun')!;
      const base = new DataView(tfdt.payload.buffer, tfdt.payload.byteOffset).getUint32(8);
      const dur = new DataView(trun.payload.buffer, trun.payload.byteOffset).getUint32(12);
      if (prevEnd !== null) expect(base).toBe(prevEnd); // contiguous: no gap, no overlap
      prevEnd = base + dur;
    }
    // The frames spanning the dropped ones carry the longer duration instead.
    const durOf = (i: number) => {
      const traf = parseBoxes(parseBoxes(frags[i].data)[0].payload).find((b) => b.type === 'traf')!;
      const trun = parseBoxes(traf.payload).find((b) => b.type === 'trun')!;
      return new DataView(trun.payload.buffer, trun.payload.byteOffset).getUint32(12);
    };
    expect(durOf(2)).toBe(Math.round((6 * 33333 * ts) / 1e6) - Math.round((2 * 33333 * ts) / 1e6)); // frame 2 covers 3,4,5
    expect(durOf(5)).toBe(Math.round((10 * 33333 * ts) / 1e6) - Math.round((8 * 33333 * ts) / 1e6)); // frame 8 covers 9
  });

  it('keeps a long run of frames exactly contiguous despite timescale rounding', () => {
    const out: Array<{ data: Uint8Array; info: FragmentInfo }> = [];
    const muxer = new Fmp4Muxer({ video: { codec: 'avc', width: 64, height: 64, description: AVCC }, onData: (d, i) => out.push({ data: d, info: i }) });
    // 33333 us does not land on a whole 90 kHz tick, so rounding drifts over time.
    for (let n = 0; n < 300; n++) muxer.addVideoSample(new Uint8Array([n & 0xff]), n * 33333, n % 30 === 0);
    muxer.flush();
    const frags = out.filter((o) => o.info.kind === 'video');
    let prevEnd: number | null = null;
    let seams = 0;
    for (const f of frags) {
      const traf = parseBoxes(parseBoxes(f.data)[0].payload).find((b) => b.type === 'traf')!;
      const tfdt = parseBoxes(traf.payload).find((b) => b.type === 'tfdt')!;
      const trun = parseBoxes(traf.payload).find((b) => b.type === 'trun')!;
      const base = new DataView(tfdt.payload.buffer, tfdt.payload.byteOffset).getUint32(8);
      const dur = new DataView(trun.payload.buffer, trun.payload.byteOffset).getUint32(12);
      if (prevEnd !== null && base !== prevEnd) seams++;
      prevEnd = base + dur;
    }
    expect(seams).toBe(0);
  });

  it('derives codec strings and Opus/AAC configs', () => {
    expect(avcCodecString(AVCC)).toBe('avc1.640028');
    expect(Array.from(defaultAsc(48000, 2))).toEqual([0x11, 0x90]);
    const head = new Uint8Array(19);
    head.set(new TextEncoder().encode('OpusHead'));
    head[8] = 1;
    head[9] = 2;
    new DataView(head.buffer).setUint16(10, 312, true);
    new DataView(head.buffer).setUint32(12, 48000, true);
    const dops = opusHeadToDops(head, 2, 48000);
    expect(Array.from(dops)).toEqual([0, 2, 1, 56, 0, 0, 0xbb, 0x80, 0, 0, 0]);
  });
});
