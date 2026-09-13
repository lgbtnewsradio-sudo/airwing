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

  const [attempt, setAttempt] = useState(0);

  // Every attempt asks the receiver for a fresh code: a rejected code invalidates the
  // receiver's pairing session, so the previous one can never be retried.
  useEffect(() => {
    let cancelled = false;
    setPhase('starting');
    setPin('');
    // Deliberately not clearing `error` here: a rejected code bumps `attempt` to fetch a
    // fresh code, and wiping the message at that point removed the very explanation the
    // user needs ("that code was not accepted"). The Try again button clears it instead.
    onStart()
      .then(() => {
        if (!cancelled) setPhase('enter');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(`Could not start pairing: ${(err as Error).message}`);
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt.deviceId, attempt]);

  const submit = async () => {
    if (phase !== 'enter') return;
    setPhase('verifying');
    try {
      await onFinish(pin);
      onDone();
    } catch (err) {
      const msg = (err as Error).message;
      setError(/wrong PIN|authentication/i.test(msg) ? 'That code was not accepted. A new code is now shown on the receiver — enter it below.' : `${msg}. A new code has been requested — enter it below.`);
      setAttempt((a) => a + 1);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Pair with {prompt.deviceName}</h2>
        {phase === 'starting' && <p>Asking {prompt.deviceName} to show a pairing code…</p>}
        {(phase === 'enter' || phase === 'verifying') && (
          <>
            <p>Enter the 4-digit code shown on {prompt.deviceName}. You only need to do this once per receiver.</p>
            <input className="pin" autoFocus inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))} onKeyDown={(e) => e.key === 'Enter' && pin.length >= 4 && submit()} />
          </>
        )}
        {error && <p className="error">{error}</p>}
        {phase === 'error' && (
          <p className="hint">Make sure {prompt.deviceName} is awake and on the same network, then try again.</p>
        )}
        <div className="actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          {phase === 'error' ? (
            <button
              className="primary"
              onClick={() => {
                setError('');
                setAttempt((a) => a + 1);
              }}
            >
              Try again
            </button>
          ) : (
            <button className="primary" onClick={submit} disabled={phase !== 'enter' || pin.length < 4}>
              {phase === 'verifying' ? 'Pairing…' : 'Pair'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
