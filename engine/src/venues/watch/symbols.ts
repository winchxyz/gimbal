// The cross-venue key the scanner pairs on (MarketFunding.base) and how many base units one unit of a venue's
// symbol is (MarketFunding.multiplier). Each reader strips its own venue's quote and suffixes first
// ("BTC-USDT-SWAP" -> "BTC", "PF_XBTUSD" -> "XBT", "xyz:TSLA" -> "TSLA"); this file does what is common to all:
// size prefixes, equity suffixes, aliases.

/** Names for the same asset; the scanner's price check (mark vs the median of the other venues) catches a miss. */
export const BASE_ALIASES: Readonly<Record<string, string>> = {
  XBT: 'BTC',
  US500: 'SPX500', SP500: 'SPX500', SPX500M: 'SPX500',
  US100: 'NDX100', NAS100: 'NDX100', TECH100M: 'NDX100', NDX: 'NDX100',
  JPN225: 'JP225',
  GOLD: 'XAU', SILVER: 'XAG', PLATINUM: 'XPT', PALLADIUM: 'XPD',
  USOIL: 'WTI', WTIOIL: 'WTI', CL: 'WTI',
  UKOIL: 'BRENT', BRENTOIL: 'BRENT', XBR: 'BRENT', BZ: 'BRENT',
  NG: 'NATGAS', XNG: 'NATGAS',
  SPX6900: 'SPX',                // the memecoin most venues list as SPX; the index is SPX500
};

export interface NormalizedBase {
  base: string;
  multiplier: number;            // base units per unit of the venue's symbol: 1000 for "kPEPE" and "1000PEPE"
}

/**
 * A venue's base name (quote already stripped) to the shared key: size prefixes `k`, `1000`, `10000`,
 * `100000`, `1000000`, `1M` and the Bybit-style suffix `SHIB1000` become a multiplier; Extended's `_24_5` and
 * Backpack's `.US` equity suffixes are dropped, and the `STOCK` suffix where the venue uses one (`stockSuffix`:
 * MEXC and Bitget); then aliases apply.
 */
export function normalizeBase(raw: string, options: NormalizeOptions = {}): NormalizedBase {
  let s = raw.trim().replace(/_24_5$/, '').replace(/\.US$/i, '');
  let multiplier = 1;
  let m: RegExpExecArray | null;
  if ((m = /^k([A-Z0-9][A-Za-z0-9]*)$/.exec(s)) !== null) {
    multiplier = 1000;
    s = m[1]!;
  } else if ((m = /^(1000000|100000|10000|1000)([A-Za-z][A-Za-z0-9]*)$/.exec(s)) !== null) {
    multiplier = Number(m[1]);
    s = m[2]!;
  } else if ((m = /^1M([A-Z]{2,}[A-Za-z0-9]*)$/.exec(s)) !== null) {
    multiplier = 1_000_000;
    s = m[1]!;
  } else if ((m = /^([A-Za-z]{2,})1000$/.exec(s)) !== null) {
    multiplier = 1000;
    s = m[1]!;
  }
  s = s.toUpperCase();
  // One letter is a whole ticker (CSTOCK is Citigroup, VSTOCK Visa, TSTOCK AT&T). A coin of the same name (MEXC's
  // C_USDT, Chainbase) then shares the base: filterLegs keeps the listing whose mark agrees with the other venues',
  // and a stock listing names a leg's market only when their marks agree (quality.ts). A digit first is a coin's own
  // name (MEXC's 4STOCK_USDT). Only where the venue marks its stocks so: Aster's GSTOCKUSDT is a coin.
  if (options.stockSuffix === true && (m = /^([A-Z]+)STOCK$/.exec(s)) !== null) s = m[1]!;
  return { base: BASE_ALIASES[s] ?? s, multiplier };
}

export interface NormalizeOptions {
  /** The venue names its stock perps `<ticker>STOCK` (MEXC's TSLASTOCK_USDT, Bitget's TSLASTOCKUSDT). */
  stockSuffix?: boolean;
}

/** `base` always, `multiplier` only when it is not 1 (absent means 1 in MarketFunding). */
export function baseFields(raw: string, options: NormalizeOptions = {}): { base: string; multiplier?: number } {
  const { base, multiplier } = normalizeBase(raw, options);
  return multiplier === 1 ? { base } : { base, multiplier };
}

/** Splits a quote currency off the end of a concatenated symbol ("BTCUSDT" -> BTC + USDT); null when none fits. */
export function splitQuote(symbol: string, quotes: readonly string[] = ['USDT', 'USDC', 'USD1', 'USD']): { base: string; quote: string } | null {
  for (const quote of quotes) {
    if (symbol.length > quote.length && symbol.endsWith(quote)) return { base: symbol.slice(0, -quote.length), quote };
  }
  return null;
}
