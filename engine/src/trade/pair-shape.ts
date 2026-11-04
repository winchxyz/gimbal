// Which two venues a pair trades and which leg is long. Until Orderly pairs, serve's pair was always short
// Hyperliquid, long Phoenix; with GIMBAL_ORDERLY_PAIRS=1 any two of Hyperliquid, Orderly and Phoenix may pair, in the
// direction the window pays. The flag is off by default: then only that first shape is built or opened.
//
// The trader's legs are in a fixed venue order, Hyperliquid first and Phoenix last (index 0, 1): short Hyperliquid /
// long Phoenix keeps the indices it always had, and Hyperliquid, the only leg that works a post-only order, is index 0
// whenever it is a leg. Each leg names its venue's own market: hyperliquid SOL, orderly PERP_SOL_USDC, phoenix SOL.
// An Orderly leg is the shared market PERP_<symbol>_USDC only, so the contract's oracle key for it (core/src/orderly.rs
// base_of) is the pair's symbol, the stored price every leg of the pair is checked against.

import type { ContractPolicy, VenueId } from '@gimbal/shared';

/** serve and pair-mainnet build or open a pair other than short Hyperliquid / long Phoenix only with this set to 1. */
export const ORDERLY_PAIRS_ENV = 'GIMBAL_ORDERLY_PAIRS';

export function orderlyPairsOn(env: (name: string) => string | undefined): boolean {
  return env(ORDERLY_PAIRS_ENV) === '1';
}

/** One leg: its venue and the venue's name of the market. */
export interface PairLeg {
  venue: VenueId;
  symbol: string;
}

/** The pair's two legs in the trader's order (index 0, 1), and which one is long. */
export interface PairShape {
  legs: [PairLeg, PairLeg];
  longIndex: 0 | 1;
}

export const PAIR_VENUES: readonly VenueId[] = ['hyperliquid', 'orderly', 'phoenix'];

/** The venue's name of the pair `symbol`'s market (the policy's spelling: kPEPE, PERP_SOL_USDC). */
export function venueSymbol(venue: VenueId, symbol: string): string {
  return venue === 'orderly' ? `PERP_${symbol}_USDC` : symbol;
}

/** The pair `symbol` long on `long`, short on `short`, legs in the trader's order. Throws for one venue twice. */
export function pairShape(symbol: string, long: VenueId, short: VenueId): PairShape {
  if (long === short) throw new Error(`a pair needs two venues, not ${long} twice`);
  for (const v of [long, short]) if (!PAIR_VENUES.includes(v)) throw new Error(`${String(v)} is not a pair venue (${PAIR_VENUES.join(', ')})`);
  const [a, b] = [long, short].sort((x, y) => PAIR_VENUES.indexOf(x) - PAIR_VENUES.indexOf(y)) as [VenueId, VenueId];
  return { legs: [{ venue: a, symbol: venueSymbol(a, symbol) }, { venue: b, symbol: venueSymbol(b, symbol) }], longIndex: a === long ? 0 : 1 };
}

/** The only pair before Orderly pairs, and what a state file without legs means: short Hyperliquid, long Phoenix. */
export function defaultShape(symbol: string): PairShape {
  return pairShape(symbol, 'phoenix', 'hyperliquid');
}

export function sameShape(a: PairShape, b: PairShape): boolean {
  return a.longIndex === b.longIndex && a.legs.every((l, i) => l.venue === b.legs[i].venue && l.symbol === b.legs[i].symbol);
}

export function isDefaultShape(s: PairShape, symbol: string): boolean {
  return sameShape(s, defaultShape(symbol));
}

export function longLeg(s: PairShape): PairLeg {
  return s.legs[s.longIndex];
}

export function shortLeg(s: PairShape): PairLeg {
  return s.legs[s.longIndex === 0 ? 1 : 0];
}

/** "short hyperliquid SOL, long orderly PERP_SOL_USDC". */
export function shapeText(s: PairShape): string {
  const l = longLeg(s);
  const h = shortLeg(s);
  return `short ${h.venue} ${h.symbol}, long ${l.venue} ${l.symbol}`;
}

/** Hyperliquid's index when it is a leg: it goes first, post-only; null: no maker leg, both legs IOC at once. */
export function makerIndexOf(s: PairShape): 0 | 1 | null {
  const i = s.legs.findIndex((l) => l.venue === 'hyperliquid');
  return i === -1 ? null : (i as 0 | 1);
}

/** The index of the leg on `venue`, or null. */
export function indexOf(s: PairShape, venue: VenueId): 0 | 1 | null {
  const i = s.legs.findIndex((l) => l.venue === venue);
  return i === -1 ? null : (i as 0 | 1);
}

/** Whether the policy lists the pair `symbol`'s market on `venue`. */
export function policyLists(policy: Pick<ContractPolicy, 'hl_assets' | 'phoenix_markets' | 'orderly_symbols'>, venue: VenueId, symbol: string): boolean {
  if (venue === 'hyperliquid') return policy.hl_assets.some((a) => a.symbol === symbol);
  if (venue === 'phoenix') return policy.phoenix_markets.some((m) => m.symbol === symbol);
  return (policy.orderly_symbols ?? []).includes(venueSymbol('orderly', symbol));
}

/**
 * The policy symbols a pair long `long` / short `short` can be opened on: both venues list it (Orderly's
 * PERP_<symbol>_USDC in orderly_symbols). In the policy's order (hl_assets, then phoenix_markets, then orderly_symbols);
 * none when the two venues are not a pair.
 * Known limit: a pair with an Orderly leg matches by name only (venueSymbol), so a market Orderly names otherwise is
 * never paired: Hyperliquid's kPEPE is Orderly's PERP_1000PEPE_USDC, its GOLD is PERP_XAU_USDC (the book maps those,
 * book/orderly.ts orderlyBookSymbol; the trader does not).
 */
export function pairSymbols(policy: Pick<ContractPolicy, 'hl_assets' | 'phoenix_markets' | 'orderly_symbols'>, long: VenueId, short: VenueId): string[] {
  if (long === short || !PAIR_VENUES.includes(long) || !PAIR_VENUES.includes(short)) return [];
  const all = [
    ...policy.hl_assets.map((a) => a.symbol), ...policy.phoenix_markets.map((m) => m.symbol),
    ...(policy.orderly_symbols ?? []).map((m) => /^PERP_([A-Za-z0-9]+)_USDC$/.exec(m)?.[1]).filter((x): x is string => x !== undefined),
  ];
  return [...new Set(all)].filter((s) => policyLists(policy, long, s) && policyLists(policy, short, s));
}

/**
 * Why `shape` may not be built or opened for `symbol`, or null: a shape other than short Hyperliquid / long Phoenix
 * while GIMBAL_ORDERLY_PAIRS is not 1, legs that are not `symbol`'s markets in the trader's order, or a market the
 * policy does not list.
 */
export function shapeRefusal(policy: Pick<ContractPolicy, 'hl_assets' | 'phoenix_markets' | 'orderly_symbols'>, symbol: string, shape: PairShape, orderlyPairs: boolean): string | null {
  if (!orderlyPairs && !isDefaultShape(shape, symbol)) {
    return `${shapeText(shape)}: only short hyperliquid / long phoenix trades while ${ORDERLY_PAIRS_ENV} is not 1`;
  }
  let want: PairShape;
  try {
    want = pairShape(symbol, longLeg(shape).venue, shortLeg(shape).venue);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (!sameShape(want, shape)) return `${shapeText(shape)} is not ${symbol}'s pair as the trader orders it (${shapeText(want)})`;
  const missing = shape.legs.filter((l) => !policyLists(policy, l.venue, symbol));
  if (missing.length > 0) return `the policy does not list ${missing.map((l) => `${l.venue} ${l.symbol}`).join(' or ')}`;
  return null;
}
