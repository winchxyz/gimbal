// Shared by the book's tests: the synthetic ledger fixture (fixtures/book/ledgers-SYNTHETIC.json, the venues' wire
// shapes, parsed by the venues' own parsers) and the records of one rotation, XLM into SOL.

import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FundingHourlyEvent } from '@ellipsis-labs/rise';
import type { HlFundingRow } from '../venues/hyperliquid.ts';
import { parseFundingRow } from '../venues/hyperliquid.ts';
import { parseFundingEvent } from '../venues/phoenix.ts';
import type { FundingPayment } from '../venues/venue.ts';
import type { BookSources } from './sync.ts';
import type { BookRecord, HlLedgerRow } from './types.ts';

export const H = 3_600_000;
export const T0 = Date.UTC(2026, 10, 2, 10, 0);   // 2026-11-02 10:00 UTC
export const XLM = 'xlm-phoenix-hyperliquid';
export const SOL = 'sol-phoenix-hyperliquid';

export interface LedgerFixture {
  hyperliquidAddress: string;
  phoenixAuthority: string;
  hyperliquid: { userFunding: HlFundingRow[] };
  phoenix: { fundingHistory: FundingHourlyEvent[] };
  hyperliquidLedger: HlLedgerRow[];
}

export function ledgerFixture(): LedgerFixture {
  return JSON.parse(readFileSync(new URL('../../fixtures/book/ledgers-SYNTHETIC.json', import.meta.url), 'utf8')) as LedgerFixture;
}

export function tempDir(dirs: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'gimbal-book-'));
  dirs.push(d);
  return d;
}

/** A ledger over the fixture's rows (mutable: tests add or drop rows between syncs), with the ranges it was asked. */
export class FixtureLedger {
  readonly asked: { start: number; end: number | undefined }[] = [];
  rows: FundingPayment[];
  fail: Error | null = null;
  constructor(rows: FundingPayment[]) {
    this.rows = rows;
  }
  async userFunding(_address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> {
    this.asked.push({ start: startTime, end: endTime });
    if (this.fail !== null) throw this.fail;
    return this.rows.filter((r) => r.time >= startTime && (endTime === undefined || r.time <= endTime)).sort((a, b) => a.time - b.time);
  }
}

export function fixtureSources(f = ledgerFixture(), fillFee: BookSources['fillFee'] = undefined) {
  const hl = new FixtureLedger(f.hyperliquid.userFunding.map(parseFundingRow));
  const phoenix = new FixtureLedger(f.phoenix.fundingHistory.map(parseFundingEvent));
  const sources: BookSources = {
    funding: { hyperliquid: hl, phoenix },
    hlLedger: async (_user, start, end) => f.hyperliquidLedger.filter((r) => r.time >= start && r.time <= end),
    hlTxRef: (hash) => ({ chain: 'hyperliquid', id: hash, url: `https://app.hyperliquid.xyz/explorer/tx/${hash}` }),
    ...(fillFee === undefined ? {} : { fillFee }),
  };
  return { hl, phoenix, sources, addresses: { hyperliquid: f.hyperliquidAddress, phoenix: f.phoenixAuthority } };
}

const tx = (chain: 'hyperliquid' | 'solana', id: string) => ({ chain, id, url: `https://example.invalid/${chain}/${id}` });

/** XLM: 4000 a leg, short Hyperliquid at 0.25, long Phoenix at 0.2502, from 10:20; 1000 USD a leg, 500 margin. */
export function enterXlm(): BookRecord {
  return {
    kind: 'enter', windowId: XLM, symbol: 'XLM', at: T0 + 20 * 60_000,
    legs: [
      { venue: 'hyperliquid', side: 'SELL', qty: '4000', avgPx: 0.25, feeUsd: 0.15 },
      { venue: 'phoenix', side: 'BUY', qty: '4000', avgPx: 0.2502, feeUsd: 0.05 },
    ],
    feeUsd: 0.2, tx: [tx('hyperliquid', 'hl-open'), tx('solana', 'px-open')], forecastNetAprPct: 20, exitReason: null,
    rotation: null, by: 'auto', marginMoves: [{ from: 'phoenix', to: 'hyperliquid', usd: 100, feeUsd: 0.32, tx: [] }],
    legUsd: 1000, leverage: 2, marginUsd: 500,
  };
}

/** XLM out at 20:20 (10 h held), rotated into SOL: Hyperliquid bought back at 0.249, Phoenix sold at 0.2493. */
export function exitXlm(): BookRecord {
  return {
    kind: 'exit', windowId: XLM, symbol: 'XLM', at: T0 + 10 * H + 20 * 60_000,
    legs: [
      { venue: 'hyperliquid', side: 'BUY', qty: '4000', avgPx: 0.249, feeUsd: 0.15 },
      { venue: 'phoenix', side: 'SELL', qty: '4000', avgPx: 0.2493, feeUsd: 0.05 },
    ],
    feeUsd: 0.2, tx: [tx('hyperliquid', 'hl-close')], forecastNetAprPct: 20, exitReason: `rotate into ${SOL}`,
    rotation: { fromId: XLM, toId: SOL }, by: 'auto', marginMoves: [],
  };
}

/** SOL in at 20:21: 5 a leg; Phoenix did not report its fill's fee. */
export function enterSol(): BookRecord {
  return {
    kind: 'enter', windowId: SOL, symbol: 'SOL', at: T0 + 10 * H + 21 * 60_000,
    legs: [
      { venue: 'hyperliquid', side: 'SELL', qty: '5', avgPx: 200, feeUsd: 0.1 },
      { venue: 'phoenix', side: 'BUY', qty: '5', avgPx: 200.1, feeUsd: null },
    ],
    feeUsd: 0.1, tx: [tx('hyperliquid', 'hl-open-sol'), tx('solana', 'px-open-sol')], forecastNetAprPct: 25, exitReason: null,
    rotation: { fromId: XLM, toId: SOL }, by: 'auto', marginMoves: [],
  };
}
