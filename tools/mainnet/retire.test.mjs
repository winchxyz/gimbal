// retire.mjs on a fake mainnet. Rule under test: every balance read fails closed, so an error, a timeout, an
// unexpected shape or a non-number refuses the DeleteAccount. Every id is a placeholder or a public test key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEAR_USDC, evmBalances, phoenixTrader, solanaBalances } from './balances.mjs';
import { OPERATOR_METHODS } from './desk.mjs';
import { MAX_DELETE_STATE, decodeCounters, decodeDeskMoney, retireCallProblem, runRetire } from './retire.mjs';
import { MAINNET_ORDERLY_BROKER } from './venues.mjs';

const OLD = 'gimbal-canary.near';
const DESK_ID = 'canary';
const OWNER = 'ab'.repeat(32);
const FUNDER = 'funder.near';
const EVM = '0x1a642f0e3c3af545e7acbd38b07251b3990914f1';
const SOL = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const PUBLIC = `ed25519:${'7'.repeat(44)}`;
const OP_PUBLIC = `ed25519:${'8'.repeat(44)}`;
const SECRET = `ed25519:${'5'.repeat(88)}`;
const NEAR = 10n ** 24n;
const NOW = Date.parse('2026-11-01T12:00:00Z');
const MIN = 60_000;
const TRUE_B64 = Buffer.from('true').toString('base64');

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
function wasmWith(names) {
  const str = (s) => [...leb(s.length), ...Buffer.from(s)];
  const body = [...leb(names.length), ...names.flatMap((n) => [...str(n), 0, 0])];
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x07, ...leb(body.length), ...body]);
}
const C7 = wasmWith(['new', 'config', 'get_desk', 'orderly_request', 'panic_close']);
const C8 = wasmWith(['new', 'config', 'get_desk', 'ft_on_transfer', 'fund_venue', 'withdraw_to_owner', 'clear_payout_lock', 'orderly_request']);
const USDC_CODE = wasmWith(['ft_transfer', 'ft_balance_of', 'storage_deposit', 'storage_unregister', 'storage_balance_of']);

// Borsh, as near-sdk writes the contract's records (contract/src/money.rs DeskMoney, contract/src/rescue.rs DeskCounters).
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u128 = (v) => Buffer.concat([u64(BigInt(v) & ((1n << 64n) - 1n)), u64(BigInt(v) >> 64n)]);
const str = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
function money({ idle = 0, pending = false, since = 0, seq = 0 } = {}) {
  return Buffer.concat([str(OWNER), u128(0), u128(0), u128(0), u128(0), u128(idle), Buffer.from([pending ? 1 : 0]), u64(since), u64(seq)]);
}
function counters(paidMs = []) {
  const deposits = Buffer.alloc(32 * 32);
  const paid = Buffer.concat(Array.from({ length: 32 }, (_, i) => u64(paidMs[i] ?? 0)));
  paidMs.forEach((_, i) => deposits.fill(i + 1, i * 32, i * 32 + 32));
  return Buffer.concat([u64(0), u128(0), u128(0), u64(0), deposits, Buffer.from([paidMs.length]), paid]);
}
const recordKey = (prefix, id) => Buffer.concat([Buffer.from([prefix]), str(id)]);

const CONFIG = {
  network: 'Mainnet', mpc: 'v1.signer', price_source: { OutLayer: { contract: 'price-oracle.near' } },
  treasury: { near: 'treasury.near', hl_builder: '0x1111111111111111111111111111111111111111', referral_codes: { hyperliquid: null, orderly: null, phoenix: null } },
  fees: { performance_bps: 1000, hl_builder_tenth_bps: 10 },
  orderly: { broker_id: MAINNET_ORDERLY_BROKER, chain_id: 42161 },
};
const FEE = { send_sir: 100, send_not_sir: 100, execution: 100 };
const FEES = { receipt: FEE, deploy: FEE, deployByte: FEE, call: FEE, callByte: FEE, addKey: FEE, addKeyByte: FEE, deleteAccount: FEE };
const ZERO_LEDGER = { deposited: 0, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 0 };
const deskOf = (over = {}) => ({
  owner: OWNER, operator: null, paused: false, policy: {}, evm_address: EVM,
  solana: { authority: SOL, usdc_ata: 'UsdcAta111', phusd_ata: 'PhusdAta111', phoenix_trader: 'Trader111' },
  orderly_account_id: `0x${'cd'.repeat(32)}`, orderly_receiver: null, orderly_ips: [], ledger: ZERO_LEDGER, ...over,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ZERO_CH = (v = '0.0', raw = v) => ({ marginSummary: { accountValue: v, totalRawUsd: raw }, withdrawable: v, assetPositions: [] });
const VENUE_HOSTS = ['api.hyperliquid.xyz', 'perp-api.phoenix.trade', 'arb1.arbitrum.io', 'rpc.hyperliquid.xyz/evm', 'api.mainnet-beta.solana.com', 'api.orderly.org'];
const ZERO_WORD = `0x${'0'.repeat(64)}`;

/**
 * A clean old canary; every field of `o` puts something somewhere (`o.x` replaces the answer of read x).
 * `o.records` is merged over desk canary's default records (prefix -> Buffer; null removes one).
 */
function world(o = {}) {
  const code = o.code ?? C7;
  const st = {
    desks: { [DESK_ID]: o.desk ?? deskOf() }, deskIds: [...(o.deskIds ?? [DESK_ID])], contractUsdc: o.contractUsdc ?? '0',
    deleted: false, registered: o.usdcRegistered === true, blockMs: o.blockMs ?? NOW,
  };
  const seen = { sent: [], fetch: [], keys: 0, log: [] };
  const accounts = {
    [OLD]: { amount: String(63n * NEAR / 10n), locked: '0', storage_usage: code.length + (o.dataBytes ?? 3_000), code_hash: 'Code111' },
    [FUNDER]: { amount: String(2n * NEAR), locked: '0', storage_usage: 500, code_hash: '11111111111111111111111111111111' },
  };
  const defaults = code === C8 ? { 0: Buffer.from([1]), 3: u64(0), 5: counters(), 7: money(), 8: counters() } : { 0: Buffer.from([1]), 3: u64(0), 5: counters() };
  const recordsOf = (id) => Object.entries({ ...defaults, ...(id === DESK_ID ? o.records ?? {} : {}) }).filter(([, v]) => v !== null);
  const client = {
    rpc: async (method) => {
      if (method === 'status') return { chain_id: 'mainnet', sync_info: { latest_block_height: 1 } };
      if (method === 'gas_price') return { gas_price: '100000000' };
      if (method === 'block') return { header: { height: 1, timestamp_nanosec: String(BigInt(st.blockMs) * 1_000_000n) } };
      throw new Error(`unexpected rpc ${method}`);
    },
    view: async (id, method, args) => {
      seen.log.push(`near:${method}`);
      if (id === NEAR_USDC && method === 'ft_balance_of') return args.account_id === OLD ? st.contractUsdc : '0';
      if (id === NEAR_USDC && method === 'storage_balance_of') return args.account_id === OLD && st.registered ? { total: '1250000000000000000000', available: '0' } : null;
      if (id === 'intents.near' && method === 'mt_tokens_for_owner') {
        if (o.intents instanceof Error) throw o.intents;
        return o.intents ?? [];
      }
      if (id === OLD) {
        if (method === 'config') return CONFIG;
        if (method === 'get_desk') return st.deskIds.includes(args.desk_id) ? st.desks[args.desk_id] ?? deskOf() : null;
      }
      throw new Error(`unexpected view ${id}.${method}`);
    },
    state: async (id, prefix) => {
      assert.equal(id, OLD);
      seen.log.push(`near:state:${prefix[0]}`);
      if (prefix[0] === 0 && o.deskStateError) throw new Error(o.deskStateError);
      if (prefix[0] !== 0 && o.recordStateError) throw new Error(o.recordStateError);
      const out = [];
      for (const desk of st.deskIds) {
        for (const [p, value] of recordsOf(desk)) {
          const key = recordKey(Number(p), desk);
          if (key.subarray(0, prefix.length).equals(prefix)) out.push({ key, value });
        }
      }
      return out;
    },
    account: async (id) => (id === OLD && st.deleted ? null : accounts[id] ?? null),
    code: async (id) => (id === OLD ? code : id === NEAR_USDC ? USDC_CODE : null),
    accessKey: async (id, key) => {
      if (key === PUBLIC && id === OLD) return { nonce: 1, permission: 'FullAccess' };
      if (key === OP_PUBLIC && id === OWNER) return { nonce: 1, permission: { FunctionCall: { allowance: String(5n * NEAR), receiver_id: OLD, method_names: [...OPERATOR_METHODS] } } };
      return null;
    },
    fees: async () => FEES,
    send: async (signer, receiver, actions, { onSent } = {}) => {
      seen.sent.push({ receiver, actions, log: [...seen.log] });
      onSent?.('Tx1');
      if (actions[0]?.method === 'storage_unregister') {
        st.registered = false;
        return { hash: 'Tx2', burntTgas: 1, burntYocto: 1n, logs: [], failure: null, value: true };
      }
      st.deleted = true;
      accounts[FUNDER] = { ...accounts[FUNDER], amount: String(BigInt(accounts[FUNDER].amount) + 63n * NEAR / 10n) };
      return { hash: 'Tx1', burntTgas: 1, burntYocto: 1n, logs: [], failure: null, value: null };
    },
  };
  const archive = {
    rpc: async (method, params) => {
      assert.equal(method, 'tx');
      if (o.archive === false) throw new Error('archival RPC down');
      return {
        transaction: {
          signer_id: o.creator ?? FUNDER, receiver_id: 'near', hash: params.tx_hash,
          actions: [{ FunctionCall: { method_name: 'create_account', args: Buffer.from(JSON.stringify({ new_account_id: OLD, new_public_key: PUBLIC })).toString('base64') } }],
        },
        status: { SuccessValue: o.createdValue ?? TRUE_B64 },
      };
    },
  };
  const hlAnswer = (body) => {
    if (body.type !== 'perpDexs') assert.equal(body.user.toLowerCase(), EVM);
    switch (body.type) {
      case 'perpDexs': return o.perpDexs ?? [null, { name: 'xyz' }];
      case 'clearinghouseState': return (o.dexes ?? {})[body.dex ?? 'main'] ?? ZERO_CH();
      case 'spotClearinghouseState': return { balances: o.spot ?? [] };
      case 'userVaultEquities': return o.vaults ?? [];
      case 'delegatorSummary': return o.staking ?? { delegated: '0.0', undelegated: '0.0', totalPendingWithdrawal: '0.0', nPendingWithdrawals: 0 };
      case 'subAccounts': return o.subAccounts ?? null;
      case 'userNonFundingLedgerUpdates': return (o.hlLedger ?? []).filter((r) => r.time >= body.startTime);
      default: throw new Error(`unexpected hl ${body.type}`);
    }
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    seen.fetch.push(`${init.method ?? 'GET'} ${u}`);
    seen.log.push(VENUE_HOSTS.some((h) => u.includes(h)) ? 'venue' : u.endsWith('/inventory') ? 'near:inventory' : 'other');
    if (u.includes('api.nearblocks.io')) {
      if (o.nearblocks === false) return json({ message: 'rate limited' }, 429);
      if (u.endsWith(`/account/${OLD}`)) {
        if (o.nearblocksAccount === false) return json({ account: [{ account_id: OLD }] });
        return json({ account: [{ account_id: OLD, created: { transaction_hash: 'CreateTx111' } }] });
      }
      if (u.endsWith('/txns/CreateTx111')) return json({ txns: [{ transaction_hash: 'CreateTx111', signer_account_id: o.creator ?? FUNDER }] });
      if (u.includes(`/account/${OLD}/txns?method=orderly_request`)) {
        if (o.orderlyTxns === false) return json({ message: 'down' }, 500);
        return json({ txns: o.orderlyTxns ?? [], cursor: null });
      }
      if (u.endsWith(`/account/${OLD}/inventory`)) {
        if (o.inventory === false) return json({ message: 'down' }, 500);
        return json({ inventory: { fts: o.fts ?? [], nfts: [] } });
      }
    }
    if (u.includes('api.hyperliquid.xyz/info')) {
      const body = JSON.parse(init.body);
      if (o.hlDown === body.type) return json({ error: 'down' }, 500);
      return json(hlAnswer(body));
    }
    if (u.includes('perp-api.phoenix.trade/v1/trader/state/')) {
      assert.ok(u.includes(SOL));
      if (o.phoenix instanceof Response) return o.phoenix;
      return json({ authority: SOL, traderPdaIndex: 0, snapshot: { version: 1, subaccounts: o.phoenix ?? [] } });
    }
    if (u.includes('/v1/get_account')) return json(o.orderlyAccount ?? { success: false, code: -1607, message: 'Account not found.' });
    if (u.includes('/v1/get_orderly_key')) return json({ success: true, data: { key_status: 'ACTIVE' } });
    const body = JSON.parse(init.body ?? '{}');
    if (body.method === 'getBalance') return json({ result: { value: o.lamports ?? 0 } });
    if (body.method === 'getTokenAccountBalance') return json({ error: { code: -32602, message: o.ataError ?? 'Invalid param: could not find account' } });
    if (body.method === 'getTokenAccountsByOwner') {
      const program = body.params[1].programId;
      return json({ result: { value: (o.tokenAccounts ?? {})[program] ?? [] } });
    }
    if (body.method?.startsWith('eth_')) {
      const hyper = u.includes('hyperliquid.xyz/evm');
      const evm = (hyper ? o.hyperevm : o.arbitrum) ?? {};
      if (body.method === 'eth_chainId') return json({ result: hyper ? '0x3e7' : '0xa4b1' });
      if (body.method === 'eth_getBalance') return json({ result: evm.native ?? '0x0' });
      if (body.method === 'eth_call') return json({ result: evm[body.params[0].to.toLowerCase()] ?? ZERO_WORD });
    }
    throw new Error(`unexpected fetch ${u} ${init.body ?? ''}`);
  };
  return {
    seen, st,
    deps: {
      near: client, archive, fetch: fetchImpl, now: () => o.now ?? NOW, tree: null, rpcEnv: {},
      readKey: (_f, accountId) => { seen.keys++; return { accountId, publicKeyString: PUBLIC }; },
    },
  };
}

async function capture(argv, deps) {
  const lines = [];
  try {
    const block = await runRetire(argv, { ...deps, say: (s = '') => lines.push(s) });
    return { out: lines.join('\n'), block, error: null };
  } catch (e) {
    return { out: lines.join('\n'), block: null, error: e };
  }
}
const refusal = async (o, pattern, argv = [OLD]) => {
  const w = world(o);
  const r = await capture(argv, w.deps);
  assert.ok(r.error !== null, `expected a refusal for ${JSON.stringify(Object.keys(o))}`);
  assert.match(r.error.message, pattern);
  assert.equal(w.seen.sent.length, 0);
  return r;
};
const clean = async (o, why, argv = [OLD]) => assert.equal((await capture(argv, world(o).deps)).error?.message ?? null, null, why);
const REGISTERED = { success: true, data: { account_id: `0x${'cd'.repeat(32)}` } };

function engineFor(onHolding, holding = [{ token: 'USDC', holding: 0, frozen: 0, pending_short: 0 }], positions = { rows: [] }) {
  const calls = [];
  const transport = {
    accountId: OWNER,
    publicKey: async () => OP_PUBLIC,
    call: async (contractId, method, args) => { calls.push({ contractId, method, kind: args.req.kind }); return { ok: true }; },
    view: async () => null, account: async () => null, allowance: async () => 0n,
  };
  const engine = async () => ({
    NearContractClient: class {
      constructor(o) { this.o = o; }
      orderlyRequest(deskId, req, reason) { return this.o.transport.call(this.o.contractId, 'orderly_request', { desk_id: deskId, req, reason }, 100); }
    },
    OrderlyDeskClient: class {
      constructor(o) { this.o = o; }
      async holding(reason) {
        await this.o.signer.orderlyRequest(this.o.deskId, { kind: 'holding' }, reason);
        await assert.rejects(this.o.signer.orderlyRequest(this.o.deskId, { kind: 'withdraw_request' }, 'x'), /not orderly_request of kind holding or positions/);
        onHolding?.();
        return { holding };
      }
      async positions(reason) {
        await this.o.signer.orderlyRequest(this.o.deskId, { kind: 'positions' }, reason);
        return positions;
      }
    },
  });
  const env = new Map([
    ['GIMBAL_MODE', 'mainnet'], ['NEAR_NETWORK', 'mainnet'], ['GIMBAL_CONTRACT_ID', OLD], ['DESK_ID', DESK_ID],
    ['OWNER_ACCOUNT_ID', OWNER], ['OPERATOR_PRIVATE_KEY', SECRET],
  ]);
  return { calls, extra: { engine, transport: async () => transport, readEnv: () => env } };
}
const SEND = [OLD, '--send', '--engine-stopped'];

test('dry run: creator from the creation transaction, every address read, the DeleteAccount printed; no key read', async () => {
  const { seen, deps } = world();
  const r = await capture([OLD], deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /creator {3}created by funder\.near in https:\/\/nearblocks\.io\/txns\/CreateTx111 \(near\.create_account returned true, confirmed/);
  for (const what of [
    'Hyperliquid perps main', 'Hyperliquid perps xyz', 'Hyperliquid spot', 'Hyperliquid vaults', 'Hyperliquid staking', 'Hyperliquid sub-accounts',
    'Hyperliquid withdrawals', 'Phoenix trader', 'Solana authority SOL', 'Solana USDC token account', 'Solana PhUSD token account', 'Solana SPL Token accounts',
    'Solana Token-2022 accounts', 'Arbitrum USDC', 'Arbitrum USDC.e', 'Arbitrum ETH', 'HyperEVM HYPE', 'HyperEVM USDC', 'Orderly', 'Orderly withdraw_request',
    'contract idle_usdc', 'rescue ring', 'Hyperliquid nonce',
  ]) assert.match(r.out, new RegExp(`\\n {2}${what.replace('.', '\\.')}`), what);
  assert.match(r.out, /gimbal-canary\.near USDC on NEAR: 0, not registered/);
  assert.match(r.out, /gimbal-canary\.near NEP-141 tokens \(nearblocks\): none/);
  assert.match(r.out, /gimbal-canary\.near intents\.near tokens: none/);
  assert.match(r.out, /DeleteAccount: the account gimbal-canary\.near is deleted; its whole NEAR balance goes to the beneficiary funder\.near/);
  assert.match(r.out, /not covered: .*Orderly withdrawal history/);
  assert.equal(seen.keys + seen.sent.length, 0);
});

test('HIGH: Hyperliquid on every perp dex, spot, vaults, staked HYPE and sub-accounts', async () => {
  await refusal({ dexes: { xyz: ZERO_CH('3.5') } }, /Hyperliquid perps xyz holds 3\.5 USDC/);
  await refusal({ dexes: { xyz: { ...ZERO_CH(), assetPositions: [{ position: { coin: 'xyz:AAPL' } }] } } }, /1 open Hyperliquid position\(s\) on xyz/);
  await refusal({ perpDexs: [null, { name: 'xyz' }, { name: 'abc' }], dexes: { abc: ZERO_CH('1') } }, /Hyperliquid perps abc holds 1 USDC/);
  await refusal({ spot: [{ coin: 'HYPE', total: '0.5', hold: '0' }] }, /Hyperliquid spot HYPE holds 0\.5/);
  await refusal({ vaults: [{ vaultAddress: '0xv', equity: '2.0' }] }, /Hyperliquid vault 0xv holds 2 USDC/);
  await refusal({ staking: { delegated: '1.0', undelegated: '0.0', totalPendingWithdrawal: '0.0', nPendingWithdrawals: 0 } }, /Hyperliquid staking holds 1 HYPE/);
  await refusal({ subAccounts: [{ name: 's', subAccountUser: '0xs' }] }, /Hyperliquid has 1 sub-account/);
});

test('HIGH: Phoenix trader collateral, positions and orders, and every SPL / Token-2022 account of the authority', async () => {
  await refusal({ phoenix: [{ subaccountIndex: 0, collateral: '2500000', positions: [], orders: [] }] }, /Phoenix trader subaccount 0 holds 2\.5 USDC of collateral/);
  await refusal({ phoenix: [{ subaccountIndex: 1, collateral: '0', positions: [{ symbol: 'SOL' }], orders: [] }] }, /Phoenix trader subaccount 1 has 1 position/);
  await refusal({ phoenix: [{ subaccountIndex: 0, collateral: '0', positions: [], orders: [], spotCollaterals: [{ symbol: 'SOL', balance: '5000000', decimals: 9 }] }] }, /Phoenix trader subaccount 0 holds 0\.005 SOL/);
  await refusal({ phoenix: json({ error: 'busy' }, 503) }, /Phoenix trader could not be read/);
  const acct = (amount) => ({ pubkey: 'Acc111', account: { data: { parsed: { info: { mint: 'Mint111', tokenAmount: { amount, decimals: 6 } } } } } });
  await refusal({ tokenAccounts: { TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: [acct('7000000')] } }, /Solana Token-2022 account Acc111 \(mint Mint111\) holds 7/);
  await refusal({ tokenAccounts: { TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: [acct('1')] } }, /Solana SPL Token account Acc111 \(mint Mint111\) holds 0\.000001/);
  await refusal({ tokenAccounts: { TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: [{ pubkey: 'Acc111', account: { data: 'base64' } }] } }, /Solana SPL Token accounts could not be read/);
});

test('LOW E: Phoenix lists of the wrong type refuse; splines, triggers, escrow and a locked deposit refuse; a list left out is empty', async () => {
  const sub = (over) => [{ subaccountIndex: 0, sequence: 0, collateral: '0', ...over }];
  await refusal({ phoenix: sub({ positions: 'x' }) }, /Phoenix trader could not be read/);
  await refusal({ phoenix: sub({ orders: null }) }, /Phoenix trader could not be read/);
  await refusal({ phoenix: sub({ collateral: undefined }) }, /Phoenix trader could not be read/);
  await refusal({ phoenix: sub({ splines: [{ symbol: 'SOL', bidRegions: [] }] }) }, /Phoenix trader subaccount 0 has 1 spline/);
  await refusal({ phoenix: sub({ triggers: [{ symbol: 'SOL' }] }) }, /Phoenix trader subaccount 0 has 1 trigger/);
  await refusal({ phoenix: sub({ escrowRequests: [{ sequenceNumber: '1' }] }) }, /Phoenix trader subaccount 0 has 1 escrow request/);
  await refusal({ phoenix: sub({ lockedDeposit: { lockedQuoteLots: '1000000', consumedQuoteLots: '0' } }) }, /Phoenix trader subaccount 0 has 1 USDC locked/);
  // The live API leaves empty lists out (a market maker's subaccounts 1 and 2 have no `positions`, none has `orders`).
  await clean({ phoenix: sub({ lockedDeposit: { lockedQuoteLots: '0', consumedQuoteLots: '0' }, cooldownStatus: {} }) }, 'lists left out are empty');
  const live = { authority: SOL, snapshot: { subaccounts: [{ subaccountIndex: 2, sequence: 0, collateral: '0', spotCollaterals: [{ symbol: 'SOL', balance: '0', decimals: 9 }] }] } };
  const [s] = await phoenixTrader(async () => json(live), SOL);
  assert.deepEqual([s.positions, s.orders, s.splines, s.triggers, s.escrow, s.lockedE6], [0, 0, 0, 0, 0, 0n]);
});

test('MEDIUM: Orderly: only -1607 means not registered; a non-numeric holding refuses', async () => {
  await refusal({ orderlyAccount: { success: false, code: -1000, message: 'internal error' } }, /Orderly could not be read/);
  await refusal({ orderlyAccount: { success: true } }, /Orderly could not be read/);
  await clean({}, 'code -1607 is "not registered", which is clean');
});

test('LOW: a Solana token account that answers anything but "could not find account" refuses', async () => {
  await refusal({ ataError: 'Invalid param: not a Token account' }, /Solana USDC token account could not be read/);
  const answers = [{ result: { value: 0 } }, { error: { code: -32602, message: 'Invalid param: WrongSize' } }];
  const seq = async () => new Response(JSON.stringify(answers.shift()));
  await assert.rejects(solanaBalances(seq, 'http://x', { authority: SOL, tokenAccounts: { usdc: 'U' } }), /getTokenAccountBalance usdc/);
});

test('LOW D: an eth_call answer of "0x" refuses, never 0', async () => {
  await refusal({ arbitrum: { '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': '0x' } }, /Arbitrum could not be read/);
  await refusal({ hyperevm: { '0xb88339cb7199b77e23db6e890353e22632ba630f': '0x' } }, /HyperEVM could not be read/);
  const answers = [{ result: '0xa4b1' }, { result: '0x0' }, { result: '0x' }];
  const seq = async () => new Response(JSON.stringify(answers.shift()));
  await assert.rejects(evmBalances(seq, 'http://x', { chainId: 42161, address: EVM, tokens: { usdc: '0x1' } }), /eth_call/);
});

test('every read fails closed: an error, a bad shape or a non-number refuses', async () => {
  await refusal({ hlDown: 'perpDexs' }, /Hyperliquid could not be read/);
  await refusal({ hlDown: 'delegatorSummary' }, /Hyperliquid could not be read/);
  await refusal({ hlDown: 'userNonFundingLedgerUpdates' }, /Hyperliquid withdrawals could not be read/);
  await refusal({ dexes: { main: ZERO_CH('abc') } }, /Hyperliquid could not be read/);
  await refusal({ intents: new Error('view failed') }, /intents\.near tokens could not be read/);
  await refusal({ inventory: false }, /NEP-141 tokens \(nearblocks\) could not be read/);
  await refusal({ recordStateError: 'view_state too large' }, /contract state could not be read/);
  await refusal({ orderlyTxns: false }, /desk canary: Orderly withdraw_request could not be read/);
});

test('LOW: Arbitrum USDC.e, HyperEVM HYPE and USDC, the contract\'s other NEP-141 tokens and intents.near balances', async () => {
  await refusal({ arbitrum: { '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': '0x' + (5_000_000).toString(16) } }, /Arbitrum USDC\.e holds 5 USDC/);
  await refusal({ hyperevm: { native: '0x' + (10n ** 17n).toString(16) } }, /HyperEVM HYPE holds 0\.1 HYPE/);
  await refusal({ hyperevm: { '0xb88339cb7199b77e23db6e890353e22632ba630f': '0x' + (2_000_000).toString(16) } }, /HyperEVM USDC holds 2 USDC/);
  await refusal({ fts: [{ contract: 'wrap.near', amount: '1000', ft_meta: { decimals: 24, symbol: 'wNEAR' } }] }, /gimbal-canary\.near holds wrap\.near 1000/);
  await refusal({ intents: [{ token: 'nep141:usdc.near' }] }, /gimbal-canary\.near holds tokens on intents\.near/);
});

test('MEDIUM: C8 money in flight: a pending payout, a fund_venue or rescue slot paid within 65 min, a missing record', async () => {
  const c8 = { code: C8 };
  await clean(c8, 'a clean C8 contract retires');
  await refusal({ ...c8, records: { 7: money({ pending: true, since: NOW - MIN, seq: 3 }) } }, /desk canary: a payout is in flight \(payout_pending, since/);
  await refusal({ ...c8, records: { 8: counters([NOW - 10 * MIN]) } }, /desk canary: fund_venue ring slot 0 was paid 10 min ago/);
  await refusal({ ...c8, records: { 5: counters([NOW - 64 * MIN]) } }, /desk canary: rescue ring slot 0 was paid 64 min ago/);
  await clean({ ...c8, records: { 8: counters([NOW - 66 * MIN]) } }, 'over 65 min is settled');
  await refusal({ ...c8, records: { 7: null } }, /desk canary: the C8 money record could not be read/);
  await refusal({ ...c8, records: { 7: money().subarray(0, 20) } }, /desk canary: the C8 money record could not be read/);
  await refusal({ ...c8, records: { 7: money({ idle: 1 }) } }, /money record idle_usdc holds 0\.000001 USDC/);
  assert.deepEqual(decodeDeskMoney(money({ idle: 5, pending: true, since: 9, seq: 2 })), {
    owner: OWNER, ledger: { deposited: 0n, withdrawn: 0n, fees_paid: 0n, hwm: 0n, idle_usdc: 5n }, payout_pending: true, payout_since_ms: 9n, payout_seq: 2n,
  });
  assert.equal(decodeCounters(counters([1, 2])).deposit_paid_ms.slice(0, 3).join(), '1,2,0');
  assert.equal(counters().length, 1329, 'the 1,329 bytes of the ring');
});

test('LOW F: a missing rescue or fund_venue ring refuses; ring ages count from the latest block, not this machine\'s clock', async () => {
  await refusal({ records: { 5: null } }, /desk canary: the rescue ring record is missing/);
  await refusal({ code: C8, records: { 8: null } }, /desk canary: the fund_venue ring record is missing/);
  // The machine says 10 min ago; the chain's final block is 2 h later, so the slot is 130 min old: settled.
  await clean({ code: C8, records: { 8: counters([NOW - 10 * MIN]) }, blockMs: NOW + 120 * MIN }, 'block time, not Date.now');
  await refusal({ code: C8, records: { 8: counters([NOW + 100 * MIN]) }, blockMs: NOW + 120 * MIN }, /fund_venue ring slot 0 was paid 20 min ago/);
});

test('MEDIUM B: withdrawals in flight: a Hyperliquid withdraw or a desk HL nonce within 30 min, an Orderly withdraw_request within 30 min', async () => {
  const wd = (ago) => ({ time: NOW - ago * MIN, hash: `0x${'ef'.repeat(32)}`, delta: { type: 'withdraw', usdc: '5.0', nonce: 1, fee: '1.0' } });
  await refusal({ hlLedger: [wd(10)] }, /desk canary: Hyperliquid withdraw of 5 USDC 10 min ago: it may still be on its way to Arbitrum/);
  await clean({ hlLedger: [wd(31)] }, 'a withdraw over 30 min ago has arrived (and Arbitrum is read)');
  await refusal({ records: { 3: u64(NOW - 5 * MIN) } }, /desk canary: the contract signed a Hyperliquid action 5 min ago \(nonce/);
  await clean({ records: { 3: u64(NOW - 40 * MIN) } }, 'an old nonce');
  await refusal({ records: { 3: null } }, /desk canary: the Hyperliquid nonce record is missing/);
  const orq = (kind, ago, desk = DESK_ID) => ({
    transaction_hash: `Orq${ago}`, block_timestamp: String(BigInt(NOW - ago * MIN) * 1_000_000n),
    actions: [{ method: 'orderly_request', args: JSON.stringify({ desk_id: desk, req: { kind }, reason: 'r' }) }],
  });
  await refusal({ orderlyTxns: [orq('withdraw_request', 12)] }, /desk canary: an Orderly withdraw_request 12 min ago \(Orq12\)/);
  await clean({ orderlyTxns: [orq('holding', 1), orq('withdraw_request', 45)] }, 'other kinds, or over 30 min ago');
});

test('LOW C: the desk list comes from the contract\'s own state (prefix 0) and is read again at the recheck', async () => {
  const two = world({ deskIds: [DESK_ID, 'other'] });
  const r = await capture([OLD], two.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /desks: canary \(owner [0-9a-f]+\), other \(owner/);
  assert.match(r.out, /\ndesk other: EVM/);
  await refusal({ deskStateError: 'too large' }, /the desk list could not be read/);
  // A desk created while the Orderly holding was read is in the recheck.
  const late = world({ orderlyAccount: REGISTERED });
  const e = engineFor(() => { late.st.deskIds.push('late'); });
  const s = await capture(SEND, { ...late.deps, ...e.extra });
  assert.match(s.error?.message ?? '', /desk late/);
  assert.equal(late.seen.sent.length, 0);
});

test('LOW: the creator: no guessing; --creation-tx only with --beneficiary, confirmed on the archival RPC, create_account returned true', async () => {
  await refusal({}, /--beneficiary someone\.near is not funder\.near/, [OLD, '--beneficiary', 'someone.near']);
  await refusal({ createdValue: Buffer.from('false').toString('base64') }, /the beneficiary is unknown/);
  await refusal({ archive: false }, /the beneficiary is unknown/, [OLD, '--beneficiary', FUNDER]);
  await refusal({ nearblocksAccount: false }, /the beneficiary is unknown/, [OLD, '--beneficiary', FUNDER]);
  const ok = world({ nearblocksAccount: false });
  const r = await capture([OLD, '--beneficiary', FUNDER, '--creation-tx', 'CreateTx111'], ok.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /creator {3}created by funder\.near in https:\/\/nearblocks\.io\/txns\/CreateTx111 \(near\.create_account returned true, confirmed/);
  await refusal({ nearblocksAccount: false, creator: 'other.near' }, /the beneficiary is unknown/, [OLD, '--beneficiary', FUNDER, '--creation-tx', 'CreateTx111']);
});

test('refusals kept: money left, too much state', async () => {
  const rich = world({ dexes: { main: ZERO_CH('5.0') } });
  const s = await capture(SEND, rich.deps);
  assert.match(s.error.message, /not deleting gimbal-canary\.near/);
  assert.equal(rich.seen.keys + rich.seen.sent.length, 0, 'refused before the key is read');
  await refusal({ desk: deskOf({ ledger: { ...ZERO_LEDGER, idle_usdc: 30_000_000 } }) }, /desk canary: contract idle_usdc \(books\) holds 30 USDC/);
  await refusal({ dataBytes: MAX_DELETE_STATE + 1 }, /NEAR refuses DeleteAccount over 10000/);
});

test('--send: signed Orderly holding and positions reads, then everything again (NEAR side last), then the DeleteAccount', async () => {
  assert.equal(retireCallProblem(OLD, OLD, 'orderly_request', { req: { kind: 'holding' } }), null);
  assert.equal(retireCallProblem(OLD, OLD, 'orderly_request', { req: { kind: 'positions' } }), null);
  assert.match(retireCallProblem(OLD, 'other.near', 'orderly_request', { req: { kind: 'holding' } }), /retire calls gimbal-canary\.near only/);
  const w = world({ orderlyAccount: REGISTERED });
  const e = engineFor();
  const dry = await capture([OLD], w.deps);
  assert.ok(dry.block.includes('desk canary: Orderly holding and positions unread (signed reads at --send)'), dry.block?.join('\n') ?? dry.error?.stack);
  const r = await capture(SEND, { ...w.deps, ...e.extra });
  assert.equal(r.error, null, r.error?.stack);
  assert.deepEqual(e.calls, [{ contractId: OLD, method: 'orderly_request', kind: 'holding' }, { contractId: OLD, method: 'orderly_request', kind: 'positions' }]);
  assert.match(r.out, /Orderly USDC +holding 0, frozen 0, pending_short 0/);
  assert.match(r.out, /Orderly positions +none/);
  assert.match(r.out, /read again after the Orderly reads: the venues first, the NEAR side last, right before signing/);
  assert.match(r.out, /window +\d+(\.\d+)? s from the first of the last NEAR reads to the DeleteAccount/);
  assert.deepEqual(w.seen.sent[0].actions, [{ type: 'DeleteAccount', beneficiaryId: FUNDER }]);
  // The last reads before the signature are the NEAR side: nothing of the venues comes after them.
  const log = w.seen.sent[0].log;
  const lastVenue = log.lastIndexOf('venue');
  for (const tag of ['near:ft_balance_of', 'near:storage_balance_of', 'near:mt_tokens_for_owner', 'near:inventory', 'near:get_desk', 'near:state:0', 'near:state:5']) {
    assert.ok(log.lastIndexOf(tag) > lastVenue, `${tag} is read after the venues`);
  }
  assert.ok(r.block.some((l) => /^delete: {3}tx Tx1 succeeded; gimbal-canary\.near no longer exists$/.test(l)));
  assert.doesNotMatch(r.out, new RegExp(SECRET));
});

test('LOW G: Orderly positions: a position, a pending order or unsettled PnL refuses; rows that are not a list refuse', async () => {
  const run = async (positions) => {
    const w = world({ orderlyAccount: REGISTERED });
    const r = await capture(SEND, { ...w.deps, ...engineFor(null, undefined, positions).extra });
    assert.equal(w.seen.sent.length, 0);
    return r.error?.message ?? '';
  };
  const row = (over) => ({ rows: [{ symbol: 'PERP_BTC_USDC', position_qty: 0, pending_long_qty: 0, pending_short_qty: 0, unsettled_pnl: 0, ...over }] });
  assert.match(await run(row({ position_qty: 0.001 })), /desk canary: Orderly PERP_BTC_USDC has a position of 0\.001/);
  assert.match(await run(row({ pending_long_qty: 1 })), /desk canary: Orderly PERP_BTC_USDC has pending orders/);
  assert.match(await run(row({ unsettled_pnl: -0.5 })), /desk canary: Orderly PERP_BTC_USDC has -0\.5 USDC of unsettled PnL/);
  assert.match(await run({ rows: 'x' }), /Orderly positions of desk canary could not be read/);
  assert.match(await run(row({ unsettled_pnl: 'abc' })), /is not a number/);
});

test('MEDIUM A: --send needs --engine-stopped; a contract registered on USDC refuses until --unregister-usdc ran', async () => {
  const w = world();
  const r = await capture([OLD, '--send'], w.deps);
  assert.match(r.error?.message ?? '', /--send needs --engine-stopped/);
  assert.equal(w.seen.keys + w.seen.sent.length, 0);
  const reg = await refusal({ usdcRegistered: true }, /gimbal-canary\.near is registered on USDC: anyone can transfer USDC to it until the DeleteAccount; first run node tools\/mainnet\/retire\.mjs gimbal-canary\.near --unregister-usdc/);
  assert.match(reg.out, /USDC on NEAR: 0, registered/);

  // The separate step: storage_unregister({"force":false}) with 1 yoctoNEAR, signed by the contract's own key.
  const u = world({ usdcRegistered: true });
  const dry = await capture([OLD, '--unregister-usdc'], u.deps);
  assert.equal(dry.error, null, dry.error?.stack);
  assert.match(dry.out, /FunctionCall storage_unregister/);
  assert.ok(dry.out.includes('args {"force":false}'));
  assert.equal(u.seen.keys + u.seen.sent.length, 0);
  const sent = await capture([OLD, '--unregister-usdc', '--send'], u.deps);
  assert.equal(sent.error, null, sent.error?.stack);
  assert.equal(u.seen.sent[0].receiver, NEAR_USDC);
  assert.equal(u.seen.sent[0].actions[0].method, 'storage_unregister');
  assert.equal(u.seen.sent[0].actions[0].deposit, 1n);
  assert.ok(sent.block.some((l) => /gimbal-canary\.near is no longer registered on USDC/.test(l)), sent.block.join('\n'));
  assert.equal(u.st.registered, false);
  // With USDC on it, storage_unregister(force false) would fail: refused before signing.
  const rich = world({ usdcRegistered: true, contractUsdc: '5' });
  const x = await capture([OLD, '--unregister-usdc', '--send'], rich.deps);
  assert.match(x.error?.message ?? '', /holds 0\.000005 USDC on NEAR: storage_unregister/);
  assert.equal(rich.seen.sent.length, 0);
});

test('MEDIUM --send: USDC, idle_usdc or a USDC registration that arrives during the Orderly read stops the delete', async () => {
  const usdc = world({ orderlyAccount: REGISTERED });
  const a = engineFor(() => { usdc.st.contractUsdc = '2000000'; });
  const r1 = await capture(SEND, { ...usdc.deps, ...a.extra });
  assert.match(r1.error?.message ?? '', /not deleting gimbal-canary\.near:[\s\S]*holds 2 USDC on NEAR/);
  assert.equal(usdc.seen.sent.length, 0);
  const idle = world({ orderlyAccount: REGISTERED });
  const b = engineFor(() => { idle.st.desks[DESK_ID] = deskOf({ ledger: { ...ZERO_LEDGER, idle_usdc: 1_000_000 } }); });
  const r2 = await capture(SEND, { ...idle.deps, ...b.extra });
  assert.match(r2.error?.message ?? '', /contract idle_usdc \(books\) holds 1 USDC/);
  assert.equal(idle.seen.sent.length, 0);
  const again = world({ orderlyAccount: REGISTERED });
  const g = engineFor(() => { again.st.registered = true; });
  const r4 = await capture(SEND, { ...again.deps, ...g.extra });
  assert.match(r4.error?.message ?? '', /registered on USDC/);
  assert.equal(again.seen.sent.length, 0);
  const nan = world({ orderlyAccount: REGISTERED });
  const c = engineFor(null, [{ token: 'USDC', holding: 'abc', frozen: 0, pending_short: 0 }]);
  const r3 = await capture(SEND, { ...nan.deps, ...c.extra });
  assert.match(r3.error?.message ?? '', /Orderly holding of desk canary could not be read|is not a number/);
  assert.equal(nan.seen.sent.length, 0);
});
