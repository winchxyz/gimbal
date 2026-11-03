// The transactions the owner's wallet signs (docs/interfaces.md §1.3): create the desk, set the policy, deposit, pin the
// Orderly receiver and set the Orderly IP list. Pure builders, so the arguments, gas and deposits are tested.
//
// Owner methods need exactly 1 yoctoNEAR, except the ones that add storage (`create_desk`, `set_policy`,
// `set_operator`, `set_orderly_receiver`, `set_orderly_ips`), which need at least 1 yocto and the storage they add;
// the excess is refunded to the caller.
import type { ContractPolicy } from '@gimbal/shared';
import type { DerivedAddresses } from './derive.ts';
import { storageDeposit, tgas } from './near.ts';
import type { WalletTx } from './wallet.ts';

/** `create_desk` and its callback burn ~18 TGas and refuse less than 64; the interface says to attach about 100. */
export const CREATE_DESK_GAS = tgas(100);
/** The owner methods that sign nothing: they only write state. */
export const OWNER_CALL_GAS = tgas(30);
/** `ft_transfer_call` runs the token's transfer, the contract's `ft_on_transfer` and the token's resolve. */
export const DEPOSIT_GAS = tgas(100);

const ONE_YOCTO = '1';

/** A desk id: 1 to 32 characters of a-z, 0-9 and "-" (`E_ARGS` otherwise, §1.5). */
export const isDeskId = (id: string): boolean => /^[a-z0-9-]{1,32}$/.test(id);

/** What the contract asks for each owner call, for the page to show before the wallet opens. */
export const CREATE_DESK_NOTE = 'The contract keeps only the storage the desk uses and returns the rest of the NEAR you attach.';

// Every storage deposit here is an upper bound, not the exact price. The contract measures what the call added to its
// storage, keeps that at 1e19 yoctoNEAR a byte and refunds the rest to the caller (contract/src/deposit.rs
// `refund_after`; for `create_desk` the callback `on_desk_keys` sends it back), so attaching more than needed costs
// nothing but a moment's lock, while attaching less is `E_DEPOSIT` and nothing is created. The exact price is not
// computed here because it depends on how the contract stores the desk, which changes with the contract.

/**
 * Bytes `create_desk` may store beyond the JSON it is given. The desk is not its arguments: the contract also stores
 * the desk's meters and its rings of deposit-address hashes (rescue and funding), its money record, a reserve for the
 * contract-wide paid-address map, its Orderly account id, the owner's index entries and 40 B of chain overhead for
 * each record, and its settings (Phoenix accounts, second 1Click key). Measured by the contract's own test
 * (`the_storage_each_owner_method_adds`): 4,081 B with a small policy, 11,691 B with the largest valid one, and it caps
 * them at 4,500 and 12,500. The policy takes less in Borsh than its JSON takes in the arguments, so what is left over
 * is the fixed part, at most about 4,300 B (a 64-character owner and a 32-character desk id). 12,000 B is far over that, and with the arguments over the largest desk in all
 * (about 0.12 NEAR, returned). The old margin of 1,000 B was short of even a small desk:
 * `E_DEPOSIT: desk alpha takes 2068 bytes of storage: attach at least 0.02068 NEAR, not 0.01597`.
 */
export const CREATE_DESK_EXTRA_BYTES = 12_000;

/**
 * Bytes the other storage calls get on top of their JSON. They store no more than they are given (a policy, an
 * address, a list of IPs, each smaller in Borsh than in JSON), so their JSON already covers them; this is a margin.
 */
export const STORAGE_MARGIN_BYTES = 1_000;

export function createDeskTx(contractId: string, deskId: string, policy: ContractPolicy, derived: DerivedAddresses): WalletTx {
  const args = { desk_id: deskId, policy, evm_address: derived.evm_address, solana: derived.solana };
  return {
    receiverId: contractId,
    actions: [{ type: 'FunctionCall', params: { methodName: 'create_desk', args, gas: CREATE_DESK_GAS, deposit: storageDeposit(JSON.stringify(args), CREATE_DESK_EXTRA_BYTES).toString() } }],
  };
}

export function setPolicyTx(contractId: string, deskId: string, policy: ContractPolicy): WalletTx {
  const args = { desk_id: deskId, policy };
  return {
    receiverId: contractId,
    actions: [{ type: 'FunctionCall', params: { methodName: 'set_policy', args, gas: OWNER_CALL_GAS, deposit: setPolicyDeposit(deskId, policy).toString() } }],
  };
}

/** What `set_policy` may hold as a storage deposit, in yoctoNEAR: an upper bound; the rest comes back. */
export const setPolicyDeposit = (deskId: string, policy: ContractPolicy): bigint => storageDeposit(JSON.stringify({ desk_id: deskId, policy }), STORAGE_MARGIN_BYTES);

/** The contract takes the receiver as a lowercase `0x` address only (`E_ARGS`). */
export function setOrderlyReceiverTx(contractId: string, deskId: string, receiver: string): WalletTx {
  const args = { desk_id: deskId, receiver: receiver.toLowerCase() };
  return {
    receiverId: contractId,
    actions: [{ type: 'FunctionCall', params: { methodName: 'set_orderly_receiver', args, gas: OWNER_CALL_GAS, deposit: storageDeposit(JSON.stringify(args), STORAGE_MARGIN_BYTES).toString() } }],
  };
}

/**
 * `set_orderly_ips`. `engineIps` are the engine's public IPs (the config's `relayerIps`): the engine sends every Orderly
 * request from there, so a list without them would lock it out of the desk's Orderly account once setup applies the
 * list (no closes, no rescue). Throws with the reason for any list the owner must not sign (`orderlyIpsProblem`).
 * No restriction at all is no call: the contract takes 1 to 10 IPs and setup skips the step while none are set.
 */
export function setOrderlyIpsTx(contractId: string, deskId: string, ips: string[], engineIps: readonly string[]): WalletTx {
  const problem = orderlyIpsProblem(ips, engineIps);
  if (problem !== null) throw new Error(problem);
  const args = { desk_id: deskId, ips: ips.map((ip) => canonicalIp(ip)!) };
  return {
    receiverId: contractId,
    actions: [{ type: 'FunctionCall', params: { methodName: 'set_orderly_ips', args, gas: OWNER_CALL_GAS, deposit: storageDeposit(JSON.stringify(args), STORAGE_MARGIN_BYTES).toString() } }],
  };
}

/** USDC on NEAR in: `ft_transfer_call` with `msg` = `{"desk_id":"<id>"}`, so the owner's deposit counts as principal (§1.2). */
export function depositTx(token: string, contractId: string, deskId: string, amount: bigint): WalletTx {
  const args = { receiver_id: contractId, amount: amount.toString(), msg: JSON.stringify({ desk_id: deskId }) };
  return { receiverId: token, actions: [{ type: 'FunctionCall', params: { methodName: 'ft_transfer_call', args, gas: DEPOSIT_GAS, deposit: ONE_YOCTO } }] };
}

/** An Orderly receiver is an Arbitrum address: `0x` and 40 hex digits. */
export const isEvmAddress = (text: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(text);

/** The IPs of the list, one per line or separated by commas: trimmed and without blanks. */
export const splitIps = (text: string): string[] => text.split(/[\s,]+/).filter((ip) => ip !== '');

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * An IP in the canonical form the contract takes (Rust's `IpAddr` display: IPv4 without leading zeros, IPv6 lowercase
 * and compressed as RFC 5952 says), or null when the text is not an IP. The URL parser does the IPv6 part.
 */
export function canonicalIp(text: string): string | null {
  const t = text.trim();
  if (V4.test(t)) return t;
  if (!/^[0-9A-Fa-f:.]+$/.test(t) || !t.includes(':')) return null;
  try {
    const host = new URL(`http://[${t}]/`).hostname;
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : null;
  } catch {
    return null;
  }
}

/** An IPv4 or IPv6 address; the contract does the final check (`E_ARGS`). */
export const isIp = (text: string): boolean => canonicalIp(text) !== null;

/**
 * Why the owner must not sign this Orderly IP list, or null when it is fine: 1 to 10 distinct IPs (the contract's
 * rule), and every one of the engine's public IPs among them. An engine IP the page does not know refuses too: a list
 * signed on a guess can lock the engine out.
 */
export function orderlyIpsProblem(ips: readonly string[], engineIps: readonly string[]): string | null {
  if (ips.length < 1 || ips.length > 10) return 'Type 1 to 10 IP addresses.';
  const bad = ips.find((ip) => !isIp(ip));
  if (bad !== undefined) return `“${bad}” is not an IP address.`;
  const list = ips.map((ip) => canonicalIp(ip)!);
  const twice = list.find((ip, i) => list.indexOf(ip) !== i);
  if (twice !== undefined) return `${twice} is in the list twice.`;
  const engine = engineIps.map((ip) => canonicalIp(ip)).filter((ip): ip is string => ip !== null);
  if (engine.length === 0) {
    return 'This page does not know the engine’s IP address (VITE_RELAYER_IP), so it cannot check that the list lets the engine in. Leave the list empty, or set VITE_RELAYER_IP.';
  }
  const missing = engine.filter((ip) => !list.includes(ip));
  if (missing.length > 0) {
    return `The list leaves out ${missing.join(' and ')}, the engine’s IP address. Orderly would refuse every request the engine sends from there, so it could not close a position or run a rescue. Add it to the list.`;
  }
  return null;
}
