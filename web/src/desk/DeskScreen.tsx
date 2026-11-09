import { useState } from 'react';
import type { DeskState, JournalEntry, Leg, ScanStatus, StrategyConfig, StrategyDecision, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { clock } from '../journal/entry.ts';
import { latestOf, storyOf, type StoryItem } from '../journal/story.ts';
import { rowOf } from '../journal/model.ts';
import { waitsView } from '../journal/waits.ts';
import { writeControls } from '../remote/readonly.ts';
import { MoneyActions } from '../shell/Header.tsx';
import { VENUE_NAMES, downVenues } from '../shell/status.ts';
import { useStatus } from '../shell/useStatus.ts';
import { useStream } from '../stream/hub.ts';
import { Flash } from '../ui/Flash.tsx';
import { cx } from '../ui/cx.ts';
import { useManualSend } from '../ui/useManualSend.ts';
import { useNow } from '../ui/useNow.ts';
import { pct, usd, venueName } from '../windows/format.ts';
import { bestEnterable, checkLines, deskMissing, hasHistory, heldWindow, sortWindows } from '../windows/model.ts';
import { checksSummary, isOpenToDesk } from '../windows/markets.ts';
import { useStrategy } from '../windows/useEngine.ts';
import { distanceTone, deskAnswer, moneyTone, type DeskAnswer } from './answer.ts';
import { decisionLine } from './decision.ts';
import { elapsed, price, qty, ratioPct, signedUsd, splitUsd } from './format.ts';
import { dayRate, exposureOf, isDown, lastClose, nextBest, nextFunding, paybackOf, placeLegs, pnlRows, thresholdText, valueGaps } from './model.ts';
import './desk.css';

/** The Desk: is the money safe and what does it earn (UX, Desk). */
export function DeskScreen() {
  const desk = useStream((s) => s.desk);
  const windows = useStream((s) => s.windows);
  const scan = useStream((s) => s.scan);
  const journal = useStream((s) => s.journal);
  const health = useStream((s) => s.health);
  const decision = useStream((s) => s.decision);
  const strategy = useStrategy().value;
  const status = useStatus('desk');
  const noDesk = useStream((s) => deskMissing(s.windows));
  const now = useNow(10_000);

  if (desk === null || status === null) return noDesk ? <NoDesk scan={scan} now={now} /> : <DeskLoading />;
  const held = windows ? heldWindow(windows) : null;
  const answer = deskAnswer({ desk, held, view: status.view });
  if (desk.legs.length === 0) return <Flat desk={desk} answer={answer} windows={windows} strategy={strategy} scan={scan} journal={journal} now={now} />;

  const rate = dayRate(held, desk.legs);
  const value = splitUsd(desk.equityUsd);
  const gaps = valueGaps(desk);
  return (
    <div className="dk">
      <section className="dk-hero" aria-label="The desk now">
        <Answer a={answer} />
        <div className="dk-v">
          <span className="fig" data-testid="desk-value">
            <Flash value={desk.equityUsd}>
              {value.dollars}
              <small>{value.cents}</small>
            </Flash>
          </span>
          <p>
            {rate ? (
              <>
                <span className={moneyTone(rate.perDayUsd) ?? undefined}>
                  <Flash value={rate.perDayUsd}>{signedUsd(rate.perDayUsd, Math.abs(rate.perDayUsd) < 0.01 ? 3 : 2)}</Flash> a day
                </span>{' '}
                <span className="g">after costs</span>
              </>
            ) : null}
            <span className="g dk-wide">
              {rate ? ' · ' : ''}
              {usd(desk.reserveUsd)} of it held for rescues
            </span>
          </p>
        </div>
        {gaps === null ? null : <p className="dk-gaps g" data-testid="desk-value-gaps">{gaps}</p>}
        <MoneyActions mode={desk.mode} className="dk-money" />
      </section>

      <Pair desk={desk} held={held} strategy={strategy} down={downVenues(desk, health)} decision={decision} now={now} />

      <div className="dk-lower">
        <div>
          <Payback pnl={desk.pnl} />
          <NextBest windows={windows} strategy={strategy} />
        </div>
        <Latest journal={journal} heldId={held?.id ?? null} heldSymbol={desk.legs[0]?.symbol ?? null} />
      </div>
    </div>
  );
}

/** The sentence; only the rate carries a colour (mint earning, coral losing). */
export function Answer({ a }: { a: DeskAnswer }) {
  return (
    <h1 className="answer wide" data-testid="desk-answer">
      {a.verb === null ? (
        a.rest
      ) : (
        <>
          {a.verb}
          {a.rate === null ? null : (
            <>
              {' '}
              <span className={a.tone ?? undefined}>{a.rate}</span>
            </>
          )}
          {a.rest}
        </>
      )}
    </h1>
  );
}

// ---------- the held pair ----------

interface PairProps {
  desk: DeskState;
  held: FundingWindow | null;
  strategy: StrategyConfig | null;
  down: readonly VenueId[];
  decision: StrategyDecision | null;
  now: number;
}

const legName = (leg: Leg): string => `${leg.side === 'short' ? 'Short' : 'Long'} ${VENUE_NAMES[leg.venue]} ${qty(Math.abs(leg.size))}`;

/** The held pair as one row; tapped, it unfolds the details of both legs. Close sits on it, for the owner. */
function Pair({ desk, held, strategy, down, decision, now }: PairProps) {
  const [open, setOpen] = useState(false);
  const { left, right } = placeLegs(desk.legs);
  const legs = [left, right].filter((l): l is Leg => l !== null);
  const symbol = held?.symbol ?? legs[0]?.symbol ?? '';
  const exposure = exposureOf(desk);
  const risk = strategy?.risk ?? null;
  const since = held?.held ? `Held since ${clock(held.held.since)}` : 'Held now';

  const distance = (leg: Leg, short = false) => (
    <>
      <span className={isDown(leg, down) ? undefined : (distanceTone(leg.distanceToLiqPct, risk) ?? undefined)}>
        <Flash value={leg.distanceToLiqPct}>{leg.distanceToLiqPct === null ? '—' : pct(leg.distanceToLiqPct, 0)}</Flash>
      </span>{' '}
      {short ? 'from liq.' : 'from liquidation'}
    </>
  );

  return (
    <section className="dk-pair" aria-label="The held pair">
      <div className="dk-row">
        <button type="button" className="c dk-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <b>{symbol}</b>
          <span>{since}</span>
        </button>
        {legs.map((leg) => (
          <div key={leg.venue + leg.side} className={cx('c', isDown(leg, down) && 'dim')}>
            <b>{legName(leg)}</b>
            <span>
              {isDown(leg, down) ? `${VENUE_NAMES[leg.venue]} not answering; figures may be old` : distance(leg)}
              {leg.unpriced ? <span className="wt"> · no price protection</span> : null}
            </span>
          </div>
        ))}
        {legs.length === 1 ? (
          <div className="c">
            <b>One leg only</b>
            <span>The desk is not hedged</span>
          </div>
        ) : null}
        <div className="c">
          <b className={exposure.drift ? 'wt' : undefined}>
            <Flash value={desk.netDelta}>{exposure.text}</Flash>
          </b>
          <span>Net exposure</span>
        </div>
        <div className="c end">
          <ClosePair symbol={symbol} urgent={desk.rescueFailure !== null} />
          <button type="button" className="btn quiet dk-details" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Details'}
            <i className={cx('chev', open && 'u')} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* The phone: the same pair as a short list (brand book C, Desk 390). */}
      <div className="dk-prow">
        <div className="t">
          <b>{symbol}</b>
          <button type="button" className="btn quiet" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Details'}
            <i className={cx('chev', open && 'u')} aria-hidden="true" />
          </button>
        </div>
        {legs.map((leg) => (
          <div key={leg.venue + leg.side} className={cx('kv', isDown(leg, down) && 'dim')}>
            <span>{legName(leg)}</span>
            <span>{isDown(leg, down) ? 'not answering' : distance(leg, true)}</span>
          </div>
        ))}
        <div className="kv">
          <span>Net exposure</span>
          <span className={exposure.drift ? 'wt' : undefined}>{exposure.text}</span>
        </div>
      </div>

      {/* Folded, the block is inert: nothing in it (the phone's Close) can be focused or clicked while it is invisible. */}
      <div className={cx('dk-legs', !open && 'shut')} aria-hidden={!open} inert={!open}>
        {legs.map((leg) => (
          <LegDetails key={leg.venue + leg.side} leg={leg} now={now} />
        ))}
        <div className="dk-legnotes">
          <p className="g">{exposure.explain}</p>
          {thresholdText(risk) ? <p className="g">{thresholdText(risk)}</p> : null}
          <Decision decision={decision} now={now} minNetAprPct={strategy?.minNetAprPct ?? null} />
        </div>
        <div className="dk-pnl">
          <h4>The pair so far</h4>
          {pnlRows(desk.pnl).map((r) => (
            <div key={r.key} className={cx('kv', r.key === 'net' && 'tot')}>
              <span>{r.label}</span>
              {/* Fees and the price move are expected costs: neutral. Funding received and the net carry their state. */}
              <span className={r.key === 'funding' || r.key === 'net' ? (moneyTone(r.key === 'net' ? desk.pnl.netUsd : desk.pnl.fundingUsd) ?? undefined) : undefined}>
                <Flash value={r.value} />
              </span>
            </div>
          ))}
        </div>
        <div className="dk-close-phone">
          <ClosePair symbol={symbol} urgent={desk.rescueFailure !== null} />
        </div>
      </div>
    </section>
  );
}

function LegDetails({ leg, now }: { leg: Leg; now: number }) {
  const rows: [string, string][] = [
    ['Entry', price(leg.entry)],
    ['Mark', price(leg.mark)],
    ['Liquidation price', leg.liqPx === null ? '—' : price(leg.liqPx)],
    ['Margin', usd(leg.marginUsd)],
    ['Margin ratio', ratioPct(leg.marginRatio)],
    ['Funding', signedUsd(leg.fundingEarnedUsd + leg.unsettledFundingUsd, 4)],
    ['Fees', signedUsd(leg.feesUsd, 4)],
    ['Next funding', nextFunding(leg.venue, now)],
  ];
  return (
    <div>
      <h4>
        {leg.side === 'short' ? 'Short' : 'Long'} {VENUE_NAMES[leg.venue]} · {qty(Math.abs(leg.size))} {leg.symbol}
      </h4>
      {leg.unpriced ? <p className="wt dk-flag">Opened without an oracle price band (no price protection)</p> : null}
      {rows.map(([label, value]) => (
        <div key={label} className="kv">
          <span>{label}</span>
          <span>
            <Flash value={value} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** What the strategy loop decided last, in plain words. A check whose numbers were stale says nothing new: it is left out. */
function Decision({ decision, now, minNetAprPct }: { decision: StrategyDecision | null; now: number; minNetAprPct: number | null }) {
  const line = decisionLine(decision, now, { minNetAprPct });
  if (line === null || /stale|out of date/.test(line.raw)) return null;
  return (
    <p className="g" data-testid="decision-line">
      Last decision, {line.when}: <span className="dk-ink">{line.reason}</span>
    </p>
  );
}

/**
 * Close both legs, for the owner (POST /close), asked in place; the engine's answer stays next to it. `urgent`: a rescue
 * could not finish and the owner is needed, so Close is the filled button.
 */
export function ClosePair({ symbol, urgent = false }: { symbol: string; urgent?: boolean }) {
  const can = writeControls().close;
  const send = useManualSend(can ? { kind: 'close', symbol } : null);
  if (!can) return null;
  if (send.asking) {
    return (
      <span className="dk-ask dk-confirm" role="alertdialog" aria-label="Close both legs now?">
        <b>Close both legs now?</b>
        <span>
          The engine closes both {symbol} legs with reduce-only orders. A reduce-only order passes even a paused desk; the contract still checks
          its price.
        </span>
        <span className="row">
          <button type="button" className="btn primary" onClick={send.confirm}>Close pair</button>
          <button type="button" className="btn quiet" onClick={send.cancel}>Cancel</button>
        </span>
      </span>
    );
  }
  return (
    <span className="dk-ask">
      {send.sending ? <span className="g" role="status">Sending…</span> : null}
      {send.outcome ? (
        <span className={send.outcome.tone === 'sent' ? undefined : 'wt'} role="status">
          {send.outcome.title}: {send.outcome.text}
        </span>
      ) : null}
      <button type="button" className={cx('btn', urgent && 'primary')} disabled={send.sending} onClick={send.ask}>Close pair</button>
    </span>
  );
}

// ---------- under the pair ----------

/** Entry costs earned back: funding received against fees and the entry basis. Only figures the desk reports. */
function Payback({ pnl }: { pnl: DeskState['pnl'] }) {
  const p = paybackOf(pnl, null);
  const costs = Math.max(0, -pnl.feesUsd) + Math.max(0, -pnl.priceUsd);
  const earned = Math.max(0, pnl.fundingUsd);
  return (
    <section className="dk-payback" aria-label="Entry costs earned back">
      <div className="hd">
        <span>Entry costs earned back</span>
        <span>{costs <= 0 ? 'no costs yet' : `${signedUsd(Math.min(earned, costs), 4).replace('+', '')} of ${usd(costs, 4)}`}</span>
      </div>
      {/* No cost yet: nothing to earn back, so no figure and no bar. */}
      {costs <= 0 ? null : (
        <>
          <b className="dk-big">{p.pct}%</b>
          <div className="bar" role="progressbar" aria-label="Entry costs earned back" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.pct}>
            <i style={{ width: `${p.pct}%` }} />
          </div>
        </>
      )}
    </section>
  );
}

function NextBest({ windows, strategy }: { windows: readonly FundingWindow[] | null; strategy: StrategyConfig | null }) {
  const next = windows ? nextBest(windows, strategy) : null;
  const w = next && windows ? windows.find((x) => x.symbol === next.symbol && !x.held && x.netAprPct === next.netAprPct) : null;
  // None passes every check: the best one Markets lists as open still shows, with how its checks stand.
  const open = !next && windows ? (sortWindows(windows.filter((x) => x.held === null && isOpenToDesk(x) && hasHistory(x)))[0] ?? null) : null;
  return (
    <section className="dk-next" aria-label="Next best market">
      <div className="hd">
        <span>Next best market</span>
        <a href="#/markets">
          Markets<i className="chev r" aria-hidden="true" />
        </a>
      </div>
      {windows === null ? (
        <p className="g dk-none">Reading the markets…</p>
      ) : next && w ? (
        <a className="next" href={`#/markets/${encodeURIComponent(w.id)}`} title={next.text}>
          <b>{next.symbol}</b>
          <span>
            {pct(next.netAprPct, 0)} a year <span className="g">· short {venueName(w.shortVenue)}, long {venueName(w.longVenue)}</span>
          </span>
        </a>
      ) : open ? (
        <a className="next" href={`#/markets/${encodeURIComponent(open.id)}`}>
          <b>{open.symbol}</b>
          <span>
            {pct(open.netAprPct, 0)} a year <span className="g">· {checksSummary(checkLines(open))}</span>
          </span>
        </a>
      ) : (
        <p className="g dk-none">No other market is open to the desk right now.</p>
      )}
    </section>
  );
}

/** One story line in a short form: the Desk's Latest. */
export function storyLine(item: StoryItem): string {
  switch (item.type) {
    case 'hold':
    case 'incident':
    case 'funding':
      return item.text;
    case 'waits':
      return waitsView(item.entries).latest.text;
    case 'entry':
      return rowOf(item.entry).summary;
  }
}

function Latest({ journal, heldId, heldSymbol }: { journal: readonly JournalEntry[]; heldId: string | null; heldSymbol: string | null }) {
  const lines = latestOf(storyOf(journal, heldId, heldSymbol));
  return (
    <section className="dk-latest" aria-label="Latest">
      <div className="hd">
        <span>Latest</span>
        <a href="#/journal">
          Journal<i className="chev r" aria-hidden="true" />
        </a>
      </div>
      {lines.length === 0 ? <p className="g dk-none">Nothing yet. What the desk does shows up here.</p> : null}
      {lines.map((item) => (
        <div key={item.id} className="jl">
          <span>{clock(item.t)}</span>
          <span>{storyLine(item)}</span>
        </div>
      ))}
    </section>
  );
}

// ---------- no pair, no desk, loading ----------

interface FlatProps {
  desk: DeskState;
  answer: DeskAnswer;
  windows: readonly FundingWindow[] | null;
  strategy: StrategyConfig | null;
  scan: ScanStatus | null;
  journal: readonly JournalEntry[];
  now: number;
}

/** No pair held: the desk value, what it waits for, the best market against the owner's minimum, the last close. */
function Flat({ desk, answer, windows, strategy, scan, journal, now }: FlatProps) {
  const best = windows ? bestEnterable(windows) : null;
  const closed = lastClose(journal, now);
  const minimum = strategy?.minNetAprPct ?? null;
  const value = splitUsd(desk.equityUsd);
  const gaps = valueGaps(desk);
  return (
    <div className="dk">
      <section className="dk-hero" aria-label="The desk now">
        <Answer a={answer} />
        <div className="dk-v">
          <span className="fig" data-testid="desk-value">
            <Flash value={desk.equityUsd}>
              {value.dollars}
              <small>{value.cents}</small>
            </Flash>
          </span>
          <p className="g">
            {strategy?.auto === false
              ? 'in the desk’s accounts, earning nothing: Auto is off, so the desk opens nothing by itself'
              : 'in the desk’s accounts, earning nothing until a market pays at least the minimum'}
          </p>
        </div>
        {gaps === null ? null : <p className="dk-gaps g" data-testid="desk-value-gaps">{gaps}</p>}
        {closed === null ? null : (
          <p className="dk-gaps g" data-testid="desk-last-close">
            Last pair closed {closed.when}: both legs are flat, <span className={moneyTone(closed.netUsd) ?? undefined}>{signedUsd(closed.netUsd)}</span>{' '}
            realized after funding, fees and price. The closing line is in the <a href="#/journal">Journal</a>.
          </p>
        )}
        <MoneyActions mode={desk.mode} className="dk-money" />
      </section>
      <div className="dk-lower">
        <section className="dk-facts" aria-label="Against your minimum">
          <div className="kv">
            <span>Best market open to the desk</span>
            <span>{best ? `${best.symbol} ${pct(best.netAprPct)}` : '—'}</span>
          </div>
          <div className="kv">
            <span>Your minimum, after costs</span>
            <span>{minimum === null ? '—' : pct(minimum, Number.isInteger(minimum) ? 0 : 1)}</span>
          </div>
          <div className="kv">
            <span>Last scan</span>
            <span>{scan ? `${elapsed(now - scan.at)} ago, ${scan.venues} venues` : '—'}</span>
          </div>
          <NextBest windows={windows} strategy={strategy} />
        </section>
        <Latest journal={journal} heldId={null} heldSymbol={null} />
      </div>
    </div>
  );
}

/** The engine runs but no desk is loaded (it refuses every desk window with E_NO_DESK). */
function NoDesk({ scan, now }: { scan: ScanStatus | null; now: number }) {
  return (
    <div className="dk">
      <section className="dk-hero">
        <h1 className="answer wide">No desk yet.</h1>
        <p className="dk-lead g">
          The engine is reading funding{scan ? ` on ${scan.venues} venues, ${elapsed(now - scan.at)} ago` : ''}, but no desk is loaded, so there are no legs,
          margin or value to show.
        </p>
        <p className="dk-lead">
          <a href="#/markets">
            See the markets<i className="chev r" aria-hidden="true" />
          </a>
        </p>
      </section>
    </div>
  );
}

/** Loading: the frame of the screen, still (no shimmer), so nothing jumps when the desk arrives. */
function DeskLoading() {
  return (
    <div className="dk" aria-busy="true" aria-label="Loading the desk">
      <section className="dk-hero">
        <i className="d-sk" style={{ width: '60%', height: 64 }} />
        <i className="d-sk" style={{ width: '40%', height: 64, marginTop: 8 }} />
        <i className="d-sk" style={{ width: 220, height: 48, marginTop: 40 }} />
      </section>
    </div>
  );
}

// Kept for other screens that name a leg the same way.
export { legName };
