// Decimal strings the contract reads (docs/interfaces.md §1.3): canonical means no sign, no leading zeros, no
// trailing zeros after the dot and at most 8 decimals. All arithmetic is BigInt, so no float ever decides a cap.

const E8 = 10n ** 8n;
const E12 = 10n ** 12n;

/** The largest integer JavaScript reads exactly; every u64 in the policy is at most this (§1.2). */
export const MAX_SAFE = 2n ** 53n - 1n;

/** `12.5` → 1250000000n (1e-8 units). Returns null for anything that is not digits with up to 8 decimals. */
export function parseE8(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]!) * E8 + BigInt((m[2] ?? '').padEnd(8, '0'));
}

/** 1e-8 units as the canonical decimal string: 1250000000n → "12.5", 0n → "0". */
export function formatE8(units: bigint): string {
  const whole = units / E8;
  const frac = (units % E8).toString().padStart(8, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

/** Whether `text` is a canonical decimal the contract accepts: "0", "12", "0.5", "16260.1626"; not "012", "1.50", "1.". */
export function isCanonical(text: string): boolean {
  if (!/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(text)) return false;
  return !text.includes('.') || !text.endsWith('0');
}

/** A positive price or amount typed by a person or sent by a venue, as 1e-12 units; null when it is not a plain positive number. */
function parseE12(value: number | string): bigint | null {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(12) : '') : value.trim();
  const m = /^(\d+)(?:\.(\d{1,12})\d*)?$/.exec(text);
  if (!m) return null;
  return BigInt(m[1]!) * E12 + BigInt((m[2] ?? '').padEnd(12, '0'));
}

/**
 * The size cap, in base units, that a USD cap buys at a mark: floor(usd / mark) to 8 decimals, canonical. It rounds
 * down so the size cap never exceeds the dollar cap; null when either input is not a positive number or the
 * answer would be zero or over the policy's integer limit (§1.2, "Unpriced assets").
 */
export function maxSzForUsd(usd: number | string, mark: number | string): string | null {
  const usdE8 = parseE8(typeof usd === 'number' ? (Number.isFinite(usd) ? usd.toFixed(8) : '') : usd);
  const markE12 = parseE12(mark);
  if (usdE8 === null || markE12 === null || usdE8 === 0n || markE12 === 0n) return null;
  // (usd / mark) in 1e-8 units: usdE8 / 1e8 / (markE12 / 1e12) * 1e8 = usdE8 * 1e12 / markE12
  const units = (usdE8 * E12) / markE12;
  if (units === 0n || units > MAX_SAFE * E8) return null;
  return formatE8(units);
}

/** What a size cap is worth at a mark, in USD to the cent, rounded down; null when the inputs do not parse. */
export function usdForSz(maxSz: string, mark: number | string): number | null {
  const sz = parseE8(maxSz);
  const markE12 = parseE12(mark);
  if (sz === null || markE12 === null) return null;
  // sz(1e-8) * mark(1e-12) = usd in 1e-20; cents = usd * 100 → / 1e18
  const cents = (sz * markE12) / 10n ** 18n;
  return Number(cents) / 100;
}
