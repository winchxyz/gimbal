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
 * each record. Measured by the contract's own test (`the_storage_each_owner_method_adds`): 3,611 B with a small
 * policy, 11,213 B with the largest valid one, and it caps them at 4,000 and 12,000. The policy takes less in Borsh
 * than its JSON takes in the arguments, so what is left over is the fixed part, at most about 3,800 B (a 64-character
 * owner and a 32-character desk id). 12,000 B is far over that, and with the arguments over the largest desk in all
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

export function setOrderlyIpsTx(contractId: string, deskId: string, ips: string[]): WalletTx {
  const args = { desk_id: deskId, ips };
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

/** IPv4 in canonical form (no leading zeros), or IPv6 with colons; the contract does the final check (`E_ARGS`). */
export function isIp(text: string): boolean {
  const v4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(text);
  return v4 || (/^[0-9a-f:]+$/.test(text) && text.includes(':') && text.length <= 39);
}
