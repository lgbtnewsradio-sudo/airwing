import { useEffect, useState } from 'react';
import type { SessionInfo, StreamConfig } from '@shared/types';
import type { CapturePipeline } from '../capture/pipeline';
import { isDirectPlayable, type MediaFile } from '../App';

interface Props {
  media: MediaFile | null;
  setMedia: (m: MediaFile | null) => void;
  config: StreamConfig;
  onChange: (patch: Partial<StreamConfig>) => void;
  sessions: SessionInfo[];
  pipeline: CapturePipeline;
  active: boolean;
  onStop: () => void;
}

function fmtSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '–:––';
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60)
    .toString()
    .padStart(2, '0')}`;
}

export function MediaPanel({ media, setMedia, config, onChange, sessions, pipeline, active, onStop }: Props) {
  const [pos, setPos] = useState<{ position: number; duration: number } | null>(null);
  useEffect(() => {
    const t = setInterval(() => setPos(pipeline.mediaPosition), 500);
    return () => clearInterval(t);
  }, [pipeline]);

  const pick = async () => {
    const f = await window.airwing.media.pick();
    if (f) {
      setMedia({ path: f.path, name: f.name, mime: f.mime, size: f.size });
      onChange({ mediaPath: f.path });
    }
  };
  const mode = config.mediaMode ?? 'auto';
  const effective = media ? (mode === 'auto' ? (isDirectPlayable(media) ? 'direct' : 'transcode') : mode) : mode;
  const fileSessions = sessions.filter((s) => s.transport.endsWith('file'));

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Stream a media file</h2>
      </div>
      <p className="hint">Send a video or audio file straight to a TV or speaker. Playback runs on the receiver so your PC stays free, with full remote control from this window or the phone remote.</p>
      <div className="row">
        <button className="primary" onClick={pick} disabled={active}>
          Choose file…
        </button>
        {media && (
          <span className="file">
            <strong>{media.name}</strong> · {fmtSize(media.size)} · {media.mime}
          </span>
        )}
      </div>
      <h3>Delivery</h3>
      <div className="segmented">
        {(
          [
            ['auto', 'Auto'],
            ['direct', 'Direct (best quality)'],
            ['transcode', 'Transcode (any format)'],
          ] as [NonNullable<StreamConfig['mediaMode']>, string][]
        ).map(([m, label]) => (
          <button key={m} className={mode === m ? 'active' : ''} onClick={() => onChange({ mediaMode: m })} disabled={active}>
            {label}
          </button>
        ))}
      </div>
      <p className="hint">
        {effective === 'direct'
          ? 'Direct: the receiver plays the original file (MP4/M4V/MOV/MP3/M4A/AAC/WAV) with lossless audio and receiver-side seeking.'
          : 'Transcode: AirWing decodes the file locally (MKV, WebM, AVI, FLAC, OGG and anything else Chromium can play) and re-encodes it as a live H.264/AAC stream that every receiver understands.'}
      </p>
      {media && effective === 'direct' && <p className="hint">Now pick a receiver on the right and press “Play here”.</p>}
      {media && effective === 'transcode' && !active && <p className="hint">Pick a receiver on the right; AirWing starts transcoding automatically. Browser viewers can watch too.</p>}
      {active && config.sourceKind === 'media' && (
        <div className="media-transport">
          <button className="secondary" onClick={() => pipeline.mediaControl('play')}>
            ▶
          </button>
          <button className="secondary" onClick={() => pipeline.mediaControl('pause')}>
            ⏸
          </button>
          <input type="range" min={0} max={pos?.duration || 0} step={0.5} value={pos?.position ?? 0} onChange={(e) => pipeline.mediaControl('seek', Number(e.target.value))} />
          <span className="time">
            {fmtTime(pos?.position ?? 0)} / {fmtTime(pos?.duration ?? 0)}
          </span>
          <button className="danger" onClick={onStop}>
            ■
          </button>
        </div>
      )}
      {fileSessions.length > 0 && (
        <p className="hint">
          Playing directly on {fileSessions.map((s) => s.device.name).join(', ')}. Use the controls in the receiver list to pause, seek or change volume.
        </p>
      )}
    </div>
  );
}
