// The names venues are shown under in the scanner's check texts. Ids stay lowercase and machine-shaped
// ("gmx-arbitrum", "hl-para"); a check is read by the owner, who knows the venues by their own names.

import type { ScanVenueId } from '@gimbal/shared';

const NAMES: Readonly<Record<string, string>> = {
  hyperliquid: 'Hyperliquid',
  phoenix: 'Phoenix',
  orderly: 'Orderly',
  // The HIP-3 builder dexes on Hyperliquid. xyz is trade.xyz's; the others go by their dex name.
  'hl-xyz': 'trade.xyz',
  'hl-para': "Hyperliquid's para dex",
  'hl-mkts': "Hyperliquid's mkts dex",
  'hl-io': "Hyperliquid's io dex",
  pacifica: 'Pacifica',
  lighter: 'Lighter',
  extended: 'Extended',
  paradex: 'Paradex',
  aster: 'Aster',
  dydx: 'dYdX',
  nado: 'Nado',
  aevo: 'Aevo',
  variational: 'Variational',
  'gmx-arbitrum': 'GMX (Arbitrum)',
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
  bitget: 'Bitget',
  gate: 'Gate',
  kucoin: 'KuCoin',
  mexc: 'MEXC',
  kraken: 'Kraken',
  backpack: 'Backpack',
};

/** A venue's display name; an id without one (a venue added later) is shown as it is rather than guessed at. */
export function venueName(id: ScanVenueId): string {
  return NAMES[id] ?? id;
}

/** `A`, `A and B`, `A, B and C`, by display name. */
export function venueNames(ids: readonly ScanVenueId[]): string {
  const names = ids.map(venueName);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
