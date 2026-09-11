import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, CaptureSource, Device, LogEvent, PairingPrompt, ReceiverInfo, SessionInfo, StreamConfig, StreamStats } from '@shared/types';
import { DEFAULT_STREAM_CONFIG } from '@shared/types';
import { CapturePipeline } from './capture/pipeline';
import { FromList } from './components/FromList';
import { ToList } from './components/ToList';
import { SettingsPanel } from './components/SettingsPanel';
import { ReceiverPanel } from './components/ReceiverPanel';
import { ExtendPanel } from './components/ExtendPanel';
import { LogPanel } from './components/LogPanel';
import { PairingDialog } from './components/PairingDialog';

type View = 'main' | 'settings' | 'browser' | 'logs' | 'extend';

export interface MediaFile {
  path: string;
  name: string;
  mime: string;
  size: number;
}

const DIRECT_PLAYABLE = /\.(mp4|m4v|mov|mp3|m4a|aac|wav)$/i;
export function isDirectPlayable(media: MediaFile): boolean {
  return DIRECT_PLAYABLE.test(media.name);
}

export function App() {
  const api = window.airwing;
  const [view, setView] = useState<View>('main');
  const [devices, setDevices] = useState<Device[]>([]);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [config, setConfig] = useState<StreamConfig>(DEFAULT_STREAM_CONFIG);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [receiver, setReceiver] = useState<ReceiverInfo | null>(null);
  const [pairing, setPairing] = useState<PairingPrompt | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaFile | null>(null);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [captureState, setCaptureState] = useState<{ active: boolean; paused: boolean }>({ active: false, paused: false });
  const [volume, setVolume] = useState(1);
  const configRef = useRef(config);
  configRef.current = config;

  const pipeline = useMemo(
    () =>
      new CapturePipeline(
        (data, info) => api.capture.sendData(data, info),
        (meta) => api.capture.sendMeta(meta),
        (state) => {
          setCaptureState({ active: state.active, paused: state.paused });
          if (state.error) setError(state.error);
          api.capture.sendState({ ...state, dropped: pipeline.stats.dropped });
        },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const refreshSources = useCallback(async () => {
    try {
      setSources(await api.sources.list());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [d, s, sess, st, r, l] = await Promise.all([api.devices.list(), api.settings.get(), api.sessions.list(), api.capture.stats(), api.receiver.info(), api.app.logs()]);
      if (!alive) return;
      setDevices(d);
      setSettings(s);
      setConfig({ ...DEFAULT_STREAM_CONFIG, ...s.stream });
      setSessions(sess);
      setStats(st);
      setReceiver(r);
      setLogs(l);
      await refreshSources();
    })().catch((err) => setError((err as Error).message));
    const offs = [
      api.devices.onChange(setDevices),
      api.sessions.onChange(setSessions),
      api.capture.onStats(setStats),
      api.settings.onChange(setSettings),
      api.pairing.onPrompt(setPairing),
      api.app.onLog((ev) => setLogs((prev) => [...prev.slice(-499), ev])),
      api.capture.onCommand(async (cmd) => {
        try {
          if (cmd.type === 'start') {
            setConfig(cmd.config);
            setError(null);
            await pipeline.start(cmd.config);
          } else if (cmd.type === 'stop') await pipeline.stop();
          else if (cmd.type === 'pause') pipeline.setPaused(cmd.paused);
          else if (cmd.type === 'keyframe') pipeline.requestKeyframe();
        } catch (err) {
          setError((err as Error).message);
        }
      }),
    ];
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSources();
    }, 8000);
    return () => {
      alive = false;
      offs.forEach((off) => off());
      clearInterval(timer);
    };
  }, [api, pipeline, refreshSources]);

  const updateConfig = useCallback(
    (patch: Partial<StreamConfig>) => {
      setConfig((c) => {
        const next = { ...c, ...patch };
        void api.settings.set({ stream: next });
        return next;
      });
    },
    [api],
  );

  const stopAll = useCallback(async () => {
    await api.capture.stop();
  }, [api]);

  // Default to the primary display so the app is ready the moment it opens.
  useEffect(() => {
    if (config.sourceKind !== 'screen' || config.sourceId) return;
    const first = sources.find((s) => s.kind === 'screen' && !s.isVirtualDisplay) ?? sources.find((s) => s.kind === 'screen');
    if (first) updateConfig({ sourceId: first.id, displayId: first.displayId });
  }, [sources, config.sourceKind, config.sourceId, updateConfig]);

  // Choosing a source is the whole action: capture starts (and restarts on a new source)
  // by itself, so picking a destination is the only other step.
  const autoStarted = useRef('');
  useEffect(() => {
    if (view !== 'main') return;
    const ready = config.sourceKind === 'audio' || (config.sourceKind === 'region' ? !!config.region : config.sourceKind === 'media' ? !!config.mediaPath : !!config.sourceId);
    if (!ready) return;
    const signature = `${config.sourceKind}:${config.sourceId ?? ''}:${config.mediaPath ?? ''}:${JSON.stringify(config.region ?? null)}`;
    if (autoStarted.current === signature) return;
    autoStarted.current = signature;
    void api.capture.start({ ...configRef.current }).catch((err) => setError((err as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, config.sourceKind, config.sourceId, config.region, config.mediaPath]);

  const toggleDevice = useCallback(
    async (device: Device) => {
      const existing = sessions.find((s) => s.device.id === device.id);
      setError(null);
      setBusyDevice(device.id);
      try {
        if (existing && existing.state !== 'error') {
          await api.sessions.disconnect(device.id);
          return;
        }
        const direct = media && config.sourceKind === 'media' && (config.mediaMode === 'direct' || (config.mediaMode !== 'transcode' && isDirectPlayable(media)));
        const info = direct ? await api.sessions.connect(device.id, { type: 'file', path: media!.path }) : await api.sessions.connect(device.id, { type: 'live' });
        if (info.state === 'error' && info.error) setError(`${device.name}: ${info.error}`);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyDevice(null);
      }
    },
    [api, sessions, media, config.sourceKind, config.mediaMode],
  );

  const pickMedia = useCallback(async () => {
    const f = await api.media.pick();
    if (f) {
      setMedia({ path: f.path, name: f.name, mime: f.mime, size: f.size });
      updateConfig({ sourceKind: 'media', mediaPath: f.path });
    }
  }, [api, updateConfig]);

  const changeVolume = useCallback(
    (v: number) => {
      setVolume(v);
      for (const s of sessions) if (s.state === 'streaming') void api.sessions.mediaControl(s.device.id, { type: 'volume', volume: v });
    },
    [api, sessions],
  );

  if (!settings) return <div className="loading">Loading AirWing…</div>;

  const live = sessions.filter((s) => s.state === 'streaming' || s.state === 'paused');
  const sourceLabel =
    config.sourceKind === 'audio'
      ? 'Audio Only'
      : config.sourceKind === 'media'
        ? (media?.name ?? 'Media')
        : config.sourceKind === 'region'
          ? config.region
            ? `Screen Region (${config.region.width} × ${config.region.height})`
            : 'Screen Region'
          : (() => {
              const s = sources.find((x) => x.id === config.sourceId);
              if (!s) return 'No source selected';
              if (s.kind === 'window') return s.name;
              const screens = sources.filter((x) => x.kind === 'screen');
              const label = s.isVirtualDisplay ? 'Extend Desktop' : `Display ${screens.indexOf(s) + 1}`;
              return s.size ? `${label} (${s.size.width} × ${s.size.height})` : label;
            })();

  const subtitle = error
    ? error
    : live.length
      ? `${captureState.paused ? 'Paused' : 'Streaming'} to ${live.map((s) => s.device.name).join(', ')}`
      : stats?.viewers
        ? `${stats.viewers} browser viewer${stats.viewers === 1 ? '' : 's'} watching`
        : 'Select a destination to begin mirroring';

  return (
    <div className="app">
      <header className="titlebar">
        <span className="logo">✈</span>
        <span className="app-name">AirWing</span>
        <div className="window-controls">
          <button title="Minimise to tray" onClick={() => api.app.minimize()}>
            ─
          </button>
          <button title="Close (keeps streaming in the tray)" onClick={() => api.app.close()}>
            ✕
          </button>
        </div>
      </header>

      <div className="status">
        <div className="status-line">
          <span className="status-icon">{config.sourceKind === 'audio' ? '🔊' : '🖵'}</span>
          <span className="status-name">{sourceLabel}</span>
        </div>
        <div className={`status-sub ${error ? 'bad' : ''}`} onClick={() => error && setError(null)} title={error ? 'Dismiss' : undefined}>
          {subtitle}
        </div>
      </div>

      <div className="toolbar">
        <button className="tool" title={captureState.active ? 'Stop' : 'Not streaming'} disabled={!captureState.active && live.length === 0} onClick={stopAll}>
          ⏻
        </button>
        <button className="tool" title={captureState.paused ? 'Resume' : 'Pause'} disabled={!captureState.active} onClick={() => api.capture.pause(!captureState.paused)}>
          {captureState.paused ? '▶' : '⏸'}
        </button>
        <button className="tool" title="Mute receivers" disabled={!live.length} onClick={() => changeVolume(0)}>
          🔈
        </button>
        <input className="volume" type="range" min={0} max={1} step={0.05} value={volume} disabled={!live.length} onChange={(e) => changeVolume(Number(e.target.value))} />
        <span className="spacer" />
        {captureState.active && stats?.encoder && (
          <span className="rate" title="Encoder output">
            {stats.fps} fps · {(stats.kbps / 1000).toFixed(1)} Mbps
          </span>
        )}
      </div>

      <main className="body">
        {view === 'main' && (
          <>
            <FromList sources={sources} config={config} onChange={updateConfig} onPickMedia={pickMedia} onOpenExtend={() => setView('extend')} mediaName={media?.name} />
            <ToList
              devices={devices}
              sessions={sessions}
              settings={settings}
              busyDeviceId={busyDevice}
              onToggle={toggleDevice}
              onRescan={() => api.devices.rescan()}
              onAddManual={(input) => api.devices.addManual(input)}
              onForget={(d) => api.devices.forget(d.id)}
              onFavorite={(d) => {
                const fav = settings.favoriteDevices.includes(d.id) ? settings.favoriteDevices.filter((x) => x !== d.id) : [...settings.favoriteDevices, d.id];
                void api.settings.set({ favoriteDevices: fav });
              }}
            />
          </>
        )}
        {view !== 'main' && (
          <div className="subview">
            <button className="back" onClick={() => setView('main')}>
              ‹ Back
            </button>
            {view === 'settings' && <SettingsPanel settings={settings} onChange={(p) => api.settings.set(p)} />}
            {view === 'browser' && <ReceiverPanel info={receiver} settings={settings} onSettings={(p) => api.settings.set(p)} stats={stats} />}
            {view === 'logs' && <LogPanel logs={logs} />}
            {view === 'extend' && <ExtendPanel sources={sources} onMirrorDisplay={(displayId, sourceId) => updateConfig({ sourceKind: 'screen', sourceId, displayId })} />}
          </div>
        )}
      </main>

      <footer className="footer">
        <button className={view === 'browser' ? 'tool on' : 'tool'} title="Browser receiver &amp; phone remote" onClick={() => setView(view === 'browser' ? 'main' : 'browser')}>
          🌐
        </button>
        <button className={view === 'logs' ? 'tool on' : 'tool'} title="Diagnostics" onClick={() => setView(view === 'logs' ? 'main' : 'logs')}>
          ☰
        </button>
        <span className="spacer" />
        <span className={`dot ${captureState.active ? (captureState.paused ? 'pending' : 'on') : ''}`} />
        <button className={view === 'settings' ? 'tool on' : 'tool'} title="Settings" onClick={() => setView(view === 'settings' ? 'main' : 'settings')}>
          ⚙
        </button>
      </footer>

      {pairing && (
        <PairingDialog
          prompt={pairing}
          onStart={() => api.pairing.start(pairing.deviceId)}
          onFinish={(pin) => api.pairing.finish(pairing.deviceId, pin)}
          onCancel={() => {
            void api.pairing.cancel(pairing.deviceId);
            setPairing(null);
          }}
          onDone={() => setPairing(null)}
        />
      )}
    </div>
  );
}
