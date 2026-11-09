import { useEffect, useMemo, useState } from 'react';
import type { StrategyConfig, Window as FundingWindow } from '@gimbal/shared';
import { writeControls } from '../remote/readonly.ts';
import { Flash } from '../ui/Flash.tsx';
import { cx } from '../ui/cx.ts';
import { useNow } from '../ui/useNow.ts';
import { hasAlert, makeAlert, type Alert } from './alerts.ts';
import { Chart } from './Chart.tsx';
import { decide, perDayOnLegs, type Decision } from './decision.ts';
import { depth, pct, usd, usdWhole, venueName } from './format.ts';
import type { HistoryState } from './history.ts';
import { checkLines, heldWindow, isNoDesk, plainNote } from './model.ts';
import { checksSummary, closedGroups, isOpenToDesk } from './markets.ts';
import { Ago } from './WindowList.tsx';
import { stepValue, waterfall } from './waterfall.ts';
import type { ManualAction, Outcome } from './manual.ts';
import { OwnerEnter } from './OwnerEnter.tsx';
import { retryHistory, sendManual } from './useEngine.ts';

interface Props {
  w: FundingWindow;
  windows: readonly FundingWindow[];
  strategy: StrategyConfig | null;
  histories: HistoryState;
  alerts: readonly Alert[];
  onToggleAlert(alert: Alert): void;
}

/** The detail stage of the selected window (design/screens/desktop/windows.html). */
export function Detail({ w, windows, strategy, histories, alerts, onToggleAlert }: Props) {
  const now = useNow(30_000);
  const minimum = strategy?.minNetAprPct ?? null;
  const held = heldWindow(windows);
  const behind = held && held.id !== w.id ? held : null;
  const decision = useMemo(() => decide({ selected: w, windows, strategy, now }), [w, windows, strategy, now]);
  const watch = !w.tradable;
  const neg = !watch && w.netAprPct < 0;

  return (
    <section className="w-detail" aria-label={`${w.symbol} detail`}>
      <a className="w-back" href="#/markets">{'←'} Markets</a>

      <div className="w-coin">
        <b>{w.symbol}</b>
        <span className="g">
          Long {venueName(w.longVenue)} · short {venueName(w.shortVenue)}
        </span>
      </div>
      {watch ? (
        <div className="w-big">
          <b>
            <Flash value={w.grossAprPct}>{pct(w.grossAprPct, 0)}</Flash>
          </b>
          <p className="g">gross a year. Watch-only: the desk cannot trade these venues, so there is no net.</p>
        </div>
      ) : (
        <div className="w-big">
          <b className={cx(neg && 'neg')}>
            <Flash value={w.netAprPct}>{pct(w.netAprPct, Math.abs(w.netAprPct) >= 10 ? 0 : 1)}</Flash>
          </b>
          <p className="g">
            a year after costs
            {strategy ? <> · about {usd(perDayOnLegs(w, strategy.legUsd))} a day on {usdWhole(strategy.legUsd)} legs</> : null}
            {' · '}
            {depth(w.depthUsd)} depth · read <Ago at={w.updatedAt} />
          </p>
          <p className="g w-status">{statusLine(w)}</p>
        </div>
      )}

      {watch ? (
        <WatchFacts w={w} />
      ) : (
        <>
          <ThreeLines w={w} legUsd={strategy?.legUsd ?? null} />
          <Chart
            symbol={w.symbol}
            history={histories[w.id]}
            held={behind ? { symbol: behind.symbol, history: histories[behind.id] } : null}
            minimum={minimum}
            onRetry={() => retryHistory(w.id)}
          />
          <Checks w={w} />
        </>
      )}

      <DecisionLine key={w.id} decision={decision} w={w} alerts={alerts} onToggleAlert={onToggleAlert} />
      {/* The live view's owner, unlocked in this tab: an entry from flat on this window (enter.ts says when it cannot). */}
      {writeControls().enter ? <OwnerEnter key={`enter-${w.id}`} w={w} windows={windows} legUsd={strategy?.legUsd ?? null} auto={strategy?.auto ?? null} place="detail" /> : null}
    </section>
  );
}

// ---------- gross to net ----------

/** Gross to net in three lines (funding, costs, net); how the costs add up is one tap away. */
function ThreeLines({ w, legUsd }: { w: FundingWindow; legUsd: number | null }) {
  const wf = useMemo(() => waterfall(w, legUsd), [w, legUsd]);
  const costs = wf.steps.filter((s) => s.key !== 'gross' && s.key !== 'net');
  const total = costs.reduce((sum, s) => sum + s.value, 0);
  return (
    <div className="w-three">
      <div className="kv">
        <span>{w.grossApr7dPct === null ? 'Funding now, a year' : 'Funding, last 7 days, a year'}</span>
        <span>{pct(w.grossApr7dPct ?? w.grossAprPct)}</span>
      </div>
      <details className="w-costs">
        <summary className="kv">
          <span>
            Costs, as a year<i className="chev" aria-hidden="true" />
          </span>
          <span>{stepValue('fees', total)}</span>
        </summary>
        {costs.map((s) => (
          <div key={s.key} className="kv sub">
            <span>{s.label}</span>
            <span>{stepValue(s.key, s.value)}</span>
          </div>
        ))}
      </details>
      <div className="kv tot">
        <span>Net, a year</span>
        <span className={cx(w.netAprPct < 0 && 'neg')}>{pct(w.netAprPct)}</span>
      </div>
    </div>
  );
}

// ---------- checks ----------

/** The checks folded into one line ("7 of 7 checks passed"); a tap reads them. */
function Checks({ w }: { w: FundingWindow }) {
  const lines = useMemo(() => checkLines(w), [w]);
  return (
    <details className="w-checks">
      <summary>
        <span>{checksSummary(lines)}</span>
        <i className="chev" aria-hidden="true" />
      </summary>
      {lines.length === 0 ? <p className="g">The engine has not checked this market yet.</p> : null}
      {lines.map((l, i) => (
        <p key={i} className={l.ok ? 'ok' : 'bad'}>
          {l.text}
          {l.blocking ? <span className="g"> · why it is not entered</span> : null}
        </p>
      ))}
    </details>
  );
}

/** Held, no desk yet, or what keeps the desk out, in plain words; empty for a market open to the desk. */
function statusLine(w: FundingWindow): string {
  if (w.held) return 'The desk holds this market.';
  if (isNoDesk(w)) return 'No desk yet: nothing can be entered until one exists.';
  if (!isOpenToDesk(w)) return closedGroups([w])[0]?.reason ? `${closedGroups([w])[0]!.reason}.` : '';
  return w.note ? plainNote(w.note) : '';
}

// ---------- watch-only ----------

function WatchFacts({ w }: { w: FundingWindow }) {
  return (
    <div className="w-cols2 w-watch">
      <div>
        <h3>Funding the scanner reads</h3>
        <div className="legend">
          <div><span>Gross now</span><span>{pct(w.grossAprPct)}</span></div>
          <div><span>Gross, last 7 days</span><span>{w.grossApr7dPct === null ? '—' : pct(w.grossApr7dPct)}</span></div>
          <div><span>Depth on the thinner side</span><span>{depth(w.depthUsd)}</span></div>
          <div><span>Updated</span><span><Ago at={w.updatedAt} /></span></div>
        </div>
      </div>
    </div>
  );
}

// ---------- decision line ----------

interface DecisionProps {
  decision: Decision;
  w: FundingWindow;
  alerts: readonly Alert[];
  onToggleAlert(alert: Alert): void;
}

type Asking = 'rotate' | 'close' | null;

/** How long the answer to a send stays under the line before it clears itself. */
const OUTCOME_MS = 20_000;

/**
 * What auto will do and why, with the two manual overrides. Rotating and closing ask for a confirmation here, in the
 * page, and then go to the engine (`POST /rotate`, `POST /close`). It answers at once, `ok` or the reason a check
 * refused; the work itself arrives as Journal and Desk events. The alert is local.
 */
function DecisionLine({ decision, w, alerts, onToggleAlert }: DecisionProps) {
  const [asking, setAsking] = useState<Asking>(null);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Remote view and hosted replay: the line says what auto will do; the overrides are not offered.
  const { alert: alertOver } = decision;
  const rotate = writeControls().rotate ? decision.rotate : null;
  const close = writeControls().close && decision.close;
  const alertSet = alertOver ? hasAlert(alerts, w.id, alertOver.over.id) : false;

  useEffect(() => {
    if (outcome === null) return;
    const timer = setTimeout(() => setOutcome(null), OUTCOME_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  const ask = (what: Exclude<Asking, null>) => {
    setOutcome(null);
    setAsking(what);
  };

  const confirm = () => {
    const action: ManualAction | null =
      asking === 'rotate' && rotate
        ? { kind: 'rotate', from: rotate.from.symbol, to: rotate.to.symbol, windowId: rotate.to.id }
        : asking === 'close'
          ? { kind: 'close', symbol: w.symbol }
          : null;
    setAsking(null);
    if (action === null) return;
    setSending(true);
    void sendManual(action).then((result) => {
      setSending(false);
      setOutcome(result);
    });
  };

  if (asking && (rotate || close)) {
    const text = asking === 'rotate' && rotate
      ? `Rotate ${rotate.from.symbol} to ${rotate.to.symbol}? Both ${rotate.from.symbol} legs close and ${rotate.to.symbol} opens.${rotate.costUsd === null ? '' : ` It costs about ${usd(rotate.costUsd)}.`}`
      : `Close both ${w.symbol} legs?`;
    return (
      <div className="w-cta" role="alertdialog" aria-label="Confirm">
        <span className="ink">{text}</span>
        <span className="end">
          <button type="button" className="btn quiet" onClick={() => setAsking(null)}>Cancel</button>
          <button type="button" className="btn primary" onClick={confirm}>{asking === 'rotate' ? 'Rotate' : 'Close position'}</button>
        </span>
      </div>
    );
  }

  return (
    <div className="w-cta">
      <span>
        {decision.text}
        {sending ? <span className="g"> Sending to the engine…</span> : null}
        {outcome ? (
          <span className={outcome.tone === 'sent' ? 'ink' : 'wt'} role="status">
            {' '}
            {outcome.title}: {outcome.text}
          </span>
        ) : null}
      </span>
      <span className="end">
        {alertOver ? (
          <button type="button" className="btn quiet" onClick={() => onToggleAlert(makeAlert(w, alertOver.over))}>
            {alertSet ? `Alert set for ${alertOver.over.symbol}. Clear` : `Alert me if it passes ${alertOver.over.symbol}`}
          </button>
        ) : null}
        {rotate ? <button type="button" className="btn" disabled={sending} onClick={() => ask('rotate')}>Rotate to {rotate.to.symbol}</button> : null}
        {close ? <button type="button" className="btn" disabled={sending} onClick={() => ask('close')}>Close position</button> : null}
      </span>
    </div>
  );
}
