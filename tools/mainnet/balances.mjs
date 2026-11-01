// Read-only balances of a desk's venue addresses, for retire.mjs (nothing may be left) and fund.mjs (did the
// transfer land): Hyperliquid (every perp dex, spot, vaults, staking, sub-accounts), the Phoenix trader, the
// Solana authority's SOL and every token account it owns, the EVM address on Arbitrum and on HyperEVM, and NEAR
// tokens (USDC, the nearblocks inventory, intents.near). Public endpoints only; an RPC URL from the environment is
// printed as its host.
//
// Every reader fails closed: an HTTP error, an answer of an unexpected shape, or an amount that is not a decimal
// throws. Nothing is ever read as 0 because it could not be read.

import { HL_API, PHOENIX_API } from './venues.mjs';

export const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
export const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
/** USDC on Arbitrum One (native, Circle). */
export const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
/** USDC.e on Arbitrum One (bridged from Ethereum). */
export const ARB_USDC_E = '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8';
/** USDC on HyperEVM (chain 999, Circle; symbol USDC, 6 decimals, checked on 2026-11-01). */
export const HYPEREVM_USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
/** USDC on NEAR (native, Circle): what the contract holds for its desks. */
export const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const NEARBLOCKS_API = 'https://api.nearblocks.io/v1';
export const TOKEN_PROGRAMS = {
  'SPL Token': 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'Token-2022': 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
};

/** The RPC URLs (shell environment first, then the public endpoints) and the hosts to print. */
export function rpcUrls(env = process.env) {
  const pick = (name, fallback) => (env[name]?.trim() ? env[name].trim() : fallback);
  const arbitrum = pick('ARBITRUM_RPC_URL', ARBITRUM_RPC);
  const solana = pick('SOLANA_RPC_URL', SOLANA_RPC);
  const hyperevm = pick('HYPEREVM_RPC_URL', HYPEREVM_RPC);
  return { arbitrum, solana, hyperevm, shown: { arbitrum: new URL(arbitrum).host, solana: new URL(solana).host, hyperevm: new URL(hyperevm).host } };
}

async function sendJson(fetchImpl, url, init, what) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const json = await res.json().catch(() => undefined);
  if (!res.ok || json === undefined) throw new Error(`${what}: HTTP ${res.status}${json === undefined ? ', not JSON' : ''}`);
  return json;
}
const postJson = (fetchImpl, url, body, what) => sendJson(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, what);
const getJson = (fetchImpl, url, what) => sendJson(fetchImpl, url, { headers: { accept: 'application/json' } }, what);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function need(cond, what) {
  if (!cond) throw new Error(`${what}: unexpected answer`);
}

/** A decimal string as integer units of `decimals` (rounded down); throws on anything else. */
export function units(text, decimals) {
  if (typeof text !== 'string' && typeof text !== 'number') throw new Error(`${JSON.stringify(text)} is not a decimal`);
  const s = String(text);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (m === null) throw new Error(`${JSON.stringify(s)} is not a decimal`);
  const v = BigInt(m[2]) * 10n ** BigInt(decimals) + BigInt((m[3] ?? '').padEnd(decimals, '0').slice(0, decimals) || '0');
  return m[1] === '-' ? -v : v;
}

/** A base-unit integer string as a bigint; throws on anything else. */
export function integer(text, what) {
  if (typeof text !== 'string' || !/^\d+$/.test(text)) throw new Error(`${what}: ${JSON.stringify(text)} is not a base-unit integer`);
  return BigInt(text);
}

/** Integer units as a decimal string, trailing zeros cut. */
export function unitsText(v, decimals) {
  const n = BigInt(v);
  const abs = n < 0n ? -n : n;
  const scale = 10n ** BigInt(decimals);
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${abs / scale}${frac === '' ? '' : `.${frac}`}`;
}

const hlInfo = (fetchImpl, body) => postJson(fetchImpl, `${HL_API}/info`, body, `hyperliquid ${body.type}${body.dex ? ` ${body.dex}` : ''}`);

/** One Hyperliquid perp dex (null = the main one): account value, withdrawable and cash (totalRawUsd), USDC x 1e6. */
export async function hyperliquidPerps(fetchImpl, address, dex = null) {
  const r = await hlInfo(fetchImpl, { type: 'clearinghouseState', user: address, ...(dex === null ? {} : { dex }) });
  const what = `hyperliquid clearinghouseState ${dex ?? 'main'}`;
  need(isObject(r) && isObject(r.marginSummary) && Array.isArray(r.assetPositions), what);
  return {
    dex: dex ?? 'main',
    accountValueE6: units(r.marginSummary.accountValue, 6),
    totalRawE6: units(r.marginSummary.totalRawUsd, 6),
    withdrawableE6: units(r.withdrawable, 6),
    positions: r.assetPositions.length,
  };
}

/**
 * Everything Hyperliquid holds for an address: every perp dex `perpDexs` lists (the main one first), spot balances,
 * vault equities, HYPE staking (delegated, undelegated, pending withdrawals) and sub-accounts.
 */
export async function hyperliquidBalances(fetchImpl, address) {
  const dexList = await hlInfo(fetchImpl, { type: 'perpDexs' });
  need(Array.isArray(dexList) && dexList.length > 0 && dexList[0] === null, 'hyperliquid perpDexs');
  const names = dexList.slice(1).map((d) => {
    need(isObject(d) && typeof d.name === 'string' && d.name !== '', 'hyperliquid perpDexs');
    return d.name;
  });
  const dexes = [];
  for (const name of [null, ...names]) dexes.push(await hyperliquidPerps(fetchImpl, address, name));
  const spot = await hlInfo(fetchImpl, { type: 'spotClearinghouseState', user: address });
  need(isObject(spot) && Array.isArray(spot.balances), 'hyperliquid spotClearinghouseState');
  const vaults = await hlInfo(fetchImpl, { type: 'userVaultEquities', user: address });
  need(Array.isArray(vaults), 'hyperliquid userVaultEquities');
  const stake = await hlInfo(fetchImpl, { type: 'delegatorSummary', user: address });
  need(isObject(stake) && Number.isInteger(stake.nPendingWithdrawals), 'hyperliquid delegatorSummary');
  const subs = await hlInfo(fetchImpl, { type: 'subAccounts', user: address });
  need(subs === null || Array.isArray(subs), 'hyperliquid subAccounts');
  return {
    dexes,
    spot: spot.balances.map((b) => {
      need(isObject(b) && typeof b.coin === 'string', 'hyperliquid spot balance');
      // Spot tokens have up to 8 decimals on HyperCore; 18 keeps every digit.
      return { coin: b.coin, total: units(b.total, 18), hold: units(b.hold ?? '0', 18) };
    }),
    vaults: vaults.map((v) => {
      need(isObject(v) && typeof v.vaultAddress === 'string', 'hyperliquid vault equity');
      return { vault: v.vaultAddress, equityE6: units(v.equity, 6) };
    }),
    staking: {
      delegated: units(stake.delegated, 18), undelegated: units(stake.undelegated, 18),
      pendingWithdrawal: units(stake.totalPendingWithdrawal, 18), nPending: stake.nPendingWithdrawals,
    },
    subAccounts: subs === null ? [] : subs.map((s) => String(s?.subAccountUser ?? s?.name ?? '?')),
  };
}

/** The lists of a Phoenix subaccount that the API leaves out when empty (the SDK's schema defaults them to []). */
export const PHOENIX_LISTS = ['positions', 'orders', 'splines', 'triggers', 'escrowRequests', 'spotCollaterals'];

/**
 * Hyperliquid's non-funding ledger of an address since `startTime` (ms): deposits, withdrawals, transfers and sends,
 * as [{ time, hash, type, usdcE6 (null when the entry carries no USDC amount), destination, user, delta }].
 */
export async function hyperliquidLedger(fetchImpl, address, startTime) {
  const rows = await hlInfo(fetchImpl, { type: 'userNonFundingLedgerUpdates', user: address.toLowerCase(), startTime });
  need(Array.isArray(rows), 'hyperliquid userNonFundingLedgerUpdates');
  return rows.map((r) => {
    need(isObject(r) && Number.isSafeInteger(r.time) && typeof r.hash === 'string' && isObject(r.delta) && typeof r.delta.type === 'string', 'hyperliquid ledger entry');
    const d = r.delta;
    const usdc = d.usdc !== undefined ? d.usdc : d.token === 'USDC' && d.amount !== undefined ? d.amount : null;
    return {
      time: r.time, hash: r.hash, type: d.type, usdcE6: usdc === null ? null : units(usdc, 6),
      destination: typeof d.destination === 'string' ? d.destination.toLowerCase() : null, user: typeof d.user === 'string' ? d.user.toLowerCase() : null, delta: d,
    };
  });
}

/**
 * The Phoenix trader of an authority (trader PDA 0), from the public API: per subaccount its quote collateral
 * (USDC x 1e6), positions, limit orders, splines, triggers, escrow requests, the locked deposit and spot
 * collateral. An authority never registered has no subaccounts. The live API leaves a list out when it is empty
 * (Phoenix's own SDK schema reads a missing list as []), so a missing list is empty; a list that is present but
 * not a list, a missing or non-integer collateral, or a lockedDeposit of another shape throws.
 */
export async function phoenixTrader(fetchImpl, authority, apiUrl = PHOENIX_API) {
  const r = await getJson(fetchImpl, `${apiUrl}/v1/trader/state/${authority}?traderPdaIndex=0`, 'phoenix trader state');
  need(isObject(r) && r.authority === authority && isObject(r.snapshot) && Array.isArray(r.snapshot.subaccounts), 'phoenix trader state');
  return r.snapshot.subaccounts.map((s) => {
    need(isObject(s) && Number.isInteger(s.subaccountIndex), 'phoenix subaccount');
    const lists = {};
    for (const f of PHOENIX_LISTS) {
      need(s[f] === undefined || Array.isArray(s[f]), `phoenix subaccount ${f}`);
      lists[f] = s[f] ?? [];
    }
    const ld = s.lockedDeposit ?? { lockedQuoteLots: '0', consumedQuoteLots: '0' };
    need(isObject(ld), 'phoenix lockedDeposit');
    return {
      index: s.subaccountIndex,
      collateralE6: integer(s.collateral, 'phoenix collateral'),
      positions: lists.positions.length,
      orders: lists.orders.length,
      splines: lists.splines.length,
      triggers: lists.triggers.length,
      escrow: lists.escrowRequests.length,
      lockedE6: integer(ld.lockedQuoteLots, 'phoenix lockedQuoteLots') + integer(ld.consumedQuoteLots, 'phoenix consumedQuoteLots'),
      spot: lists.spotCollaterals.map((c) => {
        need(isObject(c) && typeof c.symbol === 'string' && Number.isInteger(c.decimals), 'phoenix spot collateral');
        return { symbol: c.symbol, balance: integer(c.balance, 'phoenix spot collateral'), decimals: c.decimals };
      }),
    };
  });
}

/** Solana: the authority's lamports and a token account's balance in base units (0 when the account does not exist). */
export async function solanaBalances(fetchImpl, url, { authority, tokenAccounts }) {
  const rpc = (method, params) => postJson(fetchImpl, url, { jsonrpc: '2.0', id: 1, method, params }, `solana ${method}`);
  const bal = await rpc('getBalance', [authority, { commitment: 'confirmed' }]);
  if (!Number.isSafeInteger(bal?.result?.value) || bal.result.value < 0) throw new Error(`solana getBalance: ${JSON.stringify(bal?.error ?? bal).slice(0, 200)}`);
  const tokens = {};
  for (const [name, account] of Object.entries(tokenAccounts)) {
    const r = await rpc('getTokenAccountBalance', [account, { commitment: 'confirmed' }]);
    if (r.error) {
      // Only an account that was never created holds nothing: "could not find account". Anything else refuses.
      if (/could not find account/i.test(r.error.message ?? '')) {
        tokens[name] = { exists: false, amount: 0n, decimals: 6 };
        continue;
      }
      throw new Error(`solana getTokenAccountBalance ${name}: ${JSON.stringify(r.error).slice(0, 200)}`);
    }
    need(isObject(r.result?.value) && Number.isInteger(r.result.value.decimals), `solana getTokenAccountBalance ${name}`);
    tokens[name] = { exists: true, amount: integer(r.result.value.amount, `solana ${name}`), decimals: r.result.value.decimals };
  }
  return { lamports: BigInt(bal.result.value), tokens };
}

/**
 * Every token account `owner` owns under `programs` (default: SPL Token and Token-2022):
 * { program: [{ pubkey, mint, amount, decimals }] }.
 */
export async function solanaTokenAccounts(fetchImpl, url, owner, programs = Object.keys(TOKEN_PROGRAMS)) {
  const out = {};
  for (const name of programs) {
    const programId = TOKEN_PROGRAMS[name];
    if (programId === undefined) throw new Error(`unknown token program ${name}`);
    const r = await postJson(fetchImpl, url, {
      jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    }, `solana getTokenAccountsByOwner ${name}`);
    need(Array.isArray(r?.result?.value), `solana getTokenAccountsByOwner ${name}`);
    out[name] = r.result.value.map((a) => {
      const info = a?.account?.data?.parsed?.info;
      need(typeof a?.pubkey === 'string' && isObject(info) && isObject(info.tokenAmount) && Number.isInteger(info.tokenAmount.decimals), `solana ${name} account`);
      return { pubkey: a.pubkey, mint: String(info.mint), amount: integer(info.tokenAmount.amount, `solana ${name} account ${a.pubkey}`), decimals: info.tokenAmount.decimals };
    });
  }
  return out;
}

/** An EVM address on chain `chainId`: native balance (wei) and each ERC-20 of `tokens` ({ name: address }). */
export async function evmBalances(fetchImpl, url, { chainId, address, tokens }) {
  const rpc = async (method, params) => {
    const r = await postJson(fetchImpl, url, { jsonrpc: '2.0', id: 1, method, params }, `chain ${chainId} ${method}`);
    // "0x" is no number: an eth_call to an address without code, or an RPC that answered nothing. It refuses.
    if (r.error || typeof r.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(r.result)) throw new Error(`chain ${chainId} ${method}: ${JSON.stringify(r.error ?? r).slice(0, 200)}`);
    return BigInt(r.result);
  };
  const chain = await rpc('eth_chainId', []);
  if (chain !== BigInt(chainId)) throw new Error(`the RPC serves chain ${chain}, not ${chainId}`);
  const wei = await rpc('eth_getBalance', [address, 'latest']);
  const out = {};
  for (const [name, token] of Object.entries(tokens)) {
    out[name] = await rpc('eth_call', [{ to: token, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']);
  }
  return { wei, tokens: out };
}

/** Arbitrum: the address's ETH (wei), USDC and USDC.e (x 1e6). The RPC must be chain 42161. */
export async function arbitrumBalances(fetchImpl, url, address) {
  const r = await evmBalances(fetchImpl, url, { chainId: 42161, address, tokens: { usdc: ARB_USDC, usdce: ARB_USDC_E } });
  return { wei: r.wei, usdcE6: r.tokens.usdc, usdceE6: r.tokens.usdce };
}

/** HyperEVM: the address's HYPE (wei) and USDC (x 1e6). The RPC must be chain 999. */
export async function hyperEvmBalances(fetchImpl, url, address) {
  const r = await evmBalances(fetchImpl, url, { chainId: 999, address, tokens: { usdc: HYPEREVM_USDC } });
  return { wei: r.wei, usdcE6: r.tokens.usdc };
}

/** USDC on NEAR of an account, x 1e6 (ft_balance_of). */
export async function nearUsdcBalance(client, accountId) {
  return integer(await client.view(NEAR_USDC, 'ft_balance_of', { account_id: accountId }), 'USDC ft_balance_of');
}

/** Whether an account is registered on USDC on NEAR (storage_balance_of is not null). */
export async function nearUsdcRegistered(client, accountId) {
  return (await client.view(NEAR_USDC, 'storage_balance_of', { account_id: accountId })) !== null;
}

/** The NEP-141 tokens nearblocks lists for an account: [{ contract, amount (base units) }]. */
export async function nearInventory(fetchImpl, accountId) {
  const r = await getJson(fetchImpl, `${NEARBLOCKS_API}/account/${accountId}/inventory`, 'nearblocks inventory');
  need(isObject(r?.inventory) && Array.isArray(r.inventory.fts), 'nearblocks inventory');
  return r.inventory.fts.map((t) => {
    need(isObject(t) && typeof t.contract === 'string', 'nearblocks inventory token');
    return { contract: t.contract, amount: integer(String(t.amount), `nearblocks ${t.contract}`) };
  });
}

/** The tokens intents.near holds for an account (mt_tokens_for_owner): a list, empty when it holds none. */
export async function intentsTokens(client, accountId) {
  const r = await client.view('intents.near', 'mt_tokens_for_owner', { account_id: accountId });
  need(Array.isArray(r), 'intents.near mt_tokens_for_owner');
  return r;
}
