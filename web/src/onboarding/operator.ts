// The operator key (docs/interfaces.md §1.3): a FunctionCall key on the owner's account that may call only the
// operator methods of the gimbal contract. It cannot attach a deposit, so the owner methods are out of its reach.
import { nearToYocto } from './near.ts';
import type { WalletAction } from './wallet.ts';

/**
 * Every method with a mark in the Operator column of §1.3, in the table's order: the 18 with a ✓ and `set_paused`
 * ("pause only": the engine pauses; unpausing needs 1 yoctoNEAR, which this key cannot attach). A test reads the table
 * and compares, so the list cannot drift from the contract's own rules.
 */
export const OPERATOR_METHODS = [
  'set_paused',
  'fund_venue',
  'hl_approve_builder_fee',
  'hl_set_referrer',
  'refresh_prices',
  'hl_order',
  'hl_cancel',
  'hl_usd_class_transfer',
  'hl_send_to_intents',
  'sol_sign',
  'sol_sign_register',
  'sol_sign_rescue',
  'orderly_register',
  'orderly_add_key',
  'orderly_request',
  'orderly_ws_auth',
  'orderly_settle_pnl',
  'orderly_withdraw',
  'evm_usdc_to_intents',
] as const;

/** The allowlist as the owner reads it: what each group of methods is for, in plain words. */
export const OPERATOR_GROUPS: readonly { label: string; what: string; methods: readonly string[] }[] = [
  { label: 'Hyperliquid', what: 'place and cancel orders, set up the account', methods: ['hl_order', 'hl_cancel', 'hl_usd_class_transfer', 'hl_approve_builder_fee', 'hl_set_referrer'] },
  { label: 'Phoenix and Solana', what: 'sign the desk’s Solana transactions', methods: ['sol_sign', 'sol_sign_register', 'sol_sign_rescue'] },
  {
    label: 'Orderly',
    what: 'register the desk, trade, settle and withdraw to the desk’s own address',
    methods: ['orderly_register', 'orderly_add_key', 'orderly_request', 'orderly_ws_auth', 'orderly_settle_pnl', 'orderly_withdraw'],
  },
  { label: 'Moving margin', what: 'send margin between exchanges through NEAR Intents', methods: ['fund_venue', 'hl_send_to_intents', 'evm_usdc_to_intents'] },
  { label: 'Housekeeping', what: 'refresh prices, pause the desk', methods: ['refresh_prices', 'set_paused'] },
];

/** The allowance the key gets unless the page is configured otherwise (docs/interfaces.md §1.3). */
export const DEFAULT_ALLOWANCE_NEAR = '5';

/** An `ed25519:<base58>` public key of 32 bytes' length; the check is on shape, the wallet and the chain check the rest. */
export function isPublicKey(text: string): boolean {
  return /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(text);
}

/** The AddKey action: receiver = the gimbal contract, method names = the operator methods, allowance in yoctoNEAR. */
export function addOperatorKeyAction(publicKey: string, contractId: string, allowanceNear: string): WalletAction {
  const allowance = nearToYocto(allowanceNear);
  if (!isPublicKey(publicKey)) throw new Error('the engine key is not an ed25519:<base58> public key');
  if (allowance === null) throw new Error('the allowance is not a number of NEAR');
  return {
    type: 'AddKey',
    params: {
      publicKey,
      accessKey: { permission: { receiverId: contractId, allowance: allowance.toString(), methodNames: [...OPERATOR_METHODS] } },
    },
  };
}

/** Whether an account's access key list holds this key with exactly the operator methods on this contract. */
export interface AccessKeyInfo {
  publicKey: string;
  /** "FullAccess", or the function-call permission. */
  permission: 'FullAccess' | { receiverId: string; methodNames: string[]; allowance: string | null };
}

export function hasOperatorKey(keys: readonly AccessKeyInfo[], publicKey: string, contractId: string): boolean {
  const key = keys.find((k) => k.publicKey === publicKey);
  if (!key || key.permission === 'FullAccess') return false;
  const { receiverId, methodNames } = key.permission;
  return receiverId === contractId && methodNames.length === OPERATOR_METHODS.length && OPERATOR_METHODS.every((m) => methodNames.includes(m));
}
