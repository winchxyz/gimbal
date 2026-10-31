// The cross-venue key a market is paired on (MarketFunding.base) and how many base units one unit of the venue's
// symbol is (MarketFunding.multiplier). Each tradable reader maps its own symbols here, explicitly.

export interface BaseKey {
  base: string;
  multiplier: number;            // base units per unit of the venue's symbol; 1 for a plain listing
}

/**
 * Hyperliquid and Phoenix list small-priced coins per thousand under a lowercase "k": "kPEPE" is 1000 PEPE
 * (marks on 2026-10-31: HL kPEPE 0.004969, Phoenix kPEPE 0.004974, Orderly 1000PEPE 0.0049573). Anything else is
 * its own base. The "k" must be followed by an upper-case letter or digit, so a plain name is never cut.
 */
export function kiloBase(symbol: string): BaseKey {
  const m = /^k([A-Z0-9][A-Z0-9]*)$/.exec(symbol);
  return m === null ? { base: symbol, multiplier: 1 } : { base: m[1]!, multiplier: 1000 };
}

/** The `base` / `multiplier` fields of a MarketFunding row: base always, multiplier only when it is not 1. */
export function baseFields(key: BaseKey): { base: string; multiplier?: number } {
  return key.multiplier === 1 ? { base: key.base } : { base: key.base, multiplier: key.multiplier };
}
