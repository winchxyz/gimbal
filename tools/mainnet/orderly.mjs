#!/usr/bin/env node
// The owner's Orderly settings of a desk, and the operator step that applies its IP list (tools/mainnet/README.md,
// "Orderly: receiver and IP list"):
//
//   node tools/mainnet/orderly.mjs status    <contract> <desk_id> [--env-file <file>] [--send]
//   node tools/mainnet/orderly.mjs receiver  <contract> <desk_id> [0x<receiver>] [--key-file <owner key json>] [--env-file <file>] [--send]
//   node tools/mainnet/orderly.mjs ips       <contract> <desk_id> <ip[,ip...]> [--force-same] [--key-file <owner key json>] [--send]
//   node tools/mainnet/orderly.mjs apply-ips <contract> <desk_id> --engine-ips <ip[,ip...]> [--env-file <file>] [--send]
//
//   status     get_desk's orderly_receiver and orderly_ips, get_desk_settings' orderly_ips_applied, whether the
//              contract signs Orderly opens, and Orderly's public view of the account. The holding and the receiver
//              are not public: --send signs two reads, orderly_request of kinds holding and receiver_address (the
//              operator key, gas only), and compares the pinned receiver with Orderly's answer.
//   receiver   set_orderly_receiver (owner): pins the Orderly account's receiver on Arbitrum, once and for good. --send
//              first has the contract sign orderly_request kind receiver_address (the operator key) and reads Orderly's
//              answer: without an address it prints that answer and pins nothing; with one it pins it only when it is
//              that answer.
//   ips        set_orderly_ips (owner): the IPs Orderly may take the desk's key from. A new list is applied only by
//              apply-ips; until then the contract refuses every Orderly order that is not reduce-only. --force-same
//              sends the list the desk has already, which only clears orderly_ips_applied: the way out when the
//              contract signed an ip_restriction that Orderly did not take.
//   apply-ips  the engine's own venue setup (engine/src/setup/setup.ts runSetup), cut to its Orderly steps as checks.mjs
//              does: the done-checks, the signed receiver_address read, then orderly_ip_restriction, in which the
//              contract signs orderly_request kind ip_restriction for the stored list and this machine posts it to
//              Orderly. The step refuses, nothing signed, while the list leaves out one of --engine-ips (the IPs the
//              engine sends from; required with --send, never this machine's guess). It also says whether this
//              machine's IP is in the list: once the list is applied, a machine outside it cannot post a correction.
//
// Default: a dry run that reads mainnet and signs nothing. --send reads the owner's key file (receiver, ips) or the
// engine env file (the operator key: status, the receiver lookup, apply-ips) only then, never prints a key, and
// refuses in a linked git worktree. No funds move: the two owner calls attach 0.01 NEAR of storage deposit (the
// contract keeps what the setting takes and refunds the rest), the operator calls spend gas only. Each run ends with
// one block to paste back.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UsageError, isMain, parseDotEnv, parseFlags, run } from './cli.mjs';
import { CALL_TGAS, RECEIVER_REASON, engineEnvProblems, sendRefusal } from './checks.mjs';
import { wasmExports } from './deploy.mjs';
import { OPERATOR_METHODS, contractConfigProblems, engineEnvFile, orderlyAccountId } from './desk.mjs';
import { DESK_ID, eventsOf, summaryBlock } from './money.mjs';
import {
  NO_CODE, ROOT, act, createClient, describeTx, freeBalance, fullAccessVerdict, isFunctionCallKey, linkedWorktreeOf, mainnetId, near,
  nearText, nearTextUp, panicOf, readKeyFile, tgasText, txGasCap, txLink,
} from './near.mjs';
import { ORDERLY_API } from './venues.mjs';

export const COMMANDS = ['status', 'receiver', 'ips', 'apply-ips'];
/** The most addresses set_orderly_ips takes (contract/core/src/orderly.rs MAX_ORDERLY_IPS; a test compares). */
export const MAX_ORDERLY_IPS = 10;
/** What the owner calls attach: the contract keeps the storage the setting adds and refunds the rest (≥ 1 yocto). */
export const OWNER_DEPOSIT = 10n ** 22n;
/** The owner calls' gas: a desk write and an event; the unused part is refunded. */
export const OWNER_TGAS = 50n;
/** The engine's reasons for its signed Orderly requests (engine/src/venues/orderly-actions.ts). */
export const IP_REASON = 'limit the Orderly key to the relayer IPs';
export const HOLDING_REASON = 'read Orderly holding';
export const IP_RESTRICTION_PATH = '/v1/client/set_orderly_key_ip_restriction';
/** The only orderly_request kinds each command may have signed; anything else is refused before signing. */
export const ALLOWED_KINDS = { status: ['holding', 'receiver_address'], receiver: ['receiver_address'], 'apply-ips': ['receiver_address', 'ip_restriction'] };
/** The contract methods each command needs in the deployed code. */
const NEEDS = {
  status: ['get_desk'],
  receiver: ['get_desk', 'set_orderly_receiver', 'orderly_request'],
  ips: ['get_desk', 'set_orderly_ips'],
  'apply-ips': ['get_desk', 'orderly_request'],
};

const USAGE = `usage: node tools/mainnet/orderly.mjs status    <contract> <desk_id> [--env-file <file>] [--send]
       node tools/mainnet/orderly.mjs receiver  <contract> <desk_id> [0x<receiver>] [--key-file <owner key json>] [--env-file <file>] [--send]
       node tools/mainnet/orderly.mjs ips       <contract> <desk_id> <ip[,ip...]> [--force-same] [--key-file <owner key json>] [--send]
       node tools/mainnet/orderly.mjs apply-ips <contract> <desk_id> --engine-ips <ip[,ip...]> [--env-file <file>] [--send]
  default: dry run (reads mainnet, prints every call in full; signs nothing, reads no key)
  status --send signs two reads with the operator key (holding, receiver_address): gas only, nothing else`;
const SPEC = {
  status: { '--env-file': 'value', '--send': 'switch' },
  receiver: { '--key-file': 'value', '--env-file': 'value', '--send': 'switch' },
  ips: { '--key-file': 'value', '--force-same': 'switch', '--send': 'switch' },
  'apply-ips': { '--engine-ips': 'value', '--env-file': 'value', '--send': 'switch' },
};

/** Where the engine's IPs come from. */
export const ENGINE_IPS_HINT = 'every IP the engine sends its Orderly requests from (on Railway: `railway outbound-network static-ip status`, all of them)';

/** Printed by ips, apply-ips and status: what a wrong or missing list does. */
export const WRONG_LIST = [
  'warning   a wrong IP list blocks Orderly. Until a list is set and the contract signed its ip_restriction, the contract',
  '          refuses every Orderly order that is not reduce-only, so every open; reduce-only closes are still signed.',
  '          Once an ip_restriction is applied, Orderly takes the desk key only from the listed IPs: an engine whose IP is',
  '          left out cannot open, close or read on Orderly, and a corrected list must be applied from a listed IP.',
];

// --- IP addresses, as the contract's check_ip_list takes them (Rust's IpAddr parse and display) ---

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The 8 groups of an IPv6 address as Rust's parser reads it (hex groups of 1-4 digits, one `::`, a dotted IPv4 tail). */
function v6Groups(text) {
  if (!/^[0-9A-Fa-f:.]+$/.test(text) || !text.includes(':')) return null;
  let s = text;
  const cut = s.lastIndexOf(':');
  const tail = s.slice(cut + 1);
  if (tail.includes('.')) {
    if (!V4.test(tail)) return null;
    const o = tail.split('.').map(Number);
    s = `${s.slice(0, cut + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (x) => (x === '' ? [] : x.split(':').map((g) => (/^[0-9A-Fa-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const left = groups(halves[0]);
  const right = halves.length === 2 ? groups(halves[1]) : [];
  if ([...left, ...right].some(Number.isNaN)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  if (left.length + right.length > 7) return null;
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

const isMapped = (g) => g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
const mappedV4 = (g) => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;

/** Rust's Ipv6Addr display: IPv4-mapped as ::ffff:a.b.c.d, else lowercase hex with the first longest zero run (> 1) as `::`. */
function v6Text(g) {
  if (isMapped(g)) return `::ffff:${mappedV4(g)}`;
  let best = { start: 0, len: 0 };
  let cur = { start: 0, len: 0 };
  g.forEach((x, i) => {
    if (x !== 0) {
      cur = { start: i + 1, len: 0 };
      return;
    }
    cur.len++;
    if (cur.len > best.len) best = { ...cur };
  });
  const hex = (xs) => xs.map((x) => x.toString(16)).join(':');
  return best.len > 1 ? `${hex(g.slice(0, best.start))}::${hex(g.slice(best.start + best.len))}` : hex(g);
}

/** { version, canonical, value } of an IP the contract's parser takes, or null. `canonical` is what it compares with. */
export function parseIp(text) {
  if (typeof text !== 'string') return null;
  if (V4.test(text)) return { version: 4, canonical: text, value: text.split('.').reduce((v, o) => (v << 8n) | BigInt(o), 0n) };
  const g = v6Groups(text);
  if (g === null) return null;
  return { version: 6, canonical: v6Text(g), groups: g, value: g.reduce((v, x) => (v << 16n) | BigInt(x), 0n) };
}

const V4_RESERVED = [
  ['0.0.0.0', 8, '"this network"'], ['10.0.0.0', 8, 'private'], ['100.64.0.0', 10, 'carrier-grade NAT'], ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'], ['172.16.0.0', 12, 'private'], ['192.0.0.0', 24, 'IETF protocol assignments'], ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay anycast'], ['192.168.0.0', 16, 'private'], ['198.18.0.0', 15, 'benchmarking'], ['198.51.100.0', 24, 'documentation'], ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'], ['240.0.0.0', 4, 'reserved'],
];
const V6_RESERVED = [
  ['::', 96, 'unspecified, loopback or IPv4-compatible'], ['64:ff9b::', 96, 'NAT64: a translated IPv4 address'],
  ['64:ff9b:1::', 48, 'local-use NAT64 (RFC 8215): a translated IPv4 address'], ['100::', 64, 'discard-only'],
  ['2001:db8::', 32, 'documentation'], ['2002::', 16, '6to4: a tunnelled IPv4 address'], ['fc00::', 7, 'unique local (private)'], ['fe80::', 10, 'link-local'], ['ff00::', 8, 'multicast'],
];

/** The reserved range an address is in ({ cidr, name }), or null for a public address. */
export function reservedRange(p) {
  const [table, width] = p.version === 4 ? [V4_RESERVED, 32n] : [V6_RESERVED, 128n];
  for (const [base, bits, name] of table) {
    const shift = width - BigInt(bits);
    if ((p.value >> shift) === (parseIp(base).value >> shift)) return { cidr: `${base}/${bits}`, name };
  }
  return null;
}

/** Why `text` is not an address for the list (the contract's rule, plus: a public address Orderly can see), or null. */
export function ipProblem(text) {
  const p = parseIp(text);
  if (p === null) return `${JSON.stringify(text)} is not an IPv4 or IPv6 address (no ranges, ports, brackets or zones)`;
  if (p.version === 6 && isMapped(p.groups)) return `${text} is an IPv4-mapped IPv6 address: give the IPv4 address ${mappedV4(p.groups)} itself`;
  if (p.canonical !== text) return `${text} is not in the canonical form the contract takes (E_ARGS): write ${p.canonical}`;
  const r = reservedRange(p);
  if (r !== null) return `${text} is in ${r.cidr} (${r.name}): Orderly never sees a request come from it`;
  return null;
}

/** "a,b" -> ['a', 'b'], checked: each a public IP in canonical form, no repeats, 1 to `max`. Throws with every problem. */
export function parseIpList(text, what, max = MAX_ORDERLY_IPS) {
  const ips = String(text).split(',');
  const problems = [];
  ips.forEach((ip, i) => {
    if (ip === '') problems.push(`${what}: entry ${i + 1} is empty`);
    else {
      const p = ipProblem(ip);
      if (p !== null) problems.push(`${what}: ${p}`);
      else if (ips.indexOf(ip) < i) problems.push(`${what}: ${ip} is listed twice`);
    }
  });
  if (ips.length > max) problems.push(`${what}: ${ips.length} addresses; the contract takes 1 to ${max}`);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return ips;
}

/** A receiver argument: 0x and 40 hex digits, sent lowercase (the contract takes only lowercase, E_ARGS). */
export function parseReceiver(text) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`receiver ${JSON.stringify(text)} is not a 0x address of 40 hex digits`);
  const r = text.toLowerCase();
  if (/^0x0{40}$/.test(r)) throw new Error('receiver is the zero address');
  return r;
}

// --- arguments ---

export function parseOrderlyArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError(`a command is required: ${COMMANDS.join(', ')}`);
  if (!COMMANDS.includes(command)) throw new UsageError(`${command} is not one of ${COMMANDS.join(', ')}`);
  const { positional, values } = parseFlags(rest, SPEC[command]);
  if (positional.length < 2) throw new UsageError('the contract and the desk id are required');
  const [contract, deskId, ...more] = positional;
  const max = command === 'receiver' || command === 'ips' ? 1 : 0;
  if (command === 'ips' && more.length === 0) throw new UsageError('the IP list is required: <ip[,ip...]>, separated by commas, no spaces');
  if (more.length > max) throw new UsageError(`unexpected argument ${more[max]}`);
  const asUsage = (fn) => {
    try {
      return fn();
    } catch (e) {
      throw new UsageError(e.message);
    }
  };
  asUsage(() => mainnetId(contract, 'contract'));
  if (!DESK_ID.test(deskId)) throw new UsageError(`desk id ${JSON.stringify(deskId)} is not 1 to 32 characters of a-z, 0-9 and -`);
  const send = values['--send'] === true;
  const a = {
    command, contract, deskId, send, keyFile: values['--key-file'] ?? null, receiver: null, ips: null, engineIps: null, forceSame: values['--force-same'] === true,
    envFile: values['--env-file'] === undefined ? engineEnvFile(contract) : resolve(values['--env-file']),
  };
  if (command === 'receiver' && more.length === 1) a.receiver = asUsage(() => parseReceiver(more[0]));
  if (command === 'receiver' && send && a.receiver !== null && a.keyFile === null) {
    throw new UsageError('--send with a receiver needs --key-file: only the desk owner can pin it');
  }
  if (command === 'ips') {
    a.ips = asUsage(() => parseIpList(more[0], 'the IP list'));
    if (send && a.keyFile === null) throw new UsageError('--send needs --key-file: only the desk owner can set the IP list');
  }
  if (values['--engine-ips'] !== undefined) a.engineIps = asUsage(() => parseIpList(values['--engine-ips'], '--engine-ips', Infinity));
  if (command === 'apply-ips' && send && a.engineIps === null) {
    throw new UsageError(`--send needs --engine-ips <ip[,ip...]>: ${ENGINE_IPS_HINT}. This machine's IP is not the engine's, and a list `
      + 'applied without the engine\'s IPs locks it out of Orderly');
  }
  return a;
}

// --- planned calls ---

export const receiverActions = (deskId, receiver) => [act.call('set_orderly_receiver', { desk_id: deskId, receiver }, OWNER_TGAS, OWNER_DEPOSIT)];
export const ipsActions = (deskId, ips) => [act.call('set_orderly_ips', { desk_id: deskId, ips }, OWNER_TGAS, OWNER_DEPOSIT)];
/** orderly_request as the engine sends it (OrderlyDeskClient: reduce_only false, the kind, the timestamp). */
export const requestActions = (deskId, kind, nowMs, reason) => [
  act.call('orderly_request', { desk_id: deskId, req: { reduce_only: false, kind, timestamp_ms: nowMs }, reason }, CALL_TGAS, 0n),
];
/** The body the contract builds for ip_restriction (contract/core/src/orderly.rs): the desk key and the list, comma-joined. */
export const ipRestrictionBody = (authority, ips) => JSON.stringify({ orderly_key: `ed25519:${authority}`, ip_restriction_list: ips.join(',') });

/** Whether the contract signs Orderly orders that grow a position (C10: mainnet needs the list and its signed ip_restriction). */
export function opensText(ips, applied) {
  if (applied === null) return 'unknown: this contract has no get_desk_settings, so whether ip_restriction was signed cannot be read';
  if (ips.length > 0 && applied) return 'signed: the list is set and its ip_restriction signed, so the contract signs Orderly orders that grow a position';
  return `refused: the contract refuses every Orderly order that is not reduce-only (E_ARGS) until ${ips.length === 0 ? 'the owner sets a list and ' : ''}`
    + `it signs ip_restriction for ${ips.length === 0 ? 'it' : 'this list'}; reduce-only closes are still signed`;
}

/** The desk's Orderly settings as printed lines. */
export function stateLines(desk, settings) {
  const ips = desk.orderly_ips ?? [];
  const applied = settings === null ? null : settings.orderly_ips_applied === true;
  const appliedText = applied === null ? 'unknown (no get_desk_settings in this contract)'
    : applied ? 'yes: the contract signed ip_restriction for this list'
      : ips.length === 0 ? 'no (no list)' : 'no: the contract has not signed ip_restriction for this list';
  return [
    `receiver  ${desk.orderly_receiver ?? 'not pinned: fund_venue and rescues into Orderly are refused until the owner pins it'}`,
    `ips       ${ips.length === 0 ? 'none set' : ips.join(', ')}`,
    `applied   ${appliedText}`,
    `opens     ${opensText(ips, applied)}`,
  ];
}

/** A transport that has the contract sign only orderly_request of the command's kinds; views pass through. */
export function kindGuard(transport, contract, kinds) {
  return {
    get accountId() { return transport.accountId; },
    call(contractId, method, args, ...rest) {
      if (contractId !== contract || method !== 'orderly_request' || !kinds.includes(args?.req?.kind)) {
        return Promise.reject(new Error(`${method} ${JSON.stringify(args?.req?.kind ?? null)} on ${contractId} is not orderly_request of kind `
          + `${kinds.join(' or ')} on ${contract}: refused, nothing was signed`));
      }
      return transport.call(contractId, method, args, ...rest);
    },
    view: (...x) => transport.view(...x),
    account: () => transport.account(),
    allowance: () => transport.allowance(),
  };
}

// --- the run ---

const defaultEngine = async () => ({
  ...(await import('../../engine/src/venues/orderly-actions.ts')),
  ...(await import('../../engine/src/setup/setup.ts')),
  ...(await import('../../engine/src/setup/service.ts')),
  ...(await import('../../engine/src/setup/public-ip.ts')),
  ...(await import('../../engine/src/contract/near-client.ts')),
});
const defaultTransport = async (options) => new (await import('../../engine/src/contract/near-transport.ts')).NearApiTransport(options);
/** A signer for the public reads: every signature is refused. */
const noSigner = new Proxy({}, { get: (_, name) => () => Promise.reject(new Error(`a read signed nothing: ${String(name)} would sign`)) });

function readEngineEnv(file) {
  if (!existsSync(file)) throw new Error(`${file} does not exist: it is the engine env file tools/mainnet/desk.mjs --send wrote`);
  return parseDotEnv(readFileSync(file, 'utf8'));
}

/**
 * Runs one command; every effect goes through `deps` so the tests run on fakes. deps: near, fetch, now, say, tree,
 * engine() (the engine modules), transport(options), readEnv(file), readKey(file, accountId), publicIps() (this
 * machine's IPs). Returns the summary block.
 */
export async function runOrderly(argv, deps = {}) {
  const a = parseOrderlyArgs(argv);
  const tree = deps.tree === undefined ? linkedWorktreeOf(ROOT) : deps.tree;
  const refusal = sendRefusal(a.send, tree);
  if (refusal !== null) throw new Error(refusal);
  const x = {
    a,
    client: deps.near ?? near,
    fetchImpl: deps.fetch ?? ((...f) => globalThis.fetch(...f)),
    now: deps.now ?? Date.now,
    say: deps.say ?? ((s = '') => console.log(s)),
    deps,
  };
  x.say(`gimbal orderly ${a.command} on ${a.contract}, desk ${a.deskId}: ${a.send ? 'SEND' : 'dry run'}`);
  if (tree !== null) x.say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);
  Object.assign(x, await context(x));
  x.engine = await (deps.engine ?? defaultEngine)();
  if (a.command === 'status') return status(x);
  if (a.command === 'receiver') return receiver(x);
  if (a.command === 'ips') return ips(x);
  return applyIps(x);
}

/** The contract (mainnet Gimbal, with the methods the command needs), the desk and its settings. */
async function context({ a, client, say }) {
  const chain = await client.rpc('status', []);
  say(`chain     ${chain.chain_id}, block ${chain.sync_info.latest_block_height}`);
  const state = await client.account(a.contract);
  if (state === null) throw new Error(`${a.contract} does not exist on mainnet`);
  if (state.code_hash === NO_CODE) throw new Error(`${a.contract} has no contract code`);
  const config = await client.view(a.contract, 'config');
  const bad = contractConfigProblems(config);
  if (bad.length > 0) throw new Error(`${a.contract} is not a mainnet Gimbal contract:\n  ${bad.join('\n  ')}`);
  const code = await client.code(a.contract);
  const exported = code === null ? [] : wasmExports(code);
  const missing = NEEDS[a.command].filter((m) => !exported.includes(m));
  if (missing.length > 0) throw new Error(`${a.contract}'s code (code_hash ${state.code_hash}) has no ${missing.join(', ')}: this command cannot run on it`);
  const desk = await client.view(a.contract, 'get_desk', { desk_id: a.deskId });
  if (desk === null) throw new Error(`${a.contract} has no desk ${a.deskId}`);
  const brokerId = config.orderly.broker_id;
  const chainId = config.orderly.chain_id;
  const expected = orderlyAccountId(desk.evm_address, brokerId);
  if (desk.orderly_account_id !== expected) throw new Error(`get_desk's orderly_account_id ${desk.orderly_account_id} is not ${expected} (the desk's address under ${brokerId})`);
  const settings = exported.includes('get_desk_settings') ? await client.view(a.contract, 'get_desk_settings', { desk_id: a.deskId }) : null;
  say(`contract  ${a.contract}: Mainnet Gimbal, Orderly broker ${brokerId} on chain ${chainId}`);
  say(`desk      ${a.deskId}: owner ${desk.owner}, operator ${desk.operator ?? 'none (the engine signs as the owner)'}, paused ${desk.paused}, `
    + `Orderly account ${desk.orderly_account_id}`);
  for (const line of stateLines(desk, settings)) say(line);
  return { config, desk, settings, brokerId, chainId };
}

/** Orderly's public view: registered under the broker, and the desk key's state. */
async function orderlyPublic(x) {
  const reader = orderlyClient(x, noSigner);
  const registered = await reader.isRegistered(x.brokerId);
  const key = registered ? await reader.keyInfo() : null;
  const usable = key !== null && key.status === 'ACTIVE' && (key.scope ?? '').split(',').includes('trading') && (key.expiration ?? 0) > x.now();
  const keyText = !registered ? 'none (no account)' : key === null ? 'not on Orderly'
    : `${key.status}, scope ${key.scope}, until ${key.expiration === null ? '?' : new Date(key.expiration).toISOString()}`;
  x.say(`orderly   ${registered ? 'registered' : 'not registered'} under ${x.brokerId}; key ed25519:${x.desk.solana.authority} ${keyText}`);
  return { registered, key, usable };
}

function orderlyClient(x, signer) {
  return new x.engine.OrderlyDeskClient({
    deskId: x.a.deskId, network: 'mainnet', apiUrl: ORDERLY_API, accountId: x.desk.orderly_account_id, orderlyKey: `ed25519:${x.desk.solana.authority}`,
    evmAddress: x.desk.evm_address, referralCode: null, signer, fetch: x.fetchImpl, clock: { now: x.now },
  });
}

const NOT_READY = 'the desk\'s Orderly account or its key is not ready: run checks.mjs <contract> <desk_id> --step orderly --send first (register, add the key)';

/** The operator key from the engine env file, checked against the chain; its transport signs only `kinds`. */
async function operator(x, kinds) {
  const { a, client, say, deps } = x;
  const env = (deps.readEnv ?? readEngineEnv)(a.envFile);
  const e = engineEnvProblems(env, { contract: a.contract, deskId: a.deskId, desk: x.desk, brokerId: x.brokerId });
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
  const contract = new x.engine.NearContractClient({
    contractId: a.contract, network: 'mainnet', transport: kindGuard(transport, a.contract, kinds), onHealth: (s, d) => say(`  near ${s}: ${d}`),
  });
  return { contract, collected: x.engine.collectingSigner(contract), accountId: e.accountId };
}

/** The owner's key file, checked to be a full-access key of the desk owner. */
async function owner(x) {
  const signer = (x.deps.readKey ?? readKeyFile)(x.a.keyFile, x.desk.owner);
  if (fullAccessVerdict(await x.client.accessKey(x.desk.owner, signer.publicKeyString)) !== 'matches') {
    throw new Error(`--key-file is not a full-access key of the desk owner ${x.desk.owner}: nothing was signed`);
  }
  return signer;
}

/** Prints an owner transaction with its gas and checks the owner can pay the deposit and the gas. */
async function ownerPlan(x, label, actions, signedBy, checkBalance = true) {
  const { client, desk, say, a } = x;
  say(describeTx(label, { signer: desk.owner, signedBy, receiver: a.contract, actions }).join('\n'));
  const fees = await client.fees();
  const gasPrice = BigInt((await client.rpc('gas_price', [null])).gas_price);
  const cap = txGasCap(fees, { signer: desk.owner, receiver: a.contract, actions });
  const gasYocto = cap.total * gasPrice;
  say(`  gas       at most ${tgasText(cap.total)} TGas, ${nearTextUp(gasYocto, 4)} NEAR; the unused part is refunded`);
  const state = await client.account(desk.owner);
  if (state === null) throw new Error(`the owner ${desk.owner} does not exist on mainnet`);
  const free = freeBalance(state);
  say(`owner     ${desk.owner}: ${nearText(free, 4)} NEAR free`);
  if (checkBalance && free < OWNER_DEPOSIT + gasYocto) throw new Error(`the owner can spend ${nearText(free, 4)} NEAR; the call needs ${nearText(OWNER_DEPOSIT)} NEAR of deposit and up to ${nearTextUp(gasYocto, 4)} NEAR of gas`);
}

/** Sends an owner transaction and prints its outcome; returns { out, lines }. */
async function ownerSend(x, signer, actions) {
  const out = await x.client.send(signer, x.a.contract, actions, { onSent: (h) => x.say(`\ntx sent ${h}; waiting for final`) });
  x.say(`tx final: ${txLink(out.hash)} (${out.burntTgas} TGas, ${nearText(out.burntYocto, 6)} NEAR burnt)`);
  for (const log of out.logs) x.say(`  log ${log}`);
  const method = actions[0].method;
  const lines = [`${method}: tx ${out.hash} ${out.failure === null ? 'succeeded' : `FAILED ${panicOf(out.failure)}`}`];
  for (const e of eventsOf(out.logs)) lines.push(`event:    ${e.event} ${JSON.stringify(e.data)}`);
  return { out, lines };
}

const finish = (x, lines, { dryNote = null } = {}) => {
  const head = `contract ${x.a.contract}, desk ${x.a.deskId}, ${x.a.send ? 'SEND' : 'dry run'}`;
  const block = summaryBlock(`orderly ${x.a.command}`, { at: new Date(x.now()).toISOString(), lines: [head, ...lines] });
  x.say();
  x.say(block.join('\n'));
  if (dryNote !== null) x.say(`\n${dryNote}`);
  return block;
};

const stateSummary = (desk, settings) => {
  const ips = desk.orderly_ips ?? [];
  const applied = settings === null ? 'unknown' : String(settings.orderly_ips_applied === true);
  return `receiver ${desk.orderly_receiver ?? 'none'}; ips ${ips.length === 0 ? 'none' : ips.join(',')}; applied ${applied}`;
};

// --- status ---

async function status(x) {
  const { a, say } = x;
  const pub = await orderlyPublic(x);
  const lines = [`state:    ${stateSummary(x.desk, x.settings)}`, `opens:    ${opensText(x.desk.orderly_ips ?? [], x.settings === null ? null : x.settings.orderly_ips_applied === true)}`];
  lines.push(`orderly:  ${pub.registered ? 'registered' : 'not registered'}; key ${pub.key === null ? 'none' : pub.key.status}`);
  if ((x.desk.orderly_ips ?? []).length === 0 || x.settings?.orderly_ips_applied !== true) for (const l of WRONG_LIST) say(l);
  if (!pub.registered) {
    say('holding   none: no Orderly account under the broker');
    lines.push('holding:  none (no account)');
    return finish(x, lines);
  }
  const pinned = x.desk.orderly_receiver ?? null;
  say('signed    the holding and the receiver are not public: status --send SIGNS two reads with the operator key, orderly_request');
  say('          of kinds holding and receiver_address (gas only; the contract signs nothing else for them)');
  if (!a.send) {
    for (const [kind, reason, path] of [['holding', HOLDING_REASON, '/v1/client/holding'],
      ['receiver_address', RECEIVER_REASON, `/v1/client/asset/receiver_address?chain_id=${x.chainId}&token=USDC`]]) {
      say(describeTx(`  tx: orderly_request kind ${kind} (operator key, signed at --send)`, {
        signer: x.desk.operator ?? x.desk.owner, signedBy: `the operator key from ${a.envFile}, read at --send`, receiver: a.contract,
        actions: requestActions(a.deskId, kind, x.now(), reason),
      }).join('\n'));
      say(`    GET ${ORDERLY_API}${path}`);
    }
    say('money     none: reads only. --send spends gas only (about 0.001 NEAR per read; 0.3 NEAR of the key\'s allowance held per call until the refund)');
    lines.push('holding:  not read (signed read at --send)', `receiver: ${pinned === null ? 'not pinned' : `pinned ${pinned}`}; not compared with Orderly (signed read at --send)`);
    return finish(x, lines, { dryNote: 'dry run: nothing was signed or sent. --send signs the two reads above.' });
  }
  const op = await operator(x, ALLOWED_KINDS.status);
  say('money     none moves: two signed reads, gas only');
  const client = orderlyClient(x, op.contract);
  const ipHint = x.settings?.orderly_ips_applied === true ? ' (an applied IP list refuses the desk key from any IP not in it, this machine\'s included)' : '';
  const problems = [];
  try {
    const data = await client.holding(HOLDING_REASON);
    const rows = Array.isArray(data?.holding) ? data.holding : null;
    if (rows === null) lines.push(`holding:  answer ${JSON.stringify(data).slice(0, 300)}`);
    else if (rows.length === 0) lines.push('holding:  none');
    else for (const h of rows) lines.push(`holding:  ${h?.token ?? '?'} ${h?.holding ?? '?'} (frozen ${h?.frozen ?? 0}, pending_short ${h?.pending_short ?? 0})`);
  } catch (e) {
    const why = `Orderly holding could not be read: ${e.message}${ipHint}`;
    lines.push(`holding:  ${why}`);
    problems.push(why);
  }
  try {
    const found = x.engine.receiverOf(await client.receiverAddress());
    if (pinned === null) {
      lines.push(`receiver: not pinned; Orderly answers ${found}`,
        `next:     node tools/mainnet/orderly.mjs receiver ${a.contract} ${a.deskId} ${found} --key-file <owner key json> --send`);
    } else if (pinned === found) {
      lines.push(`receiver: pinned ${pinned}, Orderly's answer: they match`);
    } else {
      const why = `the pinned receiver ${pinned} is NOT Orderly's answer ${found}: every fund_venue and rescue into Orderly pays the pinned `
        + 'address, which Orderly does not credit to this account. Fund nothing into Orderly; the pin is permanent, so the fix is a new desk';
      lines.push(`receiver: MISMATCH: ${why}`);
      problems.push(why);
    }
  } catch (e) {
    const why = `Orderly's receiver could not be read: ${e.message}${ipHint}`;
    lines.push(`receiver: ${why}`);
    problems.push(why);
  }
  for (const l of lines.slice(3)) say(l.replace(/^(\w+): +/, (_, k) => `${k}${' '.repeat(Math.max(1, 10 - k.length))}`));
  const block = finish(x, lines);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return block;
}

// --- receiver ---

async function receiver(x) {
  const { a, desk, say } = x;
  const pinned = desk.orderly_receiver ?? null;
  if (pinned !== null) {
    if (a.receiver === null || a.receiver === pinned) {
      say(`nothing to send: the receiver is pinned already (${pinned}); the contract pins it once`);
      return finish(x, [`receiver: pinned ${pinned}; nothing to send`]);
    }
    throw new Error(`desk ${a.deskId} has its receiver pinned already, ${pinned}: the contract pins it once (E_ARGS the second time), so ${a.receiver} `
      + 'cannot replace it. A wrong pin is permanent for the desk: a new desk is the fix');
  }
  const pub = await orderlyPublic(x);
  say();
  say('1. look up the receiver: Orderly answers it only to a request the desk key signed');
  say(describeTx('  tx: orderly_request kind receiver_address (operator key)', {
    signer: desk.operator ?? desk.owner, signedBy: `the operator key from ${a.envFile}, read at --send`, receiver: a.contract,
    actions: requestActions(a.deskId, 'receiver_address', x.now(), RECEIVER_REASON),
  }).map((l) => `  ${l}`).join('\n'));
  say(`      GET ${ORDERLY_API}/v1/client/asset/receiver_address?chain_id=${x.chainId}&token=USDC`);
  say(`2. pin it${a.receiver === null ? ' (only when the address is given: --send without it stops after the lookup)' : ''}`);
  const actions = receiverActions(a.deskId, a.receiver ?? '<the receiver_address Orderly answers>');
  await ownerPlan(x, '  tx: set_orderly_receiver (owner)', actions, a.send ? `--key-file, a full-access key of ${desk.owner}` : 'the owner\'s key, read at --send', a.receiver !== null);
  say('money     no USDC moves. 0.01 NEAR attached for storage: the contract keeps what the pin takes (under 0.001 NEAR) and refunds the rest '
    + `to ${desk.owner}; the lookup spends operator gas only (about 0.001 NEAR)`);
  say('warning   the pin is permanent: every fund_venue and rescue into Orderly pays this address from then on; a wrong pin needs a new desk');
  if (!pub.registered || !pub.usable) {
    if (a.send) throw new Error(NOT_READY);
    say(`refused   at --send: ${NOT_READY}`);
  }
  if (!a.send) {
    return finish(x, [`receiver: not pinned; planned ${a.receiver ?? 'the lookup only'}`], {
      dryNote: `dry run: nothing was signed or sent. --send looks the receiver up${a.receiver === null ? ' and prints it' : ` and pins ${a.receiver} only when it is Orderly's answer`}.`,
    });
  }

  // Everything that can refuse without a signature first: the owner's key and balance, then the signed lookup.
  const signer = a.receiver === null ? null : await owner(x);
  const op = await operator(x, ALLOWED_KINDS.receiver);
  const answer = await orderlyClient(x, op.collected.signer).receiverAddress();
  const tx = op.collected.take().map((t) => t.id);
  const found = x.engine.receiverOf(answer);
  say(`lookup    Orderly answers ${JSON.stringify(answer)}${tx.length === 0 ? '' : ` (orderly_request tx ${tx.join(', ')})`}`);
  const lines = [`lookup:   receiver_address ${found}${tx.length === 0 ? '' : `; tx ${tx.join(', ')}`}`];
  if (a.receiver === null) {
    const next = `node tools/mainnet/orderly.mjs receiver ${a.contract} ${a.deskId} ${found} --key-file <owner key json> --send`;
    say(`next      to pin it: ${next}`);
    lines.push('receiver: not pinned (no address given)', `next:     ${next}`);
    return finish(x, lines);
  }
  if (found !== a.receiver) {
    lines.push(`receiver: NOT pinned: ${a.receiver} is not Orderly's answer ${found}`);
    finish(x, lines);
    throw new Error(`${a.receiver} is not the receiver Orderly gives this account (${found}): nothing was pinned`);
  }
  const sent = await ownerSend(x, signer, receiverActions(a.deskId, a.receiver));
  lines.push(...sent.lines);
  const after = (await x.client.view(a.contract, 'get_desk', { desk_id: a.deskId }))?.orderly_receiver ?? null;
  lines.push(`receiver: get_desk now ${after ?? 'none'}`);
  const block = finish(x, lines);
  if (sent.out.failure !== null) throw new Error(`set_orderly_receiver ${sent.out.hash}: ${panicOf(sent.out.failure)} (${txLink(sent.out.hash)})`);
  if (after !== a.receiver) throw new Error(`get_desk shows receiver ${after ?? 'none'}, not ${a.receiver}: check ${txLink(sent.out.hash)}`);
  return block;
}

// --- ips ---

async function ips(x) {
  const { a, desk, say } = x;
  const current = desk.orderly_ips ?? [];
  say(`current   ${current.length === 0 ? 'none' : current.join(', ')}`);
  say(`new       ${a.ips.join(', ')}`);
  const added = a.ips.filter((ip) => !current.includes(ip));
  const removed = current.filter((ip) => !a.ips.includes(ip));
  say(`change    ${added.length === 0 ? 'none added' : `adds ${added.join(', ')}`}; ${removed.length === 0 ? 'none removed' : `removes ${removed.join(', ')}`}`);
  const same = current.length === a.ips.length && current.every((ip, i) => ip === a.ips[i]);
  if (same && !a.forceSame) {
    say('nothing to send: the desk has this list already (setting it again would only clear orderly_ips_applied; --force-same does that)');
    return finish(x, [`ips:      ${current.join(',')} already set; nothing to send`]);
  }
  if (same && x.settings !== null && x.settings.orderly_ips_applied !== true) {
    say('nothing to send: orderly_ips_applied is false already, and --force-same only clears it (opens are refused until apply-ips succeeds)');
    return finish(x, [`ips:      ${current.join(',')} already set, applied false; --force-same has nothing to clear`]);
  }
  if (same) {
    say('force     --force-same: the same list again, only to clear orderly_ips_applied. Use it when the contract signed an ip_restriction');
    say('          that Orderly did not take: the contract then signs opens that Orderly does not limit to the list. After it,');
    say('          opens are refused until apply-ips succeeds');
  } else if (a.forceSame) {
    say('force     --force-same changes nothing here: the list differs from the desk\'s, so it is a new list anyway');
  }
  if (!same && added.length === 0 && removed.length === 0) say('warning   the same addresses in another order: the contract takes it as a new list and clears orderly_ips_applied');
  for (const l of WRONG_LIST) say(l);
  const actions = ipsActions(a.deskId, a.ips);
  await ownerPlan(x, 'tx: set_orderly_ips (owner)', actions, a.send ? `--key-file, a full-access key of ${desk.owner}` : 'the owner\'s key, read at --send');
  say('  then      orderly_ips_applied is false until apply-ips has the contract sign ip_restriction for the new list: no Orderly opens until then');
  say('money     no USDC moves. 0.01 NEAR attached for storage: the contract keeps what the list takes (at most about 0.005 NEAR for 10 IPv6 '
    + `addresses) and refunds the rest to ${desk.owner}`);
  const next = `node tools/mainnet/orderly.mjs apply-ips ${a.contract} ${a.deskId} --engine-ips <the engine's IPs>`;
  if (!a.send) {
    return finish(x, [`ips:      ${current.length === 0 ? 'none' : current.join(',')} -> ${a.ips.join(',')} planned`, `next:     ${next} (after --send)`], {
      dryNote: 'dry run: nothing was signed or sent. Add --send and --key-file <owner key json>, from the main checkout, to send it.',
    });
  }
  const signer = await owner(x);
  const sent = await ownerSend(x, signer, actions);
  const lines = [...sent.lines];
  const after = (await x.client.view(a.contract, 'get_desk', { desk_id: a.deskId }))?.orderly_ips ?? [];
  const settings = x.settings === null ? null : await x.client.view(a.contract, 'get_desk_settings', { desk_id: a.deskId });
  lines.push(`ips:      get_desk now ${after.length === 0 ? 'none' : after.join(',')}; applied ${settings === null ? 'unknown' : String(settings.orderly_ips_applied === true)}`);
  lines.push(`next:     ${next}, then the same with --send`);
  const block = finish(x, lines);
  if (sent.out.failure !== null) throw new Error(`set_orderly_ips ${sent.out.hash}: ${panicOf(sent.out.failure)} (${txLink(sent.out.hash)})`);
  if (after.join(',') !== a.ips.join(',')) throw new Error(`get_desk shows ${after.join(',') || 'no list'}, not ${a.ips.join(',')}: check ${txLink(sent.out.hash)}`);
  return block;
}

// --- apply-ips ---

async function applyIps(x) {
  const { a, desk, say } = x;
  const list = desk.orderly_ips ?? [];
  if (list.length === 0) throw new Error(`desk ${a.deskId} has no IP list: set one with the ips command first (the contract refuses ip_restriction without one, E_ARGS)`);
  for (const l of WRONG_LIST) say(l);
  const engineIps = a.engineIps;
  say(`engine    ${engineIps === null ? `not given: --send needs --engine-ips, ${ENGINE_IPS_HINT}` : `${engineIps.join(', ')} (--engine-ips)`}`);
  const missing = engineIps === null ? null : x.engine.missingIps(list, engineIps);
  if (missing !== null && missing.length > 0) {
    say(`refused   the list leaves out ${missing.join(', ')}: Orderly would refuse every request the engine sends from there, so it could not open, `
      + 'close or read. Nothing is signed; add it with the ips command first');
  }
  // This machine posts the ip_restriction; once a list is applied at Orderly, only a listed IP can post the next one.
  let here = null;
  let hereError = null;
  try {
    here = await (x.deps.publicIps ?? (() => x.engine.publicIpLookup({ fetch: x.fetchImpl })()))();
  } catch (e) {
    hereError = e.message;
  }
  const hereOut = here === null ? null : x.engine.missingIps(list, here);
  const hereText = here === null ? `unknown (${hereError})`
    : hereOut.length === 0 ? `${here.join(', ')}: in the list`
      : `${here.join(', ')}: NOT in the list. Once Orderly applies it, this machine cannot post a correction or read the holding; `
        + 'a correction then goes from a listed IP (the engine\'s POST /setup)';
  say(`this      this machine's public IP ${hereText}`);
  const pub = await orderlyPublic(x);
  const signer = desk.operator ?? desk.owner;
  const signedBy = `the operator key from ${a.envFile}, read at --send`;
  say();
  say('the engine\'s setup steps, cut to Orderly (runSetup): register and add-key are done-checks only (public reads, nothing signed here)');
  say('1. orderly_receiver_lookup: a signed read; it fails, and pins nothing, when a pinned receiver is not Orderly\'s answer');
  say(describeTx('  tx: orderly_request kind receiver_address', { signer, signedBy, receiver: a.contract, actions: requestActions(a.deskId, 'receiver_address', x.now(), RECEIVER_REASON) })
    .map((l) => `  ${l}`).join('\n'));
  say('2. orderly_ip_restriction: the contract signs the body from the stored list; this machine posts it');
  say(describeTx('  tx: orderly_request kind ip_restriction', { signer, signedBy, receiver: a.contract, actions: requestActions(a.deskId, 'ip_restriction', x.now(), IP_REASON) })
    .map((l) => `  ${l}`).join('\n'));
  say(`      POST ${ORDERLY_API}${IP_RESTRICTION_PATH} ${ipRestrictionBody(desk.solana.authority, list)}`);
  say('      Orderly takes it from any IP while no list is applied there; once one is, only from an IP in that list');
  say('money     none moves: two signed requests on the operator key, gas only (about 0.001 NEAR each; 0.3 NEAR of the allowance held per call until the refund)');
  const ready = pub.registered && pub.usable;
  if (!ready) say(`refused   at --send: ${NOT_READY}`);
  if (engineIps === null) say('refused   at --send without --engine-ips');
  // With the list marked applied already, Orderly may hold it: then only a listed IP can post, and a post from
  // elsewhere is refused ("IP is not allowed") after a signature. Refused here, before anything is signed.
  const appliedRefusal = (applied) => (applied !== true || here === null || hereOut.length === 0 ? null
    : `the contract has this list marked applied already, and this machine's IP ${here.join(', ')} is not in it: Orderly, if it `
      + 'holds the list, refuses the post from here. Post it from a listed IP (the engine\'s POST /setup). If an earlier apply-ips '
      + 'printed NOT PROTECTED, clear the flag first with ips --force-same');
  const earlyRefusal = appliedRefusal(x.settings?.orderly_ips_applied === true);
  if (earlyRefusal !== null) say(`refused   at --send: ${earlyRefusal}`);
  const thisLine = `this:     ${here === null ? 'unknown' : `${here.join(',')} ${hereOut.length === 0 ? 'in the list' : 'NOT in the list'}`}`;
  if (!a.send) {
    return finish(x, [`state:    ${stateSummary(desk, x.settings)}`, `engine:   ${engineIps === null ? 'not given (--send needs --engine-ips)' : engineIps.join(',')}${missing?.length ? `; missing from the list: ${missing.join(',')}` : ''}`, thisLine], {
      dryNote: 'dry run: nothing was signed or sent. --send, from the main checkout, runs the two steps above.',
    });
  }
  if (missing.length > 0) throw new Error(`the desk's IP list (${list.join(', ')}) leaves out ${missing.join(', ')}, an IP the engine sends from: nothing was signed`);
  if (!ready) throw new Error(NOT_READY);
  // orderly_ips_applied right before the run, read fresh: the contract sets it when it signs ip_restriction, before
  // this machine posts it, so before and after tell whether this run flipped it.
  const readApplied = async () => (x.settings === null ? null
    : (await x.client.view(a.contract, 'get_desk_settings', { desk_id: a.deskId }))?.orderly_ips_applied === true);
  const before = await readApplied();
  const refusal = appliedRefusal(before);
  if (refusal !== null) throw new Error(`${refusal}: nothing was signed`);

  const op = await operator(x, ALLOWED_KINDS['apply-ips']);
  const orderly = orderlyClient(x, op.collected.signer);
  const off = (what) => () => Promise.reject(new Error(`${what} is not part of apply-ips`));
  const progress = await x.engine.runSetup({
    deskId: a.deskId,
    desk: () => op.contract.getDesk(a.deskId),
    referralCodes: { hyperliquid: null, orderly: null, phoenix: null },
    builderFeeTenthBps: null,
    brokerId: x.brokerId,
    hl: { hasAccount: off('Hyperliquid'), referredBy: off('Hyperliquid'), approvedBuilderFee: off('Hyperliquid'), setReferrer: off('Hyperliquid'), approveBuilderFee: off('Hyperliquid') },
    orderly: {
      accountId: orderly.accountId,
      isRegistered: (b) => orderly.isRegistered(b),
      keyInfo: () => orderly.keyInfo(),
      register: off('orderly_register (run checks.mjs --step orderly --send)'),
      addKey: off('orderly_add_key (run checks.mjs --step orderly --send)'),
      receiverAddress: () => orderly.receiverAddress(),
      bindReferral: off('referral_bind'),
      restrictKeyIps: () => orderly.restrictKeyIps(),
    },
    phoenix: null,
    relayerIps: async () => engineIps,
    takeOrderlyTx: op.collected.take,
    publish: () => {},
    log: (line) => say(`  ${line}`),
    now: x.now,
  });
  const lines = [thisLine];
  for (const name of ['orderly_register', 'orderly_add_key', 'orderly_receiver_lookup', 'orderly_ip_restriction']) {
    const s = progress.steps.find((p) => p.step === name);
    const line = `setup:    ${name} ${s.status}${s.detail === undefined ? '' : `: ${s.detail}`}${s.tx.length === 0 ? '' : `; tx ${s.tx.map((t) => t.id).join(', ')}`}`;
    say(line.replace(/^setup: {4}/, 'setup     '));
    lines.push(line);
  }
  const ip = progress.steps.find((p) => p.step === 'orderly_ip_restriction');
  const lookup = progress.steps.find((p) => p.step === 'orderly_receiver_lookup');
  const problems = [];
  // Decided from the flag before and after, never from the step's tx list: a transaction that landed but whose result
  // could not be read flips the flag with no tx collected.
  let after;
  let afterError = null;
  try {
    after = await readApplied();
  } catch (e) {
    after = undefined;
    afterError = e.message;
  }
  const sameList = `node tools/mainnet/orderly.mjs ips ${a.contract} ${a.deskId} ${list.join(',')} --force-same --key-file <owner key json> --send`;
  const failed = ip.status !== 'done';
  if (failed && before === false && (after === true || after === undefined)) {
    // This run flipped the flag (or it cannot be told): the contract signs opens Orderly does not limit to the list.
    const flag = after === true ? 'marks the list applied' : `may mark the list applied (orderly_ips_applied could not be read again: ${afterError})`;
    const loud = [
      `FAILED    orderly_ip_restriction: the contract signed it in this run and ${flag}, but Orderly did NOT take it: ${ip.detail ?? 'no detail'}`,
      `          OPENS ARE NOT PROTECTED${after === true ? '' : ' if the flag is set'}: the contract signs Orderly opens while Orderly does not limit the key to the list.`,
      '          Way out, one of:',
      '          - post it from an IP Orderly takes the key from (one in a list applied there, if any: the engine\'s POST /setup)',
      `          - clear the flag, so the contract refuses opens again: ${sameList}`,
    ];
    for (const l of loud) say(l);
    lines.push(`applied:  ${after === true ? 'true' : 'unread'} in the contract (false before this run), but Orderly did NOT take the list`,
      `opens:    NOT PROTECTED${after === true ? '' : ' if the flag is set'}: the contract signs opens that Orderly does not limit to the list`,
      `fix:      post it from an IP Orderly takes, or: ${sameList}`);
    problems.push(`orderly_ip_restriction failed after the contract signed it: ${ip.detail ?? 'no detail'}. The contract ${flag} but `
      + `Orderly did not take it, so opens are NOT protected. Post it from an IP Orderly takes, or clear the flag: ${sameList}`);
  } else if (failed && before === true) {
    // The flag was set before this run: Orderly refusing the post shows it enforces a list already (an earlier one, or this).
    const why = `orderly_ip_restriction ${ip.status}: ${ip.detail ?? 'no detail'}. The contract had this list marked applied before this run, `
      + 'so Orderly holds a list already (an earlier one, or this one) and takes the post only from an IP in it: post it from a listed IP '
      + '(the engine\'s POST /setup). Nothing changed in the contract';
    say(`FAILED    ${why}`);
    lines.push('applied:  true (before this run too); Orderly holds an earlier list or this one', `opens:    ${opensText(list, true)}`);
    problems.push(why);
  } else {
    const applied = after === undefined ? null : after;
    lines.push(`applied:  ${after === undefined ? `unread (${afterError})` : applied === null ? 'unknown (no get_desk_settings)' : String(applied)}`,
      `opens:    ${opensText(list, applied)}`);
    if (failed) problems.push(`orderly_ip_restriction ${ip.status}: ${ip.detail ?? 'no detail'}${before === null ? '; whether the contract marked the list applied cannot be read (no get_desk_settings)' : ''}`);
  }
  if (lookup.status !== 'done') {
    const why = `orderly_receiver_lookup ${lookup.status}: ${lookup.detail ?? 'no detail'}`;
    say(`FAILED    ${why}`);
    lines.push(`receiver: FAILED: ${lookup.detail ?? lookup.status}`);
    problems.push(why);
  }
  const block = finish(x, lines);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return block;
}

if (isMain(import.meta.url)) await run(() => runOrderly(process.argv.slice(2)), USAGE);
