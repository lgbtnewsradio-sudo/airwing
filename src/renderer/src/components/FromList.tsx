import { useState } from 'react';
import type { CaptureSource, StreamConfig } from '@shared/types';

interface Props {
  sources: CaptureSource[];
  config: StreamConfig;
  onChange: (patch: Partial<StreamConfig>) => void;
  onPickMedia: () => void;
  onOpenExtend: () => void;
  mediaName?: string;
}

function Row({
  icon,
  label,
  detail,
  selected,
  chevron,
  onClick,
}: {
  icon: string;
  label: string;
  detail?: string;
  selected?: boolean;
  chevron?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`row ${selected ? 'selected' : ''}`} onClick={onClick}>
      <span className="row-icon">{icon}</span>
      <span className="row-label">{label}</span>
      {detail && <span className="row-detail">{detail}</span>}
      {chevron && <span className="row-chevron">›</span>}
    </button>
  );
}

export function FromList({ sources, config, onChange, onPickMedia, onOpenExtend, mediaName }: Props) {
  const [showApps, setShowApps] = useState(false);
  const screens = sources.filter((s) => s.kind === 'screen');
  const windows = sources.filter((s) => s.kind === 'window');

  if (showApps) {
    return (
      <section className="list from-list">
        <div className="list-head">
          <button className="back" onClick={() => setShowApps(false)}>
            ‹ From
          </button>
          <span className="list-title">Application</span>
        </div>
        {windows.length === 0 && <p className="empty-line">No open windows found.</p>}
        {windows.map((w) => (
          <button
            key={w.id}
            className={`row ${config.sourceKind === 'window' && config.sourceId === w.id ? 'selected' : ''}`}
            onClick={() => {
              onChange({ sourceKind: 'window', sourceId: w.id, region: undefined });
              setShowApps(false);
            }}
          >
            <span className="row-icon">{w.appIcon ? <img className="app-icon" src={w.appIcon} alt="" /> : '🗔'}</span>
            <span className="row-label">{w.name}</span>
          </button>
        ))}
      </section>
    );
  }

  const selectedWindow = config.sourceKind === 'window' ? windows.find((w) => w.id === config.sourceId) : undefined;

  return (
    <section className="list from-list">
      <div className="list-head">
        <span className="list-title">From</span>
      </div>
      {screens.map((s, i) => (
        <Row
          key={s.id}
          icon="🖵"
          label={s.isVirtualDisplay ? 'Extend Desktop' : `Display ${i + 1}`}
          detail={s.size ? `${s.size.width} × ${s.size.height}` : undefined}
          selected={config.sourceKind === 'screen' && config.sourceId === s.id}
          onClick={() => onChange({ sourceKind: 'screen', sourceId: s.id, displayId: s.displayId, region: undefined })}
        />
      ))}
      {!screens.some((s) => s.isVirtualDisplay) && <Row icon="🖵" label="Extend Desktop" detail="set up" chevron onClick={onOpenExtend} />}
      <Row icon="🗔" label={selectedWindow ? selectedWindow.name : 'Application'} selected={config.sourceKind === 'window'} chevron onClick={() => setShowApps(true)} />
      <Row
        icon="◫"
        label="Screen Region"
        detail={config.region ? `${config.region.width} × ${config.region.height}` : undefined}
        selected={config.sourceKind === 'region'}
        onClick={async () => {
          const screen = screens.find((s) => s.id === config.sourceId) ?? screens[0];
          const rect = await window.airwing.sources.selectRegion(screen?.displayId);
          if (rect) onChange({ sourceKind: 'region', sourceId: screen?.id, displayId: screen?.displayId, region: rect });
        }}
      />
      <Row icon="🔊" label="Audio Only" selected={config.sourceKind === 'audio'} onClick={() => onChange({ sourceKind: 'audio', audio: true, region: undefined })} />
      <Row icon="▶" label={mediaName ?? 'Media…'} selected={config.sourceKind === 'media'} chevron onClick={onPickMedia} />
    </section>
  );
}
