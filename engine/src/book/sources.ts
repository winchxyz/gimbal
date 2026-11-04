// The live ledgers the book reads (BookSources), over the venues' public read endpoints. Nothing here signs or sends:
// Hyperliquid /info (userFunding through HyperliquidReader, userNonFundingLedgerUpdates, userFillsByTime) and Phoenix's
// public API (funding history through PhoenixReader, trades-history). Orderly only when the caller hands it the desk's
// own reads (book/orderly.ts): its funding history is a signed read, and its fills come from the private session.

import type { TxRef } from '@gimbal/shared';
import { hyperliquidTxRef } from '../relayer/tx.ts';
import { fillsOf, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import { HL_MAINNET_INFO_URL, HL_TESTNET_INFO_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import type { OrderlyFundingFeeSource } from '../venues/orderly.ts';
import { OrderlyReader } from '../venues/orderly.ts';
import { PHOENIX_API_URL, PhoenixReader } from '../venues/phoenix.ts';
import type { OrderlyFillLog } from './orderly.ts';
import { orderlyBookFunding } from './orderly.ts';
import type { BookSources, CloseFillQuery, FillFeeQuery } from './sync.ts';
import type { BookFill } from './types.ts';
import type { HlLedgerRow } from './types.ts';

const PAGE_ROWS = 500;
const MAX_PAGES = 50;
/** An act's fills are looked for in [startedAt, at], widened by this either way (the venue's clock against ours). */
export const FILL_WINDOW_SLACK_MS = 5_000;

export interface LiveSourceOptions {
  network: 'mainnet' | 'testnet';
  fetch?: typeof fetch;
  hlInfoUrl?: string;
  phoenixApiUrl?: string;
  /**
   * The desk's Orderly reads, when it trades Orderly pairs (serve with GIMBAL_ORDERLY_PAIRS=1): `fundingFees` is the
   * desk client's signed funding_fee_history read (the book's address for 'orderly' is the account id), `fills` the
   * log the private session's executionreports feed. Absent: no Orderly ledger, as before.
   */
  orderly?: { fundingFees?: OrderlyFundingFeeSource; fills?: OrderlyFillLog; apiUrl?: string; hearWaitMs?: number };
}

async function post<T>(f: typeof fetch, url: string, body: unknown): Promise<T> {
  const res = await f(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${(body as { type: string }).type}: HTTP ${res.status}`);
  return await res.json() as T;
}

/** userNonFundingLedgerUpdates of one user in [startTime, endTime], oldest first, paged like userFunding. */
export async function hlNonFundingLedger(f: typeof fetch, infoUrl: string, user: string, startTime: number, endTime: number): Promise<HlLedgerRow[]> {
  const out: HlLedgerRow[] = [];
  const seen = new Set<string>();
  let from = startTime;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new Error(`userNonFundingLedgerUpdates: still more rows after ${MAX_PAGES} pages`);
    const rows = await post<unknown>(f, infoUrl, { type: 'userNonFundingLedgerUpdates', user: user.toLowerCase(), startTime: from, endTime });
    if (!Array.isArray(rows)) throw new Error('userNonFundingLedgerUpdates: not a list');
    let fresh = 0;
    let last = from;
    for (const r of rows as HlLedgerRow[]) {
      if (!Number.isSafeInteger(r?.time) || typeof r.hash !== 'string' || typeof r.delta?.type !== 'string') {
        throw new Error(`userNonFundingLedgerUpdates: malformed row (${rowShape(r)})`);
      }
      last = Math.max(last, r.time);
      const key = `${r.time}|${r.hash}|${r.delta.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh++;
      out.push(r);
    }
    if (rows.length < PAGE_ROWS || fresh === 0) break;
    from = last;
  }
  return out.sort((a, b) => a.time - b.time);
}

/** A row's field names and value types, never its values (a ledger row carries counterparty addresses). */
export function rowShape(r: unknown): string {
  if (r === null || typeof r !== 'object') return r === null ? 'null' : typeof r;
  return Object.entries(r as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? `{${rowShape(v)}}` : typeof v}`)
    .join(', ');
}

interface HlFillRow { coin: string; side: 'B' | 'A'; fee?: string; time: number; px?: string; sz?: string }

/** Fills summed into one BookFill (size-weighted price; the fee null when one is missing) and the last one's time. */
export function sumFills(venue: string, side: 'BUY' | 'SELL', rows: readonly { size: number; px: number | null; fee: number | null; time: number }[]): { fill: BookFill; at: number } | null {
  let qty = 0;
  let notional = 0;
  let priced = 0;
  let fee: number | null = 0;
  let at = 0;
  for (const r of rows) {
    if (!(r.size > 0)) continue;
    qty += r.size;
    if (r.px !== null && Number.isFinite(r.px)) {
      notional += r.size * r.px;
      priced += r.size;
    }
    fee = fee === null || r.fee === null || !Number.isFinite(r.fee) ? null : fee + r.fee;
    at = Math.max(at, r.time);
  }
  if (qty === 0) return null;
  return { fill: { venue, side, qty: String(Number(qty.toPrecision(12))), avgPx: priced > 0 ? notional / priced : null, feeUsd: fee }, at };
}

/** The desk's Hyperliquid fills on a coin and side in [from, to] (userFillsByTime), summed. */
export async function hlCloseFills(f: typeof fetch, infoUrl: string, q: CloseFillQuery): Promise<{ fill: BookFill; at: number } | null> {
  const rows = await post<unknown>(f, infoUrl, { type: 'userFillsByTime', user: q.address.toLowerCase(), startTime: Math.max(0, q.from), endTime: q.to });
  if (!Array.isArray(rows)) throw new Error('userFillsByTime: not a list');
  const mine = (rows as HlFillRow[]).filter((r) => r.coin === q.symbol && r.side === (q.side === 'BUY' ? 'B' : 'A') && r.time >= q.from && r.time <= q.to);
  return sumFills('hyperliquid', q.side, mine.map((r) => ({
    size: Number(r.sz), px: r.px === undefined ? null : Number(r.px), fee: r.fee === undefined ? null : Number(r.fee), time: r.time,
  })));
}

/** The desk's Phoenix fills on a market and side in [from, to] (trades-history: a buy has baseLotsDelta > 0), summed. */
export async function phoenixCloseFills(api: ReturnType<typeof phoenixTraderApi>, q: CloseFillQuery): Promise<{ fill: BookFill; at: number } | null> {
  const raw = await api.tradesHistory(q.address, 100);
  const rows = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return null;
  const mine: { size: number; px: number | null; fee: number | null; time: number }[] = [];
  for (const r of rows as { marketSymbol?: unknown; baseLotsDelta?: unknown; price?: unknown; fees?: unknown; timestamp?: unknown }[]) {
    const time = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    const delta = Number(r.baseLotsDelta);
    if (r.marketSymbol !== q.symbol || !Number.isFinite(time) || time < q.from || time > q.to || !Number.isFinite(delta)) continue;
    if ((delta > 0) !== (q.side === 'BUY')) continue;
    mine.push({ size: Math.abs(delta), px: Number.isFinite(Number(r.price)) ? Number(r.price) : null, fee: Number.isFinite(Number(r.fees)) ? Number(r.fees) : null, time });
  }
  return sumFills('phoenix', q.side, mine);
}

/**
 * The fee Hyperliquid charged for one venue side of an act: every fill on the coin and side between the act's start
 * and its record (FILL_WINDOW_SLACK_MS either way). Without the act's start it cannot tell the act's fills: null.
 */
export async function hlFillFee(f: typeof fetch, infoUrl: string, q: FillFeeQuery): Promise<number | null> {
  if (q.startedAt === null || !(q.startedAt <= q.at)) return null;
  const lo = q.startedAt - FILL_WINDOW_SLACK_MS;
  const hi = q.at + FILL_WINDOW_SLACK_MS;
  const rows = await post<unknown>(f, infoUrl, { type: 'userFillsByTime', user: q.address.toLowerCase(), startTime: Math.max(0, lo), endTime: hi });
  if (!Array.isArray(rows)) throw new Error('userFillsByTime: not a list');
  const mine = (rows as HlFillRow[]).filter((r) => r.coin === q.symbol && r.side === (q.side === 'BUY' ? 'B' : 'A') && r.time >= lo && r.time <= hi);
  if (mine.length === 0 || mine.some((r) => r.fee === undefined || !Number.isFinite(Number(r.fee)))) return null;
  return mine.reduce((s, r) => s + Number(r.fee), 0);
}

/**
 * How long a fee read waits for every one of an act's Solana signatures to show in Phoenix's trades-history. Until
 * then a signature that is not there yet means no fee: a sum without it would be partial and booked for good, so the
 * read is tried again at the next sync. After it, a signature still not there is taken as a transaction without fills
 * (a margin move in the same act, say), and the fee is what the others show.
 */
export const PHOENIX_FEE_INDEX_WAIT_MS = 30 * 60_000;

/** The fee Phoenix charged for one leg's fills of an act: trades-history rows of the act's Solana transactions. */
export async function phoenixFillFee(api: ReturnType<typeof phoenixTraderApi>, q: FillFeeQuery): Promise<number | null> {
  const sigs = q.tx.filter((t) => t.chain === 'solana').map((t) => t.id);
  if (sigs.length === 0) return null;
  const raw = await api.tradesHistory(q.address, 100);
  const rows = (raw as { data?: unknown } | null)?.data;
  const indexed = new Set(Array.isArray(rows) ? (rows as { signature?: unknown }[]).map((r) => r.signature).filter((x): x is string => typeof x === 'string') : []);
  if ((q.now ?? Date.now()) - q.at < PHOENIX_FEE_INDEX_WAIT_MS && sigs.some((sig) => !indexed.has(sig))) return null;
  let fee = 0;
  let found = false;
  for (const sig of sigs) {
    const f = fillsOf(raw, sig, q.symbol);
    if (f === null) continue;
    fee += f.feeUsd;
    found = true;
  }
  return found ? fee : null;
}

/** The desk's ledgers on `network`: Hyperliquid there, Phoenix on mainnet only (it has no testnet). */
export function liveBookSources(o: LiveSourceOptions): BookSources {
  const f = o.fetch ?? fetch;
  const infoUrl = o.hlInfoUrl ?? (o.network === 'mainnet' ? HL_MAINNET_INFO_URL : HL_TESTNET_INFO_URL);
  const hl = new HyperliquidReader({ network: o.network, url: infoUrl, fetch: f });
  const phoenixUrl = o.phoenixApiUrl ?? PHOENIX_API_URL;
  const phoenix = o.network === 'mainnet' ? new PhoenixReader({ apiUrl: phoenixUrl, fetch: f }) : null;
  const phoenixApi = o.network === 'mainnet' ? phoenixTraderApi(phoenixUrl, f) : null;
  const ox = o.orderly;
  const orderlyFunding = ox?.fundingFees === undefined ? null
    : orderlyBookFunding(new OrderlyReader({ network: o.network, fetch: f, fundingFees: ox.fundingFees, ...(ox.apiUrl === undefined ? {} : { apiUrl: ox.apiUrl }) }));
  const orderlyFills = ox?.fills ?? null;
  // An Orderly leg's fills without the session's log are unknown, never "none": a failed read the book holds and retries.
  const orderlyLog = (): OrderlyFillLog => {
    if (orderlyFills === null) throw new Error('orderly: no fill log (the private session is not open)');
    return orderlyFills;
  };
  return {
    funding: { hyperliquid: hl, ...(phoenix === null ? {} : { phoenix }), ...(orderlyFunding === null ? {} : { orderly: orderlyFunding }) },
    hlLedger: (user, startTime, endTime) => hlNonFundingLedger(f, infoUrl, user, startTime, endTime),
    fillFee: async (q) => {
      if (q.venue === 'hyperliquid') return hlFillFee(f, infoUrl, q);
      if (q.venue === 'phoenix' && phoenixApi !== null) return phoenixFillFee(phoenixApi, q);
      if (q.venue === 'orderly') return orderlyLog().fillFee(q);
      return null;
    },
    hlTxRef: (hash: string): TxRef => hyperliquidTxRef(o.network, hash),
    closeFills: async (q) => {
      if (q.venue === 'hyperliquid') return hlCloseFills(f, infoUrl, q);
      if (q.venue === 'phoenix' && phoenixApi !== null) return phoenixCloseFills(phoenixApi, q);
      if (q.venue === 'orderly') return orderlyLog().readCloseFills(q, ox?.hearWaitMs);
      return null;
    },
  };
}
