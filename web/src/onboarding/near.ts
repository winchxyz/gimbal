// NEAR amounts. Everything is a BigInt string in yoctoNEAR (10^-24 NEAR), so no float rounds a deposit or an allowance.

export const YOCTO = 10n ** 24n;
/** A gas amount as the wallet wants it: gas units as a string. */
export const tgas = (n: number): string => (BigInt(n) * 10n ** 12n).toString();

/** `5` or `0.003` NEAR as yoctoNEAR; null when it is not a plain positive number with up to 24 decimals. */
export function nearToYocto(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(text.trim());
  if (!m) return null;
  const yocto = BigInt(m[1]!) * YOCTO + BigInt((m[2] ?? '').padEnd(24, '0'));
  return yocto > 0n ? yocto : null;
}

/** yoctoNEAR as NEAR with at most `decimals` decimals, rounded up so a cost is never understated: "0.003". */
export function formatNear(yocto: bigint, decimals = 3): string {
  const unit = 10n ** BigInt(24 - decimals);
  const up = (yocto + unit - 1n) / unit;
  const whole = up / 10n ** BigInt(decimals);
  const frac = (up % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

/** What the contract holds for a byte of storage (the protocol's price, 1e19 yocto per byte). */
export const STORAGE_BYTE_COST = 10n ** 19n;

/**
 * An upper bound for a storage deposit: a byte of storage for every byte of the JSON the call carries, plus
 * `extraBytes` for what the call stores that is not in its arguments (`create_desk` stores a desk's counters and index
 * entries too: see desk-actions.ts). The contract keeps only the storage it uses and refunds the rest
 * (docs/interfaces.md §1.3), so over-paying costs nothing but a moment's lock; paying less is `E_DEPOSIT`.
 */
export function storageDeposit(argsJson: string, extraBytes = 0): bigint {
  return STORAGE_BYTE_COST * BigInt(new TextEncoder().encode(argsJson).length + extraBytes);
}
