// Number formatting for the Desk screen, next to the Windows helpers it builds on (../windows/format.ts).
// Pure, so it is tested. Negative numbers use the real minus sign (U+2212), as in design/screens/shared/data.js.
const MINUS = '−';

const grouped = (abs: number, decimals: number): string =>
  abs.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** `+$1.36`, `−$0.48`, `$0.00`: a money amount with its sign, for funding and P&L lines. Zero has no sign. */
export function signedUsd(value: number, decimals = 2): string {
  const text = grouped(Math.abs(value), decimals);
  if (Number(text.replace(/,/g, '')) === 0) return `$${text}`;
  return `${value < 0 ? MINUS : '+'}$${text}`;
}

/** `$999`, `.41`: the desk value is drawn in two sizes, cents at half size in --ink-2. */
export function splitUsd(value: number): { dollars: string; cents: string } {
  const text = grouped(Math.abs(value), 2);
  const at = text.lastIndexOf('.');
  return { dollars: `${value < 0 ? MINUS : ''}$${text.slice(0, at)}`, cents: text.slice(at) };
}

/**
 * A price to `sig` significant figures: `0.19861`, `61.214`, and cents from 1,000 up (`2,500.50`).
 * Small prices need their digits to tell an entry from a mark; big ones need grouping.
 */
export function price(value: number, sig = 5): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000) return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const decimals = Math.min(8, Math.max(0, sig - 1 - Math.floor(Math.log10(abs))));
  return value.toFixed(decimals);
}

/** `6,040`, `0.0215`: a size in base units, up to four decimals, no trailing zeros. */
export function qty(value: number): string {
  const text = Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 4 });
  return value < 0 && text !== '0' ? `${MINUS}${text}` : text;
}

/** `+120`, `−6`, `0`: a size with its sign, for the net exposure. */
export function signedQty(value: number): string {
  const text = qty(value);
  return value > 0 && text !== '0' ? `+${text}` : text;
}

/** `31%` from a margin ratio of 0.31 */
export const ratioPct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/** `2 s`, `3 min`: how long ago, without the word "ago" (for a label that already says "since"). */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}
