// retire.mjs on a fake mainnet. Rule under test: every balance read fails closed, so an error, a timeout, an
// unexpected shape or a non-number refuses the DeleteAccount. Every id is a placeholder or a public test key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEAR_USDC, solanaBalances } from './balances.mjs';
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

/** A clean old canary; every field of `o` puts something somewhere (`o.x` replaces the answer of read x). */
function world(o = {}) {
  const code = o.code ?? C7;
  const st = { desk: o.desk ?? deskOf(), contractUsdc: o.contractUsdc ?? '0', deleted: false };
  const seen = { sent: [], fetch: [], keys: 0 };
  const accounts = {
    [OLD]: { amount: String(63n * NEAR / 10n), locked: '0', storage_usage: code.length + (o.dataBytes ?? 3_000), code_hash: 'Code111' },
    [FUNDER]: { amount: String(2n * NEAR), locked: '0', storage_usage: 500, code_hash: '11111111111111111111111111111111' },
  };
  const records = new Map(Object.entries(o.records ?? (code === C8 ? { 7: money(), 8: counters(), 5: counters() } : { 5: counters() })));
  const client = {
    rpc: async (method) => {
      if (method === 'status') return { chain_id: 'mainnet', sync_info: { latest_block_height: 1 } };
      if (method === 'gas_price') return { gas_price: '100000000' };
      throw new Error(`unexpected rpc ${method}`);
    },
    view: async (id, method, args) => {
      if (id === NEAR_USDC && method === 'ft_balance_of') return args.account_id === OLD ? st.contractUsdc : '0';
      if (id === 'intents.near' && method === 'mt_tokens_for_owner') {
        if (o.intents instanceof Error) throw o.intents;
        return o.intents ?? [];
      }
      if (id === OLD) {
        if (method === 'config') return CONFIG;
        if (method === 'get_desk') return args.desk_id === DESK_ID ? st.desk : null;
        if (method === 'desks_of') return [DESK_ID];
      }
      throw new Error(`unexpected view ${id}.${method}`);
    },
    state: async (id, prefix) => {
      assert.equal(id, OLD);
      if (o.stateError) throw new Error(o.stateError);
      const out = [];
      for (const [p, value] of records) {
        const key = recordKey(Number(p), DESK_ID);
        if (key.subarray(0, prefix.length).equals(prefix)) out.push({ key, value });
      }
      return out;
    },
    account: async (id) => (id === OLD && st.deleted ? null : accounts[id] ?? null),
    code: async (id) => (id === OLD ? code : null),
    accessKey: async (id, key) => {
      if (key === PUBLIC && id === OLD) return { nonce: 1, permission: 'FullAccess' };
      if (key === OP_PUBLIC && id === OWNER) return { nonce: 1, permission: { FunctionCall: { allowance: String(5n * NEAR), receiver_id: OLD, method_names: [...OPERATOR_METHODS] } } };
      return null;
    },
    fees: async () => FEES,
    send: async (signer, receiver, actions, { onSent } = {}) => {
      seen.sent.push({ receiver, actions });
      onSent?.('Tx1');
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
          signer_id: o.creator ?? FUNDER,
          receiver_id: 'near', hash: params.tx_hash,
          actions: [{ FunctionCall: { method_name: 'create_account', args: Buffer.from(JSON.stringify({ new_account_id: OLD, new_public_key: PUBLIC })).toString('base64') } }],
        },
        status: { SuccessValue: o.createdValue ?? TRUE_B64 },
      };
    },
  };
  const hlAnswer = (body) => {
    if (body.type !== 'perpDexs') assert.equal(body.user, EVM);
    switch (body.type) {
      case 'perpDexs': return o.perpDexs ?? [null, { name: 'xyz' }];
      case 'clearinghouseState': return (o.dexes ?? {})[body.dex ?? 'main'] ?? ZERO_CH();
      case 'spotClearinghouseState': return { balances: o.spot ?? [] };
      case 'userVaultEquities': return o.vaults ?? [];
      case 'delegatorSummary': return o.staking ?? { delegated: '0.0', undelegated: '0.0', totalPendingWithdrawal: '0.0', nPendingWithdrawals: 0 };
      case 'subAccounts': return o.subAccounts ?? null;
      default: throw new Error(`unexpected hl ${body.type}`);
    }
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    seen.fetch.push(`${init.method ?? 'GET'} ${u}`);
    if (u.includes('api.nearblocks.io')) {
      if (o.nearblocks === false) return json({ message: 'rate limited' }, 429);
      if (u.endsWith(`/account/${OLD}`)) {
        if (o.nearblocksAccount === false) return json({ account: [{ account_id: OLD }] });
        return json({ account: [{ account_id: OLD, created: { transaction_hash: 'CreateTx111' } }] });
      }
      if (u.endsWith('/txns/CreateTx111')) return json({ txns: [{ transaction_hash: 'CreateTx111', signer_account_id: o.creator ?? FUNDER }] });
      if (u.includes(`/account/${OLD}/txns?method=create_desk`)) {
        return json({ txns: [{ transaction_hash: 'DeskTx111', actions: [{ method: 'create_desk', args: JSON.stringify({ desk_id: DESK_ID }) }] }], cursor: null });
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
      if (body.method === 'eth_call') return json({ result: evm[body.params[0].to.toLowerCase()] ?? '0x0' });
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

test('dry run: creator from the creation transaction, every address read, the DeleteAccount printed; no key read', async () => {
  const { seen, deps } = world();
  const r = await capture([OLD], deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /creator {3}created by funder\.near in https:\/\/nearblocks\.io\/txns\/CreateTx111 \(near\.create_account returned true, confirmed/);
  for (const what of [
    'Hyperliquid perps main', 'Hyperliquid perps xyz', 'Hyperliquid spot', 'Hyperliquid vaults', 'Hyperliquid staking', 'Hyperliquid sub-accounts',
    'Phoenix trader', 'Solana authority SOL', 'Solana USDC token account', 'Solana PhUSD token account', 'Solana SPL Token accounts',
    'Solana Token-2022 accounts', 'Arbitrum USDC', 'Arbitrum USDC.e', 'Arbitrum ETH', 'HyperEVM HYPE', 'HyperEVM USDC', 'Orderly', 'contract idle_usdc',
    'rescue ring',
  ]) assert.match(r.out, new RegExp(`\\n {2}${what.replace('.', '\\.')}`), what);
  assert.match(r.out, /gimbal-canary\.near USDC on NEAR: 0/);
  assert.match(r.out, /gimbal-canary\.near NEP-141 tokens \(nearblocks\): none/);
  assert.match(r.out, /gimbal-canary\.near intents\.near tokens: none/);
  assert.match(r.out, /DeleteAccount: the account gimbal-canary\.near is deleted; its whole NEAR balance goes to the beneficiary funder\.near/);
  assert.match(r.out, /not covered: /);
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

test('MEDIUM: Orderly: only -1607 means not registered; a non-numeric holding refuses', async () => {
  await refusal({ orderlyAccount: { success: false, code: -1000, message: 'internal error' } }, /Orderly could not be read/);
  await refusal({ orderlyAccount: { success: true } }, /Orderly could not be read/);
  const w = world();
  assert.equal((await capture([OLD], w.deps)).error, null, 'code -1607 is "not registered", which is clean');
});

test('LOW: a Solana token account that answers anything but "could not find account" refuses', async () => {
  await refusal({ ataError: 'Invalid param: not a Token account' }, /Solana USDC token account could not be read/);
  const answers = [{ result: { value: 0 } }, { error: { code: -32602, message: 'Invalid param: WrongSize' } }];
  const seq = async () => new Response(JSON.stringify(answers.shift()));
  await assert.rejects(solanaBalances(seq, 'http://x', { authority: SOL, tokenAccounts: { usdc: 'U' } }), /getTokenAccountBalance usdc/);
});

test('every read fails closed: an error, a bad shape or a non-number refuses', async () => {
  await refusal({ hlDown: 'perpDexs' }, /Hyperliquid could not be read/);
  await refusal({ hlDown: 'delegatorSummary' }, /Hyperliquid could not be read/);
  await refusal({ dexes: { main: ZERO_CH('abc') } }, /Hyperliquid could not be read/);
  await refusal({ intents: new Error('view failed') }, /intents\.near tokens could not be read/);
  await refusal({ inventory: false }, /NEP-141 tokens \(nearblocks\) could not be read/);
  await refusal({ stateError: 'view_state too large' }, /contract state could not be read/);
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
  assert.equal((await capture([OLD], world(c8).deps)).error, null, 'a clean C8 contract retires');
  await refusal({ ...c8, records: { 7: money({ pending: true, since: NOW - 60_000, seq: 3 }), 8: counters(), 5: counters() } }, /desk canary: a payout is in flight \(payout_pending, since/);
  await refusal({ ...c8, records: { 7: money(), 8: counters([NOW - 10 * 60_000]), 5: counters() } }, /desk canary: fund_venue ring slot 0 was paid 10 min ago/);
  await refusal({ ...c8, records: { 7: money(), 8: counters(), 5: counters([NOW - 64 * 60_000]) } }, /desk canary: rescue ring slot 0 was paid 64 min ago/);
  assert.equal((await capture([OLD], world({ ...c8, records: { 7: money(), 8: counters([NOW - 66 * 60_000]), 5: counters() } }).deps)).error, null, 'over 65 min is settled');
  await refusal({ ...c8, records: { 8: counters(), 5: counters() } }, /desk canary: the C8 money record could not be read/);
  await refusal({ ...c8, records: { 7: money().subarray(0, 20), 8: counters(), 5: counters() } }, /desk canary: the C8 money record could not be read/);
  await refusal({ ...c8, records: { 7: money({ idle: 1 }), 8: counters(), 5: counters() } }, /money record idle_usdc holds 0\.000001 USDC/);
  assert.deepEqual(decodeDeskMoney(money({ idle: 5, pending: true, since: 9, seq: 2 })), {
    owner: OWNER, ledger: { deposited: 0n, withdrawn: 0n, fees_paid: 0n, hwm: 0n, idle_usdc: 5n }, payout_pending: true, payout_since_ms: 9n, payout_seq: 2n,
  });
  assert.equal(decodeCounters(counters([1, 2])).deposit_paid_ms.slice(0, 3).join(), '1,2,0');
  assert.equal(counters().length, 1329, 'the 1,329 bytes of the ring');
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

test('refusals kept: money left, an unknown desk list, too much state', async () => {
  const rich = world({ dexes: { main: ZERO_CH('5.0') } });
  const s = await capture([OLD, '--send'], rich.deps);
  assert.match(s.error.message, /not deleting gimbal-canary\.near/);
  assert.equal(rich.seen.keys + rich.seen.sent.length, 0, 'refused before the key is read');
  await refusal({ desk: deskOf({ ledger: { ...ZERO_LEDGER, idle_usdc: 30_000_000 } }) }, /desk canary: contract idle_usdc \(books\) holds 30 USDC/);
  await refusal({ nearblocks: false }, /the desk list could not be read in full/);
  await refusal({ dataBytes: MAX_DELETE_STATE + 1 }, /NEAR refuses DeleteAccount over 10000/);
});

function engineFor(onHolding, holding = [{ token: 'USDC', holding: 0, frozen: 0, pending_short: 0 }]) {
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
        await assert.rejects(this.o.signer.orderlyRequest(this.o.deskId, { kind: 'withdraw_request' }, 'x'), /not orderly_request of kind holding/);
        onHolding?.();
        return { holding };
      }
    },
  });
  const env = new Map([
    ['GIMBAL_MODE', 'mainnet'], ['NEAR_NETWORK', 'mainnet'], ['GIMBAL_CONTRACT_ID', OLD], ['DESK_ID', DESK_ID],
    ['OWNER_ACCOUNT_ID', OWNER], ['OPERATOR_PRIVATE_KEY', SECRET],
  ]);
  return { calls, extra: { engine, transport: async () => transport, readEnv: () => env } };
}
const REGISTERED = { success: true, data: { account_id: `0x${'cd'.repeat(32)}` } };

test('--send: one signed Orderly holding read, then everything read again, then the DeleteAccount', async () => {
  assert.equal(retireCallProblem(OLD, OLD, 'orderly_request', { req: { kind: 'holding' } }), null);
  assert.match(retireCallProblem(OLD, 'other.near', 'orderly_request', { req: { kind: 'holding' } }), /retire calls gimbal-canary\.near only/);
  const w = world({ orderlyAccount: REGISTERED });
  const e = engineFor();
  const dry = await capture([OLD], w.deps);
  assert.ok(dry.block.includes('desk canary: Orderly holding unread (signed read at --send)'));
  const r = await capture([OLD, '--send'], { ...w.deps, ...e.extra });
  assert.equal(r.error, null, r.error?.stack);
  assert.deepEqual(e.calls, [{ contractId: OLD, method: 'orderly_request', kind: 'holding' }]);
  assert.match(r.out, /Orderly USDC +holding 0, frozen 0, pending_short 0/);
  assert.match(r.out, /read again after the Orderly read, just before signing/);
  assert.deepEqual(w.seen.sent[0].actions, [{ type: 'DeleteAccount', beneficiaryId: FUNDER }]);
  assert.ok(r.block.some((l) => /^delete: {3}tx Tx1 succeeded; gimbal-canary\.near no longer exists$/.test(l)));
  assert.doesNotMatch(r.out, new RegExp(SECRET));
});

test('MEDIUM --send: USDC or idle_usdc that arrives during the Orderly read stops the delete', async () => {
  const usdc = world({ orderlyAccount: REGISTERED });
  const a = engineFor(() => { usdc.st.contractUsdc = '2000000'; });
  const r1 = await capture([OLD, '--send'], { ...usdc.deps, ...a.extra });
  assert.match(r1.error?.message ?? '', /not deleting gimbal-canary\.near:[\s\S]*holds 2 USDC on NEAR/);
  assert.equal(usdc.seen.sent.length, 0);
  const idle = world({ orderlyAccount: REGISTERED });
  const b = engineFor(() => { idle.st.desk = deskOf({ ledger: { ...ZERO_LEDGER, idle_usdc: 1_000_000 } }); });
  const r2 = await capture([OLD, '--send'], { ...idle.deps, ...b.extra });
  assert.match(r2.error?.message ?? '', /contract idle_usdc \(books\) holds 1 USDC/);
  assert.equal(idle.seen.sent.length, 0);
  const nan = world({ orderlyAccount: REGISTERED });
  const c = engineFor(null, [{ token: 'USDC', holding: 'abc', frozen: 0, pending_short: 0 }]);
  const r3 = await capture([OLD, '--send'], { ...nan.deps, ...c.extra });
  assert.match(r3.error?.message ?? '', /Orderly holding of desk canary could not be read|is not a number/);
  assert.equal(nan.seen.sent.length, 0);
});
