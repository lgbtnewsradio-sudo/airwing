import type { AppSettings, ReceiverInfo, StreamStats } from '@shared/types';

interface Props {
  info: ReceiverInfo | null;
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
  stats: StreamStats | null;
}

export function ReceiverPanel({ info, settings, onSettings, stats }: Props) {
  if (!info) return <div className="panel">Loading…</div>;
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Browser receiver &amp; phone remote</h2>
      </div>
      <p className="hint">
        Any device with a modern browser — a smart TV, another PC, a tablet, a conference room display — can receive your screen with about one frame of latency. No app install
        required.
      </p>
      <div className="url-box">
        <label>Open this on the receiving device</label>
        <div className="url-row">
          <code>{info.url}</code>
          <button className="secondary small" onClick={() => navigator.clipboard.writeText(info.url)}>
            Copy
          </button>
          <button className="secondary small" onClick={() => window.airwing.app.openExternal(info.url)}>
            Open
          </button>
        </div>
        {settings.receiverRequireCode && (
          <p className="hint">
            Viewers must enter code <strong className="code">{info.code}</strong>
          </p>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={settings.receiverRequireCode} onChange={(e) => onSettings({ receiverRequireCode: e.target.checked })} />
        Require a 6-digit code to watch
      </label>
      <p className="hint">Connected browser viewers: {stats?.viewers ?? 0}</p>

      <h3>Remote control</h3>
      <p className="hint">Open this on your phone to pause, resume, stop, switch receivers and control media playback from the couch.</p>
      <div className="url-box">
        <div className="url-row">
          <code>{info.remoteUrl}</code>
          <button className="secondary small" onClick={() => navigator.clipboard.writeText(info.remoteUrl)}>
            Copy
          </button>
        </div>
      </div>
      <p className="hint">Server port {info.port}. Addresses on this PC: {info.addresses.join(', ')}. If a device cannot reach the URL, allow AirWing through Windows Firewall (private networks).</p>
    </div>
  );
}
