// The relayer's live check on Hyperliquid testnet: the contract signs one small IOC order for the desk through the
// MPC network, the relayer posts it to /exchange, and the fill is looked up in userFills.
//   npm run relay-hl -w engine [-- --coin ETH] [--side buy|sell] [--usd 11] [--close]
// Reads the repo's .env (values are never printed): GIMBAL_CONTRACT_ID, DESK_ID, OWNER_ACCOUNT_ID (or
// OPERATOR_ACCOUNT_ID), OPERATOR_PRIVATE_KEY, and optionally NEAR_RPC_URL and HL_API_URL.
// Before the order: the desk's Hyperliquid testnet account must hold margin, the builder fee is approved if
// Hyperliquid does not have it yet (one more signature), and a stored price older than policy.oracle_max_age_s is
// refreshed (refresh_prices). --close sends the reduce-only IOC that flattens the position afterwards.
// Testnet only: NEAR_NETWORK=mainnet or a mainnet HL_API_URL is refused.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { TxRef } from '@gimbal/shared';
import { formatNear } from '../contract/budget.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport } from '../contract/near-transport.ts';
import { priceUsd } from '../contract/prices.ts';
import { ContractRefusal } from '../contract/types.ts';
import { planIoc } from '../relayer/hl-order.ts';
import type { HlSubmitResult } from '../relayer/hyperliquid.ts';
import { HyperliquidSubmitter } from '../relayer/hyperliquid.ts';
import { Relayer } from '../relayer/relayer.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import { HL_TESTNET_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import { errorMessage } from '../venues/recorder.ts';
import { contractEnv } from './serve-contract.ts';

const { values } = parseArgs({
  options: {
    coin: { type: 'string', default: 'ETH' },
    side: { type: 'string', default: 'buy' },
    usd: { type: 'string', default: '11' },
    close: { type: 'boolean', default: false },
  },
});

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const envVar = (name: string): string | undefined => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};

const coin = values.coin!;
const side = values.side === 'sell' ? 'sell' : values.side === 'buy' ? 'buy' : fail('--side must be buy or sell');
const usd = Number(values.usd);
if (!(usd >= 10 && usd <= 50)) fail('--usd must be between 10 and 50');

let cfg;
try {
  cfg = contractEnv(envVar, 'testnet');
} catch (err) {
  fail(errorMessage(err));
}
if (cfg === null) fail('GIMBAL_CONTRACT_ID is not set (the testnet contract)');
if (cfg.network !== 'testnet') fail('testnet only: NEAR_NETWORK must be testnet');
const hlUrl = (envVar('HL_API_URL') ?? HL_TESTNET_URL).replace(/\/+$/, '').replace(/\/info$/, '');
if (!/testnet/.test(hlUrl)) fail(`testnet only: HL_API_URL ${hlUrl} is not a Hyperliquid testnet URL`);

const transport = new NearApiTransport({ network: 'testnet', accountId: cfg.accountId, privateKey: cfg.privateKey, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }) });
const client = new NearContractClient({
  contractId: cfg.contractId, network: 'testnet', transport, onHealth: (status, detail) => log(`near ${status}: ${detail}`),
});
const hl = new HyperliquidSubmitter({ network: 'testnet', apiUrl: hlUrl });
const relayer = new Relayer({ contract: client, deskId: cfg.deskId, hyperliquid: hl });
const reader = new HyperliquidReader({ network: 'testnet', url: `${hlUrl}/info` });

try {
  await run();
} catch (err) {
  if (err instanceof ContractRefusal) console.error(`refused by the contract: ${err.message}${err.txHash === null ? '' : ` (tx ${err.txHash})`}`);
  else if (err instanceof NothingExecuted) console.error(`${err.message}${err.tx.length > 0 ? `\n  ${refs(err.tx)}` : ''}`);
  else console.error(`relay-hl failed: ${errorMessage(err)}`);
  process.exitCode = 1;
}

async function run(): Promise<void> {
  const [account, allowance] = await Promise.all([transport.account(), transport.allowance()]);
  log(`operator ${cfg!.accountId}: ${formatNear(account.amount)} balance, allowance ${allowance === null ? 'unlimited' : formatNear(allowance)}`);
  const desk = await relayer.desk();
  const user = desk.evm_address.toLowerCase();
  log(`contract ${cfg!.contractId}, desk ${cfg!.deskId}: EVM ${user}, ${desk.paused ? 'PAUSED' : 'running'}`);

  const asset = desk.policy.hl_assets.find((a) => a.symbol === coin);
  if (asset === undefined) throw new Error(`${coin} is not in the desk's policy.hl_assets (${desk.policy.hl_assets.map((a) => a.symbol).join(', ')})`);
  const market = (await reader.markets()).find((m) => m.symbol === coin);
  if (market === undefined) throw new Error(`Hyperliquid testnet has no ${coin} perp`);
  if (market.assetIndex !== asset.index || market.szDecimals !== asset.sz_decimals) {
    throw new Error(`the policy has ${coin} as asset ${asset.index} (szDecimals ${asset.sz_decimals}), Hyperliquid testnet as ${market.assetIndex} (${market.szDecimals})`);
  }

  const state = await info<{ marginSummary?: { accountValue?: string }; withdrawable?: string }>({ type: 'clearinghouseState', user });
  const value = Number(state.marginSummary?.accountValue ?? 0);
  log(`Hyperliquid testnet ${user}: account value ${value.toFixed(2)} USDC, withdrawable ${Number(state.withdrawable ?? 0).toFixed(2)}`);
  if (value < usd / 5) throw new Error(`the desk's Hyperliquid testnet account holds ${value.toFixed(2)} USDC: fund it first`);

  const config = await client.config();
  const builder = config.treasury?.hl_builder;
  const fee = config.fees?.hl_builder_tenth_bps;
  if (builder !== undefined && fee !== undefined && fee > 0) {
    const approved = await info<number>({ type: 'maxBuilderFee', user, builder: builder.toLowerCase() });
    log(`builder ${builder}: fee ${fee} tenths of a bp, approved up to ${approved}`);
    if (!(Number(approved) >= fee)) {
      const r = await timed('hl_approve_builder_fee', () => relayer.hlApproveBuilderFee());
      log(`builder fee approved: ${refs(r.tx)}`);
    }
  } else {
    log('config(): no treasury.hl_builder / fees.hl_builder_tenth_bps read; the builder fee is not checked');
  }

  const oracle = await freshPrice(desk.policy.oracle_max_age_s);
  const book = await reader.book(coin, 5);
  const bookPx = side === 'buy' ? book.asks[0]?.px : book.bids[0]?.px;
  if (bookPx === undefined) throw new Error(`the ${coin} book on Hyperliquid testnet has no ${side === 'buy' ? 'asks' : 'bids'}`);
  const plan = planIoc({
    asset: asset.index, szDecimals: asset.sz_decimals, side, oraclePx: oracle, bandBps: desk.policy.price_band_bps, bookPx,
    notionalUsd: usd, maxNotionalUsd: desk.policy.max_notional_usd,
  });
  log(`IOC ${side} ${plan.order.sz} ${coin} at ${plan.order.px} (${plan.notionalUsd.toFixed(2)} USD; best ${bookPx}, contract oracle ${oracle})`);
  const result = await timed('hl_order', () => relayer.hlOrder(plan.order, `relay-hl live check: IOC ${side} ${coin}`));
  report(result);
  const seen = await inUserFills(user, result.oid);
  log(`userFills: order ${result.oid} ${seen > 0 ? `visible (${seen} fill${seen === 1 ? '' : 's'})` : 'NOT visible'}`);
  if (seen === 0) process.exitCode = 1;

  if (values.close && result.filled !== null) {
    const closeBook = await reader.book(coin, 5);
    const closePx = side === 'buy' ? closeBook.bids[0]?.px : closeBook.asks[0]?.px;
    if (closePx === undefined) throw new Error('no book to close against');
    const close = planIoc({
      asset: asset.index, szDecimals: asset.sz_decimals, side: side === 'buy' ? 'sell' : 'buy', oraclePx: oracle,
      bandBps: desk.policy.price_band_bps, bookPx: closePx, maxNotionalUsd: desk.policy.max_notional_usd, sz: result.filled.totalSz, reduceOnly: true,
    });
    log(`close: reduce-only IOC ${close.order.is_buy ? 'buy' : 'sell'} ${close.order.sz} ${coin} at ${close.order.px}`);
    report(await timed('hl_order (close)', () => relayer.hlOrder(close.order, `relay-hl live check: close ${coin}`)));
  }
}

/** The contract's stored price for the coin, refreshed once if it is older than the policy allows. */
async function freshPrice(maxAgeS: number): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const p = (await client.prices()).find((r) => r.asset === coin);
    const age = p === undefined ? Infinity : (Date.now() - p.at_ms) / 1000;
    if (p !== undefined && age <= maxAgeS - 30) {
      log(`stored price ${coin} ${priceUsd(p.price_e8)}, ${Math.round(age)} s old`);
      return priceUsd(p.price_e8);
    }
    if (attempt > 0) throw new Error(`no stored ${coin} price younger than ${maxAgeS} s after refresh_prices`);
    log(p === undefined ? `no stored ${coin} price: refresh_prices` : `stored ${coin} price is ${Math.round(age)} s old: refresh_prices`);
    log(`refresh_prices: ${refs(await client.refreshPrices([coin]))}`);
  }
}

async function inUserFills(user: string, oid: number | null): Promise<number> {
  if (oid === null) return 0;
  const fills = await info<{ oid: number }[]>({ type: 'userFills', user });
  return (Array.isArray(fills) ? fills : []).filter((f) => f.oid === oid).length;
}

function report(r: HlSubmitResult): void {
  log(`statuses ${JSON.stringify(r.statuses)}`);
  if (r.filled !== null) log(`filled ${r.filled.totalSz} at ${r.filled.avgPx}, oid ${r.oid}, ${r.fills.length} fill(s) in userFillsByTime${r.confirmed ? '' : ' (not confirmed yet)'}`);
  else if (r.resting) log(`resting, oid ${r.oid}`);
  log(`tx: ${refs(r.tx)}`);
}

async function timed<T>(what: string, run: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  log(`${what}: asking the contract to sign (MPC usually takes 5-6 s)`);
  const out = await run();
  log(`${what}: signed and delivered in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return out;
}

async function info<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${hlUrl}/info`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`hyperliquid /info ${String(body.type)}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function refs(tx: TxRef[]): string {
  return tx.length === 0 ? '(none)' : tx.map((t) => t.url).join('  ');
}

function log(line: string): void {
  console.log(`[relay-hl ${new Date().toISOString()}] ${line}`);
}

function fail(msg: string): never {
  console.error(`relay-hl: ${msg}`);
  process.exit(2);
}
