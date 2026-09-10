import { useState } from 'react';
import type { AppSettings } from '@shared/types';

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

export function SettingsPanel({ settings, onChange }: Props) {
  const [hk, setHk] = useState(settings.hotkeys);
  const [port, setPort] = useState(String(settings.serverPort));
  const [name, setName] = useState(settings.deviceName);
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
          <input type="checkbox" checked={settings.launchAtLogin} onChange={(e) => onChange({ launchAtLogin: e.target.checked })} />
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
      </div>
      <h3>Deployment</h3>
      <p className="hint">
        For managed rollouts install silently with <code>AirWing-Setup.exe /S</code>. Settings live in <code>%APPDATA%\AirWing\settings.json</code> and can be pre-seeded; pairing keys are
        in <code>credentials.json</code> next to it.
      </p>
    </div>
  );
}
