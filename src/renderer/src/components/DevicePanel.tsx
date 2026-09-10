import { useState } from 'react';
import type { AppSettings, Device, DeviceKind, MediaControlAction, SessionInfo } from '@shared/types';

interface Props {
  devices: Device[];
  sessions: SessionInfo[];
  settings: AppSettings;
  onConnect: (d: Device) => void;
  onDisconnect: (d: Device) => void;
  onPair: (d: Device) => void;
  onForget: (d: Device) => void;
  onAddManual: (input: { host: string; port?: number; kind: DeviceKind; name?: string }) => Promise<Device>;
  onRemoveManual: (d: Device) => void;
  onRescan: () => void;
  onFavorite: (d: Device) => void;
  onMediaControl: (d: Device, action: MediaControlAction) => Promise<void>;
  connectLabel: string;
}

function kindLabel(d: Device): string {
  if (d.kind === 'cast') return 'Google Cast';
  if (d.kind === 'airplay' || d.kind === 'raop') return d.caps.airplayVersion === 2 ? 'AirPlay 2' : 'AirPlay';
  return 'AirWing';
}

function kindIcon(d: Device): string {
  if (d.kind === 'cast') return '📺';
  if (!d.caps.video) return '🔊';
  if (/AppleTV/i.test(d.model ?? '')) return '🍎';
  return '📡';
}

function fmtTime(s?: number): string {
  if (s === undefined || !Number.isFinite(s)) return '–:––';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function DevicePanel(props: Props) {
  const { devices, sessions, settings } = props;
  const [showAdd, setShowAdd] = useState(false);
  const [host, setHost] = useState('');
  const [kind, setKind] = useState<DeviceKind>('airplay');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const sessionsById = new Map(sessions.map((s) => [s.device.id, s]));
  const visible = devices.filter((d) => d.kind !== 'raop' || !devices.some((o) => o.kind === 'airplay' && o.host === d.host));
  const sorted = [...visible].sort((a, b) => {
    const fa = settings.favoriteDevices.includes(a.id) ? 0 : 1;
    const fb = settings.favoriteDevices.includes(b.id) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const ra = settings.recentDevices.indexOf(a.id);
    const rb = settings.recentDevices.indexOf(b.id);
    if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
    return a.name.localeCompare(b.name);
  });

  const add = async () => {
    if (!host.trim()) return;
    setAdding(true);
    try {
      await props.onAddManual({ host: host.trim(), kind, name: name.trim() || undefined });
      setHost('');
      setName('');
      setShowAdd(false);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="panel devices">
      <div className="panel-header">
        <h2>Receivers</h2>
        <div>
          <button className="ghost" onClick={() => setShowAdd((v) => !v)} title="Connect by IP address">
            ＋
          </button>
          <button className="ghost" onClick={props.onRescan} title="Scan again">
            ⟳
          </button>
        </div>
      </div>
      {showAdd && (
        <div className="add-manual">
          <input placeholder="IP address or hostname" value={host} onChange={(e) => setHost(e.target.value)} />
          <select value={kind} onChange={(e) => setKind(e.target.value as DeviceKind)}>
            <option value="airplay">AirPlay</option>
            <option value="cast">Google Cast</option>
          </select>
          <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" onClick={add} disabled={adding || !host.trim()}>
            Add
          </button>
        </div>
      )}
      {!sorted.length && (
        <div className="empty">
          <p>Searching for Apple TV, HomePod, Chromecast, Roku, Fire TV, Reflector and other AirPlay / Google Cast receivers on your network…</p>
          <p className="hint">Not showing up? Make sure the receiver is on the same Wi-Fi, or add it by IP address with ＋.</p>
        </div>
      )}
      <ul className="device-list">
        {sorted.map((d) => {
          const s = sessionsById.get(d.id);
          const fav = settings.favoriteDevices.includes(d.id);
          const streaming = s && (s.state === 'streaming' || s.state === 'paused');
          return (
            <li key={d.id} className={`device ${s ? `state-${s.state}` : ''}`}>
              <div className="device-main">
                <span className="device-icon">{kindIcon(d)}</span>
                <div className="device-text">
                  <div className="device-name">
                    {d.name}
                    {fav && <span className="star">★</span>}
                  </div>
                  <div className="device-meta">
                    {kindLabel(d)}
                    {d.model ? ` · ${d.model}` : ''}
                    {!d.caps.video ? ' · audio' : ''}
                    {d.manual ? ' · manual' : ''}
                    {d.caps.paired ? ' · paired' : d.caps.pairingRequired && !d.caps.transientPairing ? ' · code required' : ''}
                  </div>
                  {s && (
                    <div className={`device-state ${s.state}`}>
                      {s.state === 'connecting' && 'Connecting…'}
                      {s.state === 'pairing' && 'Waiting for pairing code'}
                      {s.state === 'streaming' && `Streaming (${s.transport})`}
                      {s.state === 'paused' && 'Paused'}
                      {s.state === 'error' && `Error: ${s.error}`}
                    </div>
                  )}
                </div>
                <div className="device-actions">
                  {s && s.state !== 'error' ? (
                    <button className="danger small" onClick={() => props.onDisconnect(d)}>
                      Stop
                    </button>
                  ) : (
                    <button className="primary small" onClick={() => props.onConnect(d)} disabled={s?.state === 'connecting'}>
                      {props.connectLabel}
                    </button>
                  )}
                  <div className="menu">
                    <button className="ghost small">⋯</button>
                    <div className="menu-items">
                      <button onClick={() => props.onFavorite(d)}>{fav ? 'Remove favorite' : 'Add to favorites'}</button>
                      {(d.kind === 'airplay' || d.kind === 'raop') && <button onClick={() => props.onPair(d)}>Pair with code…</button>}
                      {d.caps.paired && d.kind !== 'cast' && <button onClick={() => props.onForget(d)}>Forget pairing</button>}
                      {d.manual && <button onClick={() => props.onRemoveManual(d)}>Remove</button>}
                    </div>
                  </div>
                </div>
              </div>
              {streaming && s.duration !== undefined && s.duration > 0 && (
                <div className="transport">
                  <button className="ghost small" onClick={() => props.onMediaControl(d, { type: s.playing ? 'pause' : 'play' })}>
                    {s.playing ? '⏸' : '▶'}
                  </button>
                  <input type="range" min={0} max={s.duration} step={0.5} value={s.position ?? 0} onChange={(e) => props.onMediaControl(d, { type: 'seek', position: Number(e.target.value) })} />
                  <span className="time">
                    {fmtTime(s.position)} / {fmtTime(s.duration)}
                  </span>
                </div>
              )}
              {streaming && (
                <div className="transport">
                  <span className="hint">Volume</span>
                  <input type="range" min={0} max={1} step={0.05} defaultValue={s.volume ?? 1} onChange={(e) => props.onMediaControl(d, { type: 'volume', volume: Number(e.target.value) })} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
