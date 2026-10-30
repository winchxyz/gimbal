// The Hyperliquid smoke check: live reads, no keys. Prints ETH funding and the top of the ETH book.

import type { HyperliquidReader } from '../venues/hyperliquid.ts';
import type { BookLevel } from '../venues/venue.ts';

const COIN = 'ETH';
const LEVELS = 5;

export async function smokeHl(reader: HyperliquidReader, log: (line: string) => void = console.log): Promise<void> {
  // The asset index comes from the venue's own list: it differs per network (ETH is 1 on mainnet, 4 on testnet).
  const [markets, funding, book] = await Promise.all([reader.markets(), reader.funding(), reader.book(COIN, LEVELS)]);
  const market = markets.find((m) => m.symbol === COIN);
  const rate = funding.find((f) => f.symbol === COIN);
  if (market === undefined) throw new Error(`hyperliquid ${reader.network}: no ${COIN} market in the universe`);
  if (rate === undefined) throw new Error(`hyperliquid ${reader.network}: no ${COIN} funding row (delisted?)`);

  const perHour = rate.ratePerHour;
  const aprPct = perHour * 24 * 365 * 100;
  log(`Hyperliquid ${reader.network}  ${reader.infoUrl}`);
  log(`${COIN}  asset index ${market.assetIndex}, ${market.szDecimals} size decimals, max leverage ${market.maxLeverage}x`);
  log(`funding  ${perHour.toFixed(10)} per hour (${(perHour * 100).toFixed(6)} %/h)   APR ${aprPct.toFixed(2)} %   `
    + `${perHour === 0 ? 'flat' : perHour > 0 ? 'longs pay shorts' : 'shorts pay longs'}   next payment ${new Date(rate.nextAt).toISOString()}`);
  log(`prices   mark ${rate.markPx ?? 'n/a'}   oracle ${rate.oraclePx ?? 'n/a'}`);
  log(`${COIN} book at ${new Date(book.time).toISOString()}, top ${LEVELS} levels per side`);
  log(`  ${'bid px'.padStart(10)} ${'bid size'.padStart(12)}   ${'ask px'.padStart(10)} ${'ask size'.padStart(12)}`);
  for (let i = 0; i < LEVELS; i++) {
    log(`  ${cell(book.bids[i])}   ${cell(book.asks[i])}`);
  }
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (bid !== undefined && ask !== undefined) {
    log(`spread   ${(ask.px - bid.px).toFixed(4)} (${(((ask.px - bid.px) / ((ask.px + bid.px) / 2)) * 1e4).toFixed(2)} bps)`);
  }
}

function cell(level: BookLevel | undefined): string {
  return level === undefined ? ' '.repeat(23) : `${String(level.px).padStart(10)} ${String(level.sz).padStart(12)}`;
}
