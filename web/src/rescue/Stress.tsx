import { useState } from 'react';
import type { Mode } from '@gimbal/shared';
import { notify } from '../ui/notice.ts';
import { stressView } from './model.ts';
import { sendStress } from './useRescue.ts';

/** The Run a stress test button, or nothing: on mainnet and before the network is known there is no button at all. */
export function StressButton({ mode, running }: { mode: Mode | null; running: boolean }) {
  const [sending, setSending] = useState(false);
  const button = stressView(mode, running, sending).button;
  if (!button) return null;
  const onClick = () => {
    setSending(true);
    void sendStress()
      .then((o) => notify(o.text, o.title, o.tone === 'sent' ? 'ok' : 'warn'))
      .finally(() => setSending(false));
  };
  return (
    <button type="button" className="btn" disabled={button.disabled} onClick={onClick}>
      {button.label}
    </button>
  );
}

/** The stress test block under the steps: what it does, the button where one may exist, and why not where it may not. */
export function Stress({ mode, running }: { mode: Mode | null; running: boolean }) {
  const { note } = stressView(mode, running, false);
  return (
    <section className="r-stress" aria-label="Stress test">
      <h3>
        <span>Stress test</span>
        <span>testnet and replay only</span>
      </h3>
      <p>
        Pushes one leg past the rescue line so you can watch every step run. NEAR Intents has no testnet, so the transfer steps play
        back a recorded mainnet run, marked as replay.
      </p>
      <StressButton mode={mode} running={running} />
      {note ? <p className="note">{note}</p> : null}
    </section>
  );
}
