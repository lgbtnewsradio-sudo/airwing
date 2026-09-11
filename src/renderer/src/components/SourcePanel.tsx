import { useEffect, useState } from 'react';
import type { CaptureSource, FrameRatePreset, LatencyMode, QualityPreset, ResolutionPreset, StreamConfig, StreamStats } from '@shared/types';

interface Props {
  sources: CaptureSource[];
  config: StreamConfig;
  onChange: (patch: Partial<StreamConfig>) => void;
  onRefresh: () => void;
  active: boolean;
  paused: boolean;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  stats: StreamStats | null;
}

const RESOLUTIONS: [ResolutionPreset, string][] = [
  ['native', 'Native'],
  ['2160p', '4K (2160p)'],
  ['1440p', '1440p'],
  ['1080p', '1080p'],
  ['720p', '720p'],
  ['480p', '480p'],
];
const FRAMERATES: FrameRatePreset[] = [60, 30, 24, 15];
const QUALITIES: [QualityPreset, string][] = [
  ['auto', 'Auto'],
  ['best', 'Best'],
  ['high', 'High'],
  ['balanced', 'Balanced'],
  ['low', 'Low bandwidth'],
];
const LATENCIES: [LatencyMode, string][] = [
  ['lowest', 'Lowest latency'],
  ['balanced', 'Balanced'],
  ['quality', 'Best quality'],
];

export function SourcePanel({ sources, config, onChange, onRefresh, active, paused, onStart, onStop, onPause, stats }: Props) {
  const [kind, setKind] = useState<'screen' | 'window' | 'region' | 'audio'>(config.sourceKind === 'media' ? 'screen' : (config.sourceKind as any));
  const [showQuality, setShowQuality] = useState(false);
  const screens = sources.filter((s) => s.kind === 'screen');
  const windows = sources.filter((s) => s.kind === 'window');
  const selected = sources.find((s) => s.id === config.sourceId);

  useEffect(() => {
    if (!config.sourceId && screens.length) onChange({ sourceId: screens[0].id, displayId: screens[0].displayId });
  }, [config.sourceId, screens, onChange]);

  const pick = (s: CaptureSource) => {
    onChange({ sourceId: s.id, displayId: s.displayId, sourceKind: kind === 'region' ? 'region' : s.kind, region: kind === 'region' ? config.region : undefined });
  };

  const setKindAndConfig = (k: typeof kind) => {
    setKind(k);
    if (k === 'audio') onChange({ sourceKind: 'audio', audio: true });
    else if (k === 'region') onChange({ sourceKind: 'region' });
    else {
      const list = k === 'screen' ? screens : windows;
      const keep = list.find((s) => s.id === config.sourceId) ?? list[0];
      onChange({ sourceKind: k, sourceId: keep?.id, displayId: keep?.displayId, region: undefined });
    }
  };

  const selectRegion = async () => {
    const screen = screens.find((s) => s.id === config.sourceId) ?? screens[0];
    if (!screen) return;
    const rect = await window.airwing.sources.selectRegion(screen.displayId);
    if (rect) onChange({ sourceKind: 'region', sourceId: screen.id, displayId: screen.displayId, region: rect });
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>What to stream</h2>
        <div className="header-actions">
          {active && (
            <>
              <button className="ghost small" onClick={onPause}>
                {paused ? '▶ Resume' : '⏸ Pause'}
              </button>
              <button className="danger small" onClick={onStop}>
                ■ Stop
              </button>
            </>
          )}
          <button className="ghost" onClick={onRefresh} title="Refresh sources">
            ⟳
          </button>
        </div>
      </div>
      <div className="segmented">
        {(
          [
            ['screen', 'Entire display'],
            ['window', 'Single app'],
            ['region', 'Screen region'],
            ['audio', 'Audio only'],
          ] as [typeof kind, string][]
        ).map(([k, label]) => (
          <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKindAndConfig(k)} disabled={active}>
            {label}
          </button>
        ))}
      </div>

      {kind === 'audio' ? (
        <p className="hint">Streams system audio only (what you hear) to speakers such as HomePod, Google Home, Chromecast Audio or a browser. Local playback can be muted in the options below.</p>
      ) : (
        <div className="source-grid">
          {(kind === 'window' ? windows : screens).map((s) => (
            <button key={s.id} className={`source ${config.sourceId === s.id ? 'selected' : ''}`} onClick={() => pick(s)} disabled={active} title={s.name}>
              <div className="thumb">{s.thumbnail ? <img src={s.thumbnail} alt="" /> : <div className="thumb-empty" />}</div>
              <div className="source-name">
                {s.appIcon && <img className="app-icon" src={s.appIcon} alt="" />}
                <span>{s.name}</span>
                {s.isVirtualDisplay && <span className="badge">virtual</span>}
              </div>
            </button>
          ))}
          {kind === 'window' && !windows.length && <p className="hint">No windows found. Open the app you want to mirror and refresh.</p>}
        </div>
      )}

      {kind === 'region' && (
        <div className="row">
          <button className="secondary" onClick={selectRegion} disabled={active}>
            {config.region ? 'Re-select region' : 'Select region…'}
          </button>
          {config.region && (
            <span className="hint">
              {config.region.width}×{config.region.height} at {config.region.x},{config.region.y}
            </span>
          )}
        </div>
      )}

      <button className="disclosure" onClick={() => setShowQuality((v) => !v)}>
        {showQuality ? '▾' : '▸'} Quality
        <span className="hint inline">
          {kind === 'audio' ? `${config.audioBitrate / 1000} kbps` : `${config.resolution} · ${config.frameRate} fps · ${config.quality}`}
          {config.audio || kind === 'audio' ? ' · audio' : ' · no audio'}
        </span>
      </button>
      <div className="options" hidden={!showQuality}>
        {kind !== 'audio' && (
          <>
            <label>
              Resolution
              <select value={config.resolution} onChange={(e) => onChange({ resolution: e.target.value as ResolutionPreset })} disabled={active}>
                {RESOLUTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Frame rate
              <select value={config.frameRate} onChange={(e) => onChange({ frameRate: Number(e.target.value) as FrameRatePreset })} disabled={active}>
                {FRAMERATES.map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </label>
            <label>
              Quality
              <select value={config.quality} onChange={(e) => onChange({ quality: e.target.value as QualityPreset })} disabled={active}>
                {QUALITIES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Latency
              <select value={config.latency} onChange={(e) => onChange({ latency: e.target.value as LatencyMode })} disabled={active}>
                {LATENCIES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={config.audio || kind === 'audio'} disabled={active || kind === 'audio'} onChange={(e) => onChange({ audio: e.target.checked })} />
          Include system audio
        </label>
        <label className="check">
          <input type="checkbox" checked={config.muteLocal} disabled={active || !(config.audio || kind === 'audio')} onChange={(e) => onChange({ muteLocal: e.target.checked })} />
          Mute this PC while streaming
        </label>
        <label>
          Audio bitrate
          <select value={config.audioBitrate} onChange={(e) => onChange({ audioBitrate: Number(e.target.value) })} disabled={active}>
            {[96000, 128000, 160000, 192000, 256000, 320000].map((b) => (
              <option key={b} value={b}>
                {b / 1000} kbps
              </option>
            ))}
          </select>
        </label>
      </div>

      {active && stats?.encoder && (
        <p className="hint">
          Encoding {stats.encoder.width}×{stats.encoder.height} @ {stats.fps} fps · {Math.round(stats.kbps / 1000)} Mbps · {stats.encoder.videoCodec}
          {stats.encoder.audioCodec ? ` + ${stats.encoder.audioCodec}` : ''}
          {stats.encoder.hardwareAccelerated ? ' · hardware' : ''}
          {stats.droppedFrames ? ` · ${stats.droppedFrames} dropped` : ''}
        </p>
      )}
      {!active && (
        <p className="hint">
          Pick a receiver below to start — you can stream to several at once.
          <button className="linklike" onClick={onStart} disabled={kind !== 'audio' && !selected && kind !== 'region'}>
            Or start without a receiver
          </button>
        </p>
      )}
    </div>
  );
}
