// A rescue's landing on Hyperliquid, confirmed in the desk's ledger (userNonFundingLedgerUpdates), never by a change
// of account value: that moves with the mark, so a real delivery on a losing leg could read as none, and a winning
// mark could read as a delivery. Ported from the money scripts' fund step (tools/mainnet/fund.mjs hlDelivery).

import type { VenueId } from '@gimbal/shared';
import type { ChainNetwork } from '../relayer/tx.ts';
import { hyperliquidTxRef } from '../relayer/tx.ts';
import { HL_MAINNET_URL } from '../venues/hyperliquid.ts';
import type { VerifiedQuote } from './oneclick.ts';
import type { LandingPort, LedgerEntry } from './rescuer.ts';

/** Ledger entry types that bring USDC into an address. */
export const HL_INCOMING = ['deposit', 'send', 'internalTransfer', 'spotTransfer'];
/** Entries this long before the transfer began still count (clock skew between this machine and Hyperliquid). */
export const LEDGER_SLACK_MS = 60_000;

export interface HlLedgerRow {
  time: number;
  hash: string;
  delta: { type: string; usdc?: string; amount?: string; token?: string; destination?: string; user?: string };
}

/** A USDC decimal ("19.480951") as × 1e8, or null. */
function e8(s: unknown): bigint | null {
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return BigInt(w!) * 100_000_000n + BigInt(f.slice(0, 8).padEnd(8, '0'));
}

/**
 * The entry that is the 1Click delivery, or null: incoming, to the desk (a `deposit` has no destination: the bridge
 * credits the address itself), not sent by the desk, of at least `minOutE8`, and not already matched to another
 * transfer (`seen`, by hash). `sinceMs` is when the rescue's hold opened (just before the payment was signed).
 *
 * When 1Click names the delivery's transactions (`deliveryTx`), the entry with one of those hashes is taken, booked
 * since `sinceMs` less the slack (clock skew). Without a named match, only an entry booked at or after `sinceMs`
 * counts: the delivery cannot come before its payment was signed.
 *
 * Residual without a named hash: the state keeps no record of the owner's fund.mjs top-ups, so one booked after the
 * hold opened, of at least `minOutE8`, would be taken for the delivery. fund.mjs takes the rescuer's lock, so the two
 * do not run together; only a late fund.mjs delivery could match. 1Click names destinationChainTxHashes on SUCCESS,
 * so this fallback is the rare path.
 */
export function hlDelivery(rows: readonly HlLedgerRow[], o: { desk: string; sinceMs: number; minOutE8: bigint; seen: ReadonlySet<string>; deliveryTx?: readonly string[] }): { hash: string; usdE8: bigint } | null {
  const named = new Set((o.deliveryTx ?? []).map((h) => h.toLowerCase()));
  const matches = deliveries(rows, o);
  const hit = matches.find((m) => named.has(m.hash.toLowerCase())) ?? matches.find((m) => m.time >= o.sinceMs);
  return hit === undefined ? null : { hash: hit.hash, usdE8: hit.usdE8 };
}

function deliveries(rows: readonly HlLedgerRow[], o: { desk: string; sinceMs: number; minOutE8: bigint; seen: ReadonlySet<string> }): { hash: string; usdE8: bigint; time: number }[] {
  const me = o.desk.toLowerCase();
  const out: { hash: string; usdE8: bigint; time: number }[] = [];
  for (const r of rows) {
    const d = r.delta;
    const usdc = d.usdc !== undefined ? d.usdc : d.token === 'USDC' ? d.amount : undefined;
    const amount = e8(usdc);
    const to = typeof d.destination === 'string' ? d.destination.toLowerCase() : null;
    const from = typeof d.user === 'string' ? d.user.toLowerCase() : null;
    if (r.time < o.sinceMs - LEDGER_SLACK_MS || !HL_INCOMING.includes(d.type) || amount === null || amount < o.minOutE8) continue;
    if (from === me || (to === null ? d.type !== 'deposit' : to !== me) || o.seen.has(r.hash)) continue;
    out.push({ hash: r.hash, usdE8: amount, time: r.time });
  }
  return out;
}

export interface HlLedgerLandingOptions {
  network: ChainNetwork;
  /** The desk's EVM address: Hyperliquid's user. */
  desk: () => Promise<string>;
  fetch?: typeof fetch;
  apiUrl?: string;
  /** Why a landing on another venue cannot be confirmed here. */
  others?: Partial<Record<VenueId, string>>;
}

/** Confirms landings on Hyperliquid from its ledger; every other venue is refused with its reason. */
export class HlLedgerLanding implements LandingPort {
  readonly #o: HlLedgerLandingOptions;
  readonly #fetch: typeof fetch;

  constructor(options: HlLedgerLandingOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? fetch;
  }

  confirms(venue: VenueId): string | null {
    if (venue === 'hyperliquid') return null;
    return this.#o.others?.[venue] ?? `a landing on ${venue} cannot be confirmed here`;
  }

  async find(venue: VenueId, q: VerifiedQuote, sinceMs: number, seen: ReadonlySet<string>, deliveryTx?: readonly string[]): Promise<LedgerEntry | null> {
    if (venue !== 'hyperliquid') return null;
    const desk = await this.#o.desk();
    const res = await this.#fetch(`${(this.#o.apiUrl ?? HL_MAINNET_URL).replace(/\/+$/, '')}/info`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'userNonFundingLedgerUpdates', user: desk.toLowerCase(), startTime: sinceMs - LEDGER_SLACK_MS }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`hyperliquid userNonFundingLedgerUpdates: HTTP ${res.status}`);
    const rows = await res.json() as unknown;
    if (!Array.isArray(rows)) throw new Error('hyperliquid userNonFundingLedgerUpdates: not a list');
    const ok = rows.filter((r): r is HlLedgerRow => typeof r === 'object' && r !== null && Number.isSafeInteger((r as HlLedgerRow).time)
      && typeof (r as HlLedgerRow).hash === 'string' && typeof (r as HlLedgerRow).delta?.type === 'string');
    const hit = hlDelivery(ok, { desk, sinceMs, minOutE8: q.minAmountOutE8, seen, ...(deliveryTx === undefined ? {} : { deliveryTx }) });
    return hit === null ? null : { id: hit.hash, usd: Number(hit.usdE8) / 1e8, tx: [hyperliquidTxRef(this.#o.network, hit.hash)] };
  }
}
