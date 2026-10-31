// Sizes for two-leg trades. Venue numbers (HL's szi strings, Orderly's floats) become exact quantities in 1e-8 base
// units (bigint), so lot math never meets float error; what goes to the contract is a canonical decimal string
// (interfaces 1.3: no sign, no leading zeros, no trailing zeros after the dot, at most 8 decimals).

/** Quantities are bigints in 1e-8 base units: the finest lot any venue the engine trades uses. */
export const QTY_DECIMALS = 8;
const SCALE = 10n ** BigInt(QTY_DECIMALS);

/** A venue number or decimal string as a quantity, rounded to the nearest 1e-8; throws on anything not finite. */
export function toQty(value: number | string): bigint {
  const text = typeof value === 'number' ? numberText(value) : value.trim();
  const m = /^([-+]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (m === null || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`not a decimal quantity: ${JSON.stringify(value)}`);
  const frac = (m[3] ?? '').padEnd(QTY_DECIMALS + 1, '0');
  let units = BigInt(m[2] || '0') * SCALE + BigInt(frac.slice(0, QTY_DECIMALS));
  if (Number(frac[QTY_DECIMALS]) >= 5) units += 1n;     // round half away from zero on the 9th decimal
  return m[1] === '-' && units !== 0n ? -units : units;
}

/** A float's exact-enough decimal text: toFixed keeps 12 decimals (venue floats carry at most ~10 significant). */
function numberText(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite quantity: ${n}`);
  return n.toFixed(12);
}

/** |q| as the canonical decimal string the contract takes ("0" for zero). */
export function qtyString(q: bigint): string {
  const a = q < 0n ? -q : q;
  const whole = a / SCALE;
  const frac = (a % SCALE).toString().padStart(QTY_DECIMALS, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

/** q with its sign, for logs and reports ("-0.0045"). */
export function signedQtyString(q: bigint): string {
  return q < 0n ? `-${qtyString(q)}` : qtyString(q);
}

export function qtyNumber(q: bigint): number {
  return Number(signedQtyString(q));
}

/** A lot given as a decimal string ("0.0001") or as a count of decimals (HL szDecimals 4). */
export function lotQty(lot: string | number): bigint {
  if (typeof lot === 'string' && /\.\d{8}\d*[1-9]/.test(lot)) throw new Error(`lot ${lot} is finer than 1e-8`);
  const q = typeof lot === 'number' ? 10n ** BigInt(QTY_DECIMALS - checkedDecimals(lot)) : toQty(lot);
  if (q <= 0n) throw new Error(`a lot must be positive, got ${String(lot)}`);
  return q;
}

function checkedDecimals(d: number): number {
  if (!Number.isInteger(d) || d < 0 || d > QTY_DECIMALS) throw new Error(`lot decimals must be 0..${QTY_DECIMALS}, got ${d}`);
  return d;
}

/** The coarsest lot both venues accept: the least common multiple, so a size on it is whole lots on each. */
export function commonLot(...lots: bigint[]): bigint {
  if (lots.length === 0) throw new Error('commonLot needs at least one lot');
  return lots.reduce((a, b) => (a / gcd(a, b)) * b);
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** |q| rounded down to whole lots (never up: a size the policy capped must stay under the cap). */
export function floorToLot(q: bigint, lot: bigint): bigint {
  const a = q < 0n ? -q : q;
  return a - (a % lot);
}

export function isWholeLots(q: bigint, lot: bigint): boolean {
  return q % lot === 0n;
}

export function abs(q: bigint): bigint {
  return q < 0n ? -q : q;
}
