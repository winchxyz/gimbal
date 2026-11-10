import type { ReactNode } from 'react';
import type { DeskState, JournalEntry, Leg, ScanStatus, StrategyConfig, StrategyDecision, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { clock } from '../journal/entry.ts';
import { heldSymbolOf, latestOf, storyOf, type StoryItem } from '../journal/story.ts';
import { rowOf } from '../journal/model.ts';
import { waitsView } from '../journal/waits.ts';
import { writeControls } from '../remote/readonly.ts';
import { MoneyActions } from '../shell/Header.tsx';
import { VENUE_NAMES, downVenues, joinNames } from '../shell/status.ts';
import { useStatus } from '../shell/useStatus.ts';
import { useStream } from '../stream/hub.ts';
import { Flash } from '../ui/Flash.tsx';
import { KeysFlow } from '../ui/KeysFlow.tsx';
import { Panel, Readings, type Reading } from '../ui/Panel.tsx';
import { RateChart } from '../ui/RateChart.tsx';
import { cx } from '../ui/cx.ts';
import { useManualSend } from '../ui/useManualSend.ts';
import { useNow } from '../ui/useNow.ts';
import { pct, tidy, usd } from '../windows/format.ts';
import { deskMissing, heldWindow } from '../windows/model.ts';
import { retryHistory, useHistories, useStrategy } from '../windows/useEngine.ts';
import { distanceTone, deskAnswer, moneyTone, answerText, type DeskAnswer } from './answer.ts';
import { decisionLine } from './decision.ts';
import { conditionsOf, coolDownOf, COOLDOWN_HOURS, marketsNote, marketsPlot, waitedFor } from './flat.ts';
import { elapsed, price, qty, ratioPct, signedUsd } from './format.ts';
import { Corridor, CoolDownLine, MarketsDots, PaybackRuler } from './Instruments.tsx';
import { dayRate, exposureOf, isDown, lastClose, nextFunding, paybackOf, valueGaps } from './model.ts';
import { linesSentence, noRoomText, roomOf, roomSentence, roomTone } from './room.ts';
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
  const shared = { desk, answer, windows, strategy, journal, decision, now };
  if (desk.legs.length === 0) return <Flat {...shared} />;
  return <Held {...shared} held={held} down={downVenues(desk, health)} />;
}

/** The sentence; only the rate carries a colour (mint earning, coral losing). */
export function Answer({ a }: { a: DeskAnswer }) {
  return (
    <h1 className={cx('answer', answerText(a).length > 54 && 'long')} data-testid="desk-answer">
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

interface ScreenProps {
  desk: DeskState;
  answer: DeskAnswer;
  windows: readonly FundingWindow[] | null;
  strategy: StrategyConfig | null;
  journal: readonly JournalEntry[];
  decision: StrategyDecision | null;
  now: number;
}

/** The top of the screen: the sentence, and the three readings that back it. */
function Top({ desk, answer, earning }: { desk: DeskState; answer: DeskAnswer; earning: Reading }) {
  const gaps = valueGaps(desk);
  const rows: Reading[] = [
    { label: 'In the desk', value: <Flash value={desk.equityUsd}>{usd(desk.equityUsd)}</Flash>, testId: 'desk-value' },
    earning,
    { label: 'Held for rescues', value: <Flash value={desk.reserveUsd}>{usd(desk.reserveUsd)}</Flash>, title: 'Part of the desk’s value, kept free so a rescue can add margin to a leg.' },
  ];
  return (
    <>
      <div className="top">
        <Answer a={answer} />
        <Readings rows={rows} shut />
      </div>
      {gaps === null ? null : <p className="dk-gaps" data-testid="desk-value-gaps">{gaps}</p>}
    </>
  );
}

// ---------- a pair is held ----------

const legName = (leg: Leg): string => `${leg.side === 'short' ? 'Short' : 'Long'} ${VENUE_NAMES[leg.venue]} ${qty(Math.abs(leg.size))}`;

function Held({ desk, answer, windows, strategy, journal, decision, now, held, down }: ScreenProps & { held: FundingWindow | null; down: readonly VenueId[] }) {
  const risk = strategy?.risk ?? null;
  const minimum = strategy?.minNetAprPct ?? null;
  const symbol = held?.symbol ?? desk.legs[0]?.symbol ?? '';
  const rate = dayRate(held, desk.legs);
  const room = roomOf(desk.legs, risk);
  const silent = desk.legs.filter((l) => isDown(l, down));
  const exposure = exposureOf(desk);
  const earning: Reading = rate
    ? {
        label: rate.perDayUsd < 0 ? 'Losing, after costs' : 'Earning, after costs',
        value: <Flash value={rate.perDayUsd}>{signedUsd(rate.perDayUsd, Math.abs(rate.perDayUsd) < 0.01 ? 3 : 2)} a day</Flash>,
        tone: moneyTone(rate.perDayUsd, 3),
      }
    : { label: 'Earning, after costs', value: '—', title: 'The held market is not in the scan right now, so its rate is not known.' };
  const said = room ? roomSentence(room, risk) : noRoomText(desk.legs);
  const lines = room ? linesSentence(risk) : null;

  return (
    <div className="dk">
      <Top desk={desk} answer={answer} earning={earning} />

      <section className="hero" aria-label="The held pair">
        <div className="cap">
          <span>Room to move</span>
          <span>
            price move from now, {symbol}
            {held?.held ? ` · held since ${clock(held.held.since)} UTC` : ''}
          </span>
        </div>
        {room ? (
          <Corridor room={room} tone={silent.length > 0 ? 'dim' : roomTone(room, risk)} zones={risk !== null} label={said} />
        ) : (
          <p className="ins-msg dk-noroom">{said}</p>
        )}
        <div className="say-row">
          <p className="say">
            {room ? <b>{said}</b> : null}
            {lines ? ` ${lines}` : ''}
            {silent.length > 0 ? ` ${joinNames(silent.map((l) => VENUE_NAMES[l.venue]))} ${silent.length === 1 ? 'is' : 'are'} not answering, so ${silent.length === 1 ? 'its' : 'their'} figures may be old.` : ''}
            {' '}
            Net exposure: <span className={cx('num', exposure.drift && 'watch-t')}><Flash value={desk.netDelta}>{exposure.text}</Flash></span>.
          </p>
          <div className="act">
            <MoneyActions mode={desk.mode} className="dk-money" />
            <ClosePair symbol={symbol} urgent={desk.rescueFailure !== null} />
          </div>
        </div>
        <Decision decision={decision} now={now} minNetAprPct={minimum} />
      </section>

      <div className="pg">
        <Panel title="The two legs" note="as each venue reports them" span={7} className="nw">
          <LegsTable legs={desk.legs} down={down} risk={risk} now={now} />
          <p className="pn-foot">{exposure.explain}</p>
        </Panel>
        <Payback pnl={desk.pnl} perDayUsd={rate?.perDayUsd ?? null} />
        <Markets windows={windows} minimum={minimum} span={7} />
        <Latest journal={journal} heldId={held?.id ?? null} heldSymbol={heldSymbolOf(desk.legs)} />
        <Week w={held} minimum={minimum} span={12} />
        <Keys contract={desk.contract} />
      </div>
    </div>
  );
}

/** Both legs side by side, the long first: it is the one the corridor draws on the left. */
function LegsTable({ legs, down, risk, now }: { legs: readonly Leg[]; down: readonly VenueId[]; risk: StrategyConfig['risk'] | null; now: number }) {
  const ordered = [...legs].sort((a, b) => (a.side === b.side ? 0 : a.side === 'long' ? -1 : 1));
  const rows: [string, (leg: Leg) => ReactNode][] = [
    ['Size', (l) => `${qty(Math.abs(l.size))} ${l.symbol}`],
    ['Entry price', (l) => price(l.entry)],
    ['Price now', (l) => price(l.mark)],
    ['Liquidation price', (l) => (l.liqPx === null ? '—' : price(l.liqPx))],
    [
      'From liquidation',
      (l) => <span className={isDown(l, down) ? undefined : (distanceTone(l.distanceToLiqPct, risk) ?? undefined)}>{l.distanceToLiqPct === null ? '—' : pct(l.distanceToLiqPct)}</span>,
    ],
    ['Margin', (l) => usd(l.marginUsd)],
    ['Margin ratio', (l) => ratioPct(l.marginRatio)],
    ['Funding so far', (l) => signedUsd(l.fundingEarnedUsd + l.unsettledFundingUsd, 4)],
    ['Fees', (l) => signedUsd(l.feesUsd, 4)],
    ['Next funding', (l) => nextFunding(l.venue, now)],
  ];
  return (
    <div className="tb-x">
      <table className="tb dk-legs">
        <thead>
          <tr>
            <th />
            {ordered.map((l) => (
              <th key={l.venue + l.side} scope="col">
                {l.side === 'short' ? 'Short' : 'Long'} · {VENUE_NAMES[l.venue]}
                {isDown(l, down) ? <small>not answering</small> : null}
                {l.unpriced ? <small className="watch-t">no price protection</small> : null}
              </th>
            ))}
            {ordered.length === 1 ? <th scope="col" className="watch-t">The other leg is not open</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, cell]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {ordered.map((l) => {
                const value = cell(l);
                return (
                  <td key={l.venue + l.side} className={isDown(l, down) ? 'g' : undefined}>
                    <Flash value={typeof value === 'string' ? value : l.distanceToLiqPct}>{value}</Flash>
                  </td>
                );
              })}
              {ordered.length === 1 ? <td className="g">—</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What the strategy loop decided last, in plain words. A check whose numbers were stale says nothing new: it is left out. */
function Decision({ decision, now, minNetAprPct }: { decision: StrategyDecision | null; now: number; minNetAprPct: number | null }) {
  const line = decisionLine(decision, now, { minNetAprPct });
  if (line === null || /stale|out of date/.test(line.raw)) return null;
  return (
    <p className="dk-dec" data-testid="decision-line">
      Last decision, {line.when}: <span>{tidy(line.reason)}</span>
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
        <span className={send.outcome.tone === 'sent' ? undefined : 'watch-t'} role="status">
          {send.outcome.title}: {send.outcome.text}
        </span>
      ) : null}
      <button type="button" className={cx('btn', urgent && 'primary')} disabled={send.sending} onClick={send.ask}>Close pair</button>
    </span>
  );
}

// ---------- the panels ----------

/** The opening cost earned back: funding received against fees and the price difference between the legs. */
function Payback({ pnl, perDayUsd }: { pnl: DeskState['pnl']; perDayUsd: number | null }) {
  const p = paybackOf(pnl, perDayUsd);
  const costs = Math.max(0, -pnl.feesUsd) + Math.max(0, -pnl.priceUsd);
  const earned = Math.max(0, pnl.fundingUsd);
  const rows: Reading[] = [
    { label: 'Funding received', value: signedUsd(pnl.fundingUsd, 4), tone: moneyTone(pnl.fundingUsd, 4) },
    { label: 'Trading fees', value: signedUsd(pnl.feesUsd, 4) },
    { label: 'Price difference between the legs', value: signedUsd(pnl.priceUsd, 4) },
    { label: 'Net so far', value: signedUsd(pnl.netUsd, 4), tone: moneyTone(pnl.netUsd, 4), kind: 'tot' },
  ];
  const rest = p.earnedBack
    ? 'From here the funding is profit.'
    : p.hoursLeft === null
      ? ''
      : `About ${Math.ceil(p.hoursLeft)} more ${Math.ceil(p.hoursLeft) === 1 ? 'hour' : 'hours'} at the rate it pays now.`;
  return (
    <Panel title="Opening cost earned back" note={costs <= 0 ? 'no cost yet' : `${usd(Math.min(earned, costs), 4)} of ${usd(costs, 4)}`} span={5} className="nw">
      {/* No cost yet: nothing to earn back, so no figure and no ruler. */}
      {costs <= 0 ? null : (
        <>
          <div className="big">
            <b>{p.pct}%</b>
            <span>of what it cost to open the pair has come back as funding. {rest}</span>
          </div>
          <PaybackRuler pct={p.pct} />
        </>
      )}
      <Readings rows={rows} shut className={costs <= 0 ? 'lead' : undefined} />
    </Panel>
  );
}

function Markets({ windows, minimum, span }: { windows: readonly FundingWindow[] | null; minimum: number | null; span: 7 | 12 }) {
  const plot = windows ? marketsPlot(windows, minimum) : null;
  return (
    <Panel title="Markets against your minimum" note={<a href="#/markets">{plot ? `${marketsNote(plot, minimum)} · ` : ''}all markets<i className="chev r" aria-hidden="true" /></a>} span={span}>
      {plot === null ? (
        <p className="pn-none">Reading the markets…</p>
      ) : plot.rows.length === 0 ? (
        <p className="pn-none">No market is open to the desk right now. The scanner still lists every pair it reads.</p>
      ) : (
        <>
          <MarketsDots plot={plot} minimum={minimum} />
          <p className="pn-foot">Net a year after fees and price impact, for the pairs the desk may open. A row opens the pair.</p>
        </>
      )}
    </Panel>
  );
}

/** One market's net rate over seven days, hour by hour. */
function Week({ w, minimum, span }: { w: FundingWindow | null; minimum: number | null; span: 7 | 12 }) {
  const histories = useHistories(w ? [w.id] : []);
  if (w === null) return null;
  const entry = histories[w.id];
  return (
    <Panel title={`${w.symbol}, net a year`} note="hourly, last 7 days" span={span} className="nw">
      <RateChart
        label={`${w.symbol}, net a year over 7 days`}
        points={entry?.history?.points ?? null}
        status={entry?.status ?? 'loading'}
        minimum={minimum}
        held={w.held ? { from: w.held.since, to: null } : null}
        onRetry={() => retryHistory(w.id)}
      />
      <p className="pn-foot">
        {w.held ? 'The green hours are the time the desk has held it. ' : ''}
        {minimum === null ? '' : `The dotted line is your ${Number(minimum.toFixed(1))}% minimum.`}
      </p>
    </Panel>
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
  const lines = latestOf(storyOf(journal, heldId, heldSymbol), 4);
  return (
    <Panel title="Latest" note={<a href="#/journal">Journal<i className="chev r" aria-hidden="true" /></a>} span={5}>
      {lines.length === 0 ? (
        <p className="pn-none">Nothing yet. What the desk does shows up here.</p>
      ) : (
        <ul className="log">
          {lines.map((item) => (
            <li key={item.id}>
              <time>{clock(item.t)}</time>
              <p>{tidy(storyLine(item))}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Keys({ contract }: { contract: string }) {
  return (
    <Panel title="Keys" note={<a href="#/safety">how an order gets signed · Safety<i className="chev r" aria-hidden="true" /></a>}>
      <KeysFlow contract={contract} />
    </Panel>
  );
}

// ---------- no pair, no desk, loading ----------

/** No pair held: when the next one can open and what it waits for, the markets against the minimum, the last close. */
function Flat({ desk, answer, windows, strategy, journal, decision, now }: ScreenProps) {
  const minimum = strategy?.minNetAprPct ?? null;
  const cool = coolDownOf(decision, journal, now);
  const conds = conditionsOf({ decision, windows: windows ?? [], strategy, cool, now });
  const waited = windows ? waitedFor(decision, windows) : null;
  const closed = lastClose(journal, now);
  const plot = windows ? marketsPlot(windows, minimum) : null;

  return (
    <div className="dk">
      <Top desk={desk} answer={answer} earning={{ label: 'Earning while it waits', value: `${usd(0)} a day` }} />

      <section className="hero" aria-label="The next pair">
        {cool ? (
          <>
            <div className="cap">
              <span>The next pair</span>
              <span>{COOLDOWN_HOURS}-hour cool-down after the last exit, UTC</span>
            </div>
            <CoolDownLine cool={cool} now={now} />
          </>
        ) : (
          <>
            <div className="cap">
              <span>The next pair</span>
              <span>{plot ? marketsNote(plot, minimum) : 'reading the markets'} · net a year after costs</span>
            </div>
            {plot === null ? (
              <p className="ins-msg dk-noroom">Reading the markets…</p>
            ) : plot.rows.length === 0 ? (
              <p className="ins-msg dk-noroom">No market is open to the desk right now. The scanner still lists every pair it reads.</p>
            ) : (
              <MarketsDots plot={plot} minimum={minimum} />
            )}
          </>
        )}
        <ol className={cx('conds', `n${conds.length}`)} aria-label="Before the desk opens the next pair">
          {conds.map((c) => (
            <li key={c.text} className={c.done ? 'done' : undefined}>
              <i aria-hidden="true">{c.done ? '✓' : ''}</i>
              <b>{c.value}</b>
              <span>{c.text}</span>
            </li>
          ))}
        </ol>
        <div className="say-row">
          <p className="say">
            The money sits in the desk’s own exchange accounts and earns nothing until a pair is open.
            {closed === null ? null : (
              <span data-testid="desk-last-close">
                {' '}The last pair closed {closed.when} with <span className={cx('num', moneyTone(closed.netUsd))}>{signedUsd(closed.netUsd)}</span> after funding, fees
                and price; its closing line is in the <a href="#/journal">Journal</a>.
              </span>
            )}
          </p>
          <div className="act">
            <MoneyActions mode={desk.mode} className="dk-money" />
          </div>
        </div>
      </section>

      <div className="pg">
        {cool ? <Markets windows={windows} minimum={minimum} span={7} /> : <Week w={waited} minimum={minimum} span={7} />}
        <Latest journal={journal} heldId={null} heldSymbol={null} />
        {cool ? <Week w={waited} minimum={minimum} span={12} /> : null}
        <Keys contract={desk.contract} />
      </div>
    </div>
  );
}

/** The engine runs but no desk is loaded (it refuses every desk window with E_NO_DESK). */
function NoDesk({ scan, now }: { scan: ScanStatus | null; now: number }) {
  return (
    <div className="dk">
      <div className="top">
        <h1 className="answer">No desk yet.</h1>
      </div>
      <section className="hero">
        <p className="say dk-first">
          The engine is reading funding{scan ? ` on ${scan.venues} venues, ${elapsed(now - scan.at)} ago` : ''}, but no desk is loaded, so there are no legs,
          margin or value to show.{' '}
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
      <div className="top">
        <div>
          <i className="sk-line" style={{ width: '70%', height: 60 }} />
          <i className="sk-line" style={{ width: '46%', height: 60, marginTop: 8 }} />
        </div>
        <div>
          <i className="sk-line" style={{ marginTop: 12 }} />
          <i className="sk-line" style={{ marginTop: 26 }} />
          <i className="sk-line" style={{ marginTop: 26 }} />
        </div>
      </div>
      <section className="hero">
        <i className="sk-line" style={{ height: 176 }} />
      </section>
    </div>
  );
}

// Kept for other screens that name a leg the same way.
export { legName };
