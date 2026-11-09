import type { Window as FundingWindow } from '@gimbal/shared';
import { useManualSend } from '../ui/useManualSend.ts';
import { enterConfirmText, enterState, OWNER_MAX_LOSS_USD } from './enter.ts';
import { venueName } from './format.ts';
import type { ManualAction } from './manual.ts';

interface Props {
  w: FundingWindow;
  windows: readonly FundingWindow[];
  legUsd: number | null;
  /** `row`: inside a list row (its own clicks must not select the row again); `detail`: the detail's action line. */
  place: 'row' | 'detail';
}

/**
 * The public live view owner's entry on one window (enter.ts): a confirm that says what will happen, then `POST
 * /rotate` with `demo` through useManualSend. The engine answers at once, ok or the reason a check refused; the
 * answer stays next to the button. A window the page knows cannot be entered shows the button disabled, with why.
 * Drawn only when writeControls().enter (the owner unlocked this tab).
 */
export function OwnerEnter({ w, windows, legUsd, place }: Props) {
  const state = enterState(w, windows);
  const action: ManualAction | null =
    state.kind === 'open' ? { kind: 'enter', symbol: w.symbol, windowId: w.id, maxLossUsd: OWNER_MAX_LOSS_USD } : null;
  const send = useManualSend(action);
  if (state.kind === 'none') return null;

  const stop = place === 'row'
    ? { onClick: (e: { stopPropagation(): void }) => e.stopPropagation(), onKeyDown: (e: { stopPropagation(): void }) => e.stopPropagation() }
    : {};
  const Wrap = place === 'row' ? 'span' : 'div';
  const className = place === 'row' ? 'rot' : 'w-cta';

  if (send.asking && action !== null) {
    return (
      <Wrap className={className} role="alertdialog" aria-label="Confirm" {...stop}>
        <span className="ink">{enterConfirmText(w, venueName, legUsd)}</span>
        <span className={place === 'row' ? 'ask' : 'end'}>
          <button type="button" className="btn quiet" onClick={send.cancel}>Cancel</button>
          <button type="button" className="btn primary" onClick={send.confirm}>Enter {w.symbol}</button>
        </span>
      </Wrap>
    );
  }

  return (
    <Wrap className={className} {...stop}>
      <span>
        {state.kind === 'blocked' ? <span className="g">{state.reason}</span> : null}
        {send.sending ? <span className="g" role="status">Sending to the engine…</span> : null}
        {send.outcome ? (
          <span className={send.outcome.tone === 'sent' ? 'ink' : 'wt'} role="status">
            {send.outcome.title}: {send.outcome.text}
          </span>
        ) : null}
      </span>
      <span className={place === 'row' ? undefined : 'end'}>
        <button type="button" className="btn" disabled={state.kind === 'blocked' || send.sending} onClick={send.ask}>
          Enter {w.symbol}
        </button>
      </span>
    </Wrap>
  );
}
