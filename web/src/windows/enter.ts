// The public live view owner's entry (`POST /rotate` with `demo`, engine/src/strategy/loop.ts): which windows offer it,
// why one cannot, and the confirm text that says in plain words what will happen. Pure, so every wording is tested.
//
// What a demo entry waives and what it never does (the engine's own check, rotateRefusal): the window's profit checks
// (the carry gate, break-even) are waived; it must still be tradable, not refused by the contract, not stale, not
// refused or held out by the NEAR AI risk check, pass every other check and the policy's markets, be sized within the
// leg size, free margin and the policy's cap, and its round trip may cost at most `maxLossUsd`. The desk must be flat:
// a demo entry never closes a held pair. Auto must be on: with auto off it is disabled here, and the engine refuses it. Every order is still
// checked by the contract against the owner's policy before the MPC network signs it.
//
// How it opens (engine/src/cli/serve-pair.ts): post-only maker orders for the maker window, then a taker fallback, an
// IOC for what is left, its limit held within the price band, the caps and a bound around the mark, then hedged on the
// other venue. Its fee and slippage count in the round trip `maxLossUsd` caps. Only the owner entry falls back; the
// loop's own entries stay maker-only.
//
// While the loop is acting (StrategyDecision.acting) the engine answers every POST /rotate with 409, so Enter is
// disabled on every window, and the entry the owner started shows its result from the Journal once it lands (entryResult).
import type { JournalEntry, Window as FundingWindow } from '@gimbal/shared';
import { capital, sentence, usd } from './format.ts';
import { heldWindow, isNoDesk } from './model.ts';

/** The most an owner entry accepts as its round trip's cost, USD: the engine's cap (engine/src/scanner/carry.ts DEMO_MAX_LOSS_USD). */
export const OWNER_MAX_LOSS_USD = 1;

export type EnterState =
  /** Not offered at all: a watch-only window, or the one held now. */
  | { kind: 'none' }
  /** Offered but disabled, with the reason shown next to it. */
  | { kind: 'blocked'; reason: string }
  | { kind: 'open' };

/** The engine's `acting` for an owner entry (loop.ts #rotateStart: `POST /rotate <id> (owner demo entry, …)`). */
export const isOwnerEntry = (acting: string): boolean => acting.includes('owner demo entry');

/** Whether `acting` is the owner entry on exactly this window (not one whose id merely starts the same). */
export const isOwnerEntryOn = (acting: string, windowId: string): boolean =>
  isOwnerEntry(acting) && acting.startsWith(`POST /rotate ${windowId} (`);

/** Why Enter waits while the loop acts: the owner's own entry, a close, or another act of the engine. */
export function actingText(acting: string): string {
  if (isOwnerEntry(acting)) return 'Your entry is still running. Enter comes back when it ends; watch the Journal.';
  if (acting.startsWith('POST /close')) return 'A close is running. Enter comes back when it ends.';
  return `The engine is acting (${acting}). Enter comes back when it ends.`;
}

/**
 * Whether the owner can ask to enter `w` now, as far as the page can tell (the engine checks again and answers).
 * `acting`: StrategyDecision.acting, what the loop is doing now (null: nothing, or an engine that does not say).
 */
export function enterState(w: FundingWindow, windows: readonly FundingWindow[], auto: boolean | null = null, acting: string | null = null): EnterState {
  if (!w.tradable || w.held) return { kind: 'none' };
  if (acting !== null && acting !== '') return { kind: 'blocked', reason: actingText(acting) };
  const held = heldWindow(windows);
  if (held !== null) return { kind: 'blocked', reason: `${held.symbol} is held. An owner entry opens from flat only: close ${held.symbol} first.` };
  if (auto === false) return { kind: 'blocked', reason: 'Auto is off in the engine rules, and the engine opens nothing while it is off.' };
  if (isNoDesk(w)) return { kind: 'blocked', reason: 'There is no desk to trade it with.' };
  if (w.refused) return { kind: 'blocked', reason: `The contract would refuse it (${w.refused.code}): ${capital(w.refused.reason)}` };
  if (w.stale) return { kind: 'blocked', reason: 'Its numbers are stale: a venue it needs did not answer.' };
  if (w.veto?.verdict === 'veto') return { kind: 'blocked', reason: 'The NEAR AI risk check refused it.' };
  return { kind: 'open' };
}

const money = (n: number): string => `$${n.toFixed(2)}`;
const whole = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * The confirm step: the two legs and their venues, the size per leg, the most the round trip may cost, that the contract
 * still checks every order, and that it opens from flat (a held pair is never closed by it).
 */
export function enterConfirmText(w: FundingWindow, venue: (id: string) => string, legUsd: number | null, maxLossUsd = OWNER_MAX_LOSS_USD): string {
  const size = legUsd === null
    ? 'at the engine rules’ leg size'
    : `up to ${whole(legUsd)} a leg (the engine rules’ leg size; it sizes again on free margin and the policy’s cap)`;
  return [
    `Enter ${w.symbol}: long on ${venue(w.longVenue)} and short on ${venue(w.shortVenue)}, ${size}.`,
    `An owner entry skips the profit checks only; it is refused if the round trip would cost more than ${money(maxLossUsd)}, and every other check still runs, the NEAR AI risk check included.`,
    'It posts maker orders first; what they leave after the maker window is taken with a taker order, within the same caps, and that cost counts in the round trip.',
    'The contract checks every order against your policy before it is signed.',
    'It opens from flat only: a held pair is never closed by it.',
  ].join(' ');
}

/** The entry the owner started: the window, and the Journal ids already there when it was sent (none of them is its result). */
export interface PendingEntry {
  windowId: string;
  symbol: string;
  seen: ReadonlySet<string>;
}

export type EntryResult =
  | { kind: 'opened'; text: string }
  | { kind: 'partly'; text: string }
  | { kind: 'not'; text: string };

/** The Journal kinds an owner entry ends on (engine/src/strategy/loop.ts #rotateStart and #enterOrRotateChecked). */
const ENDS: ReadonlySet<JournalEntry['kind']> = new Set(['enter', 'rotate', 'error', 'refused', 'veto']);

const num = (v: number | string | undefined): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** `text` with a leading `( … )` removed, nested parentheses included (the owner entry's tag). */
function dropTag(text: string): string {
  if (!text.startsWith('(')) return text;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(i + 1).trimStart();
  }
  return text;
}

/** The first `; ` clause of `text` outside parentheses. */
function firstClause(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0 && text[i + 1] === ' ') return text.slice(0, i);
  }
  return text;
}

/** Where `id` stands in `text` as a whole window id (not the start of a longer one), or -1. */
function idAt(text: string, id: string): number {
  for (let at = text.indexOf(id); at >= 0; at = text.indexOf(id, at + 1)) {
    const before = at === 0 ? ' ' : text[at - 1]!;
    const after = text[at + id.length] ?? ' ';
    if (!/[a-z0-9_-]/i.test(before) && !/[a-z0-9_-]/i.test(after)) return at;
  }
  return -1;
}

/**
 * Why an entry was not opened, from its Journal line: what follows the window id (`… <id> not carried out: `,
 * `enter <id>: `), without the owner entry's tag, the `<SYMBOL> not opened: ` lead and the clauses after the first.
 */
export function entryReason(summary: string, windowId: string, symbol: string): string {
  const at = idAt(summary, windowId);
  let text = at < 0 ? summary : summary.slice(at + windowId.length);
  text = text.replace(/^ not carried out/, '').replace(/^:\s*/, '');
  text = dropTag(text);
  if (text.startsWith(`${symbol} not opened: `)) text = text.slice(`${symbol} not opened: `.length);
  text = firstClause(text).trim();
  return text === '' ? 'The Journal has the reason.' : sentence(capital(text));
}

/**
 * What came of the entry the owner started, once its line is in the Journal (newest first, as the stream keeps it);
 * null while it has not landed. Its line is the first new one of an ending kind that names its window.
 */
export function entryResult(journal: readonly JournalEntry[], pending: PendingEntry): EntryResult | null {
  let line: JournalEntry | null = null;
  for (const e of journal) {
    if (pending.seen.has(e.id) || !ENDS.has(e.kind)) continue;
    const window = e.numbers.window;
    const names = window === undefined ? idAt(e.summary, pending.windowId) >= 0 : window === pending.windowId;
    if (names) line = e; // newest first: the last one found is the first written
  }
  if (line === null) return null;
  const { symbol } = pending;
  if (line.kind === 'enter' || line.kind === 'rotate') {
    const leg = num(line.numbers.usd) ?? num(line.numbers.legUsd);
    const taker = line.summary.includes('taker fallback') ? ' The maker orders did not fill it all; the taker fallback took the rest.' : '';
    return { kind: 'opened', text: `Opened ${symbol}: both legs are open${leg === null ? '' : `, ${usd(leg)} a leg`}.${taker} It shows on the Desk.` };
  }
  if (line.kind === 'veto') return { kind: 'not', text: `Not opened: the NEAR AI risk check refused ${symbol}. Nothing was sent.` };
  const reason = entryReason(line.summary, pending.windowId, symbol);
  if (line.kind === 'error' && line.numbers.heldLegUsd !== undefined) {
    return { kind: 'partly', text: `Opened ${symbol}, partly: ${reason} The desk holds it from now.` };
  }
  return { kind: 'not', text: `Not opened: ${reason}` };
}
