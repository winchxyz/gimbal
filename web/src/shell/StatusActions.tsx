import { useState } from 'react';
import { cx } from '../ui/cx.ts';
import { notify } from '../ui/notice.ts';
import { writeControls } from '../remote/readonly.ts';
import { sendManual } from '../windows/useEngine.ts';
import type { ActionId, StatusActionsView } from './status.ts';

// None of these is connected yet: pausing and resuming are the owner's wallet signing `set_paused`, and adding margin
// is a transfer the owner signs. Each says so and changes nothing. Closing is the engine's `POST /close`.
const NOT_SENT: Record<Exclude<ActionId, 'close'>, string> = {
  auto: 'Changing Auto is not connected to the engine yet. Nothing changed.',
  pause: 'Pausing is signed in your wallet, and wallet signing is not connected yet. Nothing changed.',
  resume: 'Resuming is signed in your wallet, and wallet signing is not connected yet. Nothing changed.',
  'add-margin': 'Adding margin is not connected to your wallet yet. Nothing changed.',
};

/**
 * The owner's buttons for the current state. Closing asks first, in place, as the Windows screen does;
 * the others say "Not sent", and Close sends `POST /close` and says what the engine answered. `className` lets the status line and the phone's page share one component.
 */
export function StatusActions({ view, className, skip }: { view: StatusActionsView; className?: string; skip?: readonly ActionId[] }) {
  const [asking, setAsking] = useState(false);
  // Read-only view: the owner's buttons are not drawn; the note, which only says something, stays.
  const buttons = writeControls().owner ? view.buttons.filter((b) => !skip?.includes(b.id)) : [];
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
            void sendManual({ kind: 'close', symbol: null }).then((o) => notify(o.text, o.title, o.tone === 'sent' ? 'ok' : 'warn'));
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
