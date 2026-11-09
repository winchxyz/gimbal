import { useEffect, useSyncExternalStore } from 'react';
import type { Window as FundingWindow } from '@gimbal/shared';
import { createStore, stream, useStream } from '../stream/hub.ts';
import { useManualSend } from '../ui/useManualSend.ts';
import { enterConfirmText, enterState, entryResult, isOwnerEntryOn, OWNER_MAX_LOSS_USD, type PendingEntry } from './enter.ts';
import { venueName } from './format.ts';
import type { ManualAction } from './manual.ts';

interface Props {
  w: FundingWindow;
  windows: readonly FundingWindow[];
  legUsd: number | null;
  /** The engine rules' `auto` (null: not read yet). Off, the engine refuses every entry, so the button says so. */
  auto: boolean | null;
  /** `row`: inside a list row (its own clicks must not select the row again); `detail`: the detail's action line. */
  place: 'row' | 'detail';
}

/**
 * The entry the owner started on this page, shared by the list row and the detail (one control each): which window,
 * the Journal ids already there when it was sent, and whether the engine was seen acting on it (an entry that ends
 * without a line of its own then says so instead of waiting forever). Cleared when the owner asks to enter again.
 */
interface Started extends PendingEntry {
  sawActing: boolean;
}
type StartedAction = { kind: 'start'; entry: Started } | { kind: 'acting'; windowId: string } | { kind: 'clear' };
const started = createStore<Started | null, StartedAction>((state, action) => {
  if (action.kind === 'start') return action.entry;
  if (action.kind === 'clear') return null;
  return state !== null && state.windowId === action.windowId && !state.sawActing ? { ...state, sawActing: true } : state;
}, null);

/**
 * The public live view owner's entry on one window (enter.ts): a confirm that says what will happen, then `POST
 * /rotate` with `demo` through useManualSend. The engine answers at once: "Entry started" on a 200, "Still running"
 * on a 409 while the loop acts. While it acts (StrategyDecision.acting) Enter is disabled on every window; the act's
 * result (opened, or not opened and why) comes from its Journal line and stays next to the window's control.
 * Drawn only when writeControls().enter (the owner unlocked this tab).
 */
export function OwnerEnter({ w, windows, legUsd, auto, place }: Props) {
  const acting = useStream((s) => s.decision?.acting ?? null);
  const journal = useStream((s) => s.journal);
  const entry = useSyncExternalStore(started.subscribe, started.getState);
  const state = enterState(w, windows, auto, acting);
  const action: ManualAction | null =
    state.kind === 'open' ? { kind: 'enter', symbol: w.symbol, windowId: w.id, maxLossUsd: OWNER_MAX_LOSS_USD } : null;
  const send = useManualSend(action, (outcome) => {
    // Taken: this window's entry is the one whose result the page waits for. The ids the Journal holds now are older.
    if (outcome.tone === 'sent') {
      started.dispatch({ kind: 'start', entry: { windowId: w.id, symbol: w.symbol, seen: new Set(stream.getState().journal.map((e) => e.id)), sawActing: false } });
    }
  });
  const mine = entry !== null && entry.windowId === w.id ? entry : null;
  const actingOnMine = mine !== null && acting !== null && isOwnerEntryOn(acting, w.id);
  useEffect(() => {
    if (actingOnMine) started.dispatch({ kind: 'acting', windowId: w.id });
  }, [actingOnMine, w.id]);

  const result = mine === null ? null : entryResult(journal, mine);
  // No line of its own (a refusal the Journal already had, worded the same): the act ended all the same.
  const ended = mine !== null && result === null && mine.sawActing && !actingOnMine;
  const running = mine !== null && result === null && !ended;

  // The window just entered is held now (no Enter on it): its result still shows where the owner looked.
  if (state.kind === 'none' && result === null) return null;

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

  const ask = () => {
    started.dispatch({ kind: 'clear' });
    send.ask();
  };
  // This window's own entry says how it is going; the "still running" reason would only repeat it.
  const reason = state.kind === 'blocked' && !(running && actingOnMine) ? state.reason : null;
  const outcome = send.outcome !== null && !(result !== null && send.outcome.tone === 'sent') ? send.outcome : null;

  return (
    <Wrap className={className} {...stop}>
      <span>
        {reason !== null ? <span className="g">{reason}</span> : null}
        {send.sending ? <span className="g" role="status">Sending to the engine…</span> : null}
        {outcome !== null ? (
          <span className={outcome.tone === 'sent' ? 'ink' : 'wt'} role="status">
            {outcome.title}: {outcome.text}
          </span>
        ) : running && outcome === null && actingOnMine ? (
          <span className="ink" role="status">Entry running: {w.symbol}, watch the Journal.</span>
        ) : null}
        {result !== null ? (
          <span className={result.kind === 'not' ? 'wt' : 'ink'} role="status">{result.text}</span>
        ) : ended ? (
          <span className="g" role="status">Your entry ended; its line is in the Journal.</span>
        ) : null}
      </span>
      {state.kind === 'none' ? null : (
        <span className={place === 'row' ? undefined : 'end'}>
          <button type="button" className="btn" disabled={state.kind === 'blocked' || send.sending} onClick={ask}>
            Enter {w.symbol}
          </button>
        </span>
      )}
    </Wrap>
  );
}
