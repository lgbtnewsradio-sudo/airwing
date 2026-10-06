import { useEffect, useState } from 'react';
import type { AppSettings } from '@shared/types';

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

export function SettingsPanel({ settings, onChange }: Props) {
  const [hk, setHk] = useState(settings.hotkeys);
  const [port, setPort] = useState(String(settings.serverPort));
  const [name, setName] = useState(settings.deviceName);
  const [networkMessage, setNetworkMessage] = useState('');
  const [networkBusy, setNetworkBusy] = useState(false);
  const [store, setStore] = useState(false);
  useEffect(() => { let active = true; window.airwing.app.distribution().then((kind) => { if (active) setStore(kind === 'store'); }).catch(() => undefined); return () => { active = false; }; }, []);
  const changeNetwork = async (allowPublic: boolean) => {
    setNetworkBusy(true);
    try {
      await window.airwing.app.configureFirewall(allowPublic);
      setNetworkMessage(allowPublic ? 'AirWing firewall rule allows private and public networks.' : 'AirWing firewall rule allows private networks only.');
    } catch (err) { setNetworkMessage((err as Error).message); }
    finally { setNetworkBusy(false); }
  };
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Settings</h2>
      </div>
      <h3>General</h3>
      <div className="options">
        <label>
          Name shown to receivers
          <input value={name} placeholder="AirWing on this PC" onChange={(e) => setName(e.target.value)} onBlur={() => onChange({ deviceName: name })} />
        </label>
        <label className="check">
          <input type="checkbox" disabled={store} checked={!store && settings.launchAtLogin} onChange={(e) => onChange({ launchAtLogin: e.target.checked })} />
          Launch AirWing when I sign in
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.startMinimized} onChange={(e) => onChange({ startMinimized: e.target.checked })} />
          Start minimized to the tray
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.showNotifications} onChange={(e) => onChange({ showNotifications: e.target.checked })} />
          Show notifications
        </label>
      </div>
      <h3>Casting quality</h3>
      <div className="options">
        <label>Preset (applies next time you start)
          <select value={settings.stream.latency} onChange={(e) => {
            const latency = e.target.value as AppSettings['stream']['latency'];
            onChange({ stream: { ...settings.stream, latency, quality: latency === 'lowest' ? 'low' : latency === 'quality' ? 'high' : 'balanced' } });
          }}>
            <option value="lowest">Lowest delay</option><option value="balanced">Balanced</option><option value="quality">Best picture</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={settings.stream.adaptiveCast !== false} onChange={(e) => onChange({ stream: { ...settings.stream, adaptiveCast: e.target.checked } })} />Automatically adjust Cast bitrate to connection health</label>
        <label className="check"><input type="checkbox" checked={settings.stream.castAudio !== false} onChange={(e) => onChange({ stream: { ...settings.stream, castAudio: e.target.checked } })} />Include system audio in Cast mirroring</label>
        <p className="hint">Audio also requires “Include audio” for the selected source. Changes apply on the next capture.</p>
      </div>
      <h3>Keyboard shortcuts</h3>
      <div className="options">
        {(
          [
            ['toggleMirror', 'Start / stop mirroring'],
            ['togglePause', 'Pause / resume'],
            ['stopAll', 'Stop everything'],
          ] as [keyof AppSettings['hotkeys'], string][]
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input value={hk[key]} onChange={(e) => setHk({ ...hk, [key]: e.target.value })} onBlur={() => onChange({ hotkeys: hk })} />
          </label>
        ))}
        <p className="hint">Use Electron accelerator syntax, e.g. CommandOrControl+Shift+M.</p>
      </div>
      <h3>Network</h3>
      <div className="options">
        <label>
          Stream server port (restart required)
          <input value={port} onChange={(e) => setPort(e.target.value)} onBlur={() => onChange({ serverPort: parseInt(port, 10) || 47000 })} />
        </label>
        <label className="check"><input type="checkbox" checked={settings.receiverRequireCode} onChange={(e) => onChange({ receiverRequireCode: e.target.checked })} />Require a code for browser viewers</label>
        <p className="hint">New installs allow private networks only. Use public access only on a network you trust. Windows will ask for administrator approval.</p>
        <button disabled={store || networkBusy} onClick={() => changeNetwork(false)}>Use private networks only</button>
        <button disabled={store || networkBusy} onClick={() => changeNetwork(true)}>Allow public networks…</button>
        {store && <p className="hint">Store edition: manage network permissions in Windows Security. Login-at-startup registration is unavailable in this edition.</p>}
        {networkMessage && <p className="hint" role="status">{networkMessage}</p>}
      </div>
      <h3>Deployment</h3>
      <p className="hint">
        For managed rollouts install silently with <code>AirWing-Setup.exe /S</code>. Settings live in <code>%APPDATA%\AirWing\settings.json</code> and can be pre-seeded; pairing keys are
        encrypted for your Windows account in <code>credentials.json</code> next to it. Use “Forget pairing” on a receiver to remove its keys.
      </p>
    </div>
  );
}
