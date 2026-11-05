// What the Journal screen shows, worked out from the entries the engine sent. Pure functions, so the rules in
// design/HANDOFF.md (Journal) are tested without a browser.
import type { DeskState, JournalEntry, Window as FundingWindow } from '@gimbal/shared';
import { signedUsd } from '../desk/format.ts';
import { dayRate, paybackOf } from '../desk/model.ts';
import { dayMonth, dayMonthTime, hours, venueName } from '../windows/format.ts';
import { heldWindow } from '../windows/model.ts';
import { amountUsd, clock, feeUsd, numberOf, proofLinks, unprotectedText, type ProofLink } from './entry.ts';
import { KINDS, inFilter, type FilterId, type Kind, type Tone } from './kinds.ts';

const DAY_MS = 86_400_000;

// ---------- the list of entries ----------

/**
 * The entries the engine read (`GET /state`, and the older pages after it) and the ones that arrived on the stream
 * since, newest first, one per id. The stream's copy wins: it is the later one. A reconnect can resend entries the
 * page already has. Nothing is cut: a reader who asked for older pages keeps them, and the engine holds a bounded few thousand.
 */
export function mergeEntries(loaded: readonly JournalEntry[], live: readonly JournalEntry[]): JournalEntry[] {
  const byId = new Map<string, JournalEntry>();
  for (const e of loaded) byId.set(e.id, e);
  for (const e of live) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.t - a.t); // the sort is stable: entries at the same time keep their order
}

export const entriesIn = (entries: readonly JournalEntry[], filter: FilterId): JournalEntry[] =>
  filter === 'all' ? [...entries] : entries.filter((e) => inFilter(e.kind, filter));

/** The number beside each filter. */
export function filterCounts(entries: readonly JournalEntry[]): Record<FilterId, number> {
  const counts: Record<FilterId, number> = { all: entries.length, trades: 0, funding: 0, money: 0, rescue: 0, refused: 0 };
  for (const e of entries) {
    const filter = KINDS[e.kind].filter;
    if (filter !== null) counts[filter] += 1;
  }
  return counts;
}

/**
 * Live updates (design/HANDOFF.md, Journal): while the reader is scrolled down, the page keeps the entries it
 * showed (`frozen`, a set of ids) and only counts the new ones, so nothing moves under them.
 * `frozen` null = the reader is at the top and sees everything.
 *
 * Only an entry newer than everything the reader was shown waits. One older than that is a page they asked for
 * (`GET /journal?before=`) and belongs at the bottom, where it moves nothing, so it shows at once.
 */
export function visibleFeed(entries: readonly JournalEntry[], frozen: ReadonlySet<string> | null): { shown: JournalEntry[]; pending: number } {
  if (frozen === null) return { shown: [...entries], pending: 0 };
  let newest = -Infinity;
  for (const e of entries) if (frozen.has(e.id) && e.t > newest) newest = e.t;
  const shown = entries.filter((e) => frozen.has(e.id) || e.t < newest);
  return { shown, pending: entries.length - shown.length };
}

// ---------- money ----------

/**
 * What an entry adds to profit and loss. A deposit or a withdrawal moves principal, so only its fee counts
 * (design/HANDOFF.md: day totals are P&L only, transfers of principal are excluded).
 */
export function pnlOf(entry: JournalEntry): number {
  if (KINDS[entry.kind].principal) return feeUsd(entry) ?? 0;
  if (entry.kind === 'rescue') return rescueCostUsd(entry);
  return amountUsd(entry) ?? 0;
}

/**
 * A rescue's cost: its `usd`; the engine's own rescue lines carry `usd: 0` and a fee in `feeUsd`. Each fee counts once:
 * Hyperliquid's withdrawal fee on its hl_withdraw line (no `amountUsd`, it moves to the desk's own address), and the
 * 1Click transfer's fee on the line that says it landed (`landedS`). The line that sent the transfer repeats that fee as
 * quoted (`amountUsd`, no `landedS`: `isQuotedFee`) and is not counted.
 */
export function rescueCostUsd(entry: JournalEntry): number {
  const usd = amountUsd(entry) ?? 0;
  if (usd !== 0) return usd;
  const landed = numberOf(entry, 'landedS') !== null;
  if (!landed && numberOf(entry, 'amountUsd') !== null) return 0;
  return feeUsd(entry) ?? 0;
}

/** A rescue line whose fee is the transfer's quote, counted when it lands (see rescueCostUsd). */
export function isQuotedFee(entry: JournalEntry): boolean {
  const fee = feeUsd(entry);
  return entry.kind === 'rescue' && fee !== null && fee !== 0 && (amountUsd(entry) ?? 0) === 0
    && numberOf(entry, 'landedS') === null && numberOf(entry, 'amountUsd') !== null;
}

// ---------- days ----------

export interface DayGroup {
  /** UTC day number: `Math.floor(t / 86 400 000)`. */
  day: number;
  /** `Today · 27 Oct`, `26 Oct` */
  label: string;
  /** Profit and loss of the entries listed under it. */
  totalUsd: number;
  entries: JournalEntry[];
}

/** `Today · 27 Oct` for today (UTC), else `26 Oct`; the year only when it is not this one. */
export function dayLabel(t: number, now: number): string {
  const today = Math.floor(t / DAY_MS) === Math.floor(now / DAY_MS);
  const base = dayMonth(t);
  if (today) return `Today · ${base}`;
  return new Date(t).getUTCFullYear() === new Date(now).getUTCFullYear() ? base : `${base} ${new Date(t).getUTCFullYear()}`;
}

/** Entries, newest first, grouped by the UTC day they happened on, each day with its P&L total. */
export function groupByDay(entries: readonly JournalEntry[], now: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const day = Math.floor(entry.t / DAY_MS);
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.entries.push(entry);
      last.totalUsd += pnlOf(entry);
    } else {
      groups.push({ day, label: dayLabel(entry.t, now), totalUsd: pnlOf(entry), entries: [entry] });
    }
  }
  return groups;
}

/** How many days the feed lists before the rest folds into one line. */
export const DAYS_SHOWN = 4;

export interface Fold {
  /** `21–23 Oct` */
  range: string;
  count: number;
  /** `11 earlier events: 1 deposit, 1 open, 9 funding payments` */
  summary: string;
  groups: DayGroup[];
}

/** `21 Oct`, `21–23 Oct`, `28 Sep – 3 Oct` */
export function dayRange(first: number, last: number): string {
  const a = new Date(Math.min(first, last));
  const b = new Date(Math.max(first, last));
  const same = (x: Date, y: Date) => x.getUTCFullYear() === y.getUTCFullYear() && x.getUTCMonth() === y.getUTCMonth();
  if (same(a, b) && a.getUTCDate() === b.getUTCDate()) return dayMonth(a.getTime());
  if (same(a, b)) return `${a.getUTCDate()}–${dayMonth(b.getTime())}`;
  return `${dayMonth(a.getTime())} – ${dayMonth(b.getTime())}`;
}

/** The first `DAYS_SHOWN` days, and the older ones as one line the reader can open. */
export function foldOlder(groups: readonly DayGroup[], keep = DAYS_SHOWN): { shown: DayGroup[]; fold: Fold | null } {
  if (groups.length <= keep) return { shown: [...groups], fold: null };
  const older = groups.slice(keep);
  const entries = older.flatMap((g) => g.entries);
  // oldest first, so the line reads as what happened: the deposit, the open, then the funding that followed
  const counts = new Map<Kind, number>();
  for (const e of [...entries].reverse()) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const parts = [...counts.entries()].map(([kind, n]) => `${n} ${KINDS[kind].noun[n === 1 ? 0 : 1]}`);
  const first = older[older.length - 1];
  const last = older[0];
  if (!first || !last) return { shown: [...groups], fold: null };
  const range = dayRange(first.day * DAY_MS, last.day * DAY_MS);
  return {
    shown: groups.slice(0, keep),
    fold: { range, count: entries.length, summary: `${entries.length} earlier ${entries.length === 1 ? 'event' : 'events'}: ${parts.join(', ')}`, groups: older },
  };
}

// ---------- one row ----------

export interface RowView {
  id: string;
  kind: Kind;
  /** `14:00` */
  time: string;
  /** `27 Oct 14:00 UTC`, for the hover text: the screen shows UTC without saying so. */
  timeTitle: string;
  label: string;
  tone: Tone | null;
  summary: string;
  /** The rescue's steps, inline under the summary. */
  steps: string[] | null;
  /** NEAR AI's reason, or the policy rule for a refusal (which has no prefix). */
  why: { prefix: string | null; text: string } | null;
  /** The amber line: an order went out without a price band. */
  flag: string | null;
  amount: { text: string; positive: boolean } | null;
  /** The small grey line under the amount: `fee −$0.14`, `fees`, `after fees`. */
  note: string | null;
  proofs: ProofLink[];
}

const seconds = (s: number): string => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;

/**
 * A rescue's steps as far as the entry says: detected, where the margin came from, the quote, the signature, the
 * landing. A replay signs nothing, so it shows no signature time.
 */
export function stepsOf(entry: JournalEntry, replay = false): string[] | null {
  if (entry.kind !== 'rescue') return null;
  const from = entry.numbers.from;
  const signed = numberOf(entry, 'signedS');
  const landed = numberOf(entry, 'landedS');
  if (typeof from !== 'string' && signed === null && landed === null) return null;
  const steps = ['detected'];
  if (typeof from === 'string' && from.length > 0) steps.push(`source: ${from === 'reserve' ? 'reserve' : venueName(from)}`);
  if (signed !== null || landed !== null) steps.push('quote ✓');
  if (signed !== null && !replay) steps.push(`signed ${seconds(signed)}`);
  if (landed !== null) steps.push(`landed ${seconds(landed)}`);
  return steps;
}

/** The reason line. A refusal's is the policy rule, so it does not say NEAR AI wrote it; the rest are NEAR AI's. */
export function whyOf(entry: JournalEntry): RowView['why'] {
  const text = entry.why?.trim();
  if (!text) return null;
  const named = /^NEAR AI\b/i.test(text);
  return { prefix: entry.kind === 'refused' || named ? null : 'NEAR AI', text };
}

function noteOf(entry: JournalEntry, amount: number | null): string | null {
  if (amount === null) return null;
  const fee = feeUsd(entry);
  if (fee !== null && fee !== 0) return `${isQuotedFee(entry) ? 'quoted fee' : 'fee'} ${signedUsd(fee)}`;
  if (entry.kind === 'enter') return 'fees';
  if (entry.kind === 'exit' || entry.kind === 'rotate') return 'after fees';
  return null;
}

export function rowOf(entry: JournalEntry, { replay = false }: { replay?: boolean } = {}): RowView {
  const info = KINDS[entry.kind];
  const amount = amountUsd(entry);
  return {
    id: entry.id,
    kind: entry.kind,
    time: clock(entry.t),
    timeTitle: `${dayMonthTime(entry.t)} UTC`,
    label: info.label,
    tone: info.tone,
    summary: entry.summary,
    steps: stepsOf(entry, replay),
    why: whyOf(entry),
    flag: unprotectedText(entry),
    // Positive money is green; moving principal is not earning, so a deposit stays plain like a withdrawal.
    amount: amount === null ? null : { text: signedUsd(amount), positive: amount > 0 && !info.principal },
    note: noteOf(entry, amount),
    proofs: proofLinks(entry.tx),
  };
}

// ---------- the side column ----------

export interface Counts {
  /** Entries the contract signed an action for. */
  signed: number;
  /** Refused on sizing, policy or the contract (not the NEAR AI risk check, a held check or a cancelled act). */
  refused: number;
  vetoed: number;
  /** Enters and rotates held because the NEAR AI risk check gave no verdict (no answer, no key, a rejected key). */
  held: number;
}

export function countsOf(entries: readonly JournalEntry[]): Counts {
  let signed = 0;
  let refused = 0;
  let vetoed = 0;
  let held = 0;
  for (const e of entries) {
    if (KINDS[e.kind].signed) signed += 1;
    // The engine journals a held risk check as `refused` with `held: 1`, and an act cancelled before anything was sent
    // (a close or a stop came first, serve stopping) with `cancelled: 1`: neither is a sizing or policy refusal.
    if (e.kind === 'refused' && e.numbers.held === 1) held += 1;
    else if (e.kind === 'refused' && e.numbers.cancelled !== 1) refused += 1;
    if (e.kind === 'veto') vetoed += 1;
  }
  return { signed, refused, vetoed, held };
}

/**
 * The counts over the entries on the page (`visibleFeed`'s `shown`): the number beside each filter and the
 * header's "N actions signed". One set for both, so the header never counts an entry the filters do not.
 */
export function pageCounts(shown: readonly JournalEntry[]): { filters: Record<FilterId, number>; signed: number } {
  return { filters: filterCounts(shown), signed: countsOf(shown).signed };
}

/** `Since 21 Oct`: the oldest entry the page holds. */
export function sinceLabel(entries: readonly JournalEntry[]): string | null {
  const oldest = entries[entries.length - 1];
  return oldest ? `Since ${dayMonth(oldest.t)}` : null;
}

export interface Attribution {
  fundingUsd: number | null;
  feesUsd: number | null;
  basisUsd: number | null;
  /** Rescue costs, app fees, and the fees on deposits and withdrawals: what the desk's own P&L does not count. */
  otherUsd: number;
  netUsd: number | null;
}

/**
 * Where the money went since the start. Funding, fees and price come from the desk's own P&L (`DeskState.pnl`);
 * what the journal adds is the cost of moving money: rescues, app fees and transfer fees. Null until a desk arrives.
 * The desk's P&L covers the legs it holds; a close that carries its realized split (`realizedFundingUsd`,
 * `realizedFeesUsd`, `realizedPriceUsd`: the replay desk's closes do) adds the pair it closed, so the net still agrees
 * with the day totals once the desk is flat.
 */
export function attributionOf(pnl: DeskState['pnl'] | null, entries: readonly JournalEntry[]): Attribution {
  let otherUsd = 0;
  const realized = { fundingUsd: 0, feesUsd: 0, priceUsd: 0 };
  for (const e of entries) {
    const info = KINDS[e.kind];
    if (info.principal) otherUsd += feeUsd(e) ?? 0;
    else if (e.kind === 'rescue') otherUsd += rescueCostUsd(e);
    else if (e.kind === 'fee') otherUsd += amountUsd(e) ?? 0;
    else if (e.kind === 'exit') {
      realized.fundingUsd += numberOf(e, 'realizedFundingUsd') ?? 0;
      realized.feesUsd += numberOf(e, 'realizedFeesUsd') ?? 0;
      realized.priceUsd += numberOf(e, 'realizedPriceUsd') ?? 0;
    }
  }
  return {
    fundingUsd: pnl ? pnl.fundingUsd + realized.fundingUsd : null,
    feesUsd: pnl ? pnl.feesUsd + realized.feesUsd : null,
    basisUsd: pnl ? pnl.priceUsd + realized.priceUsd : null,
    otherUsd,
    netUsd: pnl ? pnl.netUsd + realized.fundingUsd + realized.feesUsd + realized.priceUsd + otherUsd : null,
  };
}

/** The line under the net: where the held window stands against its entry costs. Null when nothing is held. */
export function sinceNote(desk: DeskState, windows: readonly FundingWindow[] | null): string | null {
  const symbol = desk.legs[0]?.symbol;
  if (!symbol) return null;
  const rate = dayRate(windows ? heldWindow(windows) : null, desk.legs);
  const payback = paybackOf(desk.pnl, rate?.perDayUsd ?? null);
  if (payback.earnedBack) return `The ${symbol} window’s entry costs are earned back.`;
  if (payback.hoursLeft !== null) return `The ${symbol} window paid its entry costs up front; about ${hours(Math.ceil(payback.hoursLeft))} until they are earned back.`;
  return `The ${symbol} window paid its entry costs up front; they are not earned back yet.`;
}

/**
 * The headline's count: "23 actions signed", "1 action signed". A replay has no contract and signs nothing: its
 * actions are the engine's own, simulated on recorded prices ("2 simulated actions").
 */
export const actionsText = (n: number, replay = false): string =>
  `${n.toLocaleString('en-US')} ${replay ? 'simulated ' : ''}${n === 1 ? 'action' : 'actions'}${replay ? '' : ' signed'}`;

/** Fees, basis and transfers in one figure, for the phone's summary. */
export const costsUsd = (a: Attribution): number | null => (a.feesUsd === null || a.basisUsd === null ? null : a.feesUsd + a.basisUsd + a.otherUsd);
