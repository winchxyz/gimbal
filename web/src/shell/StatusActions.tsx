import { useState } from 'react';
import { cx } from '../ui/cx.ts';
import { notify } from '../ui/notice.ts';
import type { ActionId, StatusActionsView } from './status.ts';

// None of these is connected yet: pausing and resuming are the owner's wallet signing `set_paused`, closing is
// `POST /close`, and adding margin is a transfer the owner signs. Each says so and changes nothing.
const NOT_SENT: Record<ActionId, string> = {
  auto: 'Changing Auto is not connected to the engine yet. Nothing changed.',
  pause: 'Pausing is signed in your wallet, and wallet signing is not connected yet. Nothing changed.',
  resume: 'Resuming is signed in your wallet, and wallet signing is not connected yet. Nothing changed.',
  close: 'Closing is not connected to the engine yet. Both legs are still open.',
  'add-margin': 'Adding margin is not connected to your wallet yet. Nothing changed.',
};

/**
 * The owner's buttons for the current state. Closing asks first, in place, as the Windows screen does;
 * the others say "Not sent". `className` lets the status line and the phone's page share one component.
 */
export function StatusActions({ view, className, skip }: { view: StatusActionsView; className?: string; skip?: readonly ActionId[] }) {
  const [asking, setAsking] = useState(false);
  const buttons = view.buttons.filter((b) => !skip?.includes(b.id));
  if (!view.note && buttons.length === 0) return null;

  if (asking) {
    return (
      <span className={cx('actions asking', className)} role="alertdialog" aria-label="Confirm">
        <span className="ask">Close both legs?</span>
        <button type="button" className="btn quiet" onClick={() => setAsking(false)}>Cancel</button>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            setAsking(false);
            notify(NOT_SENT.close);
          }}
        >
          Close position
        </button>
      </span>
    );
  }

  return (
    <span className={cx('actions', className)}>
      {view.note ? <span className="g3 note">{view.note}</span> : null}
      {buttons.map((b) => (
        <button
          key={b.id}
          type="button"
          className={cx('btn', b.style === 'quiet' && 'quiet', b.style === 'primary' && 'primary', b.id === 'auto' && 'auto')}
          onClick={() => (b.id === 'close' ? setAsking(true) : notify(NOT_SENT[b.id]))}
        >
          {b.label}
        </button>
      ))}
    </span>
  );
}
