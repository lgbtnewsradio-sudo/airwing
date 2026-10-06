import { useEffect, useRef, useState } from 'react';
import type { LogEvent } from '@shared/types';

export function LogPanel({ logs }: { logs: LogEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const exportBundle = async () => {
    setSaving(true);
    try { setMessage(await window.airwing.app.exportDiagnostics() ? 'Support bundle saved. Review it before sharing; it includes local network addresses and device names.' : ''); }
    catch (err) { setMessage((err as Error).message); }
    finally { setSaving(false); }
  };
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [logs.length]);
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Diagnostics</h2>
        <button disabled={saving} onClick={exportBundle}>{saving ? 'Saving…' : 'Export support bundle'}</button>
        <button className="ghost" onClick={() => navigator.clipboard.writeText(logs.map((l) => `${new Date(l.ts).toISOString()} ${l.level} ${l.scope}: ${l.message}`).join('\n'))}>
          Copy
        </button>
      </div>
      <p className="hint">
        Export a support bundle when reporting a problem. Tokens, pairing secrets, media paths and Windows usernames are removed. Nothing is uploaded automatically.
      </p>
      {message && <p className="hint" role="status">{message}</p>}
      <div className="log" ref={ref}>
        {logs.map((l, i) => (
          <div key={i} className={`log-line ${l.level}`}>
            <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>
            <span className="scope">{l.scope}</span>
            <span className="msg">{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
