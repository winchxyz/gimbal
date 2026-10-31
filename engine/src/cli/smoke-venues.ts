// Smoke checks for Phoenix and Orderly, and SOL funding on all three venues side by side. Live reads, no keys.

import type { HyperliquidReader } from '../venues/hyperliquid.ts';
import type { OrderlyReader } from '../venues/orderly.ts';
import type { PhoenixReader } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Book, BookLevel, MarketFunding, VenueReader } from '../venues/venue.ts';

const LEVELS = 5;
const HOURS_PER_YEAR = 24 * 365;

/** APR in percent from a rate per hour: rate x 24 x 365 x 100 (simple, not compounded). */
export function aprPct(ratePerHour: number): number {
  return ratePerHour * HOURS_PER_YEAR * 100;
}

export async function smokePhoenix(reader: PhoenixReader, log: (line: string) => void = console.log): Promise<void> {
  const symbol = 'SOL';
  const [markets, funding, book] = await Promise.all([reader.markets(), reader.funding(), reader.book(symbol, LEVELS)]);
  const market = markets.find((m) => m.symbol === symbol);
  if (market === undefined) throw new Error(`phoenix: no ${symbol} market`);
  log(`Phoenix mainnet  ${reader.apiUrl}`);
  log(`${symbol}  asset id ${market.assetIndex}, lot ${market.lotSize} ${symbol}, tick ${market.tickSize} USD, max leverage ${market.maxLeverage}x, `
    + `taker ${(market.takerFee * 1e4).toFixed(1)} bps, market ${market.orderbook}`);
  printFunding(funding, symbol, 'last booked hour', log);
  printBook(book, log);
}

export async function smokeOrderly(reader: OrderlyReader, log: (line: string) => void = console.log): Promise<void> {
  const symbol = 'PERP_SOL_USDC';
  const [markets, funding, book] = await Promise.all([reader.markets(), reader.funding(), reader.book(symbol, LEVELS)]);
  const market = markets.find((m) => m.symbol === symbol);
  if (market === undefined) throw new Error(`orderly ${reader.network}: no ${symbol} market`);
  log(`Orderly ${reader.network}  ${reader.apiUrl}`);
  log(`${symbol}  lot ${market.lotSize}, tick ${market.tickSize} USD, max leverage ${market.maxLeverage}x, `
    + `funding every ${market.fundingPeriodHours} h, min notional ${market.minNotional} USD`);
  printFunding(funding, symbol, `estimate for the running ${market.fundingPeriodHours} h period`, log);
  printBook(book, log);
}

export interface SolReaders {
  hyperliquid: HyperliquidReader;
  phoenix: PhoenixReader;
  orderly: OrderlyReader;
}

/** SOL funding per hour and APR on the three venues, one row each; a venue that fails gets its error on its row. */
export async function smokeSol(readers: SolReaders, log: (line: string) => void = console.log): Promise<boolean> {
  const rows: { venue: string; symbol: string; basis: string; reader: VenueReader }[] = [
    { venue: 'hyperliquid', symbol: 'SOL', basis: 'current hour, estimate', reader: readers.hyperliquid },
    { venue: 'phoenix', symbol: 'SOL', basis: 'last hour booked', reader: readers.phoenix },
    { venue: 'orderly', symbol: 'PERP_SOL_USDC', basis: 'running period, estimate', reader: readers.orderly },
  ];
  const results = await Promise.all(rows.map(async (r) => {
    try {
      const f = (await r.reader.funding()).find((x) => x.symbol === r.symbol);
      if (f === undefined) throw new Error(`no ${r.symbol} funding row`);
      return { ...r, f, error: null };
    } catch (err) {
      return { ...r, f: null, error: errorMessage(err) };
    }
  }));
  log('SOL funding, side by side. Rate per hour > 0: longs pay shorts. APR = rate per hour x 24 x 365.');
  log(`${'venue'.padEnd(12)} ${'symbol'.padEnd(14)} ${'per hour'.padStart(13)} ${'APR'.padStart(9)}  ${'pays'.padEnd(7)} ${'mark'.padStart(9)}  ${'next payment'.padEnd(24)} basis`);
  for (const r of results) {
    if (r.f === null) {
      log(`${r.venue.padEnd(12)} ${r.symbol.padEnd(14)} error: ${r.error}`);
      continue;
    }
    log(`${r.venue.padEnd(12)} ${r.symbol.padEnd(14)} ${r.f.ratePerHour.toFixed(10).padStart(13)} ${`${aprPct(r.f.ratePerHour).toFixed(2)} %`.padStart(9)}  `
      + `${r.f.settlement.padEnd(7)} ${String(r.f.markPx ?? 'n/a').padStart(9)}  ${new Date(r.f.nextAt).toISOString().padEnd(24)} ${r.basis}`);
  }
  const ok = results.filter((r) => r.f !== null);
  if (ok.length >= 2) {
    const sorted = [...ok].sort((a, b) => a.f!.ratePerHour - b.f!.ratePerHour);
    const low = sorted[0]!;
    const high = sorted.at(-1)!;
    log(`widest gap  short ${high.venue}, long ${low.venue}: ${aprPct(high.f!.ratePerHour - low.f!.ratePerHour).toFixed(2)} % APR gross, before fees and basis`);
  }
  return ok.length === results.length;
}

function printFunding(funding: MarketFunding[], symbol: string, basis: string, log: (line: string) => void): void {
  const rate = funding.find((f) => f.symbol === symbol);
  if (rate === undefined) throw new Error(`no ${symbol} funding row`);
  const perHour = rate.ratePerHour;
  log(`funding  ${perHour.toFixed(10)} per hour (${(perHour * 100).toFixed(6)} %/h)   APR ${aprPct(perHour).toFixed(2)} %   `
    + `${perHour === 0 ? 'flat' : perHour > 0 ? 'longs pay shorts' : 'shorts pay longs'}   ${basis}, settles ${rate.settlement}, `
    + `next ${new Date(rate.nextAt).toISOString()}`);
  log(`prices   mark ${rate.markPx ?? 'n/a'}   oracle ${rate.oraclePx ?? 'n/a'}   open interest ${rate.openInterest ?? 'n/a'}`);
}

function printBook(book: Book, log: (line: string) => void): void {
  log(`${book.symbol} book at ${new Date(book.time).toISOString()}, top ${LEVELS} levels per side`);
  log(`  ${'bid px'.padStart(10)} ${'bid size'.padStart(12)}   ${'ask px'.padStart(10)} ${'ask size'.padStart(12)}`);
  for (let i = 0; i < LEVELS; i++) log(`  ${cell(book.bids[i])}   ${cell(book.asks[i])}`);
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (bid !== undefined && ask !== undefined) {
    log(`spread   ${(ask.px - bid.px).toFixed(4)} (${(((ask.px - bid.px) / ((ask.px + bid.px) / 2)) * 1e4).toFixed(2)} bps)`);
  }
}

function cell(level: BookLevel | undefined): string {
  return level === undefined ? ' '.repeat(23) : `${String(level.px).padStart(10)} ${String(level.sz).padStart(12)}`;
}
