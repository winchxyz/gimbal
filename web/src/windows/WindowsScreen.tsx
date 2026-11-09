import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStream } from '../stream/hub.ts';
import { loadAlerts, reached, saveAlerts, toggleAlert, type Alert } from './alerts.ts';
import { Detail } from './Detail.tsx';
import {
  arrange,
  deskMissing,
  failedScan,
  heldWindow,
  isBelow,
  pickSelection,
  stepSelection,
  watchOnlyVenues,
  type Pin,
} from './model.ts';
import { closedGroups, isOpenToDesk, marketsAnswer } from './markets.ts';
import { usePhone, useWindowRoute } from './route.ts';
import { LoadingView } from './States.tsx';
import { SCROLLER, takeFocus } from '../ui/scroller.ts';
import { useFlip } from './useFlip.ts';
import { useHistories, useStrategy } from './useEngine.ts';
import { Closed, ListHead, MinimumRule, Notices, Row, rowId } from './WindowList.tsx';
import './windows.css';

/** After the last arrow key the selected row stays put for this long, then the list settles into its sort order. */
const KEY_PIN_MS = 2000;

/**
 * Markets: one sentence (the best market open to the desk), the markets the desk may trade best net first, everything
 * else in one collapsed section with a plain reason each, and the detail of the selected market.
 */
export function WindowsScreen() {
  const windows = useStream((s) => s.windows);
  const scan = useStream((s) => s.scan);
  const strategyState = useStrategy();
  const strategy = strategyState.value;
  const minimum = strategy?.minNetAprPct ?? null;

  const phone = usePhone();
  const route = useWindowRoute();
  const [alerts, setAlerts] = useState<Alert[]>(loadAlerts);

  const all = useMemo(() => windows ?? [], [windows]);
  // The list holds only what the desk may trade now; the rest is in the collapsed section under it.
  const open = useMemo(() => all.filter(isOpenToDesk), [all]);
  const tradableIds = useMemo(() => all.filter((w) => w.tradable).map((w) => w.id), [all]);
  const histories = useHistories(tradableIds);

  // The selected row keeps its place while the pointer is over the list or an arrow key was just pressed.
  const [hovering, setHovering] = useState(false);
  const [keying, setKeying] = useState(false);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drawn = useRef<string[]>([]);

  // With nothing chosen the desktop selects the held window, else the first row, and then keeps that choice,
  // so the default selection does not hop around as the order changes.
  const sticky = useRef<string | null>(null);
  const natural = useMemo(() => arrange(open, 'tradable', minimum), [open, minimum]);
  const guess = pickSelection(natural.rows, route.id ?? sticky.current);
  if (route.id === null) sticky.current = guess;
  const pin: Pin | null = useMemo(() => {
    const slot = guess === null ? -1 : drawn.current.indexOf(guess);
    return (hovering || keying) && guess !== null && slot >= 0 ? { id: guess, slot } : null;
    // `drawn` is read, not watched: it only changes when rows are drawn, and `natural` changes first
  }, [hovering, keying, guess, natural]);
  const arranged = useMemo(() => (pin ? arrange(open, 'tradable', minimum, pin) : natural), [open, minimum, pin, natural]);
  useLayoutEffect(() => {
    drawn.current = arranged.rows.map((w) => w.id);
  }, [arranged]);

  const rowsRef = useRef<HTMLDivElement>(null);
  useFlip(rowsRef);

  const selectedId = phone ? null : guess;
  const selected = phone ? (route.id ? (all.find((w) => w.id === route.id) ?? null) : null) : (all.find((w) => w.id === selectedId) ?? null);

  const select = useCallback((id: string) => (phone ? route.open(id) : route.replace(id)), [phone, route]);

  // ↑ and ↓ move the selection and the detail follows.
  const rowsForKeys = useRef(arranged.rows);
  rowsForKeys.current = arranged.rows;
  const selectedForKeys = useRef(selectedId);
  selectedForKeys.current = selectedId;
  const refocus = useRef(false);
  useEffect(() => {
    if (phone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      const next = stepSelection(rowsForKeys.current, selectedForKeys.current, e.key === 'ArrowDown' ? 1 : -1);
      if (next === null) return;
      refocus.current = true;
      route.replace(next);
      setKeying(true);
      clearTimeout(keyTimer.current);
      keyTimer.current = setTimeout(() => setKeying(false), KEY_PIN_MS);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(keyTimer.current);
    };
  }, [phone, route]);

  useEffect(() => {
    if (!refocus.current || selectedId === null) return;
    refocus.current = false;
    const el = document.getElementById(rowId(selectedId));
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const toggle = useCallback((alert: Alert) => {
    setAlerts((current) => {
      const next = toggleAlert(current, alert);
      saveAlerts(next);
      return next;
    });
  }, []);
  const clear = useCallback((alert: Alert) => toggle(alert), [toggle]);

  if (windows === null || strategyState.status === 'loading') return <LoadingView />;

  const held = heldWindow(all);
  const failed = failedScan(scan, all);
  const notices = (
    <Notices
      noDesk={deskMissing(all)}
      failed={failed}
      held={held}
      reached={reached(alerts, all)}
      onClearAlert={clear}
      strategyError={strategyState.status === 'error' && strategy === null ? strategyState.error : null}
    />
  );

  const detailOpen = phone && selected !== null;

  return (
    <div className={detailOpen ? 'w-page detail-open' : 'w-page'}>
      <ListHead answer={marketsAnswer(all, minimum)} open={open.length} venues={scan?.venues ?? null} watchVenues={watchOnlyVenues(scan)} />
      <div className="w-split">
      <section className="w-list" aria-label="Markets" ref={takeFocus} {...SCROLLER}>
        {notices}
        <div
          className="w-rows"
          role="listbox"
          aria-label="Markets open to the desk"
          ref={rowsRef}
          onPointerEnter={(e) => e.pointerType === 'mouse' && setHovering(true)}
          onPointerLeave={() => setHovering(false)}
        >
          {rowsWithRule(arranged.rows, arranged.ruleAt, minimum, (w) => (
            <Row
              key={w.id}
              w={w}
              selected={w.id === selectedId}
              below={isBelow(w, minimum)}
              history={histories[w.id]}
              held={held}
              windows={all}
              legUsd={strategy?.legUsd ?? null}
              auto={strategy?.auto ?? null}
              onSelect={select}
            />
          ))}
          {arranged.rows.length === 0 ? (
            <p className="w-none g">No market is open to the desk in this scan.</p>
          ) : null}
        </div>
        <Closed groups={closedGroups(all)} onSelect={select} />
        <p className="w-hint phone-only">Tap a market for its 7-day line, costs and checks.</p>
      </section>
      {selected && (!phone || detailOpen) ? (
        <Detail w={selected} windows={all} strategy={strategy} histories={histories} alerts={alerts} onToggleAlert={toggle} />
      ) : phone ? null : (
        <section className="w-detail" />
      )}
      </div>
    </div>
  );
}

/** The rows, with the "Your minimum" rule drawn before the row at `ruleAt` (or after the last one). */
function rowsWithRule<T extends { id: string }>(rows: readonly T[], ruleAt: number | null, minimum: number | null, draw: (w: T) => ReactNode) {
  const out: ReactNode[] = rows.map(draw);
  if (ruleAt !== null && minimum !== null) out.splice(ruleAt, 0, <MinimumRule key="rule" minimum={minimum} />);
  return out;
}
