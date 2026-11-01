// deposit.mjs, withdraw.mjs, fund.mjs and retire.mjs run on a fake mainnet: what the dry runs print, and every
// refusal. Every id here is a placeholder or a public test key of contract/core/tests/vectors (never funded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NEAR_USDC } from './balances.mjs';
import { OPERATOR_METHODS } from './desk.mjs';
import { depositPlan, runDeposit } from './deposit.mjs';
import { runFund, venueTarget } from './fund.mjs';
import { runRetire } from './retire.mjs';
import { CANARY_LIMITS, MAINNET_ORDERLY_BROKER } from './venues.mjs';
import { runWithdraw, withdrawActions } from './withdraw.mjs';

const vectors = (file) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../contract/core/tests/vectors/${file}`, import.meta.url)), 'utf8'));
const LIVE = vectors('oneclick-live.json');
const DRY = vectors('oneclick.json');
const HL_TO = '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054';
const fundQuote = (v) => v.quotes.find((q) => q.method === 'fund_venue' && q.response.quoteRequest.destinationAsset === HL_TO);

const CONTRACT = 'gimbal-canary2.near';
const OLD = 'gimbal-canary.near';
const DESK_ID = 'canary';
// The vectors' desk: its owner is a public test key's implicit account, as are the addresses.
const OWNER = fundQuote(LIVE).response.quoteRequest.refundTo;
const EVM = LIVE.desk.evm;
const SOL = LIVE.desk.sol;
const RECEIVER = LIVE.desk.orderly_receiver;
const FUNDER = 'funder.near';
const TREASURY = 'treasury.near';
const PUBLIC = `ed25519:${'7'.repeat(44)}`;
const OP_PUBLIC = `ed25519:${'8'.repeat(44)}`;
const SECRET = `ed25519:${'5'.repeat(88)}`;
const NEAR = 10n ** 24n;
const USDC = 1_000_000n;

const leb = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
/** A wasm module that exports `names` as functions. */
function wasmWith(names) {
  const str = (s) => [...leb(s.length), ...Buffer.from(s)];
  const body = [...leb(names.length), ...names.flatMap((n) => [...str(n), 0, 0])];
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x07, ...leb(body.length), ...body]);
}
const C8 = wasmWith(['new', 'config', 'get_desk', 'ft_on_transfer', 'fund_venue', 'withdraw_to_owner', 'clear_payout_lock', 'orderly_request']);
const C7 = wasmWith(['new', 'config', 'get_desk', 'orderly_request', 'panic_close']);

const CONFIG = {
  network: 'Mainnet', mpc: 'v1.signer', price_source: { OutLayer: { contract: 'price-oracle.near' } },
  treasury: { near: TREASURY, hl_builder: '0x1111111111111111111111111111111111111111', referral_codes: { hyperliquid: null, orderly: null, phoenix: null } },
  fees: { performance_bps: 1000, hl_builder_tenth_bps: 10 },
  orderly: { broker_id: MAINNET_ORDERLY_BROKER, chain_id: 42161 },
};
const FEE = { send_sir: 100, send_not_sir: 100, execution: 100 };
const FEES = { receipt: FEE, deploy: FEE, deployByte: FEE, call: FEE, callByte: FEE, addKey: FEE, addKeyByte: FEE, deleteAccount: FEE };

function deskOf(over = {}) {
  return {
    owner: OWNER, operator: null, paused: false, policy: { ...CANARY_LIMITS, unpriced_max_notional_usd: 20 },
    evm_address: EVM, solana: { authority: SOL, usdc_ata: 'UsdcAta111', phusd_ata: 'PhusdAta111', phoenix_trader: 'T' },
    orderly_account_id: `0x${'ab'.repeat(32)}`, orderly_receiver: null, orderly_ips: [],
    ledger: { deposited: 30_000_000, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 30_000_000 },
    ...over,
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake mainnet and venues. `o`: contract, code, desk, usdc (balances), registered (ids on USDC), accounts,
 * hl (account value), orderly (registered), nearblocks (false = down), creator, onSend(actions, receiver) -> outcome.
 */
function world(o = {}) {
  const contract = o.contract ?? CONTRACT;
  const code = o.code ?? C8;
  let desk = o.desk ?? deskOf();
  const usdc = new Map(Object.entries(o.usdc ?? { [OWNER]: String(50n * USDC) }));
  const registered = new Set(o.registered ?? [OWNER, TREASURY]);
  const seen = { sent: [], fetch: [], keys: 0, views: [] };
  let deleted = false;
  let hlValue = o.hl ?? '0.0';
  let hlRaw = o.hlRaw ?? null;
  let hlLedger = o.hlLedger ?? [];
  const accounts = {
    [contract]: { amount: String(63n * NEAR / 10n), locked: '0', storage_usage: code.length + (o.dataBytes ?? 3_000), code_hash: 'Code111' },
    [OWNER]: { amount: String(2n * NEAR), locked: '0', storage_usage: 500, code_hash: '11111111111111111111111111111111' },
    [FUNDER]: { amount: String(2n * NEAR), locked: '0', storage_usage: 500, code_hash: '11111111111111111111111111111111' },
    ...(o.accounts ?? {}),
  };
  const client = {
    rpc: async (method) => {
      if (method === 'status') return { chain_id: 'mainnet', sync_info: { latest_block_height: 1 } };
      if (method === 'gas_price') return { gas_price: '100000000' };
      throw new Error(`unexpected rpc ${method}`);
    },
    view: async (id, method, args) => {
      seen.views.push(`${id}.${method}`);
      if (id === NEAR_USDC) {
        if (method === 'ft_balance_of') return usdc.get(args.account_id) ?? '0';
        if (method === 'storage_balance_of') return registered.has(args.account_id) ? { total: '1250000000000000000000', available: '0' } : null;
      }
      if (id === contract) {
        if (method === 'config') return CONFIG;
        if (method === 'get_desk') return args.desk_id === DESK_ID ? desk : null;
        if (method === 'desks_of') return [DESK_ID];
      }
      throw new Error(`unexpected view ${id}.${method}`);
    },
    account: async (id) => (id === contract && deleted ? null : accounts[id] ?? null),
    code: async (id) => (id === contract ? code : null),
    accessKey: async (id, key) => {
      if (key === PUBLIC && (id === OWNER || id === contract)) return { nonce: 1, permission: 'FullAccess' };
      if (key === OP_PUBLIC && id === OWNER) return { nonce: 1, permission: { FunctionCall: { allowance: String(5n * NEAR), receiver_id: contract, method_names: [...OPERATOR_METHODS] } } };
      return null;
    },
    fees: async () => FEES,
    send: async (signer, receiver, actions, { onSent } = {}) => {
      const hash = `Tx${seen.sent.length + 1}`;
      seen.sent.push({ signer: signer.publicKeyString, receiver, actions });
      onSent?.(hash);
      const r = o.onSend ? o.onSend({ receiver, actions, setDesk: (d) => { desk = d; }, desk }) : {};
      if (actions[0].type === 'DeleteAccount') {
        deleted = true;
        accounts[actions[0].beneficiaryId] = { ...accounts[actions[0].beneficiaryId], amount: String(BigInt(accounts[actions[0].beneficiaryId].amount) + 63n * NEAR / 10n) };
      }
      if (r.hl !== undefined) hlValue = r.hl;
      if (r.hlRaw !== undefined) hlRaw = r.hlRaw;
      if (r.hlLedger !== undefined) hlLedger = r.hlLedger;
      return { hash, burntTgas: 5, burntYocto: 10n ** 20n, logs: r.logs ?? [], failure: r.failure ?? null, value: r.value ?? null };
    },
  };
  const archive = {
    rpc: async (method, params) => {
      assert.equal(method, 'tx');
      const creator = o.creator ?? FUNDER;
      return {
        transaction: {
          signer_id: creator, receiver_id: 'near',
          actions: [{ FunctionCall: { method_name: 'create_account', args: Buffer.from(JSON.stringify({ new_account_id: contract, new_public_key: PUBLIC })).toString('base64') } }],
          hash: params.tx_hash,
        },
        status: { SuccessValue: '' },
      };
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    seen.fetch.push(`${init.method ?? 'GET'} ${u}${init.body === undefined ? '' : ` ${init.body}`}`);
    if (u.includes('api.nearblocks.io')) {
      if (o.nearblocks === false) return json({ message: 'rate limited' }, 429);
      if (u.endsWith(`/account/${contract}`)) return json({ account: [{ account_id: contract, created: { transaction_hash: 'CreateTx111' } }] });
      if (u.endsWith('/txns/CreateTx111')) return json({ txns: [{ transaction_hash: 'CreateTx111', signer_account_id: o.creator ?? FUNDER }] });
      if (u.includes(`/account/${contract}/txns?method=create_desk`)) {
        return json({ txns: [{ transaction_hash: 'DeskTx111', actions: [{ action: 'FUNCTION_CALL', method: 'create_desk', args: JSON.stringify({ desk_id: DESK_ID, policy: {} }) }] }], cursor: null });
      }
    }
    if (u.includes('hyperliquid.xyz/info')) {
      const body = JSON.parse(init.body);
      if (body.type === 'clearinghouseState') {
        return json({ marginSummary: { accountValue: hlValue, totalRawUsd: hlRaw ?? hlValue }, withdrawable: hlValue, assetPositions: [] });
      }
      if (body.type === 'spotClearinghouseState') return json({ balances: [] });
      if (body.type === 'userNonFundingLedgerUpdates') return json(hlLedger.filter((e) => e.time >= body.startTime));
    }
    if (u.includes('/v1/get_account')) return json(o.orderly ? { success: true, data: { account_id: desk.orderly_account_id } } : { success: false, code: -1607, message: 'Account not found.' });
    if (u.includes('/v1/get_orderly_key')) return json({ success: true, data: { key_status: 'ACTIVE' } });
    if (u.endsWith('/v0/quote')) return o.quote(JSON.parse(init.body), init);
    if (u.endsWith('/v0/deposit/submit')) return json({ status: 'PENDING_DEPOSIT' });
    if (u.includes('/v0/status?depositAddress=')) return json({ status: 'SUCCESS' });
    if (init.body !== undefined) {
      const body = JSON.parse(init.body);
      if (body.method === 'getBalance') return json({ result: { value: 0 } });
      if (body.method === 'getTokenAccountBalance') return json({ error: { code: -32602, message: 'Invalid param: could not find account' } });
      if (body.method === 'eth_chainId') return json({ result: '0xa4b1' });
      if (body.method === 'eth_getBalance' || body.method === 'eth_call') return json({ result: '0x0' });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const readKey = (_file, accountId) => {
    seen.keys++;
    return { accountId, publicKeyString: o.keyPublic ?? PUBLIC };
  };
  return { seen, deps: { near: client, archive, fetch: fetchImpl, now: () => o.now ?? Date.parse('2026-11-01T12:00:00Z'), tree: null, readKey, sleep: async () => {}, pollMs: 0 } };
}

async function capture(fn, argv, deps) {
  const lines = [];
  try {
    const block = await fn(argv, { ...deps, say: (s = '') => lines.push(s) });
    return { out: lines.join('\n'), block, error: null };
  } catch (e) {
    return { out: lines.join('\n'), block: null, error: e };
  }
}

/** Every script refuses --send in a linked worktree before it reads anything. */
test('--send refuses in a linked git worktree before anything is read, for every money script and retire', async () => {
  const touched = new Proxy({}, { get: () => { throw new Error('read before the refusal'); } });
  const deps = { tree: '/w/tree', near: touched, fetch: touched, archive: touched, readKey: () => { throw new Error('key read'); }, say: () => {} };
  const cases = [
    [runDeposit, [CONTRACT, DESK_ID, '10', '--key-file', 'k.json', '--send']],
    [runWithdraw, [CONTRACT, DESK_ID, '5', '--key-file', 'k.json', '--send']],
    [runFund, [CONTRACT, DESK_ID, 'hyperliquid', '12', '--send']],
    [runRetire, [OLD, '--send', '--engine-stopped']],
    [runRetire, [OLD, '--unregister-usdc', '--send']],
  ];
  for (const [fn, argv] of cases) await assert.rejects(fn(argv, deps), /\/w\/tree is a linked git worktree: --send runs from the main checkout only/, argv.join(' '));
});

test('the money scripts refuse a contract without the C8 money methods (the old canary)', async () => {
  const { deps } = world({ code: C7, quote: () => { throw new Error('no quote'); } });
  for (const [fn, argv, method] of [
    [runDeposit, [CONTRACT, DESK_ID, '10'], 'ft_on_transfer'],
    [runWithdraw, [CONTRACT, DESK_ID, '5'], 'withdraw_to_owner'],
    [runFund, [CONTRACT, DESK_ID, 'hyperliquid', '12'], 'fund_venue'],
  ]) {
    const r = await capture(fn, argv, deps);
    assert.match(r.error?.message ?? '', new RegExp(`has no ${method}.*: it is not the C8 contract`), method);
  }
  // Every money script needs all four money methods, whichever one it calls.
  const partial = world({ code: wasmWith(['new', 'config', 'get_desk', 'ft_on_transfer', 'fund_venue', 'withdraw_to_owner']), quote: () => { throw new Error('no quote'); } });
  for (const [fn, argv] of [[runDeposit, [CONTRACT, DESK_ID, '10']], [runWithdraw, [CONTRACT, DESK_ID, '5']], [runFund, [CONTRACT, DESK_ID, 'hyperliquid', '12']]]) {
    assert.match((await capture(fn, argv, partial.deps)).error?.message ?? '', /has no clear_payout_lock: it is not the C8 contract/, argv.join(' '));
  }
});

// --- deposit ---

test('deposit dry run: the contract\'s USDC registration first, then ft_transfer_call with msg {"desk_id"} and 1 yocto; no key read', async () => {
  const { seen, deps } = world({ registered: [OWNER, TREASURY] });
  const r = await capture(runDeposit, [CONTRACT, DESK_ID, '10'], deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /tx 1: register gimbal-canary2\.near on USDC/);
  assert.match(r.out, /FunctionCall storage_deposit {2}gas 30 TGas {2}deposit 0\.00125 NEAR/);
  assert.ok(r.out.includes(`args {"account_id":"${CONTRACT}","registration_only":true}`));
  assert.match(r.out, /tx 2: deposit 10 USDC into desk canary/);
  assert.match(r.out, /FunctionCall ft_transfer_call {2}gas 150 TGas {2}deposit 0\.000000000000000000000001 NEAR/);
  assert.ok(r.out.includes(`args {"receiver_id":"${CONTRACT}","amount":"10000000","msg":"{\\"desk_id\\":\\"canary\\"}"}`));
  assert.match(r.out, /ledger after: deposited 40, idle_usdc 40 USDC/);
  assert.deepEqual(r.block.slice(-1), ['=== end ===']);
  assert.match(r.block[0], /^=== gimbal deposit 2026-11-01T12:00:00\.000Z ===$/);
  assert.equal(seen.keys, 0);
  assert.equal(seen.sent.length, 0);
  assert.equal(depositPlan({ contract: CONTRACT, deskId: DESK_ID, amount: USDC, registered: true }).length, 1, 'no registration once registered');
});

test('deposit: the owner\'s USDC shortfall is printed in the dry run and refused at the end; --send refuses before the key', async () => {
  const { seen, deps } = world({ usdc: { [OWNER]: '0' } });
  const dry = await capture(runDeposit, [CONTRACT, DESK_ID, '10'], deps);
  assert.match(dry.out, /tx 2: deposit 10 USDC/, 'the plan is printed');
  assert.match(dry.out, /refused: {2}the owner holds 0 USDC on NEAR, less than the 10 to deposit/);
  assert.match(dry.error.message, /less than the 10 to deposit/);
  const send = await capture(runDeposit, [CONTRACT, DESK_ID, '10', '--key-file', 'k.json', '--send'], deps);
  assert.match(send.error.message, /less than the 10 to deposit/);
  assert.equal(seen.keys, 0);
  assert.equal(seen.sent.length, 0);
});

test('deposit --send: a key that is not the owner\'s full-access key signs nothing; the right one sends both, one at a time', async () => {
  const wrong = world({ keyPublic: OP_PUBLIC });
  const w = await capture(runDeposit, [CONTRACT, DESK_ID, '10', '--key-file', 'k.json', '--send'], wrong.deps);
  assert.match(w.error.message, /--key-file is not a full-access key of the desk owner/);
  assert.equal(wrong.seen.sent.length, 0);

  const ok = world({
    registered: [OWNER, TREASURY],
    onSend: ({ actions, setDesk, desk }) => {
      if (actions[0].method !== 'ft_transfer_call') return { value: '' };
      setDesk({ ...desk, ledger: { ...desk.ledger, deposited: 40_000_000, idle_usdc: 40_000_000 } });
      return { value: '10000000', logs: [`EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"deposit","data":[{"desk_id":"canary","amount":"10000000"}]}`] };
    },
  });
  const r = await capture(runDeposit, [CONTRACT, DESK_ID, '10', '--key-file', 'k.json', '--send'], ok.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.deepEqual(ok.seen.sent.map((s) => `${s.receiver} ${s.actions[0].method}`), [`${NEAR_USDC} storage_deposit`, `${NEAR_USDC} ft_transfer_call`]);
  assert.ok(r.block.some((l) => /^event: {4}deposit \{"desk_id":"canary","amount":"10000000"\}$/.test(l)));
  assert.ok(r.block.some((l) => /ledger: {3}after {2}deposited 40,/.test(l)));
  assert.doesNotMatch(r.out, new RegExp(SECRET));
});

// --- withdraw ---

test('withdraw dry run: withdraw_to_owner with 1 yocto and 300 TGas, the expected fee before anything is sent', async () => {
  const { seen, deps } = world();
  const r = await capture(runWithdraw, [CONTRACT, DESK_ID, '5'], deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /FunctionCall withdraw_to_owner {2}gas 300 TGas {2}deposit 0\.000000000000000000000001 NEAR/);
  assert.ok(r.out.includes(`args {"desk_id":"canary","amount":"5000000"}`));
  assert.match(r.out, /expected {2}payout 5 USDC: 5 to the owner, fee 0 to the treasury treasury\.near/);
  assert.match(r.out, /the contract needs at least 150/);
  assert.match(r.out, /the treasury treasury\.near is registered/);
  assert.equal(seen.keys + seen.sent.length, 0);
  assert.deepEqual(withdrawActions(DESK_ID, 1n)[0].args, { desk_id: DESK_ID, amount: '1' });
});

test('withdraw refusals: over idle_usdc (E_SIZE), nothing idle, an owner not on USDC; an unregistered treasury is a warning when a fee is due', async () => {
  const { deps } = world();
  assert.match((await capture(runWithdraw, [CONTRACT, DESK_ID, '31'], deps)).error.message, /31 USDC is over desk canary's idle USDC on NEAR, 30: the contract refuses it \(E_SIZE\)/);
  const empty = world({ desk: deskOf({ ledger: { deposited: 0, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 0 } }) });
  assert.match((await capture(runWithdraw, [CONTRACT, DESK_ID, 'all'], empty.deps)).error.message, /holds no idle USDC/);
  const unreg = world({ registered: [TREASURY] });
  assert.match((await capture(runWithdraw, [CONTRACT, DESK_ID, '5'], unreg.deps)).error.message, /is not registered on USDC on NEAR: the payout transfer would fail/);
  const profit = world({ registered: [OWNER], desk: deskOf({ ledger: { deposited: 20_000_000, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 30_000_000 } }) });
  const r = await capture(runWithdraw, [CONTRACT, DESK_ID, 'all'], profit.deps);
  assert.match(r.out, /payout 30 USDC: 29 to the owner, fee 1 to the treasury/);
  assert.match(r.out, /treasury treasury\.near is NOT registered/);
  assert.match(r.out, /warning {3}the fee transfer would fail and the fee 1 would stay in the desk's idle USDC/);
});

test('withdraw --send: the events after; a false return is a refusal', async () => {
  const logs = [
    'EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"payout","data":[{"desk_id":"canary","amount":"5000000","to_owner":"5000000"}]}',
    'EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"fee_charged","data":[{"desk_id":"canary","fee":"0"}]}',
  ];
  const ok = world({ onSend: () => ({ value: true, logs }) });
  const r = await capture(runWithdraw, [CONTRACT, DESK_ID, '5', '--key-file', 'k.json', '--send'], ok.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.equal(ok.seen.sent[0].actions[0].method, 'withdraw_to_owner');
  assert.ok(r.block.includes('event:    payout {"desk_id":"canary","amount":"5000000","to_owner":"5000000"}'));
  assert.ok(r.block.includes('event:    fee_charged {"desk_id":"canary","fee":"0"}'));
  const no = world({ onSend: () => ({ value: false }) });
  assert.match((await capture(runWithdraw, [CONTRACT, DESK_ID, '5', '--key-file', 'k.json', '--send'], no.deps)).error.message, /returned false: nothing reached the owner/);
});

// --- fund ---

test('fund dry run: a dry quote (refundTo the owner, recipient the desk EVM), verified with the contract\'s rules; the API key never shows', async () => {
  const dry = fundQuote(DRY);
  const bodies = [];
  const { seen, deps } = world({
    now: Date.parse(dry.response.timestamp) + 1000,
    quote: (body, init) => {
      bodies.push({ body, auth: init.headers.authorization });
      return json(dry.response, 201);
    },
  });
  const env = new Map([['ONECLICK_API_KEY', { value: 'sk-test-secret-123', from: '.env' }]]);
  const r = await capture(runFund, [CONTRACT, DESK_ID, 'hyperliquid', '20'], { ...deps, env });
  assert.equal(r.error, null, r.error?.stack);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].body.dry, true, 'a dry run asks for a dry quote only');
  assert.equal(bodies[0].body.refundTo, OWNER);
  assert.equal(bodies[0].body.recipient, EVM);
  assert.equal(bodies[0].body.destinationAsset, HL_TO);
  assert.equal(bodies[0].auth, 'Bearer sk-test-secret-123');
  assert.doesNotMatch(r.out + seen.fetch.join('\n'), /sk-test-secret-123/);
  assert.match(r.out, /ONECLICK_API_KEY set \(from \.env; not shown\)/);
  assert.match(r.out, /verified {2}1Click's signature over the canonical quote/);
  assert.match(r.out, /room below amountOut \d+ bps \(>= 50\)/);
  assert.match(r.out, /FunctionCall fund_venue {2}gas 300 TGas {2}deposit 0 NEAR/);
  assert.ok(r.out.includes(JSON.stringify(dry.canonical_json)), 'the quote goes to the contract as the exact signed string');
  assert.match(r.out, /the contract needs at least 115/);
  assert.equal(seen.keys + seen.sent.length, 0);
});

test('fund refusals: Orderly without a pinned receiver, idle short (printed, then refused; --send before any quote)', async () => {
  assert.throws(() => venueTarget('orderly', deskOf()), /no pinned Orderly receiver: the owner pins it with set_orderly_receiver first/);
  assert.equal(venueTarget('orderly', deskOf({ orderly_receiver: RECEIVER })).recipient, RECEIVER);
  const dry = fundQuote(DRY);
  let quotes = 0;
  const short = world({
    now: Date.parse(dry.response.timestamp) + 1000,
    desk: deskOf({ ledger: { deposited: 10_000_000, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 10_000_000 } }),
    quote: () => { quotes++; return json(dry.response, 201); },
  });
  const env = new Map();
  const d = await capture(runFund, [CONTRACT, DESK_ID, 'hyperliquid', '20'], { ...short.deps, env });
  assert.match(d.out, /refused: {2}20 USDC is over desk canary's idle USDC on NEAR, 10/);
  assert.match(d.error.message, /E_SIZE/);
  assert.equal(quotes, 1);
  const s = await capture(runFund, [CONTRACT, DESK_ID, 'hyperliquid', '20', '--send'], { ...short.deps, env });
  assert.match(s.error.message, /E_SIZE/);
  assert.equal(quotes, 1, '--send asks for no live quote it cannot pay');
  assert.equal(short.seen.keys, 0);
  const o = await capture(runFund, [CONTRACT, DESK_ID, 'orderly', '10'], { ...world({ quote: () => json({}, 500) }).deps, env });
  assert.match(o.error.message, /no pinned Orderly receiver/);
});

test('fund --send: a live quote checked, fund_venue signed with the operator key, then 1Click status and the Hyperliquid ledger', async () => {
  const live = fundQuote(LIVE);
  const bodies = [];
  const at = Date.parse(live.response.timestamp) + 1000;
  const HASH = `0x${'9a'.repeat(32)}`;
  // How 1Click hands HyperCore USDC to the desk: an incoming ledger entry to the desk address (here a `send`).
  const delivery = { time: at + 5_000, hash: HASH, delta: { type: 'send', user: '0x2222222222222222222222222222222222222222', destination: EVM, token: 'USDC', amount: '19.6', usdcValue: '19.6', fee: '0.0' } };
  const w = world({
    keyPublic: OP_PUBLIC,
    now: at,
    quote: (body) => { bodies.push(body); return json(live.response, 201); },
    onSend: () => ({ value: true, hl: '19.6', hlRaw: '19.6', hlLedger: [delivery], logs: ['EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"fund_venue","data":[{"desk_id":"canary"}]}'] }),
  });
  const r = await capture(runFund, [CONTRACT, DESK_ID, 'hyperliquid', '20', '--send'], { ...w.deps, env: new Map() });
  assert.equal(r.error, null, r.error?.stack);
  assert.equal(bodies[0].dry, false);
  assert.equal(w.seen.sent.length, 1);
  const call = w.seen.sent[0].actions[0];
  assert.equal(call.method, 'fund_venue');
  assert.equal(call.args.quote, live.canonical_json);
  assert.equal(call.args.quote_signature, live.signature);
  assert.equal(w.seen.sent[0].signer, OP_PUBLIC);
  assert.ok(w.seen.fetch.some((f) => f.includes('/v0/deposit/submit') && f.includes(live.response.quote.depositAddress)));
  assert.ok(r.block.includes('1click:   status SUCCESS'));
  assert.ok(r.block.includes(`landed:   yes: 1Click SUCCESS and a Hyperliquid ledger send of 19.6 USDC to the desk (>= minAmountOut 19.480951), ${HASH}`), r.block.join('\n'));

  // A balance that rises without a ledger entry (PnL, or a transfer from elsewhere) is not a landing.
  const pnl = world({ keyPublic: OP_PUBLIC, now: at, quote: () => json(live.response, 201), onSend: () => ({ value: true, hl: '25.0', hlRaw: '25.0' }) });
  const p = await capture(runFund, [CONTRACT, DESK_ID, 'hyperliquid', '20', '--send', '--timeout-s', '60'], { ...pnl.deps, env: new Map() });
  assert.ok(p.block.some((l) => /^landed: {3}unconfirmed: 1Click SUCCESS, but no Hyperliquid ledger entry to the desk of at least minAmountOut 19\.480951 USDC/.test(l)), p.block?.join('\n') ?? p.error?.stack);
  // Too small, from the desk itself, or before the fund_venue: not the delivery.
  for (const bad of [{ ...delivery, delta: { ...delivery.delta, amount: '1.0', usdcValue: '1.0' } }, { ...delivery, delta: { ...delivery.delta, destination: '0x3333333333333333333333333333333333333333' } }, { ...delivery, time: at - 120_000 }]) {
    const x = world({ keyPublic: OP_PUBLIC, now: at, hlLedger: [bad], quote: () => json(live.response, 201), onSend: () => ({ value: true }) });
    const y = await capture(runFund, [CONTRACT, DESK_ID, 'hyperliquid', '20', '--send', '--timeout-s', '60'], { ...x.deps, env: new Map() });
    assert.ok(y.block.some((l) => /^landed: {3}unconfirmed/.test(l)), y.block?.join('\n') ?? y.error?.stack);
  }

  const full = world({ keyPublic: PUBLIC, now: Date.parse(live.response.timestamp) + 1000, quote: () => json(live.response, 201) });
  const f = await capture(runFund, [CONTRACT, DESK_ID, 'hyperliquid', '20', '--send'], { ...full.deps, env: new Map() });
  assert.match(f.error.message, /is not .*'s operator key for gimbal-canary2\.near/);
  assert.equal(full.seen.sent.length, 0);
});

test('fund refuses a verified quote that is not what was asked: amount, slippage, venue', async () => {
  const live = fundQuote(LIVE);
  const run = async (argv) => {
    const w = world({ keyPublic: OP_PUBLIC, now: Date.parse(live.response.timestamp) + 1000, quote: () => json(live.response, 201) });
    const r = await capture(runFund, argv, { ...w.deps, env: new Map() });
    return { r, sent: w.seen.sent.length };
  };
  // The recorded quote: 20 USDC from NEAR to HyperCore at 100 bps, recipient the desk EVM.
  const amount = await run([CONTRACT, DESK_ID, 'hyperliquid', '12', '--send']);
  assert.match(amount.r.error?.message ?? '', /the quote is not the transfer asked for:[\s\S]*amountIn 20000000 is not the 12 USDC asked \(12000000\)/);
  assert.equal(amount.sent, 0);
  const slip = await run([CONTRACT, DESK_ID, 'hyperliquid', '20', '--slippage-bps', '150', '--send']);
  assert.match(slip.r.error?.message ?? '', /slippageTolerance 100 is not the 150 asked/);
  assert.equal(slip.sent, 0);
  const venue = await run([CONTRACT, DESK_ID, 'solana', '20', '--send']);
  assert.match(venue.r.error?.message ?? '', /destinationAsset .* is not solana's|recipient .* is not solana's/);
  assert.equal(venue.sent, 0);
});

test('the placeholders are the vectors\' public test desk', () => {
  assert.match(OWNER, /^[0-9a-f]{64}$/);
  assert.equal(EVM, DRY.desk.evm);
});
