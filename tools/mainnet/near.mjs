// A NEAR mainnet client for the canary runbook (tools/mainnet/README.md): JSON-RPC, borsh transactions
// (FunctionCall, DeployContract, AddKey with a FunctionCall permission, DeleteKey for keys.mjs, DeleteAccount for
// retire.mjs), key files that are never printed, and a printer for planned transactions. No dependencies: node:crypto signs, the rest is written out here or shared.
//
// This is a separate module from tools/testnet/near.mjs on purpose: that one refuses mainnet, this one refuses
// testnet, and neither has a network switch, so the testnet guards stay exactly as they are. Only pure helpers
// (base58, sha256) come from it; importing it does no I/O.
//
// Mainnet only, three times over: every account id it signs for, sends to or treats as Gimbal's must be
// `<name>.near` or a 64-hex implicit account (the MPC contract `v1.signer` and the registrar `near` are named
// constants); every RPC endpoint must answer `status` with chain_id "mainnet" before the first call through it; and
// a key file that names a network must name mainnet.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { b58decode, b58encode, sha256 } from '../testnet/near.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KEYS = join(ROOT, '.keys');
/** The MPC signer (interfaces §1.1). */
export const MPC = 'v1.signer';
/** The OutLayer price oracle (interfaces §1.1). */
export const ORACLE = 'price-oracle.near';
/** Creates `<name>.near` accounts through its `create_account`. */
export const REGISTRAR = 'near';
/**
 * NEAR_RPC_URL (from the shell environment only: .env may hold a testnet RPC), then two public mainnet endpoints,
 * both checked on 2026-10-31 to answer `status` with chain_id "mainnet". rpc.mainnet.near.org is deprecated and
 * no longer listed.
 */
export const RPC_URLS = [process.env.NEAR_RPC_URL, 'https://free.rpc.fastnear.com', 'https://near.drpc.org'].filter(Boolean);
export const TGAS = 10n ** 12n;
export const YOCTO_PER_NEAR = 10n ** 24n;
/** Storage staking: 10^19 yoctoNEAR per byte (1 NEAR per 100 kB). */
export const YOCTO_PER_BYTE = 10n ** 19n;
/** The code hash of an account without a contract. */
export const NO_CODE = '11111111111111111111111111111111';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- account ids ---

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** A valid NEAR account id that is `<...>.near` or a 64-hex implicit account. */
export function isMainnetId(id) {
  return typeof id === 'string' && id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id)
    && (/\.near$/.test(id) || /^[0-9a-f]{64}$/.test(id));
}

/** Returns `id` when it is a mainnet account id; throws otherwise. */
export function mainnetId(id, what = 'account') {
  if (!isMainnetId(id)) {
    throw new Error(`${what} ${JSON.stringify(id)} is not a mainnet account (<name>.near or 64-hex implicit): these scripts run on mainnet only`);
  }
  return id;
}

/** Returns `id` when it is a top-level `<name>.near` (one part before `.near`), the kind `near` creates. */
export function topLevelNearId(id, what = 'account') {
  mainnetId(id, what);
  if (!/^([a-z\d]+[-_])*[a-z\d]+\.near$/.test(id)) throw new Error(`${what} ${id} is not a top-level <name>.near account`);
  return id;
}

// --- NEAR amounts (bigint yoctoNEAR) ---

/** "6.2" -> 6.2 NEAR in yoctoNEAR; refuses anything but digits with up to 24 decimals. */
export function parseNear(text, what = 'amount') {
  if (typeof text !== 'string' || !/^\d+(\.\d{1,24})?$/.test(text)) {
    throw new Error(`${what} ${JSON.stringify(text)} is not a NEAR amount (digits, up to 24 decimals)`);
  }
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, '0'));
}

/** yoctoNEAR as NEAR: exact with trailing zeros cut, or cut to `decimals`. */
export function nearText(yocto, decimals) {
  const v = BigInt(yocto);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  let frac = (abs % YOCTO_PER_NEAR).toString().padStart(24, '0');
  frac = decimals === undefined ? frac.replace(/0+$/, '') : frac.slice(0, decimals);
  return `${neg ? '-' : ''}${abs / YOCTO_PER_NEAR}${frac === '' ? '' : `.${frac}`}`;
}

/** Rounds up to a multiple of 0.1 NEAR. */
export function ceilToTenth(yocto) {
  const step = YOCTO_PER_NEAR / 10n;
  return ((BigInt(yocto) + step - 1n) / step) * step;
}

/** What an account can spend: its balance less the storage its state needs (part of which `locked` may cover). */
export function freeBalance(state) {
  const amount = BigInt(state.amount);
  const free = amount + BigInt(state.locked ?? 0) - BigInt(state.storage_usage) * YOCTO_PER_BYTE;
  if (free < 0n) return 0n;
  return free < amount ? free : amount;
}

// --- links ---

export const accountLink = (id) => `https://nearblocks.io/address/${id}`;
export const txLink = (hash) => `https://nearblocks.io/txns/${hash}`;

// --- JSON-RPC ---

/**
 * A mainnet RPC client. `urls` are tried in turn; each must answer `status` with chain_id "mainnet" before the
 * first call through it (a wrong chain is refused for good, a network error is retried). `fetch` and `pause` are
 * for tests.
 */
export function createClient({ urls = RPC_URLS, fetch: fetchImpl = (...a) => globalThis.fetch(...a), pause = sleep } = {}) {
  if (urls.length === 0) throw new Error('no NEAR RPC endpoint');
  const checked = new Map();
  const host = (url) => new URL(url).host;

  async function post(url, method, params, ms) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'gimbal', method, params }),
      signal: AbortSignal.timeout(ms),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // not JSON: handled by the caller as a retryable answer
    }
    return { status: res.status, json };
  }

  function assertMainnet(url) {
    if (!checked.has(url)) {
      const check = (async () => {
        const { json } = await post(url, 'status', [], 30_000);
        const chain = json?.result?.chain_id;
        if (chain === undefined) throw new Error(`${host(url)}: no chain_id in its status answer`);
        if (chain !== 'mainnet') {
          const err = new Error(`${host(url)} serves chain ${JSON.stringify(chain)}, not mainnet: refusing`);
          err.fatal = true;
          throw err;
        }
      })();
      check.catch((e) => { if (!e.fatal) checked.delete(url); });
      checked.set(url, check);
    }
    return checked.get(url);
  }

  async function rpc(method, params) {
    let last;
    for (let attempt = 0; attempt < 6; attempt++) {
      const url = urls[attempt % urls.length];
      try {
        await assertMainnet(url);
        const { status, json } = await post(url, method, params, 60_000);
        if (json === null) throw new Error(`${method}: HTTP ${status} from ${host(url)}, not JSON`);
        if (json.error) {
          const cause = json.error.cause?.name ?? json.error.name;
          if (['TIMEOUT_ERROR', 'TooManyRequests'].includes(cause) || status === 429) {
            last = new Error(`${method}: ${cause ?? `HTTP ${status}`}`);
            last.timeout = cause === 'TIMEOUT_ERROR';
            await pause(2000);
            if (last.timeout) throw last;
            continue;
          }
          const err = new Error(`${method}: ${JSON.stringify(json.error).slice(0, 2000)}`);
          err.rpc = json.error;
          throw err;
        }
        // Neither result nor error (a proxy's or a deprecation notice's JSON): retried, never taken as an answer.
        if (json.result === undefined) throw new Error(`${method}: HTTP ${status} from ${host(url)} with neither result nor error`);
        return json.result;
      } catch (e) {
        if (e.rpc || e.timeout || e.fatal) throw e;
        last = e;
        await pause(1500);
      }
    }
    throw last;
  }

  /** A view call; the contract must be a mainnet id or the MPC contract. */
  async function view(contract, method, args = {}) {
    if (contract !== MPC) mainnetId(contract, 'contract');
    const r = await rpc('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    if (r.error) throw new Error(`${contract}.${method}: ${r.error}`);
    return JSON.parse(Buffer.from(r.result).toString() || 'null');
  }

  /** view_account, or null when the account does not exist. */
  async function account(id) {
    if (id !== MPC && id !== REGISTRAR) mainnetId(id);
    try {
      return await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id });
    } catch (e) {
      if (e.rpc && /UNKNOWN_ACCOUNT/.test(JSON.stringify(e.rpc))) return null;
      throw e;
    }
  }

  /** view_access_key, or null when the account or the key does not exist. */
  async function accessKey(id, publicKey) {
    mainnetId(id);
    try {
      const r = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: id, public_key: publicKey });
      if (r.error) {
        if (/does not exist/.test(r.error)) return null;
        throw new Error(`view_access_key ${id}: ${r.error}`);
      }
      return r;
    } catch (e) {
      if (e.rpc && /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/.test(JSON.stringify(e.rpc))) return null;
      throw e;
    }
  }

  /** view_access_key_list: [{ public_key, access_key: { nonce, permission } }]. */
  async function accessKeys(id) {
    mainnetId(id);
    return (await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: id })).keys;
  }

  /**
   * Signs and sends a transaction and waits until it is final. `onSent(hash)` runs once the hash is known, before
   * waiting. Returns { hash, value (the parsed SuccessValue or null), failure, logs, burntTgas, burntYocto }.
   */
  async function send(signer, receiverId, acts, { onSent } = {}) {
    mainnetId(signer.accountId, 'signer');
    if (receiverId !== REGISTRAR) mainnetId(receiverId, 'receiver');
    const access = await accessKey(signer.accountId, signer.publicKeyString);
    if (access === null) throw new Error(`${signer.publicKeyString} is not a key of ${signer.accountId}`);
    const tx = encodeTransaction({
      signerId: signer.accountId,
      publicKey: signer.publicKey,
      nonce: BigInt(access.nonce) + 1n,
      receiverId,
      blockHash: b58decode(access.block_hash),
      actions: acts,
    });
    const hash = sha256(tx);
    const signed = Buffer.concat([tx, Buffer.from([0]), signer.sign(hash)]);
    const txHash = b58encode(hash);
    onSent?.(txHash);
    let outcome;
    try {
      outcome = await rpc('send_tx', { signed_tx_base64: signed.toString('base64'), wait_until: 'FINAL' });
    } catch (e) {
      if (!e.timeout) throw e;
    }
    for (let i = 0; outcome?.final_execution_status !== 'FINAL' || !outcome.status; i++) {
      if (i > 60) throw new Error(`transaction ${txHash} is not final after 3 min: look it up (${txLink(txHash)}) before anything else`);
      await pause(3000);
      try {
        outcome = await rpc('tx', { tx_hash: txHash, sender_account_id: signer.accountId, wait_until: 'FINAL' });
      } catch (e) {
        if (!e.timeout && !/UNKNOWN_TRANSACTION/.test(e.message)) throw e;
      }
    }
    const all = [outcome.transaction_outcome, ...outcome.receipts_outcome];
    const burnt = all.reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
    const tokens = all.reduce((s, o) => s + BigInt(o.outcome.tokens_burnt), 0n);
    const status = outcome.status;
    const value = status.SuccessValue !== undefined && status.SuccessValue !== ''
      ? JSON.parse(Buffer.from(status.SuccessValue, 'base64').toString())
      : null;
    return {
      hash: txHash,
      value,
      failure: status.Failure ?? null,
      logs: outcome.receipts_outcome.flatMap((r) => r.outcome.logs),
      burntTgas: Number((burnt * 100n) / TGAS) / 100,
      burntYocto: tokens,
    };
  }

  /** The runtime's action fees, from EXPERIMENTAL_protocol_config (for txGasCap). */
  async function fees() {
    return feesOf(await rpc('EXPERIMENTAL_protocol_config', { finality: 'final' }));
  }

  /** The account's contract code (view_code), or null when the account has none or does not exist. */
  async function code(id) {
    mainnetId(id);
    try {
      const r = await rpc('query', { request_type: 'view_code', finality: 'final', account_id: id });
      return Buffer.from(r.code_base64, 'base64');
    } catch (e) {
      if (e.rpc && /NO_CONTRACT_CODE|UNKNOWN_ACCOUNT|CodeDoesNotExist/.test(JSON.stringify(e.rpc))) return null;
      throw e;
    }
  }

  /** The contract's raw storage under `prefix` (view_state): [{ key, value }] as Buffers. Throws on any error. */
  async function state(id, prefix) {
    mainnetId(id);
    const r = await rpc('query', { request_type: 'view_state', finality: 'final', account_id: id, prefix_base64: Buffer.from(prefix).toString('base64'), include_proof: false });
    if (!Array.isArray(r?.values)) throw new Error(`view_state of ${id}: no values`);
    return r.values.map((v) => ({ key: Buffer.from(v.key, 'base64'), value: Buffer.from(v.value, 'base64') }));
  }

  return { rpc, view, account, accessKey, accessKeys, send, fees, code, state };
}

// --- gas ---

/** The fee entries txGasCap needs, each { send_sir, send_not_sir, execution } in gas, from a protocol config. */
export function feesOf(protocolConfig) {
  const t = protocolConfig?.runtime_config?.transaction_costs;
  const a = t?.action_creation_config;
  const fees = {
    receipt: t?.action_receipt_creation_config,
    deploy: a?.deploy_contract_cost,
    deployByte: a?.deploy_contract_cost_per_byte,
    call: a?.function_call_cost,
    callByte: a?.function_call_cost_per_byte,
    addKey: a?.add_key_cost?.function_call_cost,
    addKeyByte: a?.add_key_cost?.function_call_cost_per_byte,
  };
  const isFee = (f) => ['send_sir', 'send_not_sir', 'execution'].every((k) => Number.isSafeInteger(f?.[k]) || /^\d+$/.test(String(f?.[k])));
  for (const [name, f] of Object.entries(fees)) {
    if (!isFee(f)) throw new Error(`EXPERIMENTAL_protocol_config: no ${name} fee`);
  }
  // Only retire.mjs and keys.mjs need them; txGasCap refuses a DeleteAccount or a DeleteKey without its fee.
  if (isFee(a?.delete_account_cost)) fees.deleteAccount = a.delete_account_cost;
  if (isFee(a?.delete_key_cost)) fees.deleteKey = a.delete_key_cost;
  return fees;
}

/**
 * The most gas a transaction can burn: the action receipt's fee, every action's fee (send, by whether the signer is
 * the receiver, plus execution; per byte where the runtime charges per byte) and every FunctionCall's prepaid gas.
 * Returns { total, prepaid, deploy, fees } in gas, so the printout can say where it comes from.
 */
export function txGasCap(fees, { signer, receiver, actions }) {
  const sir = signer === receiver;
  const fee = (f, n = 1n) => (BigInt(sir ? f.send_sir : f.send_not_sir) + BigInt(f.execution)) * n;
  let other = fee(fees.receipt);
  let prepaid = 0n;
  let deploy = 0n;
  for (const a of actions) {
    if (a.type === 'DeployContract') {
      deploy += fee(fees.deploy) + fee(fees.deployByte, BigInt(a.code.length));
    } else if (a.type === 'FunctionCall') {
      other += fee(fees.call) + fee(fees.callByte, BigInt(Buffer.byteLength(a.method) + Buffer.byteLength(JSON.stringify(a.args))));
      prepaid += a.gasTgas * TGAS;
    } else if (a.type === 'AddKey') {
      // Per byte of the method names, each counted with a terminating byte (as the runtime counts them).
      other += fee(fees.addKey) + fee(fees.addKeyByte, BigInt(a.methodNames.reduce((n, m) => n + Buffer.byteLength(m) + 1, 0)));
    } else if (a.type === 'DeleteAccount') {
      if (fees.deleteAccount === undefined) throw new Error('EXPERIMENTAL_protocol_config: no delete_account_cost fee');
      other += fee(fees.deleteAccount);
    } else if (a.type === 'DeleteKey') {
      if (fees.deleteKey === undefined) throw new Error('EXPERIMENTAL_protocol_config: no delete_key_cost fee');
      other += fee(fees.deleteKey);
    } else {
      throw new Error(`unknown action ${a.type}`);
    }
  }
  return { total: other + prepaid + deploy, prepaid, deploy, fees: other };
}

/** Gas as TGas with one decimal, rounded up (the caps it prints are upper bounds). */
export const tgasText = (gas) => `${(Number((BigInt(gas) * 10n + TGAS - 1n) / TGAS) / 10).toFixed(1)}`;

/** yoctoNEAR as NEAR cut to `decimals`, rounded up: for "at most" amounts. */
export const nearTextUp = (yocto, decimals) => nearText(BigInt(yocto) + 10n ** BigInt(24 - decimals) - 1n, decimals);

// --- where key files may be written ---

/**
 * The linked git worktree that contains `path`, or null: the nearest ancestor with a `.git` decides (a file means
 * a linked worktree, a directory the main checkout). Ignored files in a linked worktree (.keys/, .env) are deleted
 * with it, without a warning, so key files are never written there.
 */
export function linkedWorktreeOf(path) {
  let dir = resolve(path);
  for (;;) {
    const git = join(dir, '.git');
    if (existsSync(git)) return statSync(git).isFile() ? dir : null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Throws when `path` is inside a linked worktree: keys and env files are written from the main checkout only. */
export function assertNotInLinkedWorktree(path, what) {
  const tree = linkedWorktreeOf(path);
  if (tree !== null) {
    throw new Error(`${what} would be written to ${resolve(path)}, inside the linked git worktree ${tree}: a worktree `
      + 'cleanup deletes ignored files without a warning. Run from the main checkout');
  }
}

/** The client the scripts use: the default mainnet endpoints, the global fetch. */
export const near = createClient();

/** The panic message of a failed transaction, if it is a contract panic. */
export function panicOf(failure) {
  const s = JSON.stringify(failure ?? '');
  const m = s.match(/ExecutionError\\?":\\?"([^"\\]*(?:\\.[^"\\]*)*)/);
  return m ? m[1].replace(/\\\\/g, '\\') : s;
}

// --- actions and borsh ---

/** Action descriptions: printed by describeTx, encoded by encodeTransaction. */
export const act = {
  /** `label` names the code in the printout (e.g. the wasm's path). */
  deploy: (code, label) => ({ type: 'DeployContract', code, label }),
  /** `shownArgs` replaces `args` in the printout only (default: the args themselves). */
  call: (method, args, gasTgas, deposit = 0n, shownArgs = args) => ({
    type: 'FunctionCall', method, args, gasTgas: BigInt(gasTgas), deposit: BigInt(deposit), shownArgs,
  }),
  /** A FunctionCall access key: `receiverId` only, `methodNames` only, `allowance` yoctoNEAR. Never full access. */
  functionCallKey: (publicKey, receiverId, methodNames, allowance) => {
    if (BigInt(allowance) <= 0n) throw new Error('an operator key needs an allowance above 0');
    if (methodNames.length === 0) throw new Error('an operator key needs its method names: an empty list allows every method');
    return { type: 'AddKey', publicKey, receiverId, methodNames: [...methodNames], allowance: BigInt(allowance) };
  },
  /** Deletes the signer's own account; its whole balance goes to `beneficiaryId`. Only retire.mjs plans it. */
  deleteAccount: (beneficiaryId) => ({ type: 'DeleteAccount', beneficiaryId: mainnetId(beneficiaryId, 'beneficiary') }),
  /** Deletes one access key of the signer's account. Only keys.mjs plans it, and never for a full-access key. */
  deleteKey: (publicKey) => {
    publicKeyBytes(publicKey);
    return { type: 'DeleteKey', publicKey };
  },
};

const M64 = (1n << 64n) - 1n;

class Writer {
  parts = [];
  u8(n) { this.parts.push(Buffer.from([n])); return this; }
  u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); this.parts.push(b); return this; }
  u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); this.parts.push(b); return this; }
  u128(n) { const b = Buffer.alloc(16); const v = BigInt(n); b.writeBigUInt64LE(v & M64); b.writeBigUInt64LE(v >> 64n, 8); this.parts.push(b); return this; }
  bytes(b) { this.parts.push(Buffer.from(b)); return this; }
  vec(b) { return this.u32(b.length).bytes(b); }
  string(s) { return this.vec(Buffer.from(s, 'utf8')); }
  done() { return Buffer.concat(this.parts); }
}

/** The 32 bytes of an `ed25519:<base58>` public key. */
export function publicKeyBytes(key) {
  const raw = typeof key === 'string' && key.startsWith('ed25519:') ? b58decode(key.slice('ed25519:'.length)) : null;
  if (raw === null || raw.length !== 32) throw new Error(`${JSON.stringify(key)} is not an ed25519 public key`);
  return raw;
}

function encodeAction(w, a) {
  switch (a.type) {
    case 'DeployContract':
      return w.u8(1).vec(a.code);
    case 'FunctionCall':
      return w.u8(2).string(a.method).vec(Buffer.from(JSON.stringify(a.args))).u64(a.gasTgas * TGAS).u128(a.deposit);
    case 'AddKey': {
      // AddKey(5) { public_key, access_key { nonce: 0, permission: FunctionCall(0) { allowance: Some, receiver_id,
      // method_names } } }. FullAccess (1) is never written by these scripts.
      w.u8(5).u8(0).bytes(publicKeyBytes(a.publicKey)).u64(0n).u8(0).u8(1).u128(a.allowance).string(a.receiverId).u32(a.methodNames.length);
      for (const m of a.methodNames) w.string(m);
      return w;
    }
    case 'DeleteKey':
      // DeleteKey(6) { public_key: ED25519(0) + 32 bytes }.
      return w.u8(6).u8(0).bytes(publicKeyBytes(a.publicKey));
    case 'DeleteAccount':
      return w.u8(7).string(a.beneficiaryId);
    default:
      throw new Error(`unknown action ${a.type}`);
  }
}

/** Borsh of a (v0) transaction; `publicKey` and `blockHash` are 32 bytes each. */
export function encodeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  const w = new Writer().string(signerId).u8(0).bytes(publicKey).u64(nonce).string(receiverId).bytes(blockHash).u32(actions.length);
  for (const a of actions) encodeAction(w, a);
  return w.done();
}

/** A planned transaction as printed lines: signer, receiver, each action with its full args, deposit and gas. */
export function describeTx(label, { signer, signedBy, receiver, actions }) {
  const lines = [`${label}`, `  signer    ${signer}  (${signedBy})`, `  receiver  ${receiver}`];
  actions.forEach((a, i) => {
    const n = `  action ${i + 1}`;
    if (a.type === 'FunctionCall') {
      lines.push(`${n}  FunctionCall ${a.method}  gas ${a.gasTgas} TGas  deposit ${nearText(a.deposit)} NEAR`);
      lines.push(`            args ${JSON.stringify(a.shownArgs)}`);
    } else if (a.type === 'DeployContract') {
      lines.push(`${n}  DeployContract ${a.label}: ${a.code.length.toLocaleString('en-US')} bytes, sha256 ${sha256(a.code).toString('hex')}`);
    } else if (a.type === 'AddKey') {
      lines.push(`${n}  AddKey ${a.publicKey}`);
      lines.push(`            permission FunctionCall: receiver ${a.receiverId}, allowance ${nearText(a.allowance)} NEAR, ${a.methodNames.length} methods`);
      lines.push(`            method_names ${JSON.stringify(a.methodNames)}`);
    } else if (a.type === 'DeleteKey') {
      lines.push(`${n}  DeleteKey ${a.publicKey}: the access key is removed from ${signer}`);
    } else if (a.type === 'DeleteAccount') {
      lines.push(`${n}  DeleteAccount: the account ${signer} is deleted; its whole NEAR balance goes to the beneficiary ${a.beneficiaryId}`);
    }
  });
  return lines;
}

// --- access keys ---

/** 'matches' when an access key view is a full-access key; 'does not match' otherwise (missing included). */
export function fullAccessVerdict(view) {
  return view !== null && view !== undefined && view.permission === 'FullAccess' ? 'matches' : 'does not match';
}

/** Whether an access key view is a FunctionCall key for exactly `receiverId` and exactly `methodNames`. */
export function isFunctionCallKey(view, receiverId, methodNames) {
  const fc = view?.permission?.FunctionCall;
  if (!fc) return false;
  const names = fc.method_names ?? [];
  return fc.receiver_id === receiverId && names.length === methodNames.length && methodNames.every((m) => names.includes(m));
}

// --- key files (the private key never leaves this module, except into the engine env file) ---

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

function readJsonKey(file, accountId) {
  mainnetId(accountId);
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    // The parser's message can quote the file, so only the kind of failure is shown.
    throw new Error(`${file}: not a readable JSON key file (${e.code ?? 'not JSON'})`);
  }
  if (json === null || typeof json !== 'object') throw new Error(`${file}: not a key file`);
  if (json.account_id !== accountId) throw new Error(`${file} is the key of ${JSON.stringify(json.account_id)}, not ${accountId}`);
  if (json.network !== undefined && json.network !== 'mainnet') throw new Error(`${file} is a ${JSON.stringify(json.network)} key, not mainnet`);
  const secret = json.private_key ?? json.secret_key;
  if (typeof secret !== 'string' || !secret.startsWith('ed25519:')) throw new Error(`${file}: no ed25519 private_key`);
  let raw;
  try {
    raw = b58decode(secret.slice('ed25519:'.length));
  } catch {
    throw new Error(`${file}: the private key is not base58`);
  }
  if (raw.length !== 64 && raw.length !== 32) throw new Error(`${file}: the private key is not 32 or 64 bytes`);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  const publicKey = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url');
  if (raw.length === 64 && raw.subarray(32).compare(publicKey) !== 0) throw new Error(`${file}: the private key's public half is not its own`);
  const publicKeyString = `ed25519:${b58encode(publicKey)}`;
  if (json.public_key !== undefined && json.public_key !== publicKeyString) throw new Error(`${file}: public_key is not the private key's`);
  return { privateKey, publicKey, publicKeyString, secret: `ed25519:${b58encode(Buffer.concat([raw.subarray(0, 32), publicKey]))}` };
}

/**
 * A key file as a signer: { accountId, file, publicKey (32 bytes), publicKeyString, sign }. The file is JSON with
 * account_id, public_key and private_key (or secret_key), as tools/testnet/near.mjs and near-cli write it; a
 * `network` field, when present, must be "mainnet".
 */
export function readKeyFile(file, accountId) {
  const k = readJsonKey(file, accountId);
  return { accountId, file, publicKey: k.publicKey, publicKeyString: k.publicKeyString, sign: (msg) => sign(null, msg, k.privateKey) };
}

/** Writes a new ed25519 key for `accountId` to `file` (never over an existing file); returns its public key. */
export function newKeyFile(file, accountId) {
  mainnetId(accountId);
  if (existsSync(file)) throw new Error(`${file} exists: a key file is never overwritten`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const public_key = `ed25519:${b58encode(pub)}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ account_id: accountId, public_key, private_key: `ed25519:${b58encode(Buffer.concat([seed, pub]))}`, network: 'mainnet' }) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  return public_key;
}

/** Marks the entry of `writeEnvFile` that takes the private key of `keyFile`. */
export const PRIVATE_KEY_OF_FILE = Symbol('private key of the key file');

/**
 * Writes an env file (never over an existing one): `entries` are [name, value] pairs; a value of
 * PRIVATE_KEY_OF_FILE becomes the private key of `keyFile` (for `accountId`). Nothing is printed.
 */
export function writeEnvFile(file, header, entries, { keyFile, accountId } = {}) {
  if (existsSync(file)) throw new Error(`${file} exists: it is never overwritten`);
  const lines = header.map((h) => `# ${h}`);
  for (const [name, value] of entries) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`bad env name ${name}`);
    const text = value === PRIVATE_KEY_OF_FILE ? readJsonKey(keyFile, accountId).secret : String(value);
    if (/[\r\n#"'`]/.test(text)) throw new Error(`${name}: a value with a newline, quote or # cannot be written`);
    lines.push(`${name}=${text}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
}
