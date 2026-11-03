// Read-only: the scanner's desk windows for a few symbols, each with its funding per leg (now, 7 d, 14 d), the round
// trip at the leg size, the spread expected over the hold and the scanner's refusals. Live public reads, no keys, no
// contract, nothing written anywhere.
//   npm run windows -w engine -- [--mainnet] [--venues hyperliquid,phoenix] [--symbols DOGE,LTC,XLM] [--leg-usd 20]
//                                [--policy <ContractPolicy.json>]
// --mainnet       Hyperliquid and Orderly mainnet (default testnet); Phoenix is always mainnet (no public testnet)
// --venues        two or more desk venues, default all three
// --symbols       bases to show (as the scanner pairs them: DOGE, not PERP_DOGE_USDC); default every common base
// --leg-usd       notional per leg, default the engine rules' default
// --policy        a ContractPolicy (get_desk's policy) to check the windows against; without it every window is
//                 refused E_NO_DESK. With one, E_ORACLE_STALE is expected: there is no contract to store prices.

import { parseArgs } from 'node:util';
import { holdLabel } from '../scanner/carry.ts';
import { DEFAULT_STRATEGY, scannerConfigFor } from '../scanner/config.ts';
import { Scanner } from '../scanner/scanner.ts';
import { HyperliquidReader } from '../venues/hyperliquid.ts';
import { OrderlyReader } from '../venues/orderly.ts';
import { PhoenixReader } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Book, Market, MarketFunding, MarketFundingPoint, MarketHistorySource, VenueReader } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import { loadPolicyFile } from './serve-replay.ts';
import { WINDOWS_USAGE, windowBlock, windowsOptions } from './windows-report.ts';

/** A desk reader that answers funding for some bases only, so the scanner prices and reads history for those alone. */
class OnlyBases implements VenueReader, MarketHistorySource {
  readonly id: VenueReader['id'];
  readonly #inner: VenueReader & MarketHistorySource;
  readonly #bases: ReadonlySet<string> | null;

  constructor(inner: VenueReader & MarketHistorySource, bases: readonly string[] | null) {
    this.id = inner.id;
    this.#inner = inner;
    this.#bases = bases === null ? null : new Set(bases);
  }

  markets(): Promise<Market[]> { return this.#inner.markets(); }
  account(address: string) { return this.#inner.account(address); }
  userFunding(address: string, startTime: number, endTime?: number) { return this.#inner.userFunding(address, startTime, endTime); }
  book(symbol: string, depth?: number): Promise<Book> { return this.#inner.book(symbol, depth); }
  marketFundingHistory(symbol: string, startTime: number, endTime: number): Promise<MarketFundingPoint[]> {
    return this.#inner.marketFundingHistory(symbol, startTime, endTime);
  }

  async funding(): Promise<MarketFunding[]> {
    const rows = await this.#inner.funding();
    const bases = this.#bases;
    return bases === null ? rows : rows.filter((r) => bases.has((r.base ?? r.symbol).toUpperCase()));
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    mainnet: { type: 'boolean', default: false },
    venues: { type: 'string' },
    symbols: { type: 'string' },
    'leg-usd': { type: 'string' },
    policy: { type: 'string' },
  },
});

let opts;
let policy = null;
try {
  opts = windowsOptions(values, DEFAULT_STRATEGY.legUsd);
  if (opts.policyFile !== null) policy = loadPolicyFile(opts.policyFile);
} catch (err) {
  fail(`${errorMessage(err)}\n${WINDOWS_USAGE}`);
}

const { network } = opts;
const phoenix = new PhoenixReader();
const orderly = new OrderlyReader({ network });
const all = { hyperliquid: new HyperliquidReader({ network }), phoenix, orderly };
const venues = opts.venues.map((v) => new OnlyBases(all[v], opts.symbols));
const strategy = { ...DEFAULT_STRATEGY, legUsd: opts.legUsd };
// Every history read a scan needs at once: this runs a few scans, not a server's every 5 s.
const config = { ...scannerConfigFor(network), policy, historyPerScan: 200 };
const notes: string[] = [];
const scanner = new Scanner(venues, [], { config, clock: systemClock, strategy: () => strategy, onNote: (n) => notes.push(n) });

let code = 0;
try {
  // History arrives in the background: scan until a scan starts no more reads (it then saw all of them). The first
  // reads bring each leg's week; the next, the week before it (14 d); a pair listed only on its history comes after.
  let r = await scanner.scan();
  for (let round = 0; round < 8 && r.notes.historyReads > 0; round++) {
    await scanner.idle();
    r = await scanner.scan();
  }
  const c = config.costs;
  console.log(`Gimbal windows, ${network} (Phoenix: mainnet), ${opts.venues.join(' x ')}, ${opts.symbols?.join(', ') ?? 'every common base'}, `
    + `${opts.legUsd} USD a leg, ${new Date(r.scan.at).toISOString()}`);
  console.log(`Hold ${holdLabel(c.holdHours)} (assumed: the engine rules set none). Round trip = taker fees on 4 fills + slippage on `
    + `today's books + basis buffer (adverse mark gap + ${c.basisBufferBps} bps). Policy: ${opts.policyFile ?? 'none (E_NO_DESK)'}.`);
  if (r.scan.failed.length > 0) console.log(`Did not answer: ${r.scan.failed.join(', ')}`);
  const desk = r.windows.filter((w) => w.tradable);
  for (const w of desk) {
    const carry = scanner.carry(w.id);
    if (carry === null) continue;
    console.log('');
    for (const line of windowBlock(w, carry)) console.log(line);
  }
  const shown = new Set(desk.map((w) => w.symbol.toUpperCase()));
  const missing = (opts.symbols ?? []).filter((s) => !shown.has(s));
  if (missing.length > 0) {
    console.log('');
    console.log(`No window for ${missing.join(', ')}: not listed on two of these venues, or neither direction's multi-day spread pays (see notes).`);
  }
  if (desk.length === 0 && opts.symbols === null) console.log('No desk window.');
  const dropped = Object.entries(r.notes.dropped).map(([k, n]) => `${k} ${n}`).join(', ');
  if (dropped !== '') console.log(`\nLegs dropped: ${dropped}`);
  for (const u of r.notes.unpriced) console.log(`Not priced: ${u.id}: ${u.reason}`);
  for (const n of [...new Set(notes)]) console.log(`note: ${n}`);
} catch (err) {
  console.error(`windows: ${errorMessage(err)}`);
  code = 1;
} finally {
  phoenix.close();
  orderly.close();
}
process.exit(code);
