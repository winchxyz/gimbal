import { useEffect, useMemo, useState } from 'react';
import type { StrategyConfig, Window as FundingWindow } from '@gimbal/shared';
import { Flash } from '../ui/Flash.tsx';
import { cx } from '../ui/cx.ts';
import { useNow } from '../ui/useNow.ts';
import { hasAlert, makeAlert, type Alert } from './alerts.ts';
import { Chart } from './Chart.tsx';
import { decide, perDayOnLegs, type Decision } from './decision.ts';
import { depth, hours, pct, plain, usd, usdWhole, venueName } from './format.ts';
import type { HistoryState } from './history.ts';
import { checkLines, heldWindow, isNoDesk } from './model.ts';
import { Ago } from './WindowList.tsx';
import { waterfall, type StepKey } from './waterfall.ts';
import type { ManualAction, Outcome } from './manual.ts';
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
      <a className="w-back" href="#/windows">{'←'} Windows</a>

      <div className="w-dtop">
        <div>
          <h1>{w.symbol}</h1>
          <p>
            Long {venueName(w.longVenue)} · short {venueName(w.shortVenue)} · {depth(w.depthUsd)} depth
          </p>
          {watch ? null : (
            <p className="w-facts">
              {usd(w.usdPerDayPer1k)} a day per $1k · breakeven {hours(w.breakevenHours)} · updated <Ago at={w.updatedAt} />
            </p>
          )}
        </div>
        <div className="n">
          {watch ? (
            <>
              <b><Flash value={w.grossAprPct}>{pct(w.grossAprPct)}</Flash></b>
              <span className="g">gross a year</span>
              <span>Watch-only, no net APR</span>
            </>
          ) : (
            <>
              <b className={cx(neg && 'neg', w.refused && !isNoDesk(w) && 'struck')}><Flash value={w.netAprPct}>{pct(w.netAprPct)}</Flash></b>
              <span className="g">net a year</span>
              {strategy ? <span>≈ {usd(perDayOnLegs(w, strategy.legUsd))} a day on {usdWhole(strategy.legUsd)} legs</span> : null}
            </>
          )}
        </div>
      </div>

      {watch ? (
        <WatchFacts w={w} />
      ) : (
        <>
          <Chart
            symbol={w.symbol}
            history={histories[w.id]}
            held={behind ? { symbol: behind.symbol, history: histories[behind.id] } : null}
            minimum={minimum}
            onRetry={() => retryHistory(w.id)}
          />
          <div className="w-cols2">
            <Waterfall w={w} legUsd={strategy?.legUsd ?? null} />
            <Checks w={w} />
          </div>
        </>
      )}

      <DecisionLine key={w.id} decision={decision} w={w} alerts={alerts} onToggleAlert={onToggleAlert} />
    </section>
  );
}

// ---------- cost waterfall ----------

function Waterfall({ w, legUsd }: { w: FundingWindow; legUsd: number | null }) {
  const wf = useMemo(() => waterfall(w, legUsd), [w, legUsd]);
  return (
    <div>
      <h3>From {pct(w.grossAprPct)} gross to {pct(w.netAprPct)} net</h3>
      <div className="stack">
        <i className="k-gross" style={{ width: `${wf.grossWidth}%` }} />
      </div>
      <div className="stack" style={{ marginTop: 4 }}>
        {wf.parts.map((p) => (
          <i key={p.key} className={`k-${p.key}`} style={{ width: `${p.width}%` }} />
        ))}
      </div>
      <div className="legend">
        {wf.steps.map((s) => (
          <div key={s.key} className={cx(s.key === 'net' && 'tot')}>
            <span><i className={`k-${s.key}`} />{s.label}</span>
            <span className={cx(s.key === 'net' && s.value < 0 && 'neg')}>{stepValue(s.key, s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** `+18.4%` earned, `−1.9%` spent, `13.8%` net */
function stepValue(key: StepKey, value: number): string {
  if (key === 'net') return pct(value);
  if (key === 'gross') return `+${plain(value)}%`;
  return value < 0 ? `+${plain(-value)}%` : pct(-value); // a cost that came out negative is a gain
}

// ---------- checks ----------

function Checks({ w }: { w: FundingWindow }) {
  const lines = useMemo(() => checkLines(w), [w]);
  return (
    <div className="w-verdict">
      <h3>Checks</h3>
      {lines.length === 0 ? <p className="g">The engine has not checked this window yet.</p> : null}
      {lines.map((l, i) => (
        <p key={i} className={l.ok ? 'ok' : 'bad'}>
          {l.text}
          {l.blocking ? <span className="g"> · why it is not entered</span> : null}
        </p>
      ))}
    </div>
  );
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
  const { rotate, alert: alertOver, close } = decision;
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
