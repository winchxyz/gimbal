// A desk's addresses from the MPC contract's `derived_public_key` answers (docs/interfaces.md §1.2), computed the way
// `create_desk` checks them: the EVM address is the last 20 bytes of keccak256 of the 64-byte secp256k1 key, the
// Solana authority is the Ed25519 key in base58, and the token accounts and the Phoenix trader are program addresses
// of the authority. The Solana part follows tools/testnet/near.mjs, which the contract's own vectors check
// (contract/core/tests/vectors/solana-onboarding.json), including the Phoenix trader for the authority used there.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function b58decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of text) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** The `0x` address of a 64-byte uncompressed secp256k1 key (x ‖ y), lowercase, as `create_desk` stores it. */
export function evmAddressOf(key64: Uint8Array): string {
  if (key64.length !== 64) throw new Error('the EVM key is not 64 bytes');
  return `0x${hex(keccak_256(key64).subarray(12))}`;
}

/** Decodes `secp256k1:<base58>` as the MPC contract returns it for domain 0. */
export function decodeSecp256k1(key: string): Uint8Array {
  if (!key.startsWith('secp256k1:')) throw new Error('the EVM key does not start with secp256k1:');
  const bytes = b58decode(key.slice('secp256k1:'.length));
  if (bytes.length !== 64) throw new Error('the EVM key is not 64 bytes');
  return bytes;
}

/** Decodes `ed25519:<base58>` as the MPC contract returns it for domain 1; the base58 part is the Solana address. */
export function decodeEd25519(key: string): { address: string; bytes: Uint8Array } {
  if (!key.startsWith('ed25519:')) throw new Error('the Solana key does not start with ed25519:');
  const address = key.slice('ed25519:'.length);
  const bytes = b58decode(address);
  if (bytes.length !== 32) throw new Error('the Solana key is not 32 bytes');
  return { address, bytes };
}

// --- Solana program addresses ---

const P = (1n << 255n) - 19n;
const modp = (x: bigint): bigint => ((x % P) + P) % P;
function powmod(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = modp(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const D = modp(-121665n * powmod(121666n, P - 2n));

/** Whether 32 bytes decompress to an Ed25519 point (curve25519-dalek's `decompress`): a program address must not. */
export function isOnCurve(bytes: Uint8Array): boolean {
  const b = Uint8Array.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]!);
  y = modp(y);
  const y2 = (y * y) % P;
  const u = modp(y2 - 1n);
  const v = modp(D * y2 + 1n);
  const w = (u * powmod(v, P - 2n)) % P;
  return w === 0n || powmod(w, (P - 1n) / 2n) === 1n;
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Solana's `find_program_address`: the first bump from 255 down whose hash is off the curve. */
export function findProgramAddress(seeds: Uint8Array[], program: Uint8Array): Uint8Array {
  for (let bump = 255; bump >= 1; bump--) {
    const hash = sha256(concat([...seeds, Uint8Array.of(bump), program, utf8('ProgramDerivedAddress')]));
    if (!isOnCurve(hash)) return hash;
  }
  throw new Error('no program address');
}

const TOKEN_PROGRAM = b58decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = b58decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PHOENIX_PROGRAM = b58decode('EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih');
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const PHUSD_MINT = 'PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A';

/** The `SolanaAccounts` argument of `create_desk`, as the contract stores them (snake_case, the JSON it takes). */
export interface SolanaAccounts {
  authority: string;
  usdc_ata: string;
  phusd_ata: string;
  phoenix_trader: string;
}

export function solanaAccountsOf(authority: string): SolanaAccounts {
  const a = b58decode(authority);
  const ata = (mint: string): string => b58encode(findProgramAddress([a, TOKEN_PROGRAM, b58decode(mint)], ATA_PROGRAM));
  return {
    authority,
    usdc_ata: ata(USDC_MINT),
    phusd_ata: ata(PHUSD_MINT),
    phoenix_trader: b58encode(findProgramAddress([utf8('trader'), a, Uint8Array.of(0), Uint8Array.of(0)], PHOENIX_PROGRAM)),
  };
}

/** What the desk's two MPC keys give: the arguments of `create_desk` that come from the network. */
export interface DerivedAddresses {
  evm_address: string;
  solana: SolanaAccounts;
}

/** The derivation paths of docs/interfaces.md §1.2, and the MPC domains they live in. */
export const evmPath = (deskId: string): string => `gimbal/${deskId}/evm`;
export const solPath = (deskId: string): string => `gimbal/${deskId}/sol`;
export const DOMAIN_SECP256K1 = 0;
export const DOMAIN_ED25519 = 1;

/** From the two `derived_public_key` answers. Throws with what is wrong with an answer that is not a key. */
export function addressesFrom(evmKey: string, solKey: string): DerivedAddresses {
  return {
    evm_address: evmAddressOf(decodeSecp256k1(evmKey)),
    solana: solanaAccountsOf(decodeEd25519(solKey).address),
  };
}
