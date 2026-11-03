// The live ledgers the book reads (BookSources), over the venues' public read endpoints. Nothing here signs or sends:
// Hyperliquid /info (userFunding through HyperliquidReader, userNonFundingLedgerUpdates, userFillsByTime) and Phoenix's
// public API (funding history through PhoenixReader, trades-history).

import type { TxRef } from '@gimbal/shared';
import { hyperliquidTxRef } from '../relayer/tx.ts';
import { fillsOf, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import { HL_MAINNET_INFO_URL, HL_TESTNET_INFO_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import { PHOENIX_API_URL, PhoenixReader } from '../venues/phoenix.ts';
import type { BookSources, FillFeeQuery } from './sync.ts';
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

interface HlFillRow { coin: string; side: 'B' | 'A'; fee?: string; time: number }

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

/** The fee Phoenix charged for one leg's fills of an act: trades-history rows of the act's Solana transactions. */
export async function phoenixFillFee(api: ReturnType<typeof phoenixTraderApi>, q: FillFeeQuery): Promise<number | null> {
  const sigs = q.tx.filter((t) => t.chain === 'solana').map((t) => t.id);
  if (sigs.length === 0) return null;
  const raw = await api.tradesHistory(q.address, 100);
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
  return {
    funding: { hyperliquid: hl, ...(phoenix === null ? {} : { phoenix }) },
    hlLedger: (user, startTime, endTime) => hlNonFundingLedger(f, infoUrl, user, startTime, endTime),
    fillFee: async (q) => {
      if (q.venue === 'hyperliquid') return hlFillFee(f, infoUrl, q);
      if (q.venue === 'phoenix' && phoenixApi !== null) return phoenixFillFee(phoenixApi, q);
      return null;
    },
    hlTxRef: (hash: string): TxRef => hyperliquidTxRef(o.network, hash),
  };
}
