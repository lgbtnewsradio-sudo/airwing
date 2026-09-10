import { useEffect, useRef } from 'react';
import type { LogEvent } from '@shared/types';

export function LogPanel({ logs }: { logs: LogEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [logs.length]);
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Diagnostics</h2>
        <button className="ghost" onClick={() => navigator.clipboard.writeText(logs.map((l) => `${new Date(l.ts).toISOString()} ${l.level} ${l.scope}: ${l.message}`).join('\n'))}>
          Copy
        </button>
      </div>
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
