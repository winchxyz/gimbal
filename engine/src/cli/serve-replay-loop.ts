// The strategy loop's whole cycle in replay (`npm run demo`): the replay desk (risk/sources.ts ReplayDesk) as the
// loop's hands, a book port that puts each act's money on its journal line, and the replay script that plays the
// owner's two buttons so the cycle fits in the recorded hour.
//
// replayLoop(): hands that open and close the pair on the replay desk (fills at the recorded best bid and ask, the
// scanner's taker fees; nothing signed or sent), and a LoopBookPort for loopBook(): the open's line gets `usd` (its
// fees, a cost), the close's line gets `usd` (price, the close's fees and the funding no hourly booking journaled) and
// the position's realized parts (`realizedFundingUsd`, `realizedFeesUsd`, `realizedPriceUsd`, `realizedNetUsd`). With
// the hourly `funding` lines (fundingEntry) the journal's amounts add up to the realized net.
//
// ReplayScript: a recording is about an hour long, too short for the loop to enter on its own (enterAfterChecks
// hourly checks above the minimum) or to exit on its own (exitAfterChecks, or a demo pair's 24). So, labelled on the
// journal, it plays what the owner would do: an owner demo entry (POST /rotate with demo, the loop's own path: only the
// profit checks are waived, the round trip held to REPLAY_DEMO_MAX_LOSS_USD) on the best window the policy allows,
// a few minutes in; and POST /close a few minutes after the first hour boundary the pair holds through, once its
// funding is booked. The loop's gates, its NEAR AI risk check and its sizing all run as they would live.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContractPolicy, DeskState, JournalEntry, StrategyConfig, StreamEvent, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { isEnterableButForProfit } from '../scanner/price.ts';
import type { ReplayClose, ReplayDesk, ReplayFill, ReplayFunding } from '../risk/sources.ts';
import { REPLAY_ACCOUNT_VENUES } from '../risk/sources.ts';
import type { ActOutcome, BookFill, LoopHands, LoopHeld } from '../strategy/loop.ts';
import { HyperliquidReader } from '../venues/hyperliquid.ts';
import { venueName } from '../venues/names.ts';
import { PhoenixReader } from '../venues/phoenix.ts';
import type { RecordLine } from '../venues/recorder.ts';
import { VirtualClock, readWireRecording, replayFetch } from '../venues/replay.ts';
import type { Clock, Market } from '../venues/venue.ts';
import type { LoopBookPort } from './serve-loop.ts';
import { policySymbols, windowSymbol } from './serve-loop.ts';

const HOUR_MS = 3_600_000;
/** The round trip the replay's owner demo entry accepts at most, USD (DEMO_MAX_LOSS_USD's whole allowance). */
export const REPLAY_DEMO_MAX_LOSS_USD = 1;
/** The script's entry: this long after the replay starts (the flat desk shows first). */
export const REPLAY_ENTER_AFTER_MS = 2 * 60_000;
/** The script's close: this long after the first hour boundary the pair holds through. */
export const REPLAY_EXIT_AFTER_HOUR_MS = 5 * 60_000;
/** ... and at the latest this long before the recording ends, so the flat desk shows its realized P&L. */
export const REPLAY_EXIT_BEFORE_END_MS = 5 * 60_000;
/** No entry is tried once less than this is left of the recording: a pair could not hold through an hour boundary. */
export const REPLAY_GIVE_UP_BEFORE_END_MS = 20 * 60_000;
/** An entry the loop accepted but did not open within this long (refused after its checks): the next window. */
const ENTRY_WAIT_MS = 2 * 60_000;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const two = (n: number) => String(n).padStart(2, '0');
/** `16:17`, UTC. */
export const hhmm = (ms: number): string => `${two(new Date(ms).getUTCHours())}:${two(new Date(ms).getUTCMinutes())}`;
/** `+0.0021 USD`, `-0.0100 USD`: small amounts keep four decimals. */
export const usd4 = (n: number): string => `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(4)} USD`;

function fillText(fills: readonly ReplayFill[]): string {
  const legs = fills.map((f) => `${f.side === 'BUY' ? 'bought' : 'sold'} ${f.qty} ${f.symbol} on ${venueName(f.venue)} at ${f.px} (${f.source === 'book' ? `recorded best ${f.side === 'BUY' ? 'ask' : 'bid'}` : 'recorded mark'})`);
  const fee = fills.reduce((s, f) => s + f.feeUsd, 0);
  return `replay, simulated fills, nothing signed or sent: ${legs.join(', ')}, taker fees ${fee.toFixed(4)} USD`;
}

const bookFills = (fills: readonly ReplayFill[]): BookFill[] =>
  fills.map((f) => ({ venue: f.venue, side: f.side, qty: String(f.qty), avgPx: f.px, feeUsd: f.feeUsd }));

/**
 * The symbols a pair long `long` / short `short` may open on the replay desk: the policy's (in both hl_assets and
 * phoenix_markets) on its two accounts, in either direction, as the mainnet engine's pairs; none on any other venue.
 */
export function replayPairSymbols(policy: () => ContractPolicy | null): (long: VenueId, short: VenueId) => readonly string[] {
  return (long, short) => (long !== short && REPLAY_ACCOUNT_VENUES.includes(long) && REPLAY_ACCOUNT_VENUES.includes(short) ? policySymbols(policy()) : []);
}

/**
 * The venues' wire recordings their fixture tests read (fixtures/hl-wire, fixtures/phoenix-wire), with the time each
 * was captured: the source of the markets (lots, decimals) a scan recording does not keep. Read offline through the
 * real readers over replayFetch, so the lots are the venues' own.
 */
const MARKET_WIRES: Record<'hyperliquid' | 'phoenix', { file: string; at: number }> = {
  hyperliquid: { file: 'hl-wire/hl-mainnet-2026-10-30.jsonl.gz', at: Date.UTC(2026, 9, 30, 20, 42, 35) },
  phoenix: { file: 'phoenix-wire/phoenix-mainnet-2026-10-31.jsonl.gz', at: Date.UTC(2026, 9, 31, 12) },
};

/**
 * `markets` lines for the replay desk's venues a recording has none for, dated at its start: the loop sizes legs on
 * whole lots (windowFacts), and scan recordings keep funding and books only. Markets are static venue metadata, so
 * the venues' wire recordings stand in. A venue the recording already answers markets for keeps its own.
 */
export async function replayMarketLines(lines: readonly RecordLine[], start: number, fixtures = fileURLToPath(new URL('../../fixtures/', import.meta.url))): Promise<RecordLine[]> {
  const out: RecordLine[] = [];
  for (const venue of REPLAY_ACCOUNT_VENUES) {
    if (venue !== 'hyperliquid' && venue !== 'phoenix') continue;
    if (!lines.some((l) => l.venue === venue) || lines.some((l) => l.venue === venue && l.method === 'markets')) continue;
    const wire = MARKET_WIRES[venue];
    const f = replayFetch(readWireRecording(join(fixtures, wire.file)));
    const clock = new VirtualClock(wire.at);
    let result: Market[];
    if (venue === 'hyperliquid') {
      result = await new HyperliquidReader({ network: 'mainnet', fetch: f, clock }).markets();
    } else {
      const reader = new PhoenixReader({ fetch: f, clock });
      try {
        result = await reader.markets();
      } finally {
        reader.close();
      }
    }
    out.push({ t: start, venue, method: 'markets', args: [], ms: 0, result });
  }
  return out;
}

/** Where the replay desk holds margin (the scanner's marginHeldAt): every leg's venue and every account with USDC. */
export function replayMarginVenues(desk: DeskState | null): ReadonlySet<VenueId> {
  const out = new Set<VenueId>((desk?.legs ?? []).filter((l) => l.marginUsd > 0).map((l) => l.venue));
  for (const a of desk?.accounts ?? []) if ((a.equityUsd ?? 0) > 0) out.add(a.venue);
  return out;
}

/** The loop's hands and book port on the replay desk. */
export function replayLoop(p: { desk: ReplayDesk; policy: () => ContractPolicy | null }): { hands: LoopHands; book: LoopBookPort } {
  let opened: { feeUsd: number } | null = null;
  let closed: Extract<ReplayClose, { ok: true }> | null = null;
  let openWindow: string | null = null;
  const refused = (reason: string): ActOutcome => ({ ok: false, reason: `replay: ${reason}`, sent: false, tx: [], feeUsd: 0, open: [] });

  const hands: LoopHands = {
    blocked: () => null,
    held: () => {
      const h = p.desk.held();
      if (h === null) return null;
      let pnlUsd = 0;
      const freed: Record<string, number> = {};
      for (const l of h.legs) {
        const price = (l.mark - l.entryPx) * l.size * (l.side === 'long' ? 1 : -1);
        pnlUsd += price + l.fundingUsd - l.feeUsd;
        freed[l.venue] = (freed[l.venue] ?? 0) + Math.max(0, (l.size * l.mark) / l.leverage + price);
      }
      return { symbol: h.symbol, legUsd: Math.max(...h.legs.map((l) => l.size * l.mark)), pnlUsd, oneLeg: null, freedMarginUsd: freed };
    },
    symbolOf: (w) => windowSymbol(w, policySymbols(p.policy()), replayPairSymbols(p.policy)),
    open: async (r) => {
      const o = await p.desk.openPair({
        symbol: r.symbol, qty: Number(r.qty), long: r.window.longVenue as VenueId, short: r.window.shortVenue as VenueId, leverage: r.leverage,
      });
      if (!o.ok) return refused(o.reason);
      opened = { feeUsd: o.feeUsd };
      return { ok: true, reason: fillText(o.fills), sent: true, tx: [], feeUsd: o.feeUsd, open: [], fills: bookFills(o.fills), filledQty: r.qty };
    },
    close: async () => {
      const c = await p.desk.closePair();
      if (!c.ok) return refused(c.reason);
      closed = c;
      return { ok: true, reason: fillText(c.fills), sent: true, tx: [], feeUsd: c.feeUsd, open: [], fills: bookFills(c.fills) };
    },
  };

  const book: LoopBookPort = {
    record: (record): { positionId: string | null; numbers: Record<string, number | string>; note?: string | null } => {
      if (record.kind === 'enter' && opened !== null) {
        const fee = opened.feeUsd;
        opened = null;
        openWindow = record.windowId;
        return { positionId: `replay-${record.windowId}`, numbers: { usd: -round6(fee), feeUsd: -round6(fee) } };
      }
      if (record.kind === 'exit' && closed !== null) {
        const c = closed;
        closed = null;
        openWindow = null;
        const fees = c.entryFeeUsd + c.feeUsd;
        return {
          positionId: `replay-${record.windowId}`,
          numbers: {
            usd: round6(c.priceUsd - c.feeUsd + c.unbookedFundingUsd), feeUsd: -round6(c.feeUsd),
            realizedFundingUsd: round6(c.fundingUsd), realizedFeesUsd: -round6(fees), realizedPriceUsd: round6(c.priceUsd), realizedNetUsd: round6(c.netUsd),
            heldH: Math.round((c.heldMs / HOUR_MS) * 100) / 100,
          },
          note: `realized ${usd4(c.netUsd)} in all: funding ${usd4(c.fundingUsd)}, fees ${usd4(-fees)}, price ${usd4(c.priceUsd)} (replay: recorded prices, nothing signed)`,
        };
      }
      return { positionId: null, numbers: {} };
    },
    adopt: (input) => {
      openWindow = input.windowId;
      return 'replay';
    },
    openWindow: () => openWindow,
    recordOutside: () => ({ positionId: null }),
    queueCloseLookup: () => {},
  };
  return { hands, book };
}

/** The replay desk's hourly funding booking as a journal line. */
export function fundingEntry(f: ReplayFunding, id: string): JournalEntry {
  const legs = f.legs.map((l) => `${venueName(l.venue)} ${l.side} ${usd4(l.usd)}`).join(', ');
  const numbers: Record<string, number | string> = { usd: round6(f.usd), from: new Date(f.from).toISOString(), to: new Date(f.to).toISOString() };
  for (const l of f.legs) {
    numbers[`${l.venue}Usd`] = round6(l.usd);
    numbers[`${l.venue}RatePerHour`] = l.ratePerHour;
  }
  return {
    id, t: f.to, kind: 'funding', tx: [], numbers,
    summary: `funding ${hhmm(f.from)}–${hhmm(f.to)} on ${f.legs[0]?.symbol ?? 'the pair'} at the recorded rates: ${legs}, ${usd4(f.usd)} in all (replay: nothing settled on chain)`,
  };
}

export interface ReplayScriptInput {
  clock: Clock;
  /** The replay clock's first and last instant (the recording's). */
  start: number;
  end: number;
  loop: { rotate(windowId: unknown, demo?: unknown): { ok: true } | { ok: false; reason: string }; close(): { ok: true } | { ok: false; reason: string }; readonly held: LoopHeld | null; readonly checked: number };
  windows: () => readonly FundingWindow[] | null;
  strategy: () => StrategyConfig;
  policy: () => ContractPolicy | null;
  publish: (event: StreamEvent) => void;
  log: (line: string) => void;
}

/** The windows a demo entry may open on the replay desk, best net first: Hyperliquid and Phoenix, in the policy. */
export function demoCandidates(windows: readonly FundingWindow[], policy: ContractPolicy | null): FundingWindow[] {
  const symbols = policySymbols(policy);
  const pairs = replayPairSymbols(() => policy);
  // Windows whose spread pays come first; one that pays the other way is tried only when none of those can be
  // entered (a lot too coarse for the leg, say), so the replay still shows the whole cycle.
  const pays = (w: FundingWindow) => (w.grossAprPct > 0 ? 0 : 1);
  return windows
    .filter((w) => isEnterableButForProfit(w) && 'symbol' in windowSymbol(w, symbols, pairs))
    .sort((a, b) => pays(a) - pays(b) || b.netAprPct - a.netAprPct);
}

/** When the script closes a pair entered at `enteredAt`: past the first hour boundary, before the recording ends. */
export function scriptExitAt(enteredAt: number, end: number): number {
  const after = Math.floor(enteredAt / HOUR_MS) * HOUR_MS + HOUR_MS + REPLAY_EXIT_AFTER_HOUR_MS;
  return Math.max(enteredAt + 60_000, Math.min(after, end - REPLAY_EXIT_BEFORE_END_MS));
}

/** See the header. tick() is driven by start(); every step it takes is journaled as the replay script's. */
export class ReplayScript {
  readonly #i: ReplayScriptInput;
  #phase: 'enter' | 'hold' | 'done' = 'enter';
  readonly #tried = new Set<string>();
  #asked: { windowId: string; at: number } | null = null;
  #exitAt: number | null = null;
  #closeAsked = false;
  #lastRefusal: string | null = null;
  #seq = 0;

  constructor(input: ReplayScriptInput) {
    this.#i = input;
  }

  get phase(): 'enter' | 'hold' | 'done' {
    return this.#phase;
  }

  /** Ticks every `everyMs` of real time until it is done; returns a stop. */
  start(everyMs = 1_000): () => void {
    const timer = setInterval(() => {
      this.tick();
      if (this.#phase === 'done') clearInterval(timer);
    }, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  tick(): void {
    const { clock, loop } = this.#i;
    const now = clock.now();
    if (this.#phase === 'enter') {
      const held = loop.held;
      if (held !== null) {
        this.#phase = 'hold';
        this.#exitAt = scriptExitAt(held.since, this.#i.end);
        return;
      }
      if (now < this.#i.start + REPLAY_ENTER_AFTER_MS || loop.checked < 1) return;
      if (this.#asked !== null && now - this.#asked.at < ENTRY_WAIT_MS) return;
      const windows = this.#i.windows();
      if (windows === null) return;
      const next = demoCandidates(windows, this.#i.policy()).find((w) => !this.#tried.has(w.id));
      if (next === undefined) {
        // The first scans may not have priced a window yet: looked for again until too little of the recording is left.
        if (now < this.#i.end - REPLAY_GIVE_UP_BEFORE_END_MS) return;
        this.#note(`replay script: no window the policy allows passes the checks a demo entry keeps (${this.#tried.size} tried), so the desk stays flat this replay`, {});
        this.#phase = 'done';
        return;
      }
      const first = this.#tried.size === 0;
      this.#tried.add(next.id);
      const s = this.#i.strategy();
      const target = `POST /rotate on ${next.symbol} (short ${venueName(next.shortVenue)}, long ${venueName(next.longVenue)}, ${next.netAprPct.toFixed(1)} % net`
        + `${next.grossAprPct > 0 ? '' : ', its spread pays the other way at the recorded rates, so this pair pays funding: the demo shows the cycle, not a profit'})`;
      this.#note(
        first
          ? `replay script: the recorded hour is too short for the loop to enter on its own (${s.enterAfterChecks ?? 3} hourly checks in a row above your ${s.minNetAprPct} % minimum) `
            + `or to exit on its own, so the replay plays the owner's demo entry on the best window the policy allows: ${target}, its round trip at most ${REPLAY_DEMO_MAX_LOSS_USD.toFixed(2)} USD. `
            + 'Only the profit checks are waived; the policy, the NEAR AI risk check and the sizing still count. Nothing is signed or sent.'
          : `replay script: the window before was not entered (its line says why); the next one the policy allows: ${target}. Nothing is signed or sent.`,
        { window: next.id, maxLossUsd: REPLAY_DEMO_MAX_LOSS_USD },
      );
      const r = loop.rotate(next.id, { maxLossUsd: REPLAY_DEMO_MAX_LOSS_USD });
      if (r.ok) this.#asked = { windowId: next.id, at: now };
      else {
        this.#asked = null;
        this.#i.log(`replay script: POST /rotate ${next.id} refused: ${r.reason}`);
      }
      return;
    }
    if (this.#phase !== 'hold') return;
    const held = loop.held;
    if (held === null) {
      this.#phase = 'done';
      return;
    }
    if (this.#exitAt === null || now < this.#exitAt || this.#closeAsked) return;
    const r = loop.close();
    if (!r.ok) {
      // A rescue running, say: tried again on the next tick, logged once per reason.
      if (r.reason !== this.#lastRefusal) this.#i.log(`replay script: POST /close refused, tried again: ${r.reason}`);
      this.#lastRefusal = r.reason;
      return;
    }
    this.#closeAsked = true;
    const hour = Math.floor(held.since / HOUR_MS) * HOUR_MS + HOUR_MS;
    this.#note(
      `replay script: closes ${held.symbol} with POST /close, as the owner would${now >= hour ? `, after its ${hhmm(hour)} funding` : ''}, so the whole loop fits in the recorded hour; `
      + 'live, a demo pair exits on its 24th hourly check in a row, at a stop, or when the owner closes it. Nothing is signed or sent.',
      { window: held.windowId },
    );
  }

  #note(summary: string, numbers: Record<string, number | string>): void {
    const t = this.#i.clock.now();
    this.#i.log(summary);
    this.#i.publish({ type: 'journal', data: { id: `replay-script-${t.toString(36)}-${++this.#seq}`, t, kind: 'wait', summary, numbers: { stage: 'replay script', ...numbers }, tx: [] } });
  }
}
