import { useCallback, useEffect, useRef, useState } from 'react';
import { sendManual } from '../windows/useEngine.ts';
import type { ManualAction, Outcome } from '../windows/manual.ts';

/** How long the answer to a send stays next to the control before it clears itself. */
const OUTCOME_MS = 20_000;

export interface ManualSend {
  /** The confirm question is showing. */
  asking: boolean;
  /** The request is out and the engine has not answered. */
  sending: boolean;
  /** What the engine answered (or that it did not); cleared after a while and when the question is asked again. */
  outcome: Outcome | null;
  ask(): void;
  cancel(): void;
  confirm(): void;
}

/**
 * Ask, confirm, send, and keep the answer for the control that sent it: `POST /rotate` and `POST /close` through
 * `sendManual`, which never throws. One instance per control, so a Desk Close and a list row's Rotate do not share a state.
 * `onOutcome` hears every answer once, as it comes (the owner entry starts waiting for its Journal line on a 200).
 */
export function useManualSend(action: ManualAction | null, onOutcome?: (outcome: Outcome) => void): ManualSend {
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const heard = useRef(onOutcome);
  heard.current = onOutcome;

  useEffect(() => {
    if (outcome === null) return;
    const timer = setTimeout(() => setOutcome(null), OUTCOME_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  const ask = useCallback(() => {
    setOutcome(null);
    setAsking(true);
  }, []);
  const cancel = useCallback(() => setAsking(false), []);
  const confirm = useCallback(() => {
    setAsking(false);
    if (action === null || sending) return;
    setSending(true);
    void sendManual(action).then((result) => {
      setSending(false);
      setOutcome(result);
      heard.current?.(result);
    });
  }, [action, sending]);

  return { asking, sending, outcome, ask, cancel, confirm };
}
