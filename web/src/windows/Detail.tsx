import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { StrategyConfig, Window as FundingWindow } from '@gimbal/shared';
import { price } from '../desk/format.ts';
import { writeControls } from '../remote/readonly.ts';
import { useStream } from '../stream/hub.ts';
import { Flash } from '../ui/Flash.tsx';
import { Panel, Readings, type Reading } from '../ui/Panel.tsx';
import { RateChart } from '../ui/RateChart.tsx';
import { cx } from '../ui/cx.ts';
import { ago, useNow } from '../ui/useNow.ts';
import { AcrossVenues, OtherPairs } from './Across.tsx';
import { hasAlert, makeAlert, type Alert } from './alerts.ts';
import { decide, perDayOnLegs, type Decision } from './decision.ts';
import { capital, depth, hours, pct, rate, sentence as sentenceOf, signedPct, usd, usdWhole, venueName } from './format.ts';
import type { HistoryState } from './history.ts';
import { checkLines, heldWindow } from './model.ts';
import { checksSummary, nettedFunding } from './markets.ts';
import type { ManualAction, Outcome } from './manual.ts';
import { OwnerEnter } from './OwnerEnter.tsx';
import { legsSentence, pairAnswer, pairAnswerText } from './pair.ts';
import { assetRows, countdown, everyWords, nextPayment, pairNextAt, pairRows, payout, siblingPairs, type LegView, type PairRow } from './scanner.ts';
import { SpreadScale } from './SpreadScale.tsx';
import { retryHistory, sendManual } from './useEngine.ts';
import { stepValue, waterfall } from './waterfall.ts';

interface Props {
  w: FundingWindow;
  windows: readonly FundingWindow[];
  strategy: StrategyConfig | null;
  histories: HistoryState;
  alerts: readonly Alert[];
  onToggleAlert(alert: Alert): void;
}

const NONE = <span className="g">—</span>;
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
/** `$0.040`, `$6.71`: an amount that may be a fraction of a cent keeps three decimals under a dollar. */
const money = (value: number): string => usd(value, Math.abs(value) < 1 ? 3 : 2);
/** A mark price with its currency: `$0.016583`, `$104,210.00`. */
const mark = (value: number): string => `$${price(value)}`;

/** One pair: the two rates and the spread between them as a scale, then both sides, what it pays, its costs, its week and its checks. */
export function Detail({ w, windows, strategy, histories, alerts, onToggleAlert }: Props) {
  const now = useNow(20_000);
  const minimum = strategy?.minNetAprPct ?? null;
  const held = heldWindow(windows);
  const behind = held && held.id !== w.id ? held : null;
  const engine = useStream((s) => s.decision);
  const decision = useMemo(() => decide({ selected: w, windows, strategy, now, engine }), [w, windows, strategy, now, engine]);
  // Every listed pair, for what this one is compared against: the asset's other venues and its other pairs.
  const rows = useMemo(() => pairRows(windows), [windows]);
  const row = useMemo(() => rows.find((r) => r.w.id === w.id) ?? pairRows([w])[0]!, [rows, w]);
  const asset = useMemo(() => assetRows(rows.filter((r) => r.w.symbol === w.symbol))[0] ?? null, [rows, w.symbol]);
  const siblings = useMemo(() => siblingPairs(rows, w), [rows, w]);
  const watch = !w.tradable;
  const answer = pairAnswer(w);
  const sentence = pairAnswerText(answer);
  const said = legsSentence(row);

  const readings: Reading[] = [
    { label: 'Long on', value: venueName(w.longVenue) },
    { label: 'Short on', value: venueName(w.shortVenue) },
    { label: 'Spread now', value: <Flash value={w.grossAprPct}>{rate(w.grossAprPct)}</Flash> },
    watch
      ? { label: 'Open interest, thinner side', value: depth(w.depthUsd) }
      : { label: 'Spread, 7 days', value: w.grossApr7dPct === null ? '—' : rate(w.grossApr7dPct) },
  ];

  const entry = histories[w.id];
  const lines = useMemo(() => checkLines(w), [w]);

  return (
    <article aria-label={`${w.symbol}, long ${venueName(w.longVenue)}, short ${venueName(w.shortVenue)}`}>
      <p className="w-crumb"><a href="#/markets">{'←'} Markets</a></p>
      <div className="top">
        <h1 className={cx('answer', sentence.length > 54 && 'long')} data-testid="pair-answer">
          {answer.lead}
          {answer.rate === null ? null : <span className={answer.tone ?? undefined}>{answer.rate}</span>}
          {answer.rest}
        </h1>
        <Readings rows={readings} shut />
      </div>

      <section className="hero">
        <div className="cap">
          <span>Funding on each side</span>
          <span>
            this hour, stated as a year{row.long?.apr7dPct !== null || row.short?.apr7dPct !== null ? ' · rings: the 7-day mean' : ''} · read {ago(w.updatedAt, now)}
          </span>
        </div>
        {row.long !== null && row.short !== null ? <SpreadScale long={row.long} short={row.short} spreadPct={w.grossAprPct} label={said} /> : null}
        <p className="say">{said}</p>
        <DecisionLine key={w.id} decision={decision} w={w} alerts={alerts} onToggleAlert={onToggleAlert} />
        {/* The live view's owner, unlocked in this tab: an entry from flat on this pair (enter.ts says when it cannot). */}
        {writeControls().enter ? <OwnerEnter key={`enter-${w.id}`} w={w} windows={windows} legUsd={strategy?.legUsd ?? null} auto={strategy?.auto ?? null} /> : null}
      </section>

      <div className="pg">
        <Panel title="The two sides" note="as each venue reports it" span={8}>
          <Legs row={row} now={now} />
        </Panel>
        <Panel title="What it pays" note="on $1,000 a side" span={4}>
          <Pays w={w} strategy={strategy} />
        </Panel>
        {watch ? null : (
          <>
            <Panel title="From funding to net" note="a year" span={5}>
              <Costs w={w} legUsd={strategy?.legUsd ?? null} />
            </Panel>
            <Panel title="Seven days" note={`net a year, hourly${behind ? ` · grey: ${behind.symbol}, held` : ''}`} span={7}>
              <RateChart
                label={`${w.symbol}, net a year over 7 days`}
                points={entry?.history?.points ?? null}
                status={entry?.status ?? 'loading'}
                behind={behind ? (histories[behind.id]?.history?.points ?? null) : null}
                minimum={minimum}
                held={w.held ? { from: w.held.since, to: null } : null}
                onRetry={() => retryHistory(w.id)}
              />
              <p className="pn-foot">
                {w.held ? 'The green hours are the time the desk has held it. ' : ''}
                {minimum === null ? '' : `The dotted line is your ${pct(minimum, minimum % 1 === 0 ? 0 : 1)} minimum.`}
              </p>
            </Panel>
          </>
        )}
        {asset !== null && asset.venues.length > 2 ? (
          <Panel title={`${w.symbol} by venue`} note="funding this hour, lowest first" span={7} className="nw">
            <AcrossVenues asset={asset} row={row} />
            <p className="pn-foot">
              A long is paid most at the top of the list, a short at the bottom. The filled points are this pair’s two venues.
            </p>
          </Panel>
        ) : null}
        {siblings.length > 0 ? (
          <Panel title={`Other ${w.symbol} pairs`} note={`${siblings.length} listed`} span={asset !== null && asset.venues.length > 2 ? 5 : 12} className="nw">
            <OtherPairs symbol={w.symbol} pairs={siblings} />
          </Panel>
        ) : null}
        {watch ? (
          // A pair the desk only watches is not checked for an entry: what the engine says about it are notes.
          lines.length === 0 ? null : (
            <Panel title="Why the desk only watches it">
              <ul className="w-chk plain">
                {lines.map((l, i) => <li key={i}><span>{sentenceOf(capital(l.text.replace(/^Watch-only:\s*/i, '')))}</span></li>)}
              </ul>
            </Panel>
          )
        ) : (
          <Panel title="Checks" note={checksSummary(lines)}>
            {lines.length === 0 ? <p className="pn-none">The engine has not checked this pair yet.</p> : (
              <ul className="w-chk">
                {lines.map((l, i) => (
                  <li key={i} className={l.ok ? undefined : 'bad'}>
                    <i aria-hidden="true">{l.ok ? '✓' : ''}</i>
                    <span>
                      {l.text}
                      {l.blocking ? <small>Why it is not entered</small> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>
    </article>
  );
}

/** A pair the address names that the scan no longer lists. */
export function Gone() {
  return (
    <article>
      <p className="w-crumb"><a href="#/markets">{'←'} Markets</a></p>
      <div className="top">
        <h1 className="answer long">This pair is not in the scan right now.</h1>
      </div>
      <p className="say w-gone">
        A pair is listed while both venues quote the market and their prices agree. It can come back with the next scan.{' '}
        <a href="#/markets" className="ink">See what is listed now</a>.
      </p>
    </article>
  );
}

// ---------- both sides ----------

function Legs({ row, now }: { row: PairRow; now: number }) {
  const { long, short, w } = row;
  if (long === null || short === null) {
    return <p className="pn-none">This engine does not publish each side’s readings yet; the pair’s own figures are above.</p>;
  }
  const line = (label: string, cell: (leg: LegView) => ReactNode, pair: ReactNode = null) => (
    <tr>
      <th scope="row">{label}</th>
      <td>{cell(long)}</td>
      <td>{cell(short)}</td>
      <td className="c-pair">{pair}</td>
    </tr>
  );
  const next = (leg: LegView): ReactNode => {
    const at = nextPayment(leg, now);
    return at === null ? <span className="g">accrues live</span> : <>{countdown(at - now)}<small>{hhmm(at)} UTC</small></>;
  };
  const sooner = pairNextAt(row, now);
  const week = long.apr7dPct !== null && short.apr7dPct !== null ? short.apr7dPct - long.apr7dPct : null;
  // The phone has room for the two sides only: what belongs to the pair goes under the table as readings.
  const pairOnly: Reading[] = [
    { label: 'Next payment, either side', value: sooner === null ? '—' : countdown(sooner - now) },
    { label: 'Price gap, short over long', value: row.gapPct === null ? '—' : signedPct(row.gapPct, 2) },
    { label: 'Open interest, thinner side', value: depth(w.depthUsd) },
    { label: 'Volume 24 hours, quieter side', value: row.volumeUsd === null ? '—' : depth(row.volumeUsd) },
  ];
  return (
    <>
    <div className="tb-x">
      <table className="tb legs">
        <thead>
          <tr>
            <th />
            <th scope="col">Long · {long.name}</th>
            <th scope="col">Short · {short.name}</th>
            <th scope="col" className="c-pair">The pair</th>
          </tr>
        </thead>
        <tbody>
          {line('Market', (leg) => leg.symbol)}
          {line('Funding this hour', (leg) => <>{rate(leg.aprPct)}<small>{pct((leg.aprPct / 8760), 4)} an hour</small></>, <>{rate(w.grossAprPct)}<small>spread a year</small></>)}
          {line('Mean over 7 days', (leg) => (leg.apr7dPct === null ? NONE : rate(leg.apr7dPct)), week === null ? NONE : rate(week))}
          {line('Paid', (leg) => everyWords(leg.settlement))}
          {line('Next payment', next, sooner === null ? NONE : countdown(sooner - now))}
          {line('Mark price', (leg) => (leg.markPx === null ? NONE : mark(leg.markPx)), row.gapPct === null ? NONE : <>{signedPct(row.gapPct, 2)}<small>short over long</small></>)}
          {line('Open interest', (leg) => (leg.oiUsd === null ? NONE : depth(leg.oiUsd)), <>{depth(w.depthUsd)}<small>thinner side</small></>)}
          {line('Volume, 24 hours', (leg) => (leg.volume24hUsd === null ? NONE : depth(leg.volume24hUsd)), row.volumeUsd === null ? NONE : <>{depth(row.volumeUsd)}<small>quieter side</small></>)}
          {long.move24hPct === null && short.move24hPct === null ? null : line('Price, 24 hours', (leg) => (leg.move24hPct === null ? NONE : signedPct(leg.move24hPct)))}
          {line('Read', (leg) => ago(leg.readAt, now))}
        </tbody>
      </table>
    </div>
    <Readings rows={pairOnly} className="legs-pair" shut />
    </>
  );
}

// ---------- what it pays ----------

function Pays({ w, strategy }: { w: FundingWindow; strategy: StrategyConfig | null }) {
  const watch = !w.tradable;
  const gross = payout(w.grossAprPct, 1000);
  const net = watch ? null : payout(w.netAprPct, 1000);
  const rows: [string, number, number | null][] = [
    ['An hour', gross.hour, net?.hour ?? null],
    ['8 hours', gross.eightHours, net?.eightHours ?? null],
    ['A day', gross.day, net?.day ?? null],
    ['A week', gross.week, net?.week ?? null],
    ['A year', gross.year, net?.year ?? null],
  ];
  return (
    <>
      <table className="tb">
        <thead>
          <tr>
            <th />
            <th scope="col">At this hour’s spread</th>
            {net === null ? null : <th scope="col">After costs</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, g, n]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className={net === null ? undefined : 'g'}>{money(g)}</td>
              {n === null ? null : <td className={cx(n < 0 && 'down')}>{money(n)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pn-foot">
        {watch
          ? 'If the spread held. It is this hour’s rate on both sides; fees, slippage and the rescue reserve are not priced on venues the desk cannot trade.'
          : strategy === null
            ? 'After costs is the engine’s net: the spread over 7 to 14 days less fees, slippage, the price gap and the rescue reserve.'
            : `At your ${usdWhole(strategy.legUsd)} a side that is about ${money(perDayOnLegs(w, strategy.legUsd))} a day after costs.`}
      </p>
    </>
  );
}

// ---------- gross to net ----------

/** Words for the engine's cost steps as a visitor reads them. */
const COST_WORDS: Readonly<Record<string, string>> = {
  basis: 'Price gap between the venues',
  reserve: 'Reserve kept for rescues',
};

function Costs({ w, legUsd }: { w: FundingWindow; legUsd: number | null }) {
  const wf = useMemo(() => waterfall(w, legUsd), [w, legUsd]);
  const costs = wf.steps.filter((s) => s.key !== 'gross' && s.key !== 'net');
  // The funding the engine netted, so the lines add up: the net plus the costs. A desk pair with its 7 days in is
  // netted on the multi-day basis (the smaller of the 7- and 14-day means when they agree, else the 7 days); any other
  // on this hour's rates (shared Window.netAprPct).
  const { pct: funding, multiDay } = nettedFunding(w);
  const rows: Reading[] = [
    {
      label: multiDay ? 'Funding, 7 to 14 days' : 'Funding this hour',
      value: pct(funding),
      title: multiDay ? 'The smaller of the 7- and 14-day averages when they agree, else the last 7 days' : undefined,
    },
    ...costs.map((s): Reading => ({ label: COST_WORDS[s.key] ?? s.label, value: stepValue(s.key, s.value), kind: 'sub' })),
    { label: 'Net', value: pct(w.netAprPct), tone: w.netAprPct < 0 ? 'down' : null, kind: 'tot' },
  ];
  return (
    <>
      <Readings rows={rows} className="lead" shut />
      <p className="pn-foot">
        {w.netAprPct > 0 ? `Opening and closing it is earned back in about ${hours(w.breakevenHours)}. ` : ''}
        {usd(w.usdPerDayPer1k)} a day on each $1,000 a side.
      </p>
    </>
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
    <div className="w-cta" data-testid="decision-line">
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
