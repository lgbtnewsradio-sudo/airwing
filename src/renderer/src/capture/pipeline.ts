/**
 * Capture + encode pipeline (runs in the renderer, where WebCodecs and screen capture live).
 *
 *   getDisplayMedia / media file  ->  MediaStreamTrackProcessor  ->  (scale/crop on canvas)
 *   -> VideoEncoder (H.264, hardware when available) + AudioEncoder (AAC or Opus)
 *   -> Fmp4Muxer (one fragment per sample) -> IPC to the main process StreamHub
 */

import { Fmp4Muxer, avcCodecString, type FragmentInfo } from '@shared/fmp4';
import type { EncoderInfo, StreamConfig, StreamMeta } from '@shared/types';

export interface PipelineEvents {
  state: (state: { active: boolean; paused: boolean; error?: string }) => void;
  info: (info: EncoderInfo) => void;
}

const RESOLUTION_LIMITS: Record<string, number> = {
  native: Infinity,
  '2160p': 2160,
  '1440p': 1440,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
};

function pickBitrate(width: number, height: number, fps: number, quality: StreamConfig['quality'], custom?: number): number {
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

function avcLevelFor(width: number, height: number, fps: number): string {
  const mbps = (width * height * fps) / 256; // macroblocks per second
  if (mbps <= 245760 && width * height <= 2097152) return '28'; // 4.0
  if (mbps <= 522240) return '2A'; // 4.2
  if (mbps <= 983040) return '33'; // 5.1
  return '34'; // 5.2
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
  private heldFrame: VideoFrame | null = null;
  private keyframeRequested = true;
  private lastKeyframeUs = 0;
  private lastEncodedUs = -Infinity;
  private gopUs = 2_000_000;
  private frameIntervalUs = 33333;
  private dropped = 0;
  private encoded = 0;
  private pendingVideo: Array<{ data: Uint8Array; ts: number; key: boolean; dur?: number }> = [];
  private pendingAudio: Array<{ data: Uint8Array; ts: number; dur: number }> = [];
  private videoDesc: Uint8Array | null = null;
  private audioDesc: Uint8Array | null | undefined = undefined;
  private audioCodec: 'aac' | 'opus' | null = null;
  private audioSampleRate = 48000;
  private audioChannels = 2;
  private videoCodecString = '';
  private encoderInfo: EncoderInfo | null = null;
  private config: StreamConfig | null = null;
  private target = { width: 0, height: 0 };
  private crop: { x: number; y: number; width: number; height: number } | null = null;
  private audioOnly = false;
  private muxerTimer: number | null = null;
  private statsTimer: number | null = null;
  private lastPausedTs = 0;

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

  async start(config: StreamConfig): Promise<void> {
    if (this.running) await this.stop();
    this.config = config;
    this.stopping = false;
    this.dropped = 0;
    this.encoded = 0;
    this.pendingVideo = [];
    this.pendingAudio = [];
    this.videoDesc = null;
    this.audioDesc = undefined;
    this.audioCodec = null;
    this.muxer = null;
    this.paused = false;
    this.keyframeRequested = true;
    this.lastEncodedUs = -Infinity;
    this.audioOnly = config.sourceKind === 'audio';
    this.gopUs = config.latency === 'lowest' ? 1_000_000 : config.latency === 'quality' ? 4_000_000 : 2_000_000;
    this.frameIntervalUs = Math.round(1e6 / config.frameRate);
    try {
      this.stream = await this.acquireStream(config);
      this.running = true;
      const videoTrack = this.stream.getVideoTracks()[0];
      const audioTrack = this.stream.getAudioTracks()[0];
      if (!this.audioOnly && !videoTrack) throw new Error('no video track available');
      if (this.audioOnly && !audioTrack) throw new Error('system audio capture is not available');
      if (videoTrack && !this.audioOnly) await this.setupVideo(videoTrack, config);
      if (audioTrack && (config.audio || this.audioOnly)) await this.setupAudio(audioTrack, config);
      else this.audioDesc = null;
      for (const t of this.stream.getTracks()) t.addEventListener('ended', () => void this.stop('capture source ended'));
      if (this.audioOnly && videoTrack) {
        // Keep the loopback alive but discard video frames.
        videoTrack.enabled = false;
      }
      this.muxerTimer = window.setTimeout(() => this.ensureMuxer(true), 2500);
      this.statsTimer = window.setInterval(() => this.onState({ active: this.running, paused: this.paused }), 2000);
      this.onState({ active: true, paused: false });
    } catch (err) {
      this.running = false;
      await this.stop((err as Error).message);
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
    const captured = (el as any).captureStream ? (el as any).captureStream() : (el as any).mozCaptureStream();
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
    const needsCanvas = !!this.crop || scale < 1;
    if (needsCanvas) {
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
  }

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
      const cfg: AudioEncoderConfig = {
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
      const frame = result.value;
      try {
        this.handleFrame(frame);
      } catch (err) {
        console.error('frame error', err);
        frame.close();
      }
    }
    if (this.running && !this.stopping) void this.stop('video capture ended');
  }

  private handleFrame(frame: VideoFrame): void {
    const encoder = this.videoEncoder;
    if (!encoder || encoder.state !== 'configured') {
      frame.close();
      return;
    }
    const ts = frame.timestamp;
    // Frame-rate limiter.
    if (ts - this.lastEncodedUs < this.frameIntervalUs * 0.9) {
      frame.close();
      return;
    }
    if (encoder.encodeQueueSize > 2) {
      this.dropped++;
      frame.close();
      return;
    }
    let toEncode: VideoFrame = frame;
    if (this.paused) {
      // Hold the last real frame and keep emitting it so receivers show a frozen picture.
      if (!this.heldFrame) this.heldFrame = frame.clone();
      toEncode = this.renderHeld(this.heldFrame, ts) ?? frame;
      if (toEncode !== frame) frame.close();
    } else {
      if (this.heldFrame) {
        this.heldFrame.close();
        this.heldFrame = null;
      }
      if (this.canvas && this.ctx) {
        const c = this.crop;
        if (c) this.ctx.drawImage(frame, c.x, c.y, c.width, c.height, 0, 0, this.target.width, this.target.height);
        else this.ctx.drawImage(frame, 0, 0, this.target.width, this.target.height);
        toEncode = new VideoFrame(this.canvas, { timestamp: ts, duration: frame.duration ?? undefined });
        frame.close();
      }
    }
    const key = this.keyframeRequested || ts - this.lastKeyframeUs >= this.gopUs;
    if (key) {
      this.keyframeRequested = false;
      this.lastKeyframeUs = ts;
    }
    this.lastEncodedUs = ts;
    encoder.encode(toEncode, { keyFrame: key });
    toEncode.close();
  }

  private renderHeld(held: VideoFrame, ts: number): VideoFrame | null {
    if (!this.canvas) {
      this.canvas = new OffscreenCanvas(this.target.width, this.target.height);
      this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    }
    const ctx = this.ctx!;
    const c = this.crop;
    if (c) ctx.drawImage(held, c.x, c.y, c.width, c.height, 0, 0, this.target.width, this.target.height);
    else ctx.drawImage(held, 0, 0, this.target.width, this.target.height);
    // Paused banner
    const h = Math.max(28, Math.round(this.target.height * 0.06));
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, this.target.height - h * 1.6, this.target.width, h * 1.6);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(h * 0.8)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText('Paused', this.target.width / 2, this.target.height - h * 0.8);
    return new VideoFrame(this.canvas, { timestamp: ts });
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
      if (!encoder || encoder.state !== 'configured') {
        data.close();
        continue;
      }
      if (this.paused) {
        // Replace with silence so receivers keep a continuous audio timeline.
        const frames = data.numberOfFrames;
        const silent = new AudioData({
          format: 'f32-planar',
          sampleRate: data.sampleRate,
          numberOfFrames: frames,
          numberOfChannels: data.numberOfChannels,
          timestamp: data.timestamp,
          data: new Float32Array(frames * data.numberOfChannels),
        });
        data.close();
        encoder.encode(silent);
        silent.close();
        continue;
      }
      if (encoder.encodeQueueSize > 8) {
        data.close();
        continue;
      }
      encoder.encode(data);
      data.close();
    }
  }

  private onVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    if (!this.running) return;
    if (meta?.decoderConfig?.description && !this.videoDesc) {
      const d = meta.decoderConfig.description;
      this.videoDesc = new Uint8Array(d instanceof ArrayBuffer ? d : (d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.encoded++;
    const sample = { data, ts: chunk.timestamp, key: chunk.type === 'key', dur: chunk.duration ?? undefined };
    if (!this.muxer) {
      this.pendingVideo.push(sample);
      if (this.pendingVideo.length > 120) this.pendingVideo.shift();
      this.ensureMuxer(false);
      return;
    }
    this.muxer.addVideoSample(sample.data, sample.ts, sample.key, undefined);
  }

  private onAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void {
    if (!this.running) return;
    if (this.audioDesc === undefined) {
      const d = meta?.decoderConfig?.description;
      if (d) {
        this.audioDesc = new Uint8Array(d instanceof ArrayBuffer ? d : (d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
      } else if (this.audioCodec === 'opus') {
        this.audioDesc = null;
      } else {
        this.audioDesc = null; // AAC without ASC: muxer builds a default one
      }
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

  async stop(reason?: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const wasRunning = this.running;
    this.running = false;
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
    this.muxer?.flush();
    this.muxer = null;
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
    if (wasRunning || reason) this.onState({ active: false, paused: false, error: reason && !/finished|ended/.test(reason) ? reason : undefined });
    this.stopping = false;
  }
}
