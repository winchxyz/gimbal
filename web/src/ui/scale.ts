// Geometry of the instruments: scales, ticks and the labels that fit them. Pure, so the components only draw what
// these return and the rules are tested without a browser.

/** A straight scale: a value in `domain` to a pixel in `range`. */
export function linear(domain: readonly [number, number], range: readonly [number, number]): (value: number) => number {
  const span = domain[1] - domain[0] || 1;
  return (value) => range[0] + ((value - domain[0]) / span) * (range[1] - range[0]);
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const STEPS = [1, 2, 2.5, 5, 10] as const;

/** The smallest round step (1, 2, 2.5 or 5 times a power of ten) that splits `span` into at most `most` intervals. */
export function niceStep(span: number, most: number): number {
  if (!(span > 0) || most < 1) return 1;
  const raw = span / most;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const s of STEPS) if (s * pow >= raw - 1e-12) return s * pow;
  return 10 * pow;
}

/** Every multiple of `step` from `lo` to `hi`, both ends included when they are one. */
export function ticksOf(lo: number, hi: number, step: number): number[] {
  if (!(step > 0) || hi < lo) return [];
  const out: number[] = [];
  const first = Math.ceil(lo / step - 1e-9);
  const last = Math.floor(hi / step + 1e-9);
  for (let i = first; i <= last; i++) out.push(Number((i * step).toFixed(10)));
  return out;
}

export interface Extent {
  lo: number;
  hi: number;
  step: number;
  ticks: number[];
}

/**
 * A scale for a set of rates: from zero (or the lowest value under it) to the highest, on round steps, at most `most`
 * intervals. `floor` is the least the top reaches, so a row of small values does not fill the width with noise.
 */
export function rateExtent(values: readonly number[], most = 6, floor = 10): Extent {
  const lo0 = Math.min(0, ...values);
  const hi0 = Math.max(floor, ...values);
  const step = niceStep(hi0 - lo0, most);
  const lo = Math.floor(lo0 / step + 1e-9) * step;
  const hi = Math.ceil(hi0 / step - 1e-9) * step;
  return { lo, hi, step, ticks: ticksOf(lo, hi, step) };
}

/** The advance of one character of the mono face at a tick's size (11 px), for fitting a label without measuring it. */
export const TICK_CHAR = 6.7;

/** The index of the first text that fits `width` with `pad` to spare; the last one when none does. */
export function fitText(texts: readonly string[], width: number, pad = 44, char = TICK_CHAR): number {
  const at = texts.findIndex((t) => width > t.length * char + pad);
  return at < 0 ? texts.length - 1 : at;
}

export interface Corridor {
  /** The axis: the price move from now, in percent, at which the long (lo) and the short (hi) are liquidated. */
  lo: number;
  hi: number;
  longWatch: number;
  longRescue: number;
  shortWatch: number;
  shortRescue: number;
}

/**
 * How far the coin can move before anything happens to a pair, as a price move from now in percent. A leg's distance
 * is measured from the mark at that moment, so the watch and rescue lines sit where the leg would be `watch` and
 * `rescue` percent from its liquidation price, not that many points from the end of the axis.
 */
export function corridor(longDistPct: number, shortDistPct: number, risk: { watchDistancePct: number; rescueDistancePct: number }): Corridor {
  const dl = longDistPct / 100;
  const ds = shortDistPct / 100;
  const w = risk.watchDistancePct / 100;
  const r = risk.rescueDistancePct / 100;
  // A leg already inside a zone keeps the zone's edge at "now": the zone never runs past the needle.
  const down = (d: number) => Math.min(0, ((1 - dl) / (1 - d) - 1) * 100);
  const up = (d: number) => Math.max(0, ((1 + ds) / (1 + d) - 1) * 100);
  return { lo: -longDistPct, hi: shortDistPct, longWatch: down(w), longRescue: down(r), shortWatch: up(w), shortRescue: up(r) };
}

/** Hourly values squeezed into `n` buckets by their mean, so a column of the drawing has one value. */
export function bucketMeans(values: readonly number[], n: number): number[] {
  if (values.length <= n) return [...values];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * values.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * values.length) / n));
    let sum = 0;
    for (let j = a; j < b; j++) sum += values[j] ?? 0;
    out.push(sum / (b - a));
  }
  return out;
}

const HOUR_MS = 3_600_000;

/**
 * A stepped line through timed values as an SVG path: each value holds until the next one's time (the last for an
 * hour). `from` and `to` cut it to a span of time, for the part of a week a pair was held.
 */
export function stepByTime(
  points: readonly { t: number; v: number }[],
  x: (t: number) => number,
  y: (v: number) => number,
  from = -Infinity,
  to = Infinity,
): string {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const end = points[i + 1]?.t ?? p.t + HOUR_MS;
    if (end <= from || p.t >= to) continue;
    d += `${d === '' ? 'M' : 'L'}${x(Math.max(p.t, from)).toFixed(1)} ${y(p.v).toFixed(1)}H${x(Math.min(end, to)).toFixed(1)}`;
  }
  return d;
}

/** A stepped line through hourly values as an SVG path: each value holds for its hour. */
export function stepPath(values: readonly number[], x: (i: number) => number, y: (v: number) => number, from = 0, to = values.length): string {
  let d = '';
  for (let i = from; i < to; i++) d += `${i === from ? 'M' : 'L'}${x(i).toFixed(1)} ${y(values[i] ?? 0).toFixed(1)}H${x(i + 1).toFixed(1)}`;
  return d;
}
