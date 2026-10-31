// Where an address opens. The origins follow the explorers the dashboard links everywhere else (stream/fake-explorer.ts
// has the same table for transactions): a replay plays recorded mainnet data, so it links the mainnet explorers.
// An address that is not the shape of its chain gets no link rather than a page that says "not found".
import type { Mode } from '@gimbal/shared';
import { isAccountId } from '../journal/entry.ts';

export type Net = 'mainnet' | 'testnet';
export const netOf = (mode: Mode): Net => (mode === 'testnet' ? 'testnet' : 'mainnet');

const isEvmAddress = (text: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(text);
const isSolanaAddress = (text: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);

/** A NEAR account on nearblocks (an account, not a transaction). */
export function nearUrl(account: string, net: Net): string | null {
  if (!isAccountId(account)) return null;
  return `${net === 'testnet' ? 'https://testnet.nearblocks.io' : 'https://nearblocks.io'}/address/${encodeURIComponent(account)}`;
}

/** An EVM address on Hyperliquid's own explorer. */
export function hyperliquidUrl(address: string, net: Net): string | null {
  if (!isEvmAddress(address)) return null;
  return `https://app.hyperliquid${net === 'testnet' ? '-testnet' : ''}.xyz/explorer/address/${address}`;
}

/** A Solana account on Solscan; the testnet desk's Solana side is devnet, as the dashboard's transaction links say. */
export function solscanUrl(address: string, net: Net): string | null {
  if (!isSolanaAddress(address)) return null;
  return `https://solscan.io/account/${address}${net === 'testnet' ? '?cluster=devnet' : ''}`;
}

/** An EVM address on Arbiscan (Arbitrum One, or Sepolia on testnet). */
export function arbiscanUrl(address: string, net: Net): string | null {
  if (!isEvmAddress(address)) return null;
  return `https://${net === 'testnet' ? 'sepolia.' : ''}arbiscan.io/address/${address}`;
}

/** `0x5e1d7a03…c09a`: the head and tail of an address, for a phone row. */
export function shortAddress(address: string, head = 6, tail = 4): string {
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}
