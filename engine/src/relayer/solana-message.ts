// Solana instructions to a legacy message, the bytes `sol_sign` and `sol_sign_rescue` take, and the SPL Token
// instructions the desk's own messages add to the Phoenix SDK's. The account order is web3.js's
// (Transaction.compileMessage): signers first, then writable accounts, each group by base58 address, the fee payer
// moved to the front. The contract checks every account by its place, so the order is pinned against its vectors
// (contract/core/tests/vectors), not just any valid order.

import { base58Decode } from './solana.ts';

/** An instruction in @solana/kit's shape, which the Phoenix SDK returns. */
export interface SolInstruction {
  programAddress: string;
  /** role: @solana/kit's AccountRole, 0 readonly, 1 writable, 2 readonly signer, 3 writable signer. */
  accounts?: readonly { address: string; role: number }[];
  data?: Uint8Array | ArrayLike<number>;
}

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const READONLY = 0;
const WRITABLE = 1;
const READONLY_SIGNER = 2;

/** SPL Token `Revoke` (5): `owner` takes back every allowance on its token account `source`. */
export function tokenRevoke(source: string, owner: string): SolInstruction {
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [{ address: source, role: WRITABLE }, { address: owner, role: READONLY_SIGNER }],
    data: Uint8Array.of(5),
  };
}

/** SPL Token `TransferChecked` (12): `amount` base units of `mint` (with its `decimals`) from `source` to `destination`. */
export function tokenTransferChecked(source: string, mint: string, destination: string, owner: string, amount: bigint, decimals: number): SolInstruction {
  if (amount <= 0n || amount >= 1n << 64n) throw new Error(`TransferChecked: amount ${amount} is not a u64 above 0`);
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: source, role: WRITABLE }, { address: mint, role: READONLY },
      { address: destination, role: WRITABLE }, { address: owner, role: READONLY_SIGNER },
    ],
    data: Uint8Array.from(data),
  };
}

/** computeBudgetInstructions() of solana.ts, as SolInstructions. */
export function asSolInstructions(ixs: readonly { programAddress: string; data: Uint8Array }[]): SolInstruction[] {
  return ixs.map((ix) => ({ programAddress: ix.programAddress, accounts: [], data: ix.data }));
}

interface Meta {
  address: string;
  signer: boolean;
  writable: boolean;
}

// web3.js 1.x compares addresses this way when it orders a message's keys.
const COMPARE: Intl.CollatorOptions = { usage: 'sort', sensitivity: 'variant', ignorePunctuation: false, numeric: false, caseFirst: 'lower' };

/** The legacy message of `instructions`, paid by `feePayer`, on `recentBlockhash`. */
export function compileLegacyMessage(feePayer: string, instructions: readonly SolInstruction[], recentBlockhash: string): Uint8Array {
  const metas = new Map<string, Meta>();
  const add = (address: string, signer: boolean, writable: boolean) => {
    const m = metas.get(address);
    if (m === undefined) metas.set(address, { address, signer, writable });
    else {
      m.signer ||= signer;
      m.writable ||= writable;
    }
  };
  for (const ix of instructions) for (const a of ix.accounts ?? []) add(a.address, a.role >= READONLY_SIGNER, (a.role & WRITABLE) === WRITABLE);
  for (const ix of instructions) add(ix.programAddress, false, false);
  const sorted = [...metas.values()].filter((m) => m.address !== feePayer).sort((x, y) => {
    if (x.signer !== y.signer) return x.signer ? -1 : 1;
    if (x.writable !== y.writable) return x.writable ? -1 : 1;
    return x.address.localeCompare(y.address, 'en', COMPARE);
  });
  const keys: Meta[] = [{ address: feePayer, signer: true, writable: true }, ...sorted];
  const index = new Map(keys.map((k, i) => [k.address, i]));
  if (keys.length > 256) throw new Error(`solana: ${keys.length} accounts, a legacy message holds 256`);

  const out: number[] = [
    keys.filter((k) => k.signer).length,
    keys.filter((k) => k.signer && !k.writable).length,
    keys.filter((k) => !k.signer && !k.writable).length,
  ];
  compactU16(out, keys.length);
  for (const k of keys) out.push(...key32(k.address));
  out.push(...key32(recentBlockhash));
  compactU16(out, instructions.length);
  for (const ix of instructions) {
    out.push(index.get(ix.programAddress)!);
    const accounts = ix.accounts ?? [];
    compactU16(out, accounts.length);
    for (const a of accounts) out.push(index.get(a.address)!);
    const data = Array.from(ix.data ?? []);
    compactU16(out, data.length);
    out.push(...data);
  }
  return Uint8Array.from(out);
}

function key32(address: string): Buffer {
  const b = base58Decode(address);
  if (b.length !== 32) throw new Error(`solana: ${address} is not a 32-byte address`);
  return b;
}

function compactU16(out: number[], n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`solana: ${n} does not fit a compact-u16`);
  let v = n;
  for (;;) {
    const byte = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}
