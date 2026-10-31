// The watch-only venues: read for reference by the scanner, never traded. One reader per venue id, ids lowercase.
// Every reader reads public keyless endpoints only, one bulk sweep of 1-3 calls (plus listing data cached for
// 10 minutes), and its funding() throws a WatchVenueError when the venue does not answer usable market data.

import type { WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { AevoReader } from './aevo.ts';
import { AsterReader } from './aster.ts';
import { BackpackReader } from './backpack.ts';
import { BitgetReader } from './bitget.ts';
import { DydxReader } from './dydx.ts';
import { ExtendedReader } from './extended.ts';
import { GateReader } from './gate.ts';
import { GmxReader } from './gmx.ts';
import { HL_WATCH_DEXES, HlDexReader, HlPredictedFeed, HlPredictedReader } from './hyperliquid.ts';
import { KrakenReader } from './kraken.ts';
import { KucoinReader } from './kucoin.ts';
import { LighterReader } from './lighter.ts';
import { MexcReader } from './mexc.ts';
import { NadoReader } from './nado.ts';
import { OkxReader } from './okx.ts';
import { PacificaReader } from './pacifica.ts';
import { ParadexReader } from './paradex.ts';
import { VariationalReader } from './variational.ts';

export type { WatchReaderOptions } from './http.ts';
export { WatchVenueError } from './http.ts';

/** Every watch venue id, DEX first, in the order watchReaders() returns them. */
export const WATCH_VENUE_IDS = [
  'hl-xyz', 'hl-para', 'hl-mkts', 'hl-io', 'pacifica', 'lighter', 'extended', 'paradex', 'aster', 'dydx', 'nado',
  'aevo', 'variational', 'gmx-arbitrum',
  'binance', 'bybit', 'okx', 'bitget', 'gate', 'kucoin', 'mexc', 'kraken', 'backpack',
] as const;

export type WatchVenueId = (typeof WATCH_VENUE_IDS)[number];

/**
 * One reader per watch venue, all on the same injected fetch and clock. Binance and Bybit share one Hyperliquid
 * `predictedFundings` call per sweep (Hyperliquid relays both venues' next rates), so they carry no open interest.
 */
export function watchReaders(options: WatchReaderOptions = {}): WatchReader[] {
  const predicted = new HlPredictedFeed(options);
  return [
    ...HL_WATCH_DEXES.map((dex) => new HlDexReader(dex, options)),
    new PacificaReader(options),
    new LighterReader(options),
    new ExtendedReader(options),
    new ParadexReader(options),
    new AsterReader(options),
    new DydxReader(options),
    new NadoReader(options),
    new AevoReader(options),
    new VariationalReader(options),
    new GmxReader(options),
    new HlPredictedReader('binance', predicted),
    new HlPredictedReader('bybit', predicted),
    new OkxReader(options),
    new BitgetReader(options),
    new GateReader(options),
    new KucoinReader(options),
    new MexcReader(options),
    new KrakenReader(options),
    new BackpackReader(options),
  ];
}
