import { useEffect, useState } from 'react';
import type { CaptureSource, ExtendDesktopInfo } from '@shared/types';

interface Props {
  sources: CaptureSource[];
  onMirrorDisplay: (displayId: string, sourceId: string) => void;
}

export function ExtendPanel({ sources, onMirrorDisplay }: Props) {
  const [info, setInfo] = useState<ExtendDesktopInfo | null>(null);
  useEffect(() => {
    // Each refresh spawns powershell.exe to look for a virtual display driver, so poll
    // slowly, never overlap two probes, and stop touching state once unmounted.
    let alive = true;
    let inFlight = false;
    const refresh = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      try {
        const next = await window.airwing.sources.extendInfo();
        if (alive) setInfo(next);
      } catch {
        /* the probe is best-effort; keep the last known state */
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const t = setInterval(() => void refresh(), 20000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const virtualScreens = sources.filter((s) => s.kind === 'screen' && s.isVirtualDisplay);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Extend your desktop</h2>
      </div>
      <p className="hint">
        Turn a TV into an extra monitor. Windows only lets an app add a display through a signed display driver, so AirWing pairs with the open-source
        <strong> Virtual Display Driver</strong>: install it once, and every virtual display it creates shows up here ready to be streamed to any receiver.
      </p>
      <div className="steps">
        <div className={`step ${info?.driverInstalled ? 'done' : ''}`}>
          <span className="step-num">1</span>
          <div>
            <strong>Install the Virtual Display Driver</strong>
            <p className="hint">{info?.driverInstalled ? 'Detected — the driver is installed.' : 'Free, MIT-licensed, works on Windows 10/11 (x64 and ARM64).'}</p>
            {!info?.driverInstalled && (
              <button className="secondary" onClick={() => window.airwing.sources.extendInstall()}>
                Download driver…
              </button>
            )}
          </div>
        </div>
        <div className={`step ${virtualScreens.length ? 'done' : ''}`}>
          <span className="step-num">2</span>
          <div>
            <strong>Add a virtual display</strong>
            <p className="hint">Use the driver’s tray app (or Windows Settings → Display) to enable a virtual monitor and arrange it next to your real one.</p>
          </div>
        </div>
        <div className="step">
          <span className="step-num">3</span>
          <div>
            <strong>Stream the virtual display</strong>
            {virtualScreens.length ? (
              <div className="source-grid">
                {virtualScreens.map((s) => (
                  <button key={s.id} className="source" onClick={() => onMirrorDisplay(s.displayId ?? '', s.id)}>
                    <div className="thumb">{s.thumbnail && <img src={s.thumbnail} alt="" />}</div>
                    <div className="source-name">{s.name}</div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="hint">No virtual display detected yet. Once one exists it appears here, and you can also pick it from the Mirror tab as “Entire display”.</p>
            )}
          </div>
        </div>
      </div>
      <p className="hint">
        Tip: any display — real or virtual — can be sent to several receivers at once. Drag windows onto the virtual display to show them only on the TV.
      </p>
    </div>
  );
}
