import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, CaptureSource, Device, LogEvent, PairingPrompt, ReceiverInfo, SessionInfo, StreamConfig, StreamStats } from '@shared/types';
import { DEFAULT_STREAM_CONFIG } from '@shared/types';
import { CapturePipeline } from './capture/pipeline';
import { DevicePanel } from './components/DevicePanel';
import { SourcePanel } from './components/SourcePanel';
import { MediaPanel } from './components/MediaPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ReceiverPanel } from './components/ReceiverPanel';
import { ExtendPanel } from './components/ExtendPanel';
import { LogPanel } from './components/LogPanel';
import { PairingDialog } from './components/PairingDialog';
import { StatusBar } from './components/StatusBar';

export type Tab = 'mirror' | 'media' | 'extend' | 'receiver' | 'settings' | 'logs';

export interface MediaFile {
  path: string;
  name: string;
  mime: string;
  size: number;
}

export function App() {
  const api = window.airwing;
  const [tab, setTab] = useState<Tab>('mirror');
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
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [captureState, setCaptureState] = useState<{ active: boolean; paused: boolean }>({ active: false, paused: false });
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
      const [d, s, sess, st, r, l, v] = await Promise.all([
        api.devices.list(),
        api.settings.get(),
        api.sessions.list(),
        api.capture.stats(),
        api.receiver.info(),
        api.app.logs(),
        api.app.version(),
      ]);
      if (!alive) return;
      setDevices(d);
      setSettings(s);
      setConfig({ ...DEFAULT_STREAM_CONFIG, ...s.stream });
      setSessions(sess);
      setStats(st);
      setReceiver(r);
      setLogs(l);
      setVersion(v);
      await refreshSources();
    })().catch((err) => setError((err as Error).message));
    const offs = [
      api.devices.onChange(setDevices),
      api.sessions.onChange(setSessions),
      api.capture.onStats(setStats),
      api.settings.onChange((s) => setSettings(s)),
      api.pairing.onPrompt((p) => setPairing(p)),
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
    const sourceTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !pipeline.active) void refreshSources();
    }, 8000);
    return () => {
      alive = false;
      offs.forEach((off) => off());
      clearInterval(sourceTimer);
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

  const startMirroring = useCallback(
    async (override?: Partial<StreamConfig>) => {
      const cfg = { ...configRef.current, ...override };
      setError(null);
      setBusy('Starting capture…');
      try {
        await api.capture.start(cfg);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [api],
  );

  const stopAll = useCallback(async () => {
    setBusy('Stopping…');
    try {
      await api.capture.stop();
    } finally {
      setBusy(null);
    }
  }, [api]);

  const connectDevice = useCallback(
    async (device: Device) => {
      setError(null);
      setBusy(`Connecting to ${device.name}…`);
      try {
        const isMediaDirect = tab === 'media' && media && (config.mediaMode === 'direct' || (config.mediaMode !== 'transcode' && isDirectPlayable(media)));
        if (isMediaDirect) {
          await api.sessions.connect(device.id, { type: 'file', path: media.path });
        } else {
          if (!captureState.active) {
            await api.capture.start(tab === 'media' && media ? { ...config, sourceKind: 'media', mediaPath: media.path } : config);
          }
          const info = await api.sessions.connect(device.id, { type: 'live' });
          if (info.state === 'error' && info.error) setError(`${device.name}: ${info.error}`);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [api, tab, media, config, captureState.active],
  );

  const disconnectDevice = useCallback(
    async (device: Device) => {
      await api.sessions.disconnect(device.id);
    },
    [api],
  );

  const togglePause = useCallback(async () => {
    await api.capture.pause(!captureState.paused);
  }, [api, captureState.paused]);

  useEffect(() => {
    if (!captureState.active) return;
    if (sessions.length === 0 && !stats?.viewers && !pipeline.active) return;
  }, [captureState.active, sessions.length, stats?.viewers, pipeline.active]);

  if (!settings) {
    return <div className="loading">Loading AirWing…</div>;
  }

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="logo">✈</span>
          <span className="name">AirWing</span>
          <span className="version">v{version}</span>
        </div>
        <nav className="tabs">
          {(
            [
              ['mirror', 'Mirror'],
              ['media', 'Media'],
              ['extend', 'Extend Desktop'],
              ['receiver', 'Browser Receiver'],
              ['settings', 'Settings'],
              ['logs', 'Logs'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="window-controls">
          <button title="Minimize to tray" onClick={() => api.app.minimize()}>
            –
          </button>
          <button title="Close (keeps streaming in tray)" onClick={() => api.app.close()}>
            ×
          </button>
        </div>
      </header>

      <main className="content">
        <section className="left">
          {tab === 'mirror' && (
            <SourcePanel
              sources={sources}
              config={config}
              onChange={updateConfig}
              onRefresh={refreshSources}
              active={captureState.active}
              paused={captureState.paused}
              onStart={() => startMirroring()}
              onStop={stopAll}
              onPause={togglePause}
              stats={stats}
            />
          )}
          {tab === 'media' && <MediaPanel media={media} setMedia={setMedia} config={config} onChange={updateConfig} sessions={sessions} pipeline={pipeline} active={captureState.active} onStop={stopAll} />}
          {tab === 'extend' && <ExtendPanel onMirrorDisplay={(displayId, sourceId) => startMirroring({ sourceKind: 'screen', sourceId, displayId })} sources={sources} />}
          {tab === 'receiver' && <ReceiverPanel info={receiver} settings={settings} onSettings={(p) => api.settings.set(p)} stats={stats} />}
          {tab === 'settings' && <SettingsPanel settings={settings} onChange={(p) => api.settings.set(p)} />}
          {tab === 'logs' && <LogPanel logs={logs} />}
        </section>
        <aside className="right">
          <DevicePanel
            devices={devices}
            sessions={sessions}
            settings={settings}
            onConnect={connectDevice}
            onDisconnect={disconnectDevice}
            onPair={(d) => setPairing({ deviceId: d.id, deviceName: d.name, message: 'Enter the code shown on the receiver.' })}
            onForget={(d) => api.devices.forget(d.id)}
            onAddManual={(input) => api.devices.addManual(input)}
            onRemoveManual={(d) => api.devices.removeManual(d.id)}
            onRescan={() => api.devices.rescan()}
            onFavorite={(d) => {
              const fav = settings.favoriteDevices.includes(d.id) ? settings.favoriteDevices.filter((x) => x !== d.id) : [...settings.favoriteDevices, d.id];
              void api.settings.set({ favoriteDevices: fav });
            }}
            onMediaControl={(d, action) => api.sessions.mediaControl(d.id, action)}
            connectLabel={tab === 'media' ? 'Play here' : 'Mirror here'}
          />
        </aside>
      </main>

      <StatusBar stats={stats} sessions={sessions} active={captureState.active} paused={captureState.paused} busy={busy} error={error} onDismissError={() => setError(null)} onStop={stopAll} onPause={togglePause} />

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

const DIRECT_PLAYABLE = /\.(mp4|m4v|mov|mp3|m4a|aac|wav)$/i;

export function isDirectPlayable(media: MediaFile): boolean {
  return DIRECT_PLAYABLE.test(media.name);
}
