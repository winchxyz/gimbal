// What a submitter hands back: the transactions it can point at (TxRef, with an explorer link), and the one error
// every venue uses when a signed action changed nothing, so the journal can say so plainly.

import type { TxRef } from '@gimbal/shared';

export type ChainNetwork = 'mainnet' | 'testnet';

export function hyperliquidTxRef(network: ChainNetwork, hash: string): TxRef {
  const host = network === 'mainnet' ? 'app.hyperliquid.xyz' : 'app.hyperliquid-testnet.xyz';
  return { chain: 'hyperliquid', id: hash, url: `https://${host}/explorer/tx/${hash}` };
}

export function solanaTxRef(network: ChainNetwork, signature: string): TxRef {
  return { chain: 'solana', id: signature, url: `https://solscan.io/tx/${signature}${network === 'mainnet' ? '' : '?cluster=devnet'}` };
}

export function arbitrumTxRef(network: ChainNetwork, hash: string): TxRef {
  return { chain: 'arbitrum', id: hash, url: `https://${network === 'mainnet' ? '' : 'sepolia.'}arbiscan.io/tx/${hash}` };
}

/**
 * A signed action that executed nothing: an IOC with no match, a Solana transaction that expired or failed, a reverted
 * EIP-3009 transfer. `tx` lists what did happen on chain (the NEAR signature, a failed transaction that paid a fee).
 */
export class NothingExecuted extends Error {
  readonly venue: string;
  readonly reason: string;
  readonly tx: TxRef[];
  constructor(venue: string, reason: string, tx: TxRef[] = []) {
    super(`${venue}: nothing executed: ${reason}`);
    this.name = 'NothingExecuted';
    this.venue = venue;
    this.reason = reason;
    this.tx = tx;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
