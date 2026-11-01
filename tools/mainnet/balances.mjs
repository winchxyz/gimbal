// Read-only balances of a desk's venue addresses, for retire.mjs (nothing may be left) and fund.mjs (did the
// transfer land): Hyperliquid perps and spot, the Solana authority's SOL and token accounts, USDC and ETH on
// Arbitrum, and USDC on NEAR. Public endpoints only; an RPC URL from the environment is printed as its host.

import { HL_API } from './venues.mjs';

export const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
/** USDC on Arbitrum One (native, Circle). */
export const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
/** USDC on NEAR (native, Circle): what the contract holds for its desks. */
export const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

/** The RPC URLs (shell environment first, then the public endpoints) and the hosts to print. */
export function rpcUrls(env = process.env) {
  const pick = (name, fallback) => (env[name]?.trim() ? env[name].trim() : fallback);
  const arbitrum = pick('ARBITRUM_RPC_URL', ARBITRUM_RPC);
  const solana = pick('SOLANA_RPC_URL', SOLANA_RPC);
  return { arbitrum, solana, shown: { arbitrum: new URL(arbitrum).host, solana: new URL(solana).host } };
}

async function postJson(fetchImpl, url, body, what) {
  const res = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json === null) throw new Error(`${what}: HTTP ${res.status}${json === null ? ', not JSON' : ''}`);
  return json;
}

/** A decimal string as integer units of `decimals` (rounded down); throws on anything else. */
export function units(text, decimals) {
  const s = String(text);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (m === null) throw new Error(`${JSON.stringify(s)} is not a decimal`);
  const v = BigInt(m[2]) * 10n ** BigInt(decimals) + BigInt((m[3] ?? '').padEnd(decimals, '0').slice(0, decimals) || '0');
  return m[1] === '-' ? -v : v;
}

/** Integer units as a decimal string, trailing zeros cut. */
export function unitsText(v, decimals) {
  const n = BigInt(v);
  const abs = n < 0n ? -n : n;
  const scale = 10n ** BigInt(decimals);
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${abs / scale}${frac === '' ? '' : `.${frac}`}`;
}

/**
 * Hyperliquid: the main perps dex (account value and withdrawable, USDC x 1e6 rounded down) and every spot balance
 * (total, in the token's own units as a decimal string).
 */
export async function hyperliquidBalances(fetchImpl, address) {
  const perps = await postJson(fetchImpl, `${HL_API}/info`, { type: 'clearinghouseState', user: address }, 'hyperliquid clearinghouseState');
  const spot = await postJson(fetchImpl, `${HL_API}/info`, { type: 'spotClearinghouseState', user: address }, 'hyperliquid spotClearinghouseState');
  const value = perps?.marginSummary?.accountValue;
  if (value === undefined) throw new Error('hyperliquid clearinghouseState: no marginSummary.accountValue');
  return {
    accountValueE6: units(value, 6),
    withdrawableE6: units(perps.withdrawable ?? '0', 6),
    positions: (perps.assetPositions ?? []).length,
    spot: (spot?.balances ?? []).map((b) => ({ coin: b.coin, total: String(b.total), hold: String(b.hold ?? '0') })),
  };
}

/** Solana: the authority's lamports and a token account's balance in base units (0 when the account does not exist). */
export async function solanaBalances(fetchImpl, url, { authority, tokenAccounts }) {
  const rpc = (method, params) => postJson(fetchImpl, url, { jsonrpc: '2.0', id: 1, method, params }, `solana ${method}`);
  const bal = await rpc('getBalance', [authority, { commitment: 'confirmed' }]);
  if (typeof bal?.result?.value !== 'number') throw new Error(`solana getBalance: ${JSON.stringify(bal?.error ?? bal).slice(0, 200)}`);
  const tokens = {};
  for (const [name, account] of Object.entries(tokenAccounts)) {
    const r = await rpc('getTokenAccountBalance', [account, { commitment: 'confirmed' }]);
    if (r.error) {
      // An account that was never created holds nothing: "could not find account" (-32602).
      if (/could not find account|Invalid param/i.test(r.error.message ?? '')) {
        tokens[name] = { exists: false, amount: 0n, decimals: 6 };
        continue;
      }
      throw new Error(`solana getTokenAccountBalance ${name}: ${JSON.stringify(r.error).slice(0, 200)}`);
    }
    tokens[name] = { exists: true, amount: BigInt(r.result.value.amount), decimals: r.result.value.decimals };
  }
  return { lamports: BigInt(bal.result.value), tokens };
}

/** Arbitrum: the address's ETH (wei) and USDC (x 1e6). The RPC must be chain 42161. */
export async function arbitrumBalances(fetchImpl, url, address) {
  const rpc = async (method, params) => {
    const r = await postJson(fetchImpl, url, { jsonrpc: '2.0', id: 1, method, params }, `arbitrum ${method}`);
    if (r.error || typeof r.result !== 'string') throw new Error(`arbitrum ${method}: ${JSON.stringify(r.error ?? r).slice(0, 200)}`);
    return r.result;
  };
  const chain = await rpc('eth_chainId', []);
  if (BigInt(chain) !== 42161n) throw new Error(`the Arbitrum RPC serves chain ${BigInt(chain)}, not 42161`);
  const eth = BigInt(await rpc('eth_getBalance', [address, 'latest']));
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`;
  const usdc = BigInt(await rpc('eth_call', [{ to: ARB_USDC, data }, 'latest']));
  return { wei: eth, usdcE6: usdc };
}

/** USDC on NEAR of an account, x 1e6 (ft_balance_of). */
export async function nearUsdcBalance(client, accountId) {
  return BigInt(await client.view(NEAR_USDC, 'ft_balance_of', { account_id: accountId }));
}

/** Whether an account is registered on USDC on NEAR (storage_balance_of is not null). */
export async function nearUsdcRegistered(client, accountId) {
  return (await client.view(NEAR_USDC, 'storage_balance_of', { account_id: accountId })) !== null;
}
