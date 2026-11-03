// The settings `npm run mcp` and `npm run attack` share: one desk on one contract, and the operator key file that
// signs for it. The key file is the JSON tools/testnet/operator-key.mjs writes (account_id, public_key,
// private_key); its private key goes into the NEAR transport and is never printed.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NearNetwork } from '../contract/near-client.ts';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface DeskEnv {
  network: NearNetwork;
  contractId: string;
  deskId: string;
  rpcUrl: string | undefined;
  /** The operator key file, absolute. */
  keyFile: string;
  keyExists: boolean;
}

export const defaultKeyFile = (contractId: string) => join(REPO_ROOT, '.keys', `operator-${contractId}.json`);

/**
 * NEAR_NETWORK (default testnet), GIMBAL_CONTRACT_ID, DESK_ID, OPERATOR_KEY_FILE (default
 * .keys/operator-<contract>.json at the repo root), NEAR_RPC_URL. Errors name variables, never values.
 */
export function deskEnv(env: (name: string) => string | undefined, overrides: Partial<Record<'network' | 'contract' | 'desk' | 'keyFile', string>> = {}): DeskEnv {
  const network = overrides.network ?? env('NEAR_NETWORK') ?? 'testnet';
  if (network !== 'testnet' && network !== 'mainnet') throw new Error(`NEAR_NETWORK must be testnet or mainnet, got ${network}`);
  const contractId = overrides.contract ?? env('GIMBAL_CONTRACT_ID');
  const deskId = overrides.desk ?? env('DESK_ID');
  const missing = [contractId === undefined ? 'GIMBAL_CONTRACT_ID (--contract)' : null, deskId === undefined ? 'DESK_ID (--desk)' : null].filter((m) => m !== null);
  if (missing.length > 0) throw new Error(`name the desk: ${missing.join(', ')}`);
  const suffix = /\.(near|testnet)$/.exec(contractId!)?.[1];
  if (suffix !== undefined && (suffix === 'near' ? 'mainnet' : 'testnet') !== network) {
    throw new Error(`${contractId} is a ${suffix === 'near' ? 'mainnet' : 'testnet'} account, but NEAR_NETWORK is ${network}`);
  }
  const keyFile = resolve(overrides.keyFile ?? env('OPERATOR_KEY_FILE') ?? defaultKeyFile(contractId!));
  return { network, contractId: contractId!, deskId: deskId!, rpcUrl: env('NEAR_RPC_URL'), keyFile, keyExists: existsSync(keyFile) };
}

/** The account and private key of an operator key file. The error never quotes the file's content. */
export function loadOperatorKey(file: string): { accountId: string; privateKey: string; publicKey: string | null } {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: not a readable JSON key file (${(e as { code?: string }).code ?? 'not JSON'})`);
  }
  const o = (json ?? {}) as Record<string, unknown>;
  const secret = o.private_key ?? o.secret_key;
  if (typeof o.account_id !== 'string' || o.account_id === '') throw new Error(`${file}: no account_id`);
  if (typeof secret !== 'string' || !secret.startsWith('ed25519:')) throw new Error(`${file}: no ed25519 private_key`);
  return { accountId: o.account_id, privateKey: secret, publicKey: typeof o.public_key === 'string' ? o.public_key : null };
}

/** process.env with blank values read as unset. */
export const processEnv = (name: string): string | undefined => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};
