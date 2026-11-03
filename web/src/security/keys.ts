// What the keys on the owner's NEAR account may call, read from the chain, and what no function-call key can.
// Pure, so it is tested; the chain read is `Chain.accessKeys` (onboarding/chain.ts).
import { OPERATOR_GROUPS, OPERATOR_METHODS, type AccessKeyInfo } from '../onboarding/operator.ts';

export interface KeyGroup {
  label: string;
  what: string;
  methods: string[];
}

export interface OperatorKey {
  publicKey: string;
  /** NEAR the key may still spend on gas, rounded down; null when the key has no allowance limit. */
  allowance: string | null;
  /** The methods the key lists, in the chain's order. */
  methods: string[];
  /** The key lists no methods, which NEAR reads as "every method of the contract". */
  noMethodList: boolean;
  /** The operator methods this key holds, grouped as the owner reads them. */
  groups: KeyGroup[];
  /** Listed methods that are not on the operator list. The contract still refuses an owner method (it needs 1 yoctoNEAR). */
  extra: string[];
}

export interface KeyReading {
  /** FunctionCall keys whose receiver is the gimbal contract. */
  keys: OperatorKey[];
  /** Full-access keys on the account: the owner's wallets, which can call everything. */
  fullAccess: number;
}

/** yoctoNEAR as NEAR, rounded down so a remaining allowance is never overstated: 4999700000000000000000000 → `4.9997`. */
export function allowanceText(yocto: string): string | null {
  if (!/^\d+$/.test(yocto)) return null;
  const value = BigInt(yocto);
  const unit = 10n ** 20n;
  const down = value / unit;
  const whole = down / 10_000n;
  const frac = (down % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

const isOperatorMethod = (name: string): boolean => (OPERATOR_METHODS as readonly string[]).includes(name);

/** Keeps the keys that can call this contract and says what each may do. */
export function readKeys(keys: readonly AccessKeyInfo[], contractId: string): KeyReading {
  const out: OperatorKey[] = [];
  let fullAccess = 0;
  for (const key of keys) {
    if (key.permission === 'FullAccess') {
      fullAccess += 1;
      continue;
    }
    const { receiverId, methodNames, allowance } = key.permission;
    if (receiverId !== contractId) continue;
    out.push({
      publicKey: key.publicKey,
      allowance: allowance === null ? null : allowanceText(allowance),
      methods: [...methodNames],
      noMethodList: methodNames.length === 0,
      groups: OPERATOR_GROUPS.map((g) => ({ label: g.label, what: g.what, methods: g.methods.filter((m) => methodNames.includes(m)) })).filter((g) => g.methods.length > 0),
      extra: methodNames.filter((m) => !isOperatorMethod(m)),
    });
  }
  return { keys: out, fullAccess };
}

export interface OwnerMethod {
  method: string;
  /** What the call does, in plain words. */
  what: string;
}

/**
 * The methods only the desk's owner may call: the rows of docs/interfaces.md §1.3 with a ✓ under Owner and nothing
 * under Operator. A test reads the table and compares, so this list cannot drift from the contract's own rules.
 * `set_paused` is the table's "pause only" row: the operator may pause, only the owner may resume (below).
 */
export const OWNER_ONLY: readonly OwnerMethod[] = [
  { method: 'withdraw_to_owner', what: 'pay USDC out to you' },
  { method: 'clear_payout_lock', what: 'free a payout that has been stuck for over an hour' },
  { method: 'set_policy', what: 'change the policy' },
  { method: 'set_operator', what: 'replace the operator' },
  { method: 'set_orderly_receiver', what: 'pin the Orderly deposit address' },
  { method: 'set_orderly_ips', what: 'set where the Orderly key may be used from' },
  { method: 'create_desk', what: 'create a desk' },
  { method: 'set_phoenix_accounts', what: 'replace the Phoenix and Ember accounts the desk uses' },
  { method: 'accept_oneclick_key', what: 'accept the treasury’s second 1Click key for the desk (it signs quotes a day later)' },
  { method: 'distrust_pinned_oneclick_key', what: 'stop 1Click’s pinned key from signing the desk’s quotes, for good' },
];

/** The one call of the operator's own method that it cannot make: resuming. Pausing needs no deposit, resuming needs 1 yoctoNEAR. */
export const RESUME: OwnerMethod = { method: 'set_paused', what: 'resume a paused desk (it may only pause one)' };

/**
 * Rows of §1.3 that no desk owner calls: a deposit hook, the contract owner's mock price, the oracle's callback, the
 * treasury's 1Click key proposal.
 */
export const OTHER_CALLERS: readonly string[] = ['ft_on_transfer', 'set_mock_price', 'oracle_on_call', 'propose_oneclick_key'];
