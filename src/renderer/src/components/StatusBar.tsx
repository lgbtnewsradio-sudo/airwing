import type { SessionInfo, StreamStats } from '@shared/types';

interface Props {
  stats: StreamStats | null;
  sessions: SessionInfo[];
  active: boolean;
  paused: boolean;
  busy: string | null;
  error: string | null;
  onDismissError: () => void;
  onStop: () => void;
  onPause: () => void;
}

export function StatusBar({ stats, sessions, active, paused, busy, error, onDismissError, onStop, onPause }: Props) {
  const streaming = sessions.filter((s) => s.state === 'streaming');
  return (
    <footer className="statusbar">
      <div className={`dot ${active ? (paused ? 'paused' : 'live') : ''}`} />
      <span className="status-text">
        {busy ??
          (active
            ? `${paused ? 'Paused' : 'Live'} · ${streaming.length} receiver${streaming.length === 1 ? '' : 's'}${stats?.viewers ? ` · ${stats.viewers} browser viewer${stats.viewers === 1 ? '' : 's'}` : ''}${
                stats?.encoder ? ` · ${stats.fps} fps · ${(stats.kbps / 1000).toFixed(1)} Mbps` : ''
              }`
            : 'Idle')}
      </span>
      {error && (
        <span className="status-error" onClick={onDismissError} title="Dismiss">
          ⚠ {error}
        </span>
      )}
      <span className="spacer" />
      {active && (
        <>
          <button className="ghost small" onClick={onPause}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="danger small" onClick={onStop}>
            Stop all
          </button>
        </>
      )}
    </footer>
  );
}
