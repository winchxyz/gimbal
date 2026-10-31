// The storage the contract's owner methods add to a desk, byte for byte, and what each charges for it. Test support:
// only the fake world (fakes.ts) uses it, so a transaction the page builds with too small a deposit is refused here the
// way the chain refuses it (`E_DEPOSIT`), instead of passing because the fake accepted any deposit.
//
// The rules are the contract's (contract/src/deposit.rs, lib.rs): a storage method keeps what it adds, measured as the
// change in `storage_usage`, at 1e19 yoctoNEAR a byte and at least 1 yocto, and refunds the rest. Storage freed is not
// paid back. The sizes are Borsh sizes of the stored structs plus the chain's 40 bytes for every key/value record. The
// numbers were checked against the contract's own measurement (`the_storage_each_owner_method_adds`, contract/src/tests.rs)
// in fake-storage.test.ts, so a change to a stored struct that moves them shows up there.
import type { ContractPolicy } from '@gimbal/shared';
import { b58encode } from './derive.ts';
import { STORAGE_BYTE_COST } from './near.ts';

/**
 * `Policy::largest_valid()` of contract/core/src/policy.rs: every list full and every string as long as it may be. The
 * contract measures its desk with it and caps the result, so the tests use it as the worst case a deposit must cover.
 */
export function largestValidPolicy(): ContractPolicy {
  const max = Number.MAX_SAFE_INTEGER;
  const pad = (i: number, width: number): string => String(i).padStart(width, '0');
  return {
    hl_assets: Array.from({ length: 32 }, (_, i) => ({ index: 0xffffffff - i, symbol: pad(i, 32), sz_decimals: 6 })),
    phoenix_markets: Array.from({ length: 32 }, (_, i) => {
      const key = new Uint8Array(32).fill(0xff);
      key[31] = i;
      return { symbol: pad(i, 32), orderbook: b58encode(key), base_lot_e8: max, tick_e8: max };
    }),
    orderly_symbols: Array.from({ length: 32 }, (_, i) => `PERP_${pad(i, 22)}_USDC`),
    max_notional_usd: max,
    price_band_bps: 10_000,
    oracle_max_age_s: 3_600,
    rescue_cap_usd_per_hour: max,
    max_transfer_cost_bps: 10_000,
    max_transfer_cost_flat_e6: max,
    unpriced: Array.from({ length: 32 }, (_, i) => ({ symbol: pad(i, 32), max_sz: '9007199254740990.99999999' })),
    unpriced_max_notional_usd: max,
  };
}

/** What the chain adds to the storage used for every key/value pair it holds, on top of the key and the value. */
const RECORD_BYTES = 40;
/** A map key of the contract: one byte of storage-key prefix, then the Borsh key. */
const PREFIX = 1;
/** `DeskCounters` (contract/src/rescue.rs): the meters, the nonce, and the ring of 32 deposit-address hashes and times. */
export const DESK_COUNTERS_BYTES = 8 + 16 + 16 + 8 + 32 * 32 + 1 + 32 * 8;
/** A desk's Orderly account id is `0x` and 64 hex digits. */
const ORDERLY_ACCOUNT_ID_CHARS = 66;
/** The two `u128` counters and the three `u128` ledger fields of `Ledger`. */
const LEDGER_BYTES = 5 * 16;

const utf8 = (text: string): number => new TextEncoder().encode(text).length;
/** Borsh `String`: a 4-byte length, then the bytes. */
const str = (text: string): number => 4 + utf8(text);
const list = <T>(items: readonly T[], size: (item: T) => number): number => 4 + items.reduce((sum, item) => sum + size(item), 0);

/** The Borsh size of `Policy` (contract/core/src/policy.rs). */
export function policyBytes(p: ContractPolicy): number {
  return (
    list(p.hl_assets, (a) => 4 + str(a.symbol) + 1) +
    list(p.phoenix_markets, (m) => str(m.symbol) + str(m.orderbook) + 8 + 8) +
    list(p.orderly_symbols, str) +
    8 + // max_notional_usd
    4 + // price_band_bps
    4 + // oracle_max_age_s
    8 + // rescue_cap_usd_per_hour
    4 + // max_transfer_cost_bps
    8 + // max_transfer_cost_flat_e6
    list(p.unpriced, (u) => str(u.symbol) + str(u.max_sz)) +
    8 // unpriced_max_notional_usd
  );
}

export interface SolanaShape {
  authority: string;
  usdc_ata: string;
  phusd_ata: string;
  phoenix_trader: string;
}

/** What a new desk is made of, as `create_desk` stores it. */
export interface NewDesk {
  deskId: string;
  owner: string;
  policy: ContractPolicy;
  evm_address: string;
  solana: SolanaShape;
  /** The owner already has a desk on this contract: its count record exists and is only updated. */
  ownerHasDesk: boolean;
}

/** Bytes `create_desk` adds: the desk, its nonce, its counters, the owner's index entry and, for a first desk, the owner's count. */
export function createDeskBytes(d: NewDesk): number {
  const desk =
    str(d.owner) +
    1 + // operator: None
    1 + // paused
    policyBytes(d.policy) +
    str(d.evm_address) +
    str(d.solana.authority) +
    str(d.solana.usdc_ata) +
    str(d.solana.phusd_ata) +
    str(d.solana.phoenix_trader) +
    4 +
    ORDERLY_ACCOUNT_ID_CHARS +
    1 + // orderly_receiver: None
    4 + // orderly_ips: empty
    LEDGER_BYTES;
  const idKey = PREFIX + str(d.deskId);
  const records =
    RECORD_BYTES + idKey + desk + // desks
    RECORD_BYTES + idKey + 8 + // hl_nonces
    RECORD_BYTES + idKey + DESK_COUNTERS_BYTES + // desk_counters
    RECORD_BYTES + (PREFIX + str(d.owner) + 4) + str(d.deskId); // desk_ids: (owner, n) -> desk id
  const count = d.ownerHasDesk ? 0 : RECORD_BYTES + (PREFIX + str(d.owner)) + 4; // desk_counts: owner -> n
  return records + count;
}

/** Bytes `set_policy` adds: the new policy less the old one, never negative (freed storage is not paid back). */
export const setPolicyBytes = (before: ContractPolicy, after: ContractPolicy): number => Math.max(0, policyBytes(after) - policyBytes(before));

/** Bytes `set_orderly_receiver` adds: a `String` where there was `None`. The tag byte was already there. */
export const setReceiverBytes = (receiver: string): number => str(receiver);

/** Bytes `set_orderly_ips` adds: the new list less the old one. */
export const setIpsBytes = (before: readonly string[], after: readonly string[]): number =>
  Math.max(0, list(after, str) - list(before, str));

/** What a storage method keeps of its deposit: the storage it added, and at least the 1 yocto that proves the wallet. */
export function storageCharge(addedBytes: number): bigint {
  const cost = STORAGE_BYTE_COST * BigInt(addedBytes);
  return cost < 1n ? 1n : cost;
}

/** A storage method with no deposit at all is the function-call key's path, which the contract refuses with `E_NOT_ALLOWED`. */
export const noDepositRefusal = (method: string): string => `E_NOT_ALLOWED: ${method} needs a deposit of at least 1 yoctoNEAR from the owner's wallet`;

/**
 * The contract's refusal for a storage method that came with too little, or null. `what` names the call as the
 * contract's message does (`desk alpha`, `set_policy on desk alpha`).
 */
export function depositRefusal(method: string, what: string, addedBytes: number, attached: bigint): string | null {
  if (attached === 0n) return noDepositRefusal(method);
  const charge = storageCharge(addedBytes);
  if (attached < charge) return `E_DEPOSIT: ${what} takes ${addedBytes} bytes of storage: attach at least ${charge} yoctoNEAR, not ${attached}`;
  return null;
}
