/**
 * Capture + encode pipeline (runs in the renderer, where WebCodecs and screen capture live).
 *
 *   getDisplayMedia / media file  ->  MediaStreamTrackProcessor  ->  latest-frame slot
 *   -> wall-clock pacer (constant frame rate, repeats unchanged frames, scale/crop on canvas)
 *   -> VideoEncoder (H.264, hardware when available) + AudioEncoder (AAC or Opus)
 *   -> Fmp4Muxer (one fragment per sample) -> IPC to the main process StreamHub
 *
 * All timestamps are generated here on one clock: video from the pacer grid, audio from a
 * sample counter anchored to the same clock. Chromium's capture timestamps are not used
 * because screen and loopback-audio tracks do not share a time base.
 */

import { Fmp4Muxer, avcCodecString, type FragmentInfo } from '@shared/fmp4';
import type { EncoderInfo, StreamConfig, StreamMeta } from '@shared/types';

export interface PipelineEvents {
  state: (state: { active: boolean; paused: boolean; error?: string; reason?: string }) => void;
}

const RESOLUTION_LIMITS: Record<string, number> = {
  native: Infinity,
  '2160p': 2160,
  '1440p': 1440,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
};

export function pickBitrate(width: number, height: number, fps: number, quality: StreamConfig['quality'], custom?: number): number {
  if (custom && custom > 0) return custom;
  const pixelsPerSec = width * height * fps;
  // bits per pixel tuned for screen content (sharp text needs more than camera video).
  const bpp: Record<string, number> = { low: 0.045, balanced: 0.08, auto: 0.1, high: 0.14, best: 0.2 };
  const raw = pixelsPerSec * (bpp[quality] ?? 0.1);
  return Math.round(Math.max(600_000, Math.min(40_000_000, raw)));
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

export function avcLevelFor(width: number, height: number, fps: number): string {
  const mbps = (width * height * fps) / 256; // macroblocks per second
  if (mbps <= 245760 && width * height <= 2097152) return '28'; // 4.0
  if (mbps <= 522240) return '2A'; // 4.2
  if (mbps <= 983040) return '33'; // 5.1
  return '34'; // 5.2
}

function bufferOf(d: AllowSharedBufferSource | undefined): Uint8Array | null {
  if (!d) return null;
  if (d instanceof ArrayBuffer) return new Uint8Array(d.slice(0));
  const v = d as ArrayBufferView;
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export class CapturePipeline {
  private stream: MediaStream | null = null;
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private muxer: Fmp4Muxer | null = null;
  private videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private mediaEl: HTMLVideoElement | null = null;
  private audioCtx: AudioContext | null = null;
  private running = false;
  private stopping = false;
  paused = false;
  private latestFrame: VideoFrame | null = null;
  private heldFrame: VideoFrame | null = null;
  private pacer: number | null = null;
  private startMs = 0;
  private lastTick = -1;
  private keyframeRequested = true;
  private lastKeyframeUs = -Infinity;
  private gopUs = 1_000_000;
  private frameIntervalUs = 33333;
  private dropped = 0;
  private encoded = 0;
  private pendingVideo: Array<{ data: Uint8Array; ts: number; key: boolean; dur: number }> = [];
  private pendingAudio: Array<{ data: Uint8Array; ts: number; dur: number }> = [];
  private videoDesc: Uint8Array | null = null;
  private audioDesc: Uint8Array | null | undefined = undefined;
  private audioCodec: 'aac' | 'opus' | null = null;
  private audioSampleRate = 48000;
  private audioChannels = 2;
  private audioNextUs = -1;
  private videoCodecString = '';
  private encoderInfo: EncoderInfo | null = null;
  private config: StreamConfig | null = null;
  private target = { width: 0, height: 0 };
  private crop: { x: number; y: number; width: number; height: number } | null = null;
  private audioOnly = false;
  private muxerTimer: number | null = null;
  private statsTimer: number | null = null;
  /** True when cropping or scaling means frames must go through the canvas. */
  private canvasRequired = false;
  /** AirPlay screen-mirroring tap: emit raw avcC access units for the mirror transport. */
  private mirrorTap = false;
  private mirrorConfigSent = false;
  onRawVideo: ((au: Uint8Array, keyframe: boolean, config?: Uint8Array) => void) | null = null;
  /**
   * Google Cast low-latency tap: a second, independent VP8 encoder fed the same paced frames
   * as the primary H.264 one, for the real-time Cast Streaming ("mirroring") transport —
   * see src/main/cast/mirroring.ts. Separate encoder because the receiver app for this path
   * (Chrome Mirroring) requires VP8, not H.264.
   */
  private vp8Encoder: VideoEncoder | null = null;
  private castMirrorTap = false;
  private castMirrorKeyframeRequested = true;
  private castMirrorLastKeyframeUs = -Infinity;
  /** Actual VP8 encode dimensions, capped independently of the primary H.264 target. */
  private vp8Width = 0;
  private vp8Height = 0;
  /** VP8 delta frames chain off the previous frame with no built-in recovery on loss (no
   *  retransmission is implemented for Cast Streaming yet), so a single dropped packet would
   *  otherwise freeze the picture forever. Re-keying periodically bounds that to one interval. */
  private readonly castMirrorGopUs = 2_000_000;
  onRawVideoVp8: ((chunk: Uint8Array, keyframe: boolean, timestampUs: number, width: number, height: number) => void) | null = null;
  /** Fired if this Chromium build cannot encode VP8 at all, so the caller can fall back. */
  onCastMirrorUnavailable: (() => void) | null = null;
  /**
   * Serialises start/stop. Both are async and were independently reachable (the stop and
   * start IPC commands arrive on separate callbacks), so an in-flight teardown could run
   * its second half *after* a new start had built a fresh session and dismantle it —
   * capture appeared to start and instantly died.
   */
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly send: (data: Uint8Array, info: FragmentInfo) => void,
    private readonly sendMeta: (meta: StreamMeta) => void,
    private readonly onState: PipelineEvents['state'],
  ) {}

  get active(): boolean {
    return this.running;
  }

  get stats(): { dropped: number; encoded: number } {
    return { dropped: this.dropped, encoded: this.encoded };
  }

  private nowUs(): number {
    return Math.round((performance.now() - this.startMs) * 1000);
  }

  /** Public entry points queue behind each other; internal callers use the *Internal forms. */
  start(config: StreamConfig): Promise<void> {
    return this.enqueue(() => this.startInternal(config));
  }

  stop(reason?: string): Promise<void> {
    return this.enqueue(() => this.stopInternal(reason));
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(op, op);
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startInternal(config: StreamConfig): Promise<void> {
    if (this.running) await this.stopInternal();
    this.config = config;
    this.stopping = false;
    this.dropped = 0;
    this.encoded = 0;
    this.pendingVideo = [];
    this.pendingAudio = [];
    this.videoDesc = null;
    this.audioDesc = undefined;
    this.audioCodec = null;
    this.audioNextUs = -1;
    this.encoderInfo = null;
    this.muxer = null;
    this.paused = false;
    this.keyframeRequested = true;
    this.lastKeyframeUs = -Infinity;
    this.lastTick = -1;
    this.audioOnly = config.sourceKind === 'audio';
    this.gopUs = config.latency === 'lowest' ? 500_000 : config.latency === 'quality' ? 2_000_000 : 1_000_000;
    this.frameIntervalUs = Math.round(1e6 / config.frameRate);
    try {
      this.stream = await this.acquireStream(config);
      this.running = true;
      this.startMs = performance.now();
      const videoTrack = this.stream.getVideoTracks()[0];
      const audioTrack = this.stream.getAudioTracks()[0];
      if (!this.audioOnly && !videoTrack) throw new Error('no video track available');
      if (this.audioOnly && !audioTrack) throw new Error('system audio capture is not available');
      if (videoTrack && !this.audioOnly) await this.setupVideo(videoTrack, config);
      if (audioTrack && (config.audio || this.audioOnly)) await this.setupAudio(audioTrack, config);
      else this.audioDesc = null;
      for (const t of this.stream.getTracks()) t.addEventListener('ended', () => void this.stop('capture source ended'));
      if (this.audioOnly && videoTrack) videoTrack.enabled = false;
      this.muxerTimer = window.setTimeout(() => this.ensureMuxer(true), 2500);
      this.statsTimer = window.setInterval(() => this.onState({ active: this.running, paused: this.paused }), 2000);
      this.onState({ active: true, paused: false });
    } catch (err) {
      this.running = false;
      await this.stopInternal((err as Error).message);
      throw err;
    }
  }

  private async acquireStream(config: StreamConfig): Promise<MediaStream> {
    if (config.sourceKind === 'media') {
      if (!config.mediaPath) throw new Error('no media file selected');
      return this.captureMediaFile(config.mediaPath);
    }
    const constraints: DisplayMediaStreamOptions = {
      video: { frameRate: { ideal: config.frameRate, max: 60 } } as MediaTrackConstraints,
      audio: config.audio || config.sourceKind === 'audio',
    };
    return navigator.mediaDevices.getDisplayMedia(constraints);
  }

  private async captureMediaFile(path: string): Promise<MediaStream> {
    const el = document.createElement('video');
    el.style.position = 'fixed';
    el.style.left = '-10000px';
    el.style.width = '16px';
    el.style.height = '9px';
    el.crossOrigin = 'anonymous';
    el.src = `file:///${path.replace(/\\/g, '/')}`;
    el.playsInline = true;
    document.body.appendChild(el);
    this.mediaEl = el;
    await new Promise<void>((resolve, reject) => {
      el.onloadedmetadata = () => resolve();
      el.onerror = () => reject(new Error('this file cannot be decoded for transcoding'));
    });
    const ctx = new AudioContext();
    this.audioCtx = ctx;
    const src = ctx.createMediaElementSource(el);
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest); // not connected to ctx.destination -> no local playback
    const captured: MediaStream = (el as any).captureStream ? (el as any).captureStream() : (el as any).mozCaptureStream();
    const stream = new MediaStream([...captured.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    await el.play();
    el.onended = () => void this.stop('media playback finished');
    return stream;
  }

  /** Media transport controls when transcoding a file. */
  mediaControl(action: 'play' | 'pause' | 'seek', position?: number): void {
    if (!this.mediaEl) return;
    if (action === 'play') void this.mediaEl.play();
    if (action === 'pause') this.mediaEl.pause();
    if (action === 'seek' && position !== undefined) this.mediaEl.currentTime = position;
  }

  get mediaPosition(): { position: number; duration: number } | null {
    if (!this.mediaEl) return null;
    return { position: this.mediaEl.currentTime, duration: this.mediaEl.duration || 0 };
  }

  // ------------------------------------------------------------------------ video

  private async setupVideo(track: MediaStreamTrack, config: StreamConfig): Promise<void> {
    const s = track.getSettings();
    let srcW = s.width ?? 1920;
    let srcH = s.height ?? 1080;
    this.crop = null;
    if (config.sourceKind === 'region' && config.region && config.region.width > 8 && config.region.height > 8) {
      this.crop = { ...config.region };
      srcW = this.crop.width;
      srcH = this.crop.height;
    }
    const limit = RESOLUTION_LIMITS[config.resolution] ?? 1080;
    const scale = Math.min(1, limit / Math.min(srcW, srcH), 4096 / Math.max(srcW, srcH));
    this.target = { width: even(srcW * scale), height: even(srcH * scale) };
    this.canvasRequired = !!this.crop || scale < 1;
    if (this.canvasRequired) {
      this.canvas = new OffscreenCanvas(this.target.width, this.target.height);
      this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    }
    const bitrate = pickBitrate(this.target.width, this.target.height, config.frameRate, config.quality, config.videoBitrate);
    const level = avcLevelFor(this.target.width, this.target.height, config.frameRate);
    const candidates = [`avc1.6400${level}`, `avc1.4D40${level}`, `avc1.42E0${level}`, 'avc1.42E028'];
    let chosen: VideoEncoderConfig | null = null;
    let hw = false;
    for (const accel of ['prefer-hardware', 'no-preference'] as const) {
      for (const codec of candidates) {
        const cfg: VideoEncoderConfig = {
          codec,
          width: this.target.width,
          height: this.target.height,
          bitrate,
          framerate: config.frameRate,
          latencyMode: config.latency === 'quality' ? 'quality' : 'realtime',
          hardwareAcceleration: accel,
          avc: { format: 'avc' },
          bitrateMode: 'variable',
        };
        try {
          const support = await VideoEncoder.isConfigSupported(cfg);
          if (support.supported) {
            chosen = cfg;
            hw = accel === 'prefer-hardware';
            break;
          }
        } catch {
          /* try next */
        }
      }
      if (chosen) break;
    }
    if (!chosen) throw new Error('no H.264 encoder available in this Chromium build');
    this.videoCodecString = chosen.codec;
    this.encoderInfo = {
      videoCodec: chosen.codec,
      audioCodec: '',
      width: this.target.width,
      height: this.target.height,
      frameRate: config.frameRate,
      videoBitrate: bitrate,
      audioBitrate: config.audioBitrate,
      hardwareAccelerated: hw,
    };
    const encoder = new VideoEncoder({
      output: (chunk, meta) => this.onVideoChunk(chunk, meta),
      error: (e) => void this.stop(`video encoder error: ${e.message}`),
    });
    encoder.configure(chosen);
    this.videoEncoder = encoder;
    const processor = new MediaStreamTrackProcessor<VideoFrame>({ track });
    this.videoReader = processor.readable.getReader();
    void this.videoLoop();
    this.startPacer();
  }

  /** Keep only the most recent captured frame; the pacer decides when to encode. */
  private async videoLoop(): Promise<void> {
    const reader = this.videoReader!;
    while (this.running) {
      let result: ReadableStreamReadResult<VideoFrame>;
      try {
        result = await reader.read();
      } catch {
        break;
      }
      if (result.done) break;
      if (!this.running) {
        result.value.close();
        break;
      }
      this.latestFrame?.close();
      this.latestFrame = result.value;
    }
    if (this.running && !this.stopping) void this.stop('video capture ended');
  }

  private startPacer(): void {
    const intervalMs = this.frameIntervalUs / 1000;
    this.pacer = window.setInterval(() => this.tick(), Math.max(4, intervalMs / 2));
  }

  private tick(): void {
    if (!this.running || !this.videoEncoder || this.videoEncoder.state !== 'configured') return;
    const nowUs = this.nowUs();
    const tickIndex = Math.floor(nowUs / this.frameIntervalUs);
    if (tickIndex <= this.lastTick) return;
    const source = this.paused ? this.heldFrame ?? this.latestFrame : this.latestFrame;
    if (!source) return;
    if (this.videoEncoder.encodeQueueSize > 2) {
      this.dropped++;
      this.lastTick = tickIndex;
      return;
    }
    if (this.paused && !this.heldFrame) this.heldFrame = source.clone();
    if (!this.paused && this.heldFrame) {
      this.heldFrame.close();
      this.heldFrame = null;
    }
    const ts = tickIndex * this.frameIntervalUs;
    const durationTicks = this.lastTick < 0 ? 1 : tickIndex - this.lastTick;
    this.lastTick = tickIndex;
    let frame: VideoFrame;
    try {
      frame = this.render(source, ts, this.paused);
    } catch (err) {
      console.warn('render failed', err);
      return;
    }
    const key = this.keyframeRequested || ts - this.lastKeyframeUs >= this.gopUs;
    if (key) {
      this.keyframeRequested = false;
      this.lastKeyframeUs = ts;
    }
    (frame as any).__durationUs = durationTicks * this.frameIntervalUs;
    if (this.castMirrorTap && this.vp8Encoder && this.vp8Encoder.state === 'configured' && this.vp8Encoder.encodeQueueSize <= 2) {
      const vp8Key = this.castMirrorKeyframeRequested || ts - this.castMirrorLastKeyframeUs >= this.castMirrorGopUs;
      if (vp8Key) {
        this.castMirrorKeyframeRequested = false;
        this.castMirrorLastKeyframeUs = ts;
      }
      const vp8Frame = frame.clone();
      this.vp8Encoder.encode(vp8Frame, { keyFrame: vp8Key });
      vp8Frame.close();
    }
    this.videoEncoder.encode(frame, { keyFrame: key });
    frame.close();
  }

  private render(source: VideoFrame, timestamp: number, paused: boolean): VideoFrame {
    const duration = this.frameIntervalUs;
    if (!paused && !this.canvasRequired) {
      // Drop the canvas the pause banner needed, so we return to the zero-copy path. Left
      // in place, a single pause sent every later frame through drawImage for the rest of
      // the session.
      if (this.canvas) {
        this.canvas = null;
        this.ctx = null;
      }
      return new VideoFrame(source, { timestamp, duration });
    }
    if (!this.canvas) {
      this.canvas = new OffscreenCanvas(this.target.width, this.target.height);
      this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    }
    const ctx = this.ctx!;
    const c = this.crop;
    if (c) ctx.drawImage(source, c.x, c.y, c.width, c.height, 0, 0, this.target.width, this.target.height);
    else ctx.drawImage(source, 0, 0, this.target.width, this.target.height);
    if (paused) {
      const h = Math.max(28, Math.round(this.target.height * 0.06));
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, this.target.height - h * 1.6, this.target.width, h * 1.6);
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.round(h * 0.8)}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText('Paused', this.target.width / 2, this.target.height - h * 0.8);
    }
    return new VideoFrame(this.canvas, { timestamp, duration });
  }

  // ------------------------------------------------------------------------ audio

  private async setupAudio(track: MediaStreamTrack, config: StreamConfig): Promise<void> {
    const s = track.getSettings();
    this.audioSampleRate = s.sampleRate ?? 48000;
    this.audioChannels = Math.min(2, s.channelCount ?? 2) || 2;
    const bitrate = config.audioBitrate || 160000;
    const candidates: Array<{ codec: string; kind: 'aac' | 'opus' }> = [
      { codec: 'mp4a.40.2', kind: 'aac' },
      { codec: 'opus', kind: 'opus' },
    ];
    let chosen: AudioEncoderConfig | null = null;
    for (const c of candidates) {
      const cfg = {
        codec: c.codec,
        sampleRate: this.audioSampleRate,
        numberOfChannels: this.audioChannels,
        bitrate,
        ...(c.kind === 'aac' ? { aac: { format: 'aac' } } : {}),
      } as AudioEncoderConfig;
      try {
        const support = await AudioEncoder.isConfigSupported(cfg);
        if (support.supported) {
          chosen = cfg;
          this.audioCodec = c.kind;
          break;
        }
      } catch {
        /* next */
      }
    }
    if (!chosen) {
      console.warn('no audio encoder available; streaming without audio');
      this.audioDesc = null;
      return;
    }
    if (this.encoderInfo) this.encoderInfo.audioCodec = chosen.codec;
    else this.encoderInfo = { videoCodec: '', audioCodec: chosen.codec, width: 0, height: 0, frameRate: 0, videoBitrate: 0, audioBitrate: bitrate };
    const encoder = new AudioEncoder({
      output: (chunk, meta) => this.onAudioChunk(chunk, meta),
      error: (e) => void this.stop(`audio encoder error: ${e.message}`),
    });
    encoder.configure(chosen);
    this.audioEncoder = encoder;
    const processor = new MediaStreamTrackProcessor<AudioData>({ track });
    this.audioReader = processor.readable.getReader();
    void this.audioLoop();
  }

  private async audioLoop(): Promise<void> {
    const reader = this.audioReader!;
    while (this.running) {
      let result: ReadableStreamReadResult<AudioData>;
      try {
        result = await reader.read();
      } catch {
        break;
      }
      if (result.done) break;
      const data = result.value;
      const encoder = this.audioEncoder;
      if (!encoder || encoder.state !== 'configured' || !this.running) {
        data.close();
        continue;
      }
      if (encoder.encodeQueueSize > 8) {
        data.close();
        continue;
      }
      const frames = data.numberOfFrames;
      const channels = data.numberOfChannels;
      const sr = data.sampleRate;
      if (sr !== this.audioSampleRate || channels !== this.audioChannels) {
        // Track settings changed after configure; keep encoding with the configured layout.
        this.audioSampleRate = sr;
        this.audioChannels = channels;
      }
      // Restamp on our clock: contiguous sample counter, resynced to wall time if it drifts > 80 ms.
      const wall = this.nowUs();
      if (this.audioNextUs < 0 || Math.abs(this.audioNextUs - wall) > 80_000) this.audioNextUs = wall;
      const timestamp = this.audioNextUs;
      this.audioNextUs += Math.round((frames * 1e6) / sr);
      const planar = new Float32Array(frames * channels);
      if (!this.paused) {
        try {
          if (data.format === 'f32-planar') {
            for (let ch = 0; ch < channels; ch++) data.copyTo(planar.subarray(ch * frames, (ch + 1) * frames), { planeIndex: ch });
          } else {
            // Convert whatever the capturer gives us (usually f32 interleaved) to planar.
            const interleaved = new Float32Array(frames * channels);
            data.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
            for (let ch = 0; ch < channels; ch++) for (let i = 0; i < frames; i++) planar[ch * frames + i] = interleaved[i * channels + ch];
          }
        } catch (err) {
          console.warn('audio copy failed', err);
        }
      }
      data.close();
      const restamped = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: frames, numberOfChannels: channels, timestamp, data: planar });
      encoder.encode(restamped);
      restamped.close();
    }
  }

  // ------------------------------------------------------------------------ encoder output

  private onVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    if (!this.running) return;
    if (meta?.decoderConfig?.description && !this.videoDesc) this.videoDesc = bufferOf(meta.decoderConfig.description);
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.encoded++;
    const dur = chunk.duration && chunk.duration > 0 ? chunk.duration : this.frameIntervalUs;
    const key = chunk.type === 'key';
    // AirPlay screen-mirroring tap: WebCodecs 'avc' output is already avcC (length-prefixed
    // NALUs), exactly what the mirror transport sends. The avcC config rides the first frame.
    if (this.mirrorTap && this.onRawVideo) {
      const config = !this.mirrorConfigSent && this.videoDesc ? this.videoDesc : undefined;
      if (config) this.mirrorConfigSent = true;
      this.onRawVideo(data, key, config);
    }
    const sample = { data, ts: chunk.timestamp, key, dur };
    if (!this.muxer) {
      this.pendingVideo.push(sample);
      if (this.pendingVideo.length > 120) this.pendingVideo.shift();
      this.ensureMuxer(false);
      return;
    }
    // Pass no duration: the muxer derives each frame's duration from the next frame's
    // timestamp. A fixed duration would leave a hole in the timeline whenever a frame is
    // dropped, and MSE stalls forever at a hole (this is what froze receivers).
    this.muxer.addVideoSample(sample.data, sample.ts, sample.key, undefined);
  }

  private onAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void {
    if (!this.running) return;
    if (this.audioDesc === undefined) {
      this.audioDesc = bufferOf(meta?.decoderConfig?.description) ?? null;
      if (meta?.decoderConfig?.sampleRate) this.audioSampleRate = meta.decoderConfig.sampleRate;
      if (meta?.decoderConfig?.numberOfChannels) this.audioChannels = meta.decoderConfig.numberOfChannels;
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const dur = chunk.duration ?? Math.round(((this.audioCodec === 'aac' ? 1024 : 960) / this.audioSampleRate) * 1e6);
    if (!this.muxer) {
      this.pendingAudio.push({ data, ts: chunk.timestamp, dur });
      if (this.pendingAudio.length > 400) this.pendingAudio.shift();
      this.ensureMuxer(false);
      return;
    }
    this.muxer.addAudioSample(data, chunk.timestamp, dur);
  }

  /** Create the muxer once we know the decoder configs (or give up waiting for audio). */
  private ensureMuxer(force: boolean): void {
    if (this.muxer || !this.running) return;
    const haveVideo = this.audioOnly || !!this.videoDesc;
    const wantAudio = !!this.audioEncoder;
    const haveAudio = !wantAudio || this.audioDesc !== undefined;
    if (!haveVideo) return;
    if (!haveAudio && !force) return;
    const includeAudio = wantAudio && this.audioDesc !== undefined;
    const audioCfg = includeAudio
      ? { codec: this.audioCodec ?? 'aac', sampleRate: this.audioSampleRate, channels: this.audioChannels, description: this.audioDesc ?? undefined, bitrate: this.config?.audioBitrate }
      : undefined;
    const videoCfg = this.audioOnly ? undefined : { codec: 'avc' as const, width: this.target.width, height: this.target.height, description: this.videoDesc! };
    this.muxer = new Fmp4Muxer({
      video: videoCfg,
      audio: audioCfg,
      onData: (data, info) => this.send(data, info),
    });
    const codecs = [videoCfg ? avcCodecString(videoCfg.description) : '', audioCfg ? (audioCfg.codec === 'aac' ? 'mp4a.40.2' : 'opus') : ''].filter(Boolean).join(',');
    const info: EncoderInfo = {
      ...(this.encoderInfo ?? { videoCodec: '', audioCodec: '', width: 0, height: 0, frameRate: 0, videoBitrate: 0, audioBitrate: 0 }),
      videoCodec: this.videoCodecString,
      audioCodec: audioCfg ? (audioCfg.codec === 'aac' ? 'mp4a.40.2' : 'opus') : '',
    };
    this.sendMeta({ encoder: info, codecs, mime: `${this.audioOnly ? 'audio' : 'video'}/mp4; codecs="${codecs}"`, audioOnly: this.audioOnly });
    this.muxer.start();
    // Replay buffered samples starting from the first keyframe.
    const firstKey = this.pendingVideo.findIndex((s) => s.key);
    const video = firstKey >= 0 ? this.pendingVideo.slice(firstKey) : [];
    const startTs = video[0]?.ts ?? this.pendingAudio[0]?.ts ?? 0;
    const audio = includeAudio ? this.pendingAudio.filter((a) => a.ts >= startTs - 50_000) : [];
    const merged = [
      ...video.map((v) => ({ ts: v.ts, run: () => this.muxer!.addVideoSample(v.data, v.ts, v.key, undefined) })),
      ...audio.map((a) => ({ ts: a.ts, run: () => this.muxer!.addAudioSample(a.data, a.ts, a.dur) })),
    ].sort((a, b) => a.ts - b.ts);
    for (const m of merged) m.run();
    this.pendingVideo = [];
    this.pendingAudio = [];
    if (this.muxerTimer) {
      clearTimeout(this.muxerTimer);
      this.muxerTimer = null;
    }
  }

  requestKeyframe(): void {
    this.keyframeRequested = true;
  }

  /** Ask the VP8 tap for a fresh keyframe (e.g. right after a Cast Streaming session negotiates). */
  requestCastMirrorKeyframe(): void {
    this.castMirrorKeyframeRequested = true;
  }

  /** Turn the raw-H.264 mirror tap on or off. Enabling forces a fresh keyframe + config. */
  setMirrorTap(active: boolean): void {
    if (this.mirrorTap === active) return;
    this.mirrorTap = active;
    if (active) {
      this.mirrorConfigSent = false;
      this.keyframeRequested = true; // the receiver needs an IDR + avcC to start decoding
    }
  }

  /**
   * Turn the Cast Streaming (low-latency Chromecast) VP8 tap on or off. Lazily creates a
   * second encoder alongside the primary H.264 one — most sessions never cast to Google Cast,
   * so it costs nothing until asked for. Resolves once the encoder is confirmed usable (or
   * calls onCastMirrorUnavailable and resolves anyway) so the caller can fall back promptly.
   */
  async setCastMirrorTap(active: boolean): Promise<void> {
    if (this.castMirrorTap === active) return;
    if (!active) {
      this.castMirrorTap = false;
      if (this.vp8Encoder && this.vp8Encoder.state !== 'closed') this.vp8Encoder.close();
      this.vp8Encoder = null;
      return;
    }
    if (!this.running || this.target.width <= 0 || this.target.height <= 0) {
      this.onCastMirrorUnavailable?.();
      return;
    }
    // Cap independently of the primary H.264 target (which can be native/1080p+). Running a
    // second full-resolution real-time encoder alongside the first is expensive, and this one
    // is very likely software-only: measured 1.4 CPU cores sustained at 1920x1080 with no
    // hardware-acceleration preference even requested, which reads as encoder backlog and
    // shows up as several seconds of accumulating lag with no relation to anything on the
    // network side. A real captured Chrome OFFER (see mirroring.ts) also mirrors at 1280x720,
    // not the source's native resolution, for what is almost certainly this same reason.
    const vp8Scale = Math.min(1, 720 / Math.min(this.target.width, this.target.height));
    const vp8Width = even(this.target.width * vp8Scale);
    const vp8Height = even(this.target.height * vp8Scale);
    const frameRate = this.config?.frameRate ?? 30;
    const bitrate = pickBitrate(vp8Width, vp8Height, frameRate, this.config?.quality ?? 'balanced');
    let cfg: VideoEncoderConfig | null = null;
    for (const accel of ['prefer-hardware', 'no-preference'] as const) {
      const candidate: VideoEncoderConfig = {
        codec: 'vp8',
        width: vp8Width,
        height: vp8Height,
        bitrate,
        framerate: frameRate,
        latencyMode: 'realtime',
        hardwareAcceleration: accel,
        bitrateMode: 'variable',
      };
      try {
        const support = await VideoEncoder.isConfigSupported(candidate);
        if (support.supported) {
          cfg = candidate;
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (!cfg) {
      console.warn('VP8 encoding is not available in this Chromium build; cannot use Cast Streaming');
      this.onCastMirrorUnavailable?.();
      return;
    }
    this.vp8Width = vp8Width;
    this.vp8Height = vp8Height;
    const encoder = new VideoEncoder({
      output: (chunk) => this.onVp8Chunk(chunk),
      error: (e) => console.warn('VP8 encoder error', e),
    });
    encoder.configure(cfg);
    this.vp8Encoder = encoder;
    this.castMirrorTap = true;
    this.castMirrorKeyframeRequested = true;
  }

  private onVp8Chunk(chunk: EncodedVideoChunk): void {
    if (!this.onRawVideoVp8) return;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.onRawVideoVp8(data, chunk.type === 'key', chunk.timestamp, this.vp8Width, this.vp8Height);
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.keyframeRequested = true;
    if (this.mediaEl) {
      if (paused) this.mediaEl.pause();
      else void this.mediaEl.play();
    }
    this.onState({ active: this.running, paused });
  }

  private async stopInternal(reason?: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const wasRunning = this.running;
    this.running = false;
    if (this.pacer) clearInterval(this.pacer);
    this.pacer = null;
    if (this.muxerTimer) clearTimeout(this.muxerTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.muxerTimer = null;
    this.statsTimer = null;
    try {
      await this.videoReader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      await this.audioReader?.cancel();
    } catch {
      /* ignore */
    }
    this.videoReader = null;
    this.audioReader = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    try {
      if (this.videoEncoder && this.videoEncoder.state !== 'closed') {
        await this.videoEncoder.flush().catch(() => undefined);
        this.videoEncoder.close();
      }
    } catch {
      /* ignore */
    }
    try {
      if (this.audioEncoder && this.audioEncoder.state !== 'closed') {
        await this.audioEncoder.flush().catch(() => undefined);
        this.audioEncoder.close();
      }
    } catch {
      /* ignore */
    }
    this.videoEncoder = null;
    this.audioEncoder = null;
    try {
      if (this.vp8Encoder && this.vp8Encoder.state !== 'closed') this.vp8Encoder.close();
    } catch {
      /* ignore */
    }
    this.vp8Encoder = null;
    this.castMirrorTap = false;
    this.muxer?.flush();
    this.muxer = null;
    this.latestFrame?.close();
    this.latestFrame = null;
    this.heldFrame?.close();
    this.heldFrame = null;
    if (this.mediaEl) {
      this.mediaEl.pause();
      this.mediaEl.remove();
      this.mediaEl = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this.canvas = null;
    this.ctx = null;
    this.paused = false;
    // Always report why capture stopped; silently swallowing "ended" reasons made a
    // capture that died on its own look like a frozen picture with nothing in the log.
    if (wasRunning || reason) {
      this.onState({ active: false, paused: false, reason: reason ?? 'stopped by request', error: reason && !/finished|stopped by request/.test(reason) ? reason : undefined });
    }
    this.stopping = false;
  }
}
