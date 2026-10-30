// Mock data shared by every direction, so the line-up compares design, not numbers.
// Example data with realistic magnitudes; no real accounts, addresses or ids.
window.GIMBAL = {
  network: 'mainnet',
  owner: 'demo-owner.near',
  desk: 'desk-07',
  now: '27 Oct 2026 · 14:02 UTC',

  scan: { venues: 32, tradable: 3, coins: 1041, markets: 8289, seconds: 2.4, updated: '2 s ago' },
  rule: { minNet: 5, maxLegUsd: 1500, maxLev: 3 },

  // longEarn + shortEarn = gross; gross − costs = net; all APR %, depth is $ within 50 bps on the thinner side
  windows: [
    { asset: 'DOGE', long: 'Phoenix', short: 'Hyperliquid', longEarn: 16.1, shortEarn: 2.3, gross: 18.4, gross7: 16.9, costs: 4.6, net: 13.8, depth: 41000, ai: 'pass', aiNote: 'Spread held for 13 straight weeks. Phoenix book is thin: keep each leg under $1,500.', spark: [12, 14, 13, 17, 15, 18, 16, 19, 17, 18, 18.4], status: 'open' },
    { asset: 'NEAR', long: 'Phoenix', short: 'Orderly', longEarn: 9.8, shortEarn: 2.6, gross: 12.4, gross7: 11.1, costs: 4.4, net: 8.0, depth: 182000, ai: 'pass', aiNote: 'Both books deep enough for the cap. Funding timing matches within the hour.', spark: [8, 9, 10, 9, 11, 12, 11, 12, 13, 12, 12.4] },
    { asset: 'AVAX', long: 'Orderly', short: 'Hyperliquid', longEarn: 3.1, shortEarn: 9.0, gross: 12.1, gross7: 3.4, costs: 3.0, net: 9.1, depth: 264000, ai: 'veto', aiNote: 'One 8-hour spike. The 7-day median gap is 1.2%, so the window is likely to close before fees are earned back.', spark: [1, 1, 2, 1, 1, 2, 1, 2, 1, 6, 12.1] },
    { asset: 'SOL', long: 'Phoenix', short: 'Orderly', longEarn: 8.2, shortEarn: 3.7, gross: 11.9, gross7: 10.2, costs: 3.3, net: 8.6, depth: 1240000, ai: 'pass', aiNote: 'Deepest window on the list. Lower carry, lowest rescue risk.', spark: [9, 10, 9, 11, 10, 10, 11, 12, 11, 12, 11.9] },
    { asset: 'LTC', long: 'Phoenix', short: 'Hyperliquid', longEarn: 7.4, shortEarn: 3.2, gross: 10.6, gross7: 9.8, costs: 3.7, net: 6.9, depth: 58000, ai: 'pass', aiNote: 'Steady for 9 weeks. Next in line if DOGE compresses.', spark: [9, 9, 10, 10, 9, 10, 11, 10, 10, 11, 10.6] },
    { asset: 'ZRO', long: 'Hyperliquid', short: 'Orderly', longEarn: 30.2, shortEarn: 9.1, gross: 39.3, gross7: 31.0, costs: 4.1, net: 35.2, depth: 22000, ai: null, refused: 'No trusted oracle price for ZRO. Unpriced assets need your opt-in.', spark: [22, 25, 30, 28, 33, 31, 36, 34, 38, 37, 39.3] },
    { asset: 'BTC', long: 'Phoenix', short: 'Hyperliquid', longEarn: 4.1, shortEarn: 1.9, gross: 6.0, gross7: 5.2, costs: 3.9, net: 2.1, depth: 3800000, ai: 'pass', aiNote: 'Safe but below your 5% rule after costs.', spark: [5, 5, 6, 5, 4, 5, 6, 5, 5, 6, 6.0] },
    { asset: 'ETH', long: 'Hyperliquid', short: 'Phoenix', longEarn: 1.2, shortEarn: 0.4, gross: 1.6, gross7: 1.9, costs: 4.0, net: -2.4, depth: 2900000, ai: 'pass', aiNote: 'Costs exceed the gap.', spark: [2, 2, 1, 2, 2, 1, 2, 2, 1, 2, 1.6] },
  ],

  // watch-only: the scanner reads these venues but the desk cannot trade there
  watch: [
    { asset: 'XMR', long: 'Lighter', short: 'Hyperliquid', gross: 55.1, gross7: 48.7, depth: 96000 },
    { asset: 'NEAR', long: 'Extended', short: 'Hyperliquid', gross: 33.4, gross7: 29.0, depth: 140000 },
    { asset: 'WIF', long: 'Aster', short: 'Binance', gross: 27.8, gross7: 18.2, depth: 410000 },
    { asset: 'TIA', long: 'Paradex', short: 'Bybit', gross: 21.5, gross7: 19.9, depth: 230000 },
    { asset: 'SUI', long: 'GMX', short: 'dYdX', gross: 17.2, gross7: 15.0, depth: 75000 },
  ],

  costs: [ // the selected window's cost waterfall, APR %
    { k: 'Trading fees · 4 fills', v: 1.6 },
    { k: 'Slippage at $1,200', v: 0.9 },
    { k: 'Funding timing', v: 0.3 },
    { k: 'Rescue reserve · Intents', v: 1.4 },
    { k: 'Gas + signatures', v: 0.4 },
  ],

  position: {
    window: 'DOGE · long Phoenix · short Hyperliquid',
    opened: '2 d 14 h ago',
    health: 'ok', // ok | watch | rescue
    netDelta: 0, netDeltaUsd: 0.0,
    thresholds: { watch: 15, rescue: 8 }, // % distance to liquidation
    legs: [
      { side: 'Short', venue: 'Hyperliquid', chain: 'EVM · secp256k1', size: -6040, entry: 0.19861, mark: 0.19842, notional: 1198.46, margin: 482.10, ratio: 31, liq: 0.26314, dist: 32.6, funding: 0.31, fees: 0.48 },
      { side: 'Long', venue: 'Phoenix', chain: 'Solana · Ed25519', size: 6040, entry: 0.19873, mark: 0.19846, notional: 1198.70, margin: 476.50, ratio: 33, liq: 0.13512, dist: 31.9, funding: 1.05, fees: 0.99 },
    ],
    funding: 1.36, fees: 1.47, basis: -0.48, pnl: -0.59, breakeven: '23 h', runningNet: 13.8,
    orders: [
      { t: '24 Oct 23:41:07', venue: 'Hyperliquid', what: 'Sell 6,040 DOGE · IOC', px: 0.19861, guard: true, sig: '5.8 s' },
      { t: '24 Oct 23:41:08', venue: 'Phoenix', what: 'Buy 6,040 DOGE · market', px: 0.19873, guard: true, sig: '6.4 s' },
      { t: '24 Oct 23:39:52', venue: 'Phoenix', what: 'Close LTC long · market', px: 61.214, guard: false, why: 'Oracle 74 s old, past the 60 s limit. Sent reduce-only without a price band.', sig: '7.1 s' },
      { t: '24 Oct 23:39:51', venue: 'Hyperliquid', what: 'Close LTC short · IOC', px: 61.198, guard: true, sig: '6.0 s' },
    ],
  },
};

window.fmt = {
  pct: (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + '%',
  pctPlain: (v, d = 1) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + '%',
  usd: (v, d = 2) => (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
  usdS: (v) => (v < 0 ? '−' : v > 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2),
  depth: (v) => v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + Math.round(v / 1e3) + 'k',
  num: (v, d = 0) => (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
  spark: (pts, w, h, pad = 2) => {
    const mn = Math.min(...pts), mx = Math.max(...pts), r = mx - mn || 1;
    return pts.map((p, i) => `${(pad + i * (w - 2 * pad) / (pts.length - 1)).toFixed(1)},${(h - pad - (p - mn) / r * (h - 2 * pad)).toFixed(1)}`).join(' ');
  },
};
