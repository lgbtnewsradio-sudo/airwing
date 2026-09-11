/**
 * Minimal fragmented-MP4 (ISO BMFF) muxer.
 *
 * Produces an init segment (ftyp + moov) followed by one movie fragment
 * (moof + mdat) per sample. One-fragment-per-sample keeps end-to-end latency
 * at a single frame for MSE receivers; the HLS segmenter in the main process
 * concatenates fragments into keyframe-aligned segments for Chromecast/AirPlay.
 *
 * Supported codecs: H.264 (avc1/avcC), H.265 (hvc1/hvcC), AAC (mp4a/esds), Opus (Opus/dOps).
 * Pure TypeScript with no DOM or Node dependencies.
 */

export type FragmentKind = 'init' | 'video' | 'audio';

export interface FragmentInfo {
  kind: FragmentKind;
  keyframe: boolean;
  /** Presentation timestamp in microseconds, relative to stream start. */
  timestampUs: number;
  durationUs: number;
  sequence: number;
}

export interface VideoTrackConfig {
  codec: 'avc' | 'hevc';
  width: number;
  height: number;
  /** avcC (H.264) or hvcC (H.265) decoder configuration record. */
  description: Uint8Array;
  timescale?: number;
}

export interface AudioTrackConfig {
  codec: 'aac' | 'opus';
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig for AAC; OpusHead (with magic) for Opus. */
  description?: Uint8Array;
  bitrate?: number;
}

export interface MuxerOptions {
  video?: VideoTrackConfig;
  audio?: AudioTrackConfig;
  onData: (data: Uint8Array, info: FragmentInfo) => void;
}

const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;
const VIDEO_TIMESCALE = 90000;

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

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

function u8(...v: number[]): Uint8Array {
  return new Uint8Array(v);
}

function u16(v: number): Uint8Array {
  return u8((v >> 8) & 0xff, v & 0xff);
}

function u24(v: number): Uint8Array {
  return u8((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
}

function u32(v: number): Uint8Array {
  return u8((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function u64(v: number): Uint8Array {
  const hi = Math.floor(v / 0x100000000);
  const lo = v >>> 0;
  return concat([u32(hi), u32(lo)]);
}

function str(s: string): Uint8Array {
  return textEncoder.encode(s);
}

function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(8 + body.length), str(type), body]);
}

export function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, u8(version), u24(flags), ...payload);
}

const UNITY_MATRIX = concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

// ---------------------------------------------------------------------------
// Init segment
// ---------------------------------------------------------------------------

function ftyp(): Uint8Array {
  return box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'), str('iso5'), str('iso6'));
}

function mvhd(nextTrackId: number): Uint8Array {
  return fullBox(
    'mvhd', 0, 0,
    u32(0), u32(0), // creation, modification
    u32(1000), u32(0), // timescale, duration
    u32(0x00010000), u16(0x0100), zeros(10),
    UNITY_MATRIX,
    zeros(24),
    u32(nextTrackId),
  );
}

function tkhd(trackId: number, width: number, height: number, audio: boolean): Uint8Array {
  return fullBox(
    'tkhd', 0, 3,
    u32(0), u32(0), u32(trackId), u32(0), u32(0),
    zeros(8), u16(0), u16(0), u16(audio ? 0x0100 : 0), u16(0),
    UNITY_MATRIX,
    u32(width << 16), u32(height << 16),
  );
}

function mdhd(timescale: number): Uint8Array {
  return fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
}

function hdlr(handler: string, name: string): Uint8Array {
  return fullBox('hdlr', 0, 0, u32(0), str(handler), zeros(12), str(name), u8(0));
}

function dinf(): Uint8Array {
  return box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
}

function emptyStblTail(): Uint8Array[] {
  return [
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
  ];
}

function visualSampleEntry(v: VideoTrackConfig): Uint8Array {
  const type = v.codec === 'avc' ? 'avc1' : 'hvc1';
  const configBox = v.codec === 'avc' ? 'avcC' : 'hvcC';
  const compressor = zeros(32);
  return box(
    type,
    zeros(6), u16(1), // reserved, data_reference_index
    u16(0), u16(0), zeros(12),
    u16(v.width), u16(v.height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1),
    compressor,
    u16(0x0018), u16(0xffff),
    box(configBox, v.description),
  );
}

function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  return concat([
    u8(tag, 0x80 | ((len >> 21) & 0x7f), 0x80 | ((len >> 14) & 0x7f), 0x80 | ((len >> 7) & 0x7f), len & 0x7f),
    payload,
  ]);
}

function esds(asc: Uint8Array, bitrate: number): Uint8Array {
  const decoderSpecific = descriptor(0x05, asc);
  const decoderConfig = descriptor(
    0x04,
    concat([u8(0x40, 0x15), u24(0), u32(bitrate), u32(bitrate), decoderSpecific]),
  );
  const slConfig = descriptor(0x06, u8(0x02));
  const es = descriptor(0x03, concat([u16(0), u8(0), decoderConfig, slConfig]));
  return fullBox('esds', 0, 0, es);
}

/** Convert an OpusHead identification header into an ISO BMFF dOps box payload. */
export function opusHeadToDops(head: Uint8Array | undefined, channels: number, sampleRate: number): Uint8Array {
  if (head && head.length >= 19 && String.fromCharCode(...head.subarray(0, 8)) === 'OpusHead') {
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const chan = head[9];
    const preSkip = dv.getUint16(10, true);
    const inputRate = dv.getUint32(12, true);
    const gain = dv.getInt16(16, true);
    const family = head[18];
    const parts = [u8(0), u8(chan), u16(preSkip), u32(inputRate), u16(gain & 0xffff), u8(family)];
    if (family !== 0 && head.length >= 21 + chan) {
      parts.push(head.subarray(19, 21 + chan));
    }
    return concat(parts);
  }
  return concat([u8(0), u8(channels), u16(312), u32(sampleRate), u16(0), u8(0)]);
}

function audioSampleEntry(a: AudioTrackConfig): Uint8Array {
  const isAac = a.codec === 'aac';
  const type = isAac ? 'mp4a' : 'Opus';
  const codecBox = isAac
    ? esds(a.description ?? defaultAsc(a.sampleRate, a.channels), a.bitrate ?? 128000)
    : box('dOps', opusHeadToDops(a.description, a.channels, a.sampleRate));
  return box(
    type,
    zeros(6), u16(1),
    zeros(8),
    u16(a.channels), u16(16), u16(0), u16(0),
    u32(a.sampleRate << 16),
    codecBox,
  );
}

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Build an AudioSpecificConfig for AAC-LC when the encoder did not provide one. */
export function defaultAsc(sampleRate: number, channels: number): Uint8Array {
  let idx = AAC_SAMPLE_RATES.indexOf(sampleRate);
  if (idx < 0) idx = 3;
  const objectType = 2; // AAC LC
  const b0 = (objectType << 3) | (idx >> 1);
  const b1 = ((idx & 1) << 7) | (channels << 3);
  return u8(b0, b1);
}

function trak(config: { id: number; video?: VideoTrackConfig; audio?: AudioTrackConfig }): Uint8Array {
  const isAudio = !!config.audio;
  const timescale = isAudio ? config.audio!.sampleRate : config.video!.timescale ?? VIDEO_TIMESCALE;
  const width = config.video?.width ?? 0;
  const height = config.video?.height ?? 0;
  const sampleEntry = isAudio ? audioSampleEntry(config.audio!) : visualSampleEntry(config.video!);
  const mhd = isAudio ? fullBox('smhd', 0, 0, u16(0), u16(0)) : fullBox('vmhd', 0, 1, u16(0), zeros(6));
  return box(
    'trak',
    tkhd(config.id, width, height, isAudio),
    box(
      'mdia',
      mdhd(timescale),
      hdlr(isAudio ? 'soun' : 'vide', isAudio ? 'SoundHandler' : 'VideoHandler'),
      box('minf', mhd, dinf(), box('stbl', fullBox('stsd', 0, 0, u32(1), sampleEntry), ...emptyStblTail())),
    ),
  );
}

function trex(trackId: number): Uint8Array {
  return fullBox('trex', 0, 0, u32(trackId), u32(1), u32(0), u32(0), u32(0));
}

export function buildInitSegment(video?: VideoTrackConfig, audio?: AudioTrackConfig): Uint8Array {
  const traks: Uint8Array[] = [];
  const trexes: Uint8Array[] = [];
  if (video) {
    traks.push(trak({ id: VIDEO_TRACK_ID, video }));
    trexes.push(trex(VIDEO_TRACK_ID));
  }
  if (audio) {
    traks.push(trak({ id: AUDIO_TRACK_ID, audio }));
    trexes.push(trex(AUDIO_TRACK_ID));
  }
  const moov = box('moov', mvhd(3), ...traks, box('mvex', ...trexes));
  return concat([ftyp(), moov]);
}

// ---------------------------------------------------------------------------
// Media fragments
// ---------------------------------------------------------------------------

const SAMPLE_FLAGS_SYNC = 0x02000000;
const SAMPLE_FLAGS_NON_SYNC = 0x01010000;

export function buildFragment(
  trackId: number,
  sequence: number,
  baseDecodeTime: number,
  duration: number,
  data: Uint8Array,
  keyframe: boolean,
): Uint8Array {
  const trunSize = 12 + 8 + 12; // header + count/offset + one sample
  const trafSize = 8 + 16 + 20 + trunSize;
  const moofSize = 8 + 16 + trafSize;
  const dataOffset = moofSize + 8;
  const moof = box(
    'moof',
    fullBox('mfhd', 0, 0, u32(sequence)),
    box(
      'traf',
      fullBox('tfhd', 0, 0x020000, u32(trackId)),
      fullBox('tfdt', 1, 0, u64(baseDecodeTime)),
      fullBox('trun', 0, 0x701, u32(1), u32(dataOffset), u32(duration), u32(data.length), u32(keyframe ? SAMPLE_FLAGS_SYNC : SAMPLE_FLAGS_NON_SYNC)),
    ),
  );
  if (moof.length !== moofSize) throw new Error(`moof size mismatch ${moof.length} != ${moofSize}`);
  return concat([moof, box('mdat', data)]);
}

interface PendingSample {
  data: Uint8Array;
  timestampUs: number;
  keyframe: boolean;
}

/**
 * Streaming muxer: feed encoded samples, receive init + fragments through onData.
 * Video samples without an explicit duration are held until the next sample
 * arrives so that exact durations can be written (adds one frame of latency).
 */
export class Fmp4Muxer {
  private readonly onData: MuxerOptions['onData'];
  private readonly video?: VideoTrackConfig;
  private readonly audio?: AudioTrackConfig;
  private sequence = 1;
  private originUs: number | null = null;
  private pendingVideo: PendingSample | null = null;
  private videoDecodeTime = 0; // in video timescale
  private audioDecodeTime = 0; // in audio timescale (samples)
  private started = false;
  private lastVideoDurationUs = 33333;

  constructor(opts: MuxerOptions) {
    this.onData = opts.onData;
    this.video = opts.video;
    this.audio = opts.audio;
  }

  get videoTimescale(): number {
    return this.video?.timescale ?? VIDEO_TIMESCALE;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const init = buildInitSegment(this.video, this.audio);
    this.onData(init, { kind: 'init', keyframe: true, timestampUs: 0, durationUs: 0, sequence: 0 });
  }

  private relative(tsUs: number): number {
    if (this.originUs === null) this.originUs = tsUs;
    return Math.max(0, tsUs - this.originUs);
  }

  addVideoSample(data: Uint8Array, timestampUs: number, keyframe: boolean, durationUs?: number): void {
    if (!this.video) throw new Error('muxer has no video track');
    if (!this.started) this.start();
    const rel = this.relative(timestampUs);
    if (durationUs && durationUs > 0) {
      this.emitVideo({ data, timestampUs: rel, keyframe }, durationUs);
      return;
    }
    if (this.pendingVideo) {
      const dur = Math.max(1000, rel - this.pendingVideo.timestampUs);
      this.emitVideo(this.pendingVideo, dur, rel);
    }
    this.pendingVideo = { data, timestampUs: rel, keyframe };
  }

  private emitVideo(sample: PendingSample, durationUs: number, nextTimestampUs?: number): void {
    const ts = this.videoTimescale;
    // Keep decode time locked to the sample's presentation time to avoid drift.
    const base = Math.round((sample.timestampUs * ts) / 1e6);
    // Derive the duration from the next sample's decode time so fragments are exactly
    // contiguous. Rounding the duration independently leaves a sub-millisecond seam, and
    // any seam at all is a hole that MSE can stall on.
    const durationTs =
      nextTimestampUs === undefined
        ? Math.max(1, Math.round((durationUs * ts) / 1e6))
        : Math.max(1, Math.round((nextTimestampUs * ts) / 1e6) - base);
    this.videoDecodeTime = base;
    this.lastVideoDurationUs = durationUs;
    const frag = buildFragment(VIDEO_TRACK_ID, this.sequence, base, durationTs, sample.data, sample.keyframe);
    this.onData(frag, { kind: 'video', keyframe: sample.keyframe, timestampUs: sample.timestampUs, durationUs, sequence: this.sequence });
    this.sequence++;
  }

  addAudioSample(data: Uint8Array, timestampUs: number, durationUs: number): void {
    if (!this.audio) throw new Error('muxer has no audio track');
    if (!this.started) this.start();
    const rel = this.relative(timestampUs);
    const sr = this.audio.sampleRate;
    const durationSamples = Math.max(1, Math.round((durationUs * sr) / 1e6));
    let base = Math.round((rel * sr) / 1e6);
    // Audio frames are contiguous; snap tiny timestamp jitter to the running decode time
    // so MSE does not see micro-gaps, but resync on real discontinuities (> 40 ms).
    if (Math.abs(base - this.audioDecodeTime) < sr * 0.04) base = this.audioDecodeTime;
    this.audioDecodeTime = base + durationSamples;
    const frag = buildFragment(AUDIO_TRACK_ID, this.sequence, base, durationSamples, data, true);
    this.onData(frag, { kind: 'audio', keyframe: true, timestampUs: rel, durationUs, sequence: this.sequence });
    this.sequence++;
  }

  /** Flush the held video sample using the last known frame duration. */
  flush(): void {
    if (this.pendingVideo) {
      this.emitVideo(this.pendingVideo, this.lastVideoDurationUs);
      this.pendingVideo = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers (used by tests and the HLS segmenter)
// ---------------------------------------------------------------------------

export interface ParsedBox {
  type: string;
  start: number;
  size: number;
  /** Payload (excluding the 8-byte header). */
  payload: Uint8Array;
}

export function parseBoxes(buf: Uint8Array, start = 0, end = buf.length): ParsedBox[] {
  const out: ParsedBox[] = [];
  let pos = start;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    let headerLen = 8;
    if (size === 1) {
      size = dv.getUint32(pos + 12) + dv.getUint32(pos + 8) * 0x100000000;
      headerLen = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerLen || pos + size > end) break;
    out.push({ type, start: pos, size, payload: buf.subarray(pos + headerLen, pos + size) });
    pos += size;
  }
  return out;
}

export function findBox(buf: Uint8Array, path: string[]): ParsedBox | undefined {
  let current: Uint8Array = buf;
  let found: ParsedBox | undefined;
  for (const type of path) {
    const boxes = parseBoxes(current);
    found = boxes.find((b) => b.type === type);
    if (!found) return undefined;
    current = found.payload;
    // Full boxes with children: skip version/flags for containers we know about.
    if (type === 'stsd') current = current.subarray(8);
    if (type === 'avc1' || type === 'hvc1') current = current.subarray(78);
    if (type === 'mp4a' || type === 'Opus') current = current.subarray(28);
  }
  return found;
}

export function codecsString(video?: VideoTrackConfig, audio?: AudioTrackConfig, videoCodecString?: string, audioCodecString?: string): string {
  const parts: string[] = [];
  if (video) parts.push(videoCodecString ?? (video.codec === 'avc' ? avcCodecString(video.description) : 'hvc1.1.6.L120.B0'));
  if (audio) parts.push(audioCodecString ?? (audio.codec === 'aac' ? 'mp4a.40.2' : 'opus'));
  return parts.join(',');
}

export function avcCodecString(avcC: Uint8Array): string {
  if (avcC.length < 4) return 'avc1.42E01E';
  const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}
