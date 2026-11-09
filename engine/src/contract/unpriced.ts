// Which policy.unpriced entry the contract applies to an order on a venue's market, resolved exactly as the contract
// resolves it. Every order is valued by gimbal-core limits.rs check_value under one policy symbol, which is what
// policy.unpriced (and the stored prices) are keyed by:
// - Hyperliquid: the policy asset's own symbol (hl.rs check_order finds hl_assets by index, then uses asset.symbol);
//   the engine names a Hyperliquid market by that symbol (kPEPE), so it is used as it is;
// - Phoenix: the policy market's symbol (phoenix.rs order uses market.symbol); the engine names a Phoenix market by it;
// - Orderly: base_of of the order's symbol (orderly.rs): PERP_<BASE>_USDC -> BASE, any other string as it is. An
//   Orderly market is never looked up by its full name: PERP_ETHFI_USDC is capped by the entry for ETHFI.
// max_sz counts base units of that policy symbol, the size each venue's order carries: Hyperliquid's sz, Phoenix's
// numBaseLots × base_lot_e8, Orderly's quantity (units of PERP_<BASE>_USDC's BASE, e.g. 1000PEPE).

import type { ContractPolicy, VenueId } from '@gimbal/shared';

export type UnpricedAsset = ContractPolicy['unpriced'][number];
export type UnpricedPolicy = Pick<ContractPolicy, 'unpriced' | 'max_notional_usd' | 'unpriced_max_notional_usd'>;

/** core/src/orderly.rs base_of, character for character: "PERP_ETHFI_USDC" -> "ETHFI"; anything else unchanged. */
export function orderlyContractBase(symbol: string): string {
  if (!symbol.startsWith('PERP_')) return symbol;
  const rest = symbol.slice('PERP_'.length);
  return rest.endsWith('_USDC') ? rest.slice(0, -'_USDC'.length) : symbol;
}

/** The policy symbol the contract checks an order on `venue`'s market `symbol` under (see the header). */
export function policySymbolOf(venue: VenueId, symbol: string): string {
  return venue === 'orderly' ? orderlyContractBase(symbol) : symbol;
}

/** limits.rs unpriced_max_sz_e8's lookup: the entry for a policy symbol, if the owner listed it. */
export function unpricedBySymbol(policy: Pick<ContractPolicy, 'unpriced'>, policySymbol: string): UnpricedAsset | undefined {
  return policy.unpriced.find((u) => u.symbol === policySymbol);
}

/** The policy.unpriced entry the contract applies to an order on `venue`'s market `symbol`, or undefined (priced). */
export function unpricedEntry(policy: Pick<ContractPolicy, 'unpriced'>, venue: VenueId, symbol: string): UnpricedAsset | undefined {
  return unpricedBySymbol(policy, policySymbolOf(venue, symbol));
}

/** policy.rs unpriced_cap_usd: an unpriced order fits both notional caps. */
export function unpricedCapUsd(policy: Pick<ContractPolicy, 'max_notional_usd' | 'unpriced_max_notional_usd'>): number {
  return Math.min(policy.max_notional_usd, policy.unpriced_max_notional_usd);
}

/** A leg's caps as the leg classes take them: the notional cap, and an unpriced market's max_sz. */
export interface LegCaps {
  maxNotionalUsd: number;
  maxSz?: string;
}

/** The caps the contract holds an order on `venue`'s market `symbol` to: the unpriced cap and max_sz, or max_notional_usd. */
export function legCaps(policy: UnpricedPolicy, venue: VenueId, symbol: string): LegCaps {
  const u = unpricedEntry(policy, venue, symbol);
  return u === undefined ? { maxNotionalUsd: policy.max_notional_usd } : { maxNotionalUsd: unpricedCapUsd(policy), maxSz: u.max_sz };
}

/** One leg of a pair: its venue and that venue's name of the market (trade/pair-shape.ts PairLeg). */
export interface VenueMarket {
  venue: VenueId;
  symbol: string;
}

/** Whether any leg is priced: the contract checks that leg against a stored price, which must then be fresh. */
export function anyLegPriced(policy: Pick<ContractPolicy, 'unpriced'>, legs: readonly VenueMarket[]): boolean {
  return legs.some((l) => unpricedEntry(policy, l.venue, l.symbol) === undefined);
}

/** The notional cap one size of a pair must fit on every leg: the smallest of the legs' caps. */
export function pairCapUsd(policy: UnpricedPolicy, legs: readonly VenueMarket[]): number {
  return Math.min(policy.max_notional_usd, ...legs.map((l) => legCaps(policy, l.venue, l.symbol).maxNotionalUsd));
}
