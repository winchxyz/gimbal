// Number and date formatting for the Windows screen. Pure, so it is tested. Negative numbers use the real
// minus sign (U+2212), as in design/screens/shared/data.js, and every number is shown in en-US.

const MINUS = '−';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const group = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function fixed(value: number, decimals: number): string {
  // -0.04 rounds to "-0.0": show it as 0.0, never as a negative zero.
  const text = Math.abs(value).toFixed(decimals);
  return Number(text) === 0 ? text : (value < 0 ? MINUS : '') + text;
}

/** `8.6%`, `−2.4%` */
export const pct = (value: number, decimals = 1): string => `${fixed(value, decimals)}%`;

/** `+8.6%`, `−2.4%`, `0.0%`: a percentage with its sign. A value that rounds to zero has none. */
export function signedPct(value: number, decimals = 1): string {
  const text = fixed(value, decimals);
  return Number(text.replace(MINUS, '-')) > 0 ? `+${text}%` : `${text}%`;
}

/** `8.6`, `−2.4`: a percentage without the sign, for the small lines under a row */
export const plain = (value: number, decimals = 1): string => fixed(value, decimals);

/** `$0.28`, `−$0.07`, `$1,200.00` */
export function usd(value: number, decimals = 2): string {
  const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return Number(text.replace(/,/g, '')) === 0 || value >= 0 ? `$${text}` : `${MINUS}$${text}`;
}

/** `$1,200`: whole dollars, for leg sizes */
export const usdWhole = (value: number): string => `${value < 0 ? MINUS : ''}$${group.format(Math.abs(Math.round(value)))}`;

/** Depth on the thinner side: `$22k`, `$1.2M` */
export function depth(value: number): string {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${Math.round(value / 1e3)}k`;
  return `$${Math.round(value)}`;
}

/** Hours until the entry costs are earned back: `23 h`, `3 d 2 h` */
export function hours(value: number): string {
  const h = Math.max(0, Math.round(value));
  if (h < 48) return `${h} h`;
  const rest = h % 24;
  return rest === 0 ? `${Math.floor(h / 24)} d` : `${Math.floor(h / 24)} d ${rest} h`;
}

/** `2 d 14 h`, `6 h`, `35 min`: how long something has been going on */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h} h`;
  const rest = h % 24;
  return rest === 0 ? `${Math.floor(h / 24)} d` : `${Math.floor(h / 24)} d ${rest} h`;
}

const two = (n: number) => String(n).padStart(2, '0');

// Dates are UTC: the engine's hourly points are on UTC hours, and a test must not depend on the machine's zone.

/** `20 Oct` */
export function dayMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** `24 Oct 23:41` */
export function dayMonthTime(ms: number): string {
  const d = new Date(ms);
  return `${dayMonth(ms)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** `Phoenix`, `dYdX`: the name a venue id is shown under */
const SPECIAL_NAMES: Record<string, string> = {
  hyperliquid: 'Hyperliquid',
  phoenix: 'Phoenix',
  orderly: 'Orderly',
  dydx: 'dYdX',
  gmx: 'GMX',
  okx: 'OKX',
  mexc: 'MEXC',
  'trade.xyz': 'trade.xyz',
};

export function venueName(id: string): string {
  const known = SPECIAL_NAMES[id.toLowerCase()];
  if (known) return known;
  return id.length === 0 ? id : id.charAt(0).toUpperCase() + id.slice(1);
}

/** `A, B and C` */
export function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** `no price` becomes `No price`. */
export const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** One sentence from a reason that may or may not end in a full stop. */
export function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
