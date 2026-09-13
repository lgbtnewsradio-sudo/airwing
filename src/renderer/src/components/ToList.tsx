import { useState } from 'react';
import type { AppSettings, Device, DeviceKind, SessionInfo } from '@shared/types';
import { unsupportedLabel } from '@shared/support';

interface Props {
  devices: Device[];
  sessions: SessionInfo[];
  settings: AppSettings;
  onToggle: (d: Device) => void;
  onRescan: () => void;
  onAddManual: (input: { host: string; port?: number; kind: DeviceKind | 'auto'; name?: string }) => Promise<Device>;
  onForget: (d: Device) => void;
  onFavorite: (d: Device) => void;
  busyDeviceId?: string | null;
}

function icon(d: Device): string {
  if (d.kind === 'cast') return '📺';
  if (!d.caps.video) return '🔈';
  if (/AppleTV/i.test(d.model ?? '')) return '📺';
  return '📡';
}

function subtitle(d: Device): string {
  const proto = d.kind === 'cast' ? 'Google Cast' : d.caps.airplayVersion === 2 ? 'AirPlay 2' : 'AirPlay';
  const bits = [proto];
  if (!d.caps.video) bits.push('audio only');
  if (d.manual) bits.push('manual');
  return bits.join(' · ');
}

export function ToList({ devices, sessions, settings, onToggle, onRescan, onAddManual, onForget, onFavorite, busyDeviceId }: Props) {
  const [host, setHost] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const byId = new Map(sessions.map((s) => [s.device.id, s]));
  const visible = devices.filter((d) => d.kind !== 'raop' || !devices.some((o) => o.kind === 'airplay' && o.host === d.host));
  const sorted = [...visible].sort((a, b) => {
    const fa = settings.favoriteDevices.includes(a.id) ? 0 : 1;
    const fb = settings.favoriteDevices.includes(b.id) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a.name.localeCompare(b.name);
  });

  const quickConnect = async () => {
    const value = host.trim();
    if (!value) return;
    setAdding(true);
    setAddError('');
    try {
      // Accept "host", "host:port" and "[v6::addr]:port". A bare address is sent as
      // "auto" so the main process can ask the device which protocol it speaks rather
      // than guessing AirPlay and producing a receiver that can never connect.
      let hostPart = value;
      let port: number | undefined;
      const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(value);
      if (bracketed) {
        hostPart = bracketed[1];
        port = bracketed[2] ? parseInt(bracketed[2], 10) : undefined;
      } else if ((value.match(/:/g) ?? []).length === 1) {
        const [h, p] = value.split(':');
        if (/^\d+$/.test(p)) {
          hostPart = h;
          port = parseInt(p, 10);
        }
      }
      const kind: DeviceKind | 'auto' = port === undefined ? 'auto' : port === 8009 ? 'cast' : 'airplay';
      await onAddManual({ host: hostPart, port, kind });
      setHost('');
    } catch (err) {
      setAddError((err as Error).message || 'could not add that receiver');
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="list to-list">
      <div className="list-head">
        <span className="list-title">To</span>
        <button className="icon-btn" title="Scan again" onClick={onRescan}>
          ⟳
        </button>
      </div>

      <div className="quick-connect">
        <span className="row-icon">⌁</span>
        <input placeholder="IP address or hostname" value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && quickConnect()} />
        <button className="icon-btn" disabled={adding || !host.trim()} onClick={quickConnect} title="Add receiver">
          {adding ? '…' : '→'}
        </button>
      </div>
      {addError && <p className="empty-line error-line">{addError}</p>}

      {sorted.length === 0 && <p className="empty-line">Looking for receivers on your network…</p>}

      {sorted.map((d) => {
        const s = byId.get(d.id);
        const state = s?.state;
        const live = state === 'streaming' || state === 'paused';
        const fav = settings.favoriteDevices.includes(d.id);
        return (
          <div key={d.id} className={`row receiver ${live ? 'live' : ''} ${state === 'error' ? 'failed' : ''}`}>
            <button className="row-main" onClick={() => onToggle(d)} disabled={busyDeviceId === d.id}>
              <span className="row-icon">{icon(d)}</span>
              <span className="row-text">
                <span className="row-label">
                  {d.name}
                  {fav && <span className="star">★</span>}
                </span>
                <span className="row-sub">
                  {state === 'connecting' && 'Connecting…'}
                  {state === 'pairing' && 'Waiting for the code on screen'}
                  {live && (state === 'paused' ? 'Paused' : d.kind === 'web' ? 'Streaming' : 'Streaming · a few seconds behind')}
                  {state === 'error' && (s?.error ?? 'Failed')}
                  {!state && (unsupportedLabel(d) ?? subtitle(d))}
                </span>
              </span>
              <span className={`dot ${live ? 'on' : state === 'connecting' || state === 'pairing' ? 'pending' : state === 'error' ? 'bad' : ''}`} />
            </button>
            <div className="row-menu">
              <button className="icon-btn" title="More">
                ⋯
              </button>
              <div className="row-menu-items">
                <button onClick={() => onFavorite(d)}>{fav ? 'Remove favourite' : 'Add favourite'}</button>
                {d.caps.paired && <button onClick={() => onForget(d)}>Forget pairing</button>}
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}
