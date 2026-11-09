// A holding period in words (brand book C, Journal): the sentence that opens the Journal while a pair is held, and the
// facts the period unfolds to. Every number comes from the journal's own hold checks (`hoursHeld`, `heldNetAprPct`,
// `badChecks`, `exitAfterChecks`, `pnlUsd`) or from the desk's P&L; a fact the engine did not send is left out, never
// guessed. Pure, so the words and colours are tested.
import type { DeskState, JournalEntry } from '@gimbal/shared';
import { moneyTone, type Tone } from '../desk/answer.ts';
import { qty } from '../desk/format.ts';
import { dayMonthTime, duration, pct, venueName } from '../windows/format.ts';
import { clock, numberOf } from './entry.ts';
import { smallUsd, type StoryItem } from './story.ts';

export type HoldItem = Extract<StoryItem, { type: 'hold' }>;
type Incident = Extract<StoryItem, { type: 'incident' }>;

export interface PeriodFact {
  label: string;
  value: string;
  /** Colour on the value: money earned or lost only. */
  tone: Tone;
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const count = (n: number): string => WORDS[n] ?? String(n);

/** `03:08` the same UTC day as now, `8 Nov 03:08` before it. */
function when(ms: number, now: number): string {
  return Math.floor(ms / 86_400_000) === Math.floor(now / 86_400_000) ? clock(ms) : dayMonthTime(ms);
}

const isZero = (usd: number, decimals = 4): boolean => Number(Math.abs(usd).toFixed(decimals)) === 0;

/** `Hyperliquid missed two reads and came back`, `Hyperliquid did not answer at 04:23`: the period's outages. */
export function incidentsText(incidents: readonly Pick<Incident, 't' | 'entry' | 'recovery'>[]): string | null {
  if (incidents.length === 0) return null;
  const venues = [...new Set(incidents.map((i) => venueName(String(i.entry.numbers.venue ?? ''))))];
  const who = venues.length === 1 ? venues[0]! : 'The venues';
  const open = incidents.filter((i) => i.recovery === null).sort((a, b) => b.t - a.t)[0];
  if (open) return `${venueName(String(open.entry.numbers.venue ?? ''))} did not answer at ${clock(open.t)}`;
  return `${who} missed ${count(incidents.length)} ${incidents.length === 1 ? 'read' : 'reads'} and came back`;
}

/**
 * The Journal's sentence while a pair is held: `Holding MON since 03:08. Funding paid +$0.0031; Hyperliquid missed two
 * reads and came back.` Null when no period on the page is ongoing (the screen then says what the contract signed).
 * `fundingUsd` is the desk's own P&L for the held pair (`DeskState.pnl.fundingUsd`), null when it is not known.
 */
export function journalHeadline(items: readonly StoryItem[], fundingUsd: number | null, now: number): string | null {
  const hold = items.find((i): i is HoldItem => i.type === 'hold' && i.ongoing);
  if (!hold) return null;
  const head = `Holding ${hold.symbol} since ${when(hold.from, now)}.`;
  const funding =
    fundingUsd === null || isZero(fundingUsd) ? null : `${fundingUsd < 0 ? 'Funding cost' : 'Funding paid'} ${smallUsd(fundingUsd)}`;
  const incidents = incidentsText(items.filter((i): i is Incident => i.type === 'incident' && i.t >= hold.from));
  const tail = [funding, incidents].filter((p): p is string => p !== null);
  return tail.length === 0 ? head : `${head} ${tail.join('; ')}.`;
}

const isAttested = (e: JournalEntry): boolean => e.numbers.stage === 'attestation' && /verified TDX quote/.test(e.summary);

/**
 * What a holding period unfolds to, in order. `entries` is every entry on the page (for the attestations in the
 * period); `desk` gives the legs and the P&L of the pair held now, used only for the ongoing period.
 */
export function periodFacts(
  item: Pick<HoldItem, 'symbol' | 'from' | 'firstCheck' | 't' | 'checks' | 'ongoing' | 'entries'>,
  { entries, desk, now }: { entries: readonly JournalEntry[]; desk: Pick<DeskState, 'legs' | 'pnl'> | null; now: number },
): PeriodFact[] {
  const facts: PeriodFact[] = [];
  const fact = (label: string, value: string, tone: Tone = null) => facts.push({ label, value, tone });
  const live = item.ongoing && desk !== null && desk.legs.length > 0 ? desk : null;

  if (live) {
    const short = live.legs.find((l) => l.side === 'short');
    const long = live.legs.find((l) => l.side === 'long');
    if (short && long) fact(`Short ${venueName(short.venue)}, long ${venueName(long.venue)}`, `${qty(short.size)} ${item.symbol} a leg`);
  }
  fact('Held for', `${duration((item.ongoing ? now : item.t) - item.from)}${item.ongoing ? ' so far' : ''}`);
  const partial = item.firstCheck - item.from > 10 * 60_000;
  fact('Checks', `${item.checks}${partial ? ` since ${clock(item.firstCheck)}` : ''}, ${item.checks === 1 ? 'it' : 'each one'} held`);

  const nets = item.entries.map((e) => numberOf(e, 'heldNetAprPct')).filter((v): v is number => v !== null);
  if (nets.length > 0) {
    const lo = Math.min(...nets);
    const hi = Math.max(...nets);
    fact('Net a year at those checks', lo === hi ? pct(lo, 1) : `${pct(lo, 1)} to ${pct(hi, 1)}`);
  }
  const newest = item.entries[0];
  const bad = newest ? numberOf(newest, 'badChecks') : null;
  const exit = newest ? numberOf(newest, 'exitAfterChecks') : null;
  if (bad !== null && exit !== null) fact('Checks against it', `${bad} of the ${exit} in a row that would close it`);

  if (live) {
    fact('Funding paid', smallUsd(live.pnl.fundingUsd), moneyTone(live.pnl.fundingUsd, 4));
    fact('Fees', smallUsd(live.pnl.feesUsd));
    fact('Net so far, after fees and price', smallUsd(live.pnl.netUsd), moneyTone(live.pnl.netUsd, 4));
  } else {
    const pnl = newest ? numberOf(newest, 'pnlUsd') : null;
    if (pnl !== null) fact('Net at the last check', smallUsd(pnl), moneyTone(pnl, 4));
  }

  const end = item.ongoing ? now : item.t;
  const attested = entries.filter((e) => e.t >= item.from && e.t <= end && isAttested(e)).length;
  if (attested > 0) fact('Risk model attested', `${attested} ${attested === 1 ? 'time' : 'times'}, a verified TDX quote`);
  return facts;
}
