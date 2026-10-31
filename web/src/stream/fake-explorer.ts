// Development only: transaction references for the fake journal. The ids are made up (the first and last four
// characters are the ones the mockup shows, the middle is filler), so an explorer says "not found"; the addresses
// have the shape of the real ones, so a link opens the right explorer, which is what the Journal screen is checked on.
import type { Mode, TxRef } from '@gimbal/shared';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HEX = '0123456789abcdef';

const ALPHABETS = { near: BASE58, solana: BASE58, hyperliquid: HEX, arbitrum: HEX } as const;
const LENGTHS = { near: 44, solana: 88, hyperliquid: 64, arbitrum: 64 } as const;

// mulberry32 over an FNV-1a hash of the text: the same text always gives the same filler
function seeded(text: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORIGINS: Record<TxRef['chain'], Record<Mode, string>> = {
  near: { mainnet: 'https://nearblocks.io/txns/', replay: 'https://nearblocks.io/txns/', testnet: 'https://testnet.nearblocks.io/txns/' },
  hyperliquid: {
    mainnet: 'https://app.hyperliquid.xyz/explorer/tx/',
    replay: 'https://app.hyperliquid.xyz/explorer/tx/',
    testnet: 'https://app.hyperliquid-testnet.xyz/explorer/tx/',
  },
  solana: { mainnet: 'https://solscan.io/tx/', replay: 'https://solscan.io/tx/', testnet: 'https://solscan.io/tx/' },
  arbitrum: { mainnet: 'https://arbiscan.io/tx/', replay: 'https://arbiscan.io/tx/', testnet: 'https://sepolia.arbiscan.io/tx/' },
};

/** `head` and `tail` are what the row shows (`9xQe`, `4Ta1`); the id is as long as a real one of that chain. */
export function fakeTx(chain: TxRef['chain'], head: string, tail: string, mode: Mode = 'mainnet'): TxRef {
  const alphabet = ALPHABETS[chain];
  const prefix = chain === 'hyperliquid' || chain === 'arbitrum' ? '0x' : '';
  const rnd = seeded(`${chain}:${head}:${tail}`);
  const fill = Array.from({ length: LENGTHS[chain] - head.length - tail.length }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
  const id = `${prefix}${head}${fill}${tail}`;
  const query = chain === 'solana' && mode === 'testnet' ? '?cluster=devnet' : '';
  return { chain, id, url: `${ORIGINS[chain][mode]}${id}${query}` };
}
