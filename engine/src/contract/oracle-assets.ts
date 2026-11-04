// The assets the contract prices (contract/core/src/oracle.rs ORACLE_ASSETS), by ticker: their OutLayer token ids.
// refresh_prices can store a price for these symbols only; any other symbol trades only through policy.unpriced.

export const ORACLE_ASSETS: Readonly<Record<string, string>> = {
  ETH: 'eth.bridge.near',
  BTC: 'nbtc.bridge.near',
  SOL: '22.contract.portalbridge.near',
  DOGE: 'doge.omft.near',
  LTC: 'ltc.omft.near',
  XLM: 'xlm',
  ZEC: 'zec.omft.near',
};

/** Whether refresh_prices can store a price for `symbol` (a policy symbol, as the contract spells it). */
export function oraclePriced(symbol: string): boolean {
  return Object.hasOwn(ORACLE_ASSETS, symbol);
}
