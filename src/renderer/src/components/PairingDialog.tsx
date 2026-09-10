import { useEffect, useState } from 'react';
import type { PairingPrompt } from '@shared/types';

interface Props {
  prompt: PairingPrompt;
  onStart: () => Promise<void>;
  onFinish: (pin: string) => Promise<void>;
  onCancel: () => void;
  onDone: () => void;
}

export function PairingDialog({ prompt, onStart, onFinish, onCancel, onDone }: Props) {
  const [pin, setPin] = useState('');
  const [phase, setPhase] = useState<'starting' | 'enter' | 'verifying' | 'error'>('starting');
  const [error, setError] = useState('');

  useEffect(() => {
    onStart()
      .then(() => setPhase('enter'))
      .catch((err) => {
        setError((err as Error).message);
        setPhase('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt.deviceId]);

  const submit = async () => {
    setPhase('verifying');
    try {
      await onFinish(pin);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Pair with {prompt.deviceName}</h2>
        {phase === 'starting' && <p>Asking {prompt.deviceName} to show a pairing code…</p>}
        {(phase === 'enter' || phase === 'verifying' || phase === 'error') && (
          <>
            <p>Enter the 4-digit code shown on {prompt.deviceName}. You only need to do this once per receiver.</p>
            <input className="pin" autoFocus inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))} onKeyDown={(e) => e.key === 'Enter' && pin.length >= 4 && submit()} />
            {error && <p className="error">{error}</p>}
          </>
        )}
        <div className="actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={phase === 'starting' || phase === 'verifying' || pin.length < 4}>
            {phase === 'verifying' ? 'Pairing…' : 'Pair'}
          </button>
        </div>
      </div>
    </div>
  );
}
