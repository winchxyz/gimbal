#!/usr/bin/env node
// Three checks on a mainnet canary that move no funds (tools/mainnet/README.md, "7. Canary checks"):
//
//   node tools/mainnet/checks.mjs <contract> <desk_id> [--step prices|orderly|quotes] [--env-file <file>] [--send]
//
//   prices   refresh_prices once for the oracle assets (the first OutLayer call): the transaction's gas, what the
//            contract and the caller spent, and prices() read back until every asset has a newer price.
//   orderly  under the contract's broker on its chain: register the desk's EVM account, add the desk's orderly key,
//            then the signed GET receiver_address, printed in full. The engine's own setup code does it
//            (engine/src/setup/setup.ts runSetup, OrderlyDeskClient, NearContractClient): each step reads Orderly
//            first and skips what is done. No referral binding, no IP restriction, no deposit.
//   quotes   dry 1Click quotes (`dry: true`, nothing is reserved) out of HyperCore, to Solana USDC and to USDC on
//            NEAR, and one into HyperCore as a control: does 1Click still answer "Quoting for this pair is not
//            available"? Being reads, they are asked in the dry run too.
//
// Default: a dry run. It reads mainnet and prints every call it would make, with every public value in full, and
// signs nothing. --send signs with the engine's operator key, read from the engine env file that desk.mjs wrote
// (default .keys/engine-mainnet-<contract>.env), only then, and never printed. --send refuses in a linked git
// worktree. The script calls only refresh_prices, orderly_register, orderly_add_key and orderly_request of kind
// receiver_address; any other contract call is refused before it is signed. It ends with one summary block.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UsageError, isMain, parseDotEnv, parseFlags, run } from './cli.mjs';
import { OPERATOR_METHODS, contractConfigProblems, engineEnvFile, orderlyAccountId } from './desk.mjs';
import {
  ORACLE, ROOT, accountLink, act, createClient, describeTx, isFunctionCallKey, linkedWorktreeOf, mainnetId, near, nearText,
  nearTextUp, tgasText, txGasCap, txLink,
} from './near.mjs';
import { CANARY_SYMBOLS, ORDERLY_API } from './venues.mjs';

export const STEPS = ['prices', 'orderly', 'quotes'];
export const ONECLICK_API = 'https://1click.chaindefuser.com/v0';
/** 1Click asset ids (CLAUDE.md, contract/core/tests/vectors/oneclick-live.json). */
export const ASSETS = {
  hypercoreUsdc: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054',
  solanaUsdc: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  nearUsdc: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
};
/** The oracle ids of the contract's assets (contract/core/src/oracle.rs ORACLE_ASSETS): what request_price_data gets. */
export const ORACLE_IDS = {
  BTC: 'nbtc.bridge.near', DOGE: 'doge.omft.near', ETH: 'eth.bridge.near', LTC: 'ltc.omft.near', SOL: '22.contract.portalbridge.near',
};
export const NOT_AVAILABLE = /Quoting for this pair is not available/i;
/** The engine's gas for every operator call (engine/src/contract/budget.ts DEFAULT_CALL_TGAS; a test compares). */
export const CALL_TGAS = 300;
/** What refresh_prices attaches to the oracle from the contract's balance (contract/src/prices.rs ORACLE_DEPOSIT). */
export const ORACLE_DEPOSIT = 20n * 10n ** 21n;
/** AddOrderlyKey's lifetime the engine asks for (engine/src/venues/orderly-actions.ts ORDERLY_KEY_LIFETIME_MS). */
export const KEY_LIFETIME_MS = 364 * 86_400_000;
export const RECEIVER_REASON = 'look up the Orderly receiver address';

/** The only contract calls each step may make; everything else is refused before it is signed. */
export const ALLOWED_CALLS = {
  prices: ['refresh_prices'],
  orderly: ['orderly_register', 'orderly_add_key', 'orderly_request'],
  quotes: [],
};
export const ALLOWED_ORDERLY_KINDS = ['receiver_address'];

const USAGE = `usage: node tools/mainnet/checks.mjs <contract> <desk_id> [--step ${STEPS.join('|')}] [--env-file <file>] [--send]
  default: dry run of all three steps (reads mainnet and asks the dry 1Click quotes; signs nothing)`;
const SPEC = { '--step': 'value', '--env-file': 'value', '--send': 'switch' };

export function parseChecksArgs(argv) {
  const { positional, values } = parseFlags(argv, SPEC);
  if (positional.length < 2) throw new UsageError('the contract and the desk id are required');
  if (positional.length > 2) throw new UsageError(`unexpected argument ${positional[2]}`);
  const [contract, deskId] = positional;
  try {
    mainnetId(contract, 'contract');
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (!/^[a-z0-9-]{1,32}$/.test(deskId)) throw new UsageError(`desk id ${JSON.stringify(deskId)} is not 1 to 32 characters of a-z, 0-9 and -`);
  const step = values['--step'];
  if (step !== undefined && !STEPS.includes(step)) throw new UsageError(`--step ${step} is not one of ${STEPS.join(', ')}`);
  return {
    contract, deskId, steps: step === undefined ? [...STEPS] : [step], send: values['--send'] === true,
    envFile: values['--env-file'] === undefined ? engineEnvFile(contract) : resolve(values['--env-file']),
  };
}

/** --send in a linked git worktree: refused, as every --send of these scripts (its ignored .keys/ go with it). */
export function sendRefusal(send, tree) {
  if (!send || tree === null) return null;
  return `${tree} is a linked git worktree: --send runs from the main checkout only, where .keys/ lives`;
}

/** Why a contract call is not one this step may make, or null. */
export function callProblem(step, contract, contractId, method, args) {
  if (contractId !== contract) return `${method} on ${contractId}: this script calls ${contract} only`;
  if (!(ALLOWED_CALLS[step] ?? []).includes(method)) return `${method} is not a call of the ${step} step (${(ALLOWED_CALLS[step] ?? []).join(', ') || 'none'}): refused, nothing was signed`;
  if (method === 'orderly_request' && !ALLOWED_ORDERLY_KINDS.includes(args?.req?.kind)) {
    return `orderly_request kind ${JSON.stringify(args?.req?.kind)} is not ${ALLOWED_ORDERLY_KINDS.join(', ')}: refused, nothing was signed`;
  }
  return null;
}

/** A NearTransport that makes only the step's calls; views and balance reads pass through. */
export function guardedTransport(transport, step, contract) {
  return {
    get accountId() { return transport.accountId; },
    call(contractId, method, args, tgas, ...rest) {
      const problem = callProblem(step, contract, contractId, method, args);
      if (problem !== null) return Promise.reject(new Error(problem));
      return transport.call(contractId, method, args, tgas, ...rest);
    },
    view: (...a) => transport.view(...a),
    account: () => transport.account(),
    allowance: () => transport.allowance(),
  };
}

/**
 * The engine env file's settings for this canary, checked against the chain's public values. Errors name the
 * variable, never a value from the file. Returns { accountId, privateKey, rpcUrl }; the key is never printed.
 */
export function engineEnvProblems(env, { contract, deskId, desk, brokerId }) {
  const out = [];
  const get = (n) => (env.get(n) ?? '').trim();
  for (const n of ['GIMBAL_MODE', 'NEAR_NETWORK']) if (get(n) !== 'mainnet') out.push(`${n} is not mainnet`);
  if (get('GIMBAL_CONTRACT_ID') !== contract) out.push(`GIMBAL_CONTRACT_ID is not ${contract}`);
  if (get('DESK_ID') !== deskId) out.push(`DESK_ID is not ${deskId}`);
  const accountId = get('OPERATOR_ACCOUNT_ID') || get('OWNER_ACCOUNT_ID');
  if (accountId === '') out.push('OWNER_ACCOUNT_ID (or OPERATOR_ACCOUNT_ID) is empty');
  else if (accountId !== desk.owner && accountId !== desk.operator) out.push(`the operator account (OPERATOR_ACCOUNT_ID or OWNER_ACCOUNT_ID) is neither the desk's owner ${desk.owner} nor its operator`);
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(get('OPERATOR_PRIVATE_KEY'))) out.push('OPERATOR_PRIVATE_KEY is not an ed25519 secret key');
  if (get('ORDERLY_BROKER_ID') !== '' && get('ORDERLY_BROKER_ID') !== brokerId) out.push(`ORDERLY_BROKER_ID is not the contract's broker ${brokerId}`);
  return { problems: out, accountId, privateKey: get('OPERATOR_PRIVATE_KEY'), rpcUrl: get('NEAR_RPC_URL') || null };
}

/** The engine env file's names and values (never printed). */
function readEngineEnv(file) {
  if (!existsSync(file)) throw new Error(`${file} does not exist: it is the engine env file tools/mainnet/desk.mjs --send wrote`);
  return parseDotEnv(readFileSync(file, 'utf8'));
}

// --- prices ---

/** The refresh_prices transaction as printed lines, and its args. */
export function refreshPlan({ contract, signer, signedBy, assets = CANARY_SYMBOLS }) {
  const actions = [act.call('refresh_prices', { assets }, CALL_TGAS, 0n)];
  const lines = describeTx('tx: refresh_prices (operator key)', { signer, signedBy, receiver: contract, actions });
  lines.push(`  then      ${contract} -> ${ORACLE} request_price_data ${JSON.stringify({ asset_ids: assets.map((a) => ORACLE_IDS[a]) })}`
    + `, deposit ${nearText(ORACLE_DEPOSIT)} NEAR from the contract's balance (the oracle refunds it when its cache is fresh)`);
  lines.push(`            -> ${contract}.on_prices ${JSON.stringify({ assets })} stores each newer price (there is no oracle_call fallback: `
    + 'if request_price_data fails, nothing new is stored and the call returns false)');
  return { actions, lines };
}

/** Gas and NEAR burnt over a final transaction outcome, with each receipt's executor, gas, logs and status. */
export function txCosts(outcome) {
  const all = [outcome.transaction_outcome, ...(outcome.receipts_outcome ?? [])];
  const gas = all.reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
  const tokens = all.reduce((s, o) => s + BigInt(o.outcome.tokens_burnt), 0n);
  const receipts = (outcome.receipts_outcome ?? []).map((r) => ({
    executor: r.outcome.executor_id,
    gas: BigInt(r.outcome.gas_burnt),
    logs: r.outcome.logs ?? [],
    status: Object.keys(r.outcome.status ?? {})[0] ?? 'Unknown',
  }));
  return { gas, tokens, receipts };
}

/** The stored prices as `ASSET price (at ISO)` text, in USD. */
export function pricesText(rows) {
  if (rows.length === 0) return 'none stored';
  return rows.map((r) => `${r.asset} ${(Number(r.price_e8) / 1e8).toString()} (at ${new Date(r.at_ms).toISOString()})`).join(', ');
}

/** The assets prices() does not show newer than before (all of them when none was stored). */
export function stalePrices(before, after, assets) {
  const was = new Map(before.map((p) => [p.asset, p.at_ms]));
  const now = new Map(after.map((p) => [p.asset, p.at_ms]));
  return assets.filter((a) => !now.has(a) || (was.has(a) && now.get(a) <= was.get(a)));
}

// --- orderly ---

/** The calls of the Orderly step as printed lines, given what Orderly says now (null: not read). */
export function orderlyPlanLines({ contract, deskId, desk, brokerId, chainId, signer, signedBy, registered, key, now }) {
  const accountId = desk.orderly_account_id;
  const orderlyKey = `ed25519:${desk.solana.authority}`;
  const tx = (method, args) => describeTx(`NEAR tx ${method}`, { signer, signedBy, receiver: contract, actions: [act.call(method, args, CALL_TGAS, 0n)] })
    .map((l) => `    ${l}`);
  const keyUsable = key !== null && key !== undefined && key.status === 'ACTIVE' && (key.scope ?? '').split(',').includes('trading') && (key.expiration ?? 0) > now;
  const lines = [
    `orderly   broker ${brokerId} on chain ${chainId}, ${ORDERLY_API}`,
    `  desk EVM address   ${desk.evm_address}`,
    `  Orderly account    ${accountId}`,
    `  orderly key        ${orderlyKey}`,
    `  now                ${registered === null ? 'not read' : registered ? 'registered' : 'not registered'}; key ${key === undefined ? 'not read (no account yet)' : key === null ? 'not on Orderly' : `${key.status}, scope ${key.scope}, until ${key.expiration === null ? '?' : new Date(key.expiration).toISOString()}`}`,
    `  1. register${registered ? ' (done: skipped)' : ''}`,
    `    GET ${ORDERLY_API}/v1/registration_nonce`,
    ...tx('orderly_register', { desk_id: deskId, registration_nonce: '<the nonce from GET /v1/registration_nonce, read at --send>' }),
    `    POST ${ORDERLY_API}/v1/register_account {"message":<the Registration the contract signed>,"signature":<its 0x signature>,"userAddress":"${desk.evm_address}"}`,
    `  2. add the orderly key${keyUsable ? ' (done: skipped)' : ''}`,
    ...tx('orderly_add_key', { desk_id: deskId, expiration_ms: now + KEY_LIFETIME_MS }),
    `    POST ${ORDERLY_API}/v1/orderly_key {"message":<the AddOrderlyKey the contract signed, orderlyKey ${orderlyKey}, scope read,trading>,"signature":<its 0x signature>,"userAddress":"${desk.evm_address}"}`,
    '  3. receiver address (always: a signed read)',
    ...tx('orderly_request', { desk_id: deskId, req: { reduce_only: false, kind: 'receiver_address', timestamp_ms: now }, reason: RECEIVER_REASON }),
    `    GET ${ORDERLY_API}/v1/client/asset/receiver_address?chain_id=${chainId}&token=USDC`,
    `        headers orderly-account-id ${accountId}, orderly-key ${orderlyKey}, orderly-timestamp <signed>, orderly-signature <signed>`,
    '  not done here: referral_bind, ip_restriction, set_orderly_receiver, any deposit',
  ];
  return lines;
}

// --- quotes ---

/** The dry quote requests: out of HyperCore to Solana USDC and to USDC on NEAR, and a control into HyperCore. */
export function quoteRequests({ contract, deskId, desk, now }) {
  const base = (originAsset, destinationAsset, amount, refundTo, recipient, extra = {}) => ({
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    depositType: 'ORIGIN_CHAIN',
    refundType: 'ORIGIN_CHAIN',
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(now + 30 * 60_000).toISOString(),
    originAsset,
    destinationAsset,
    amount,
    refundTo,
    recipient,
    ...extra,
  });
  return [
    {
      name: 'HyperCore -> Solana USDC (rescue Hyperliquid -> Phoenix)',
      outOfHyperCore: true,
      body: base(ASSETS.hypercoreUsdc, ASSETS.solanaUsdc, '500000000', desk.evm_address, desk.solana.authority),
    },
    {
      name: 'HyperCore -> NEAR USDC (payout to the contract)',
      outOfHyperCore: true,
      body: base(ASSETS.hypercoreUsdc, ASSETS.nearUsdc, '500000000', desk.evm_address, contract, { customRecipientMsg: JSON.stringify({ desk_id: deskId }) }),
    },
    {
      name: 'control: Solana USDC -> HyperCore (rescue Phoenix -> Hyperliquid)',
      outOfHyperCore: false,
      body: base(ASSETS.solanaUsdc, ASSETS.hypercoreUsdc, '5000000', desk.solana.authority, desk.evm_address),
    },
  ];
}

/** One quote answer as { verdict, text }: 'not available', 'quoted', or 'refused' with 1Click's message. */
export function quoteVerdict(status, body) {
  const message = typeof body?.message === 'string' ? body.message : null;
  if (status >= 200 && status < 300 && body?.quote) {
    const q = body.quote;
    return { verdict: 'quoted', text: `amountIn ${q.amountIn} (${q.amountInFormatted}), amountOut ${q.amountOut} (${q.amountOutFormatted}), minAmountOut ${q.minAmountOut}, timeEstimate ${q.timeEstimate} s` };
  }
  if (message !== null && NOT_AVAILABLE.test(message)) return { verdict: 'not available', text: `HTTP ${status} "${message}"` };
  return { verdict: 'refused', text: `HTTP ${status} ${message === null ? JSON.stringify(body).slice(0, 300) : `"${message}"`}` };
}

export async function askQuote(fetchImpl, body) {
  const res = await fetchImpl(`${ONECLICK_API}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/** The block the human pastes back. */
export function summaryBlock({ at, contract, deskId, send, lines }) {
  return [
    `=== gimbal canary checks ${at} ===`,
    `contract ${contract}, desk ${deskId}, ${send ? 'SEND' : 'dry run'}`,
    ...lines,
    '=== end ===',
  ];
}

// --- the run ---

/** The engine's Orderly client (the done-checks of the dry run); with `signing`, its setup and contract client too. */
const defaultEngine = async (signing) => ({
  ...(await import('../../engine/src/venues/orderly-actions.ts')),
  ...(signing ? {
    ...(await import('../../engine/src/setup/setup.ts')),
    ...(await import('../../engine/src/setup/service.ts')),
    ...(await import('../../engine/src/contract/near-client.ts')),
  } : {}),
});
const defaultTransport = async (options) => new (await import('../../engine/src/contract/near-transport.ts')).NearApiTransport(options);

/** A signer for the dry run: every signature is refused, so the done-checks can run on the real client. */
const noSigner = new Proxy({}, { get: (_, name) => () => Promise.reject(new Error(`dry run: ${String(name)} would sign`)) });

/**
 * Runs the checks; every effect goes through `deps`, so tests run the dry run on fakes. Returns the summary lines.
 * deps: near (tools client), fetch, now, say, tree (linked worktree or null), engine() (the engine modules),
 * transport(options) (the signing NearTransport), readEnv(file), sleep, pollMs, pollTimes.
 */
export async function runChecks(argv, deps = {}) {
  const a = parseChecksArgs(argv);
  const client = deps.near ?? near;
  const fetchImpl = deps.fetch ?? ((...x) => globalThis.fetch(...x));
  const now = deps.now ?? Date.now;
  const say = deps.say ?? ((s = '') => console.log(s));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const tree = deps.tree === undefined ? linkedWorktreeOf(ROOT) : deps.tree;
  const refusal = sendRefusal(a.send, tree);
  if (refusal !== null) throw new Error(refusal);
  const summary = [];

  say(`gimbal canary checks on ${a.contract}, desk ${a.deskId}: ${a.send ? 'SEND' : 'dry run'}; steps ${a.steps.join(', ')}`);
  if (tree !== null) say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);

  const status = await client.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  const config = await client.view(a.contract, 'config');
  const bad = contractConfigProblems(config);
  if (bad.length > 0) throw new Error(`${a.contract} is not a mainnet Gimbal contract:\n  ${bad.join('\n  ')}`);
  const brokerId = config.orderly.broker_id;
  const chainId = config.orderly.chain_id;
  const desk = await client.view(a.contract, 'get_desk', { desk_id: a.deskId });
  if (desk === null) throw new Error(`${a.contract} has no desk ${a.deskId}`);
  const expectedId = orderlyAccountId(desk.evm_address, brokerId);
  if (desk.orderly_account_id !== expectedId) throw new Error(`get_desk's orderly_account_id ${desk.orderly_account_id} is not ${expectedId} (the desk's address under ${brokerId})`);
  let signerId = desk.operator ?? desk.owner;
  say(`contract  version ${JSON.stringify(await client.view(a.contract, 'version'))}, Mainnet, OutLayer ${config.price_source.OutLayer.contract}, `
    + `Orderly broker ${brokerId} on chain ${chainId}`);
  say(`desk      ${a.deskId}: owner ${desk.owner}, operator ${desk.operator ?? 'none (the engine signs as the owner)'}, paused ${desk.paused}, `
    + `EVM ${desk.evm_address}, Solana ${desk.solana.authority}`);
  say(`env file  ${a.envFile}: ${existsSync(a.envFile) ? 'exists' : 'not found'}${a.send ? '' : ' (read only with --send)'}`);
  const signedBy = a.send ? `the operator key in ${a.envFile}` : 'the operator key from the engine env file, read at --send';

  // Keys only now, and only with --send: checked against the chain before the first signature.
  let signing = null;
  const needsKey = a.send && a.steps.some((s) => s !== 'quotes');
  if (needsKey) {
    const env = (deps.readEnv ?? readEngineEnv)(a.envFile);
    const e = engineEnvProblems(env, { contract: a.contract, deskId: a.deskId, desk, brokerId });
    if (e.problems.length > 0) throw new Error(`${a.envFile} does not match ${a.contract} / ${a.deskId}:\n  ${e.problems.join('\n  ')}`);
    if (e.rpcUrl !== null) await createClient({ urls: [e.rpcUrl] }).rpc('status', []);
    const transport = await (deps.transport ?? defaultTransport)({
      network: 'mainnet', accountId: e.accountId, privateKey: e.privateKey, ...(e.rpcUrl === null ? {} : { rpcUrl: e.rpcUrl }),
    });
    const publicKey = await transport.publicKey();
    const view = await client.accessKey(e.accountId, publicKey);
    if (!isFunctionCallKey(view, a.contract, OPERATOR_METHODS)) {
      throw new Error(`${publicKey} is not ${e.accountId}'s operator key for ${a.contract} (FunctionCall, the ${OPERATOR_METHODS.length} operator methods): nothing was signed`);
    }
    say(`key       ${publicKey} on ${e.accountId}: FunctionCall, receiver ${a.contract}, allowance ${nearText(BigInt(view.permission.FunctionCall.allowance ?? 0), 4)} NEAR left`);
    signing = { transport, accountId: e.accountId, publicKey };
    signerId = e.accountId;
  }

  for (const step of a.steps) {
    say();
    if (step === 'prices') summary.push(...await pricesStep({ a, client, say, sleep, now, signerId, signedBy, signing, deps }));
    if (step === 'orderly') summary.push(...await orderlyStep({ a, client, say, now, desk, brokerId, chainId, signerId, signedBy, signing, fetchImpl, deps }));
    if (step === 'quotes') summary.push(...await quotesStep({ a, say, now, desk, fetchImpl }));
  }

  const block = summaryBlock({ at: new Date(now()).toISOString(), contract: a.contract, deskId: a.deskId, send: a.send, lines: summary });
  say();
  say(block.join('\n'));
  if (!a.send && a.steps.some((s) => s !== 'quotes')) {
    say('\ndry run: nothing was signed or sent (the dry quotes reserve nothing). Add --send, from the main checkout, to run the steps above.');
  }
  return block;
}

async function balances(client, ids) {
  const out = {};
  for (const id of ids) {
    const state = await client.account(id);
    if (state === null) throw new Error(`${id} does not exist on mainnet`);
    out[id] = BigInt(state.amount);
  }
  return out;
}

async function pricesStep({ a, client, say, sleep, now, signerId, signedBy, signing, deps }) {
  const assets = [...CANARY_SYMBOLS];
  const { actions, lines } = refreshPlan({ contract: a.contract, signer: signerId, signedBy, assets });
  say('prices');
  say(lines.join('\n'));
  const fees = await client.fees();
  const gasPrice = BigInt((await client.rpc('gas_price', [null])).gas_price);
  const cap = txGasCap(fees, { signer: signerId, receiver: a.contract, actions });
  say(`  gas       at most ${tgasText(cap.total)} TGas (${tgasText(cap.prepaid)} prepaid + ${tgasText(cap.fees)} action fees), `
    + `at most ${nearTextUp(cap.total * gasPrice, 4)} NEAR at ${gasPrice} yocto/gas; the unused part is refunded`);
  const before = (await client.view(a.contract, 'prices')) ?? [];
  const bal = await balances(client, [a.contract, signerId]);
  say(`  prices()  ${pricesText(before)}`);
  say(`  balances  ${a.contract} ${nearText(bal[a.contract], 6)} NEAR, ${signerId} ${nearText(bal[signerId], 6)} NEAR`);
  if (signing === null) return [`prices:  dry run; refresh_prices ${assets.join(',')} not sent; prices() now: ${pricesText(before)}`];

  const allowanceBefore = await signing.transport.allowance();
  const transport = guardedTransport(signing.transport, 'prices', a.contract);
  say('  sending refresh_prices; waiting for every receipt');
  const r = await transport.call(a.contract, 'refresh_prices', { assets }, CALL_TGAS);
  say(`  tx ${txLink(r.txHash)}: ${r.ok ? `returned ${JSON.stringify(r.value)}` : `FAILED ${r.failure}`}`);
  const outcome = await client.rpc('tx', { tx_hash: r.txHash, sender_account_id: signing.accountId, wait_until: 'FINAL' });
  const costs = txCosts(outcome);
  for (const rc of costs.receipts) {
    say(`    receipt ${rc.executor}: ${tgasText(rc.gas)} TGas, ${rc.status}`);
    for (const log of rc.logs) say(`      log ${log}`);
  }
  let after = before;
  let stale = assets;
  const times = deps.pollTimes ?? 36;
  for (let i = 0; i < times; i++) {
    after = (await client.view(a.contract, 'prices')) ?? [];
    stale = stalePrices(before, after, assets);
    if (stale.length === 0) break;
    if (i < times - 1) await sleep(deps.pollMs ?? 5_000);
  }
  const bal2 = await balances(client, [a.contract, signerId]);
  const allowanceAfter = await signing.transport.allowance();
  const delta = (id) => nearText(bal2[id] - bal[id], 6);
  const lines2 = [
    `prices:  tx ${r.txHash} ${r.ok ? `returned ${JSON.stringify(r.value)}` : 'FAILED'}; gas burnt ${tgasText(costs.gas)} TGas (${nearText(costs.tokens, 6)} NEAR)`,
    `         ${a.contract} balance ${delta(a.contract)} NEAR; ${signerId} balance ${delta(signerId)} NEAR`
      + `${allowanceBefore === null || allowanceAfter === null ? '' : `; key allowance ${nearText(allowanceAfter - allowanceBefore, 6)} NEAR`}`,
    `         prices() after: ${pricesText(after)}${stale.length === 0 ? '' : `; no newer price for ${stale.join(', ')}`}`,
    ...(r.ok ? [] : [`         failure ${r.failure}`]),
  ];
  return lines2;
}

async function orderlyStep({ a, client, say, now, desk, brokerId, chainId, signerId, signedBy, signing, fetchImpl, deps }) {
  const engine = await (deps.engine ?? defaultEngine)(signing !== null);
  const orderlyKey = `ed25519:${desk.solana.authority}`;
  const reader = new engine.OrderlyDeskClient({
    deskId: a.deskId, network: 'mainnet', apiUrl: ORDERLY_API, accountId: desk.orderly_account_id, orderlyKey,
    evmAddress: desk.evm_address, referralCode: null, signer: noSigner, fetch: fetchImpl, clock: { now },
  });
  const registered = await reader.isRegistered(brokerId);
  const key = registered ? await reader.keyInfo() : undefined;
  say(orderlyPlanLines({ contract: a.contract, deskId: a.deskId, desk, brokerId, chainId, signer: signerId, signedBy, registered, key, now: now() }).join('\n'));
  if (signing === null) {
    return [`orderly: dry run; ${registered ? 'registered' : 'not registered'} under ${brokerId}, key ${key === undefined ? 'none (no account)' : key === null ? 'not on Orderly' : key.status}; account ${desk.orderly_account_id}`];
  }

  // The engine's own setup, cut to the three Orderly steps: no codes, no builder fee, no Phoenix, no IP list.
  const contract = new engine.NearContractClient({
    contractId: a.contract, network: 'mainnet', transport: guardedTransport(signing.transport, 'orderly', a.contract),
    onHealth: (s, d) => say(`  near ${s}: ${d}`),
  });
  const collected = engine.collectingSigner(contract);
  const orderly = new engine.OrderlyDeskClient({
    deskId: a.deskId, network: 'mainnet', apiUrl: ORDERLY_API, accountId: desk.orderly_account_id, orderlyKey,
    evmAddress: desk.evm_address, referralCode: null, signer: collected.signer, fetch: fetchImpl, clock: { now },
  });
  let receiverAnswer;
  const orderlySetup = {
    accountId: orderly.accountId,
    isRegistered: (b) => orderly.isRegistered(b),
    keyInfo: () => orderly.keyInfo(),
    register: () => orderly.register(),
    addKey: () => orderly.addKey(),
    receiverAddress: async () => (receiverAnswer = await orderly.receiverAddress()),
    bindReferral: () => Promise.reject(new Error('referral_bind is not part of this check')),
    restrictKeyIps: () => Promise.reject(new Error('ip_restriction is not part of this check')),
  };
  const offHl = () => Promise.reject(new Error('Hyperliquid is not part of this check'));
  const progress = await engine.runSetup({
    deskId: a.deskId,
    desk: async () => ({ ...(await contract.getDesk(a.deskId)), orderly_ips: [] }),
    referralCodes: { hyperliquid: null, orderly: null, phoenix: null },
    builderFeeTenthBps: null,
    brokerId,
    hl: { hasAccount: offHl, referredBy: offHl, approvedBuilderFee: offHl, setReferrer: offHl, approveBuilderFee: offHl },
    orderly: orderlySetup,
    phoenix: null,
    takeOrderlyTx: collected.take,
    publish: () => {},
    log: (line) => say(`  ${line}`),
    now,
  });
  const out = [];
  for (const name of ['orderly_register', 'orderly_add_key', 'orderly_receiver_lookup']) {
    const s = progress.steps.find((x) => x.step === name);
    const line = `orderly: ${name} ${s.status}${s.detail === undefined ? '' : `: ${s.detail}`}${s.tx.length === 0 ? '' : `; tx ${s.tx.map((t) => t.id).join(', ')}`}`;
    say(`  ${line}`);
    out.push(line);
  }
  if (receiverAnswer !== undefined) {
    const full = `orderly: receiver_address answer ${JSON.stringify(receiverAnswer)}`;
    say(`  ${full}`);
    out.push(full);
  }
  out.push(`orderly: account ${desk.orderly_account_id}, ${accountLink(a.contract)}`);
  return out;
}

async function quotesStep({ a, say, now, desk, fetchImpl }) {
  say('quotes    dry 1Click quotes (dry: true reserves no deposit address); being reads, the dry run asks them too');
  const out = [];
  for (const q of quoteRequests({ contract: a.contract, deskId: a.deskId, desk, now: now() })) {
    say(`  ${q.name}`);
    say(`    POST ${ONECLICK_API}/quote ${JSON.stringify(q.body)}`);
    let v;
    try {
      const r = await askQuote(fetchImpl, q.body);
      v = quoteVerdict(r.status, r.body);
    } catch (e) {
      v = { verdict: 'error', text: e.message };
    }
    say(`    -> ${v.verdict}: ${v.text}`);
    out.push(`quotes:  ${q.name}: ${v.verdict === 'not available' ? 'still not available' : v.verdict} (${v.text})`);
  }
  return out;
}

if (isMain(import.meta.url)) await run(() => runChecks(process.argv.slice(2)), USAGE);
