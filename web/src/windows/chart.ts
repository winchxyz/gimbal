// Geometry of the 7-day chart and of the row sparklines. Pure: the components only draw what these return.
import type { WindowHistory } from '@gimbal/shared';
import { dayMonth } from './format.ts';

export interface Scale {
  min: number;
  max: number;
  step: number;
  /** Grid lines and their labels, bottom to top. */
  ticks: number[];
}

const STEPS = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

/** The grid always reaches this far up (design/HANDOFF.md: labels at 0, 5, 10, 15, 20%). */
const FLOOR_TOP = 20;

/**
 * Grid for the values and the owner's minimum: 0, 5, 10, 15, 20 for a typical window, wider when a window
 * is higher, and below zero when its net is negative. At most five intervals.
 */
export function niceScale(values: readonly number[], minimum: number | null): Scale {
  const all = [...values, ...(minimum === null ? [] : [minimum]), 0, FLOOR_TOP];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const step = STEPS.find((s) => Math.ceil(hi / s) - Math.floor(lo / s) <= 5) ?? STEPS[STEPS.length - 1] ?? 5000;
  const min = Math.floor(lo / step) * step;
  let max = Math.ceil(hi / step) * step;
  if (max - min < 2 * step) max = min + 2 * step; // never a single interval
  const ticks: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) ticks.push(v);
  return { min, max, step, ticks };
}

export interface Axes {
  width: number;
  height: number;
  /** Right edge of the plot; the tick labels sit in the gutter to its right. */
  plotRight: number;
  x(t: number): number;
  y(v: number): number;
  grid: { value: number; y: number }[];
  /** y of the owner's minimum, or null when it is not known */
  minimumY: number | null;
}

export interface AxesInput {
  width: number;
  height: number;
  domain: readonly [number, number];
  scale: Scale;
  minimum: number | null;
  gutter?: number;   // width kept free on the right for tick labels
  top?: number;
  bottom?: number;   // room for the date labels
}

export function axes(input: AxesInput): Axes {
  const { width, height, domain, scale, minimum } = input;
  const plotRight = width - (input.gutter ?? 48);
  const top = input.top ?? 8;
  const plotHeight = height - top - (input.bottom ?? 20);
  const span = domain[1] - domain[0] || 1;
  const y = (v: number) => top + ((scale.max - v) / (scale.max - scale.min)) * plotHeight;
  return {
    width,
    height,
    plotRight,
    x: (t) => ((t - domain[0]) / span) * plotRight,
    y,
    grid: scale.ticks.map((value) => ({ value, y: y(value) })),
    minimumY: minimum === null ? null : y(minimum),
  };
}

/** `x,y x,y …` for an SVG polyline, one decimal like the mockup. */
export function polyline(points: readonly { t: number; netAprPct: number }[], ax: Axes): string {
  return points.map((p) => `${ax.x(p.t).toFixed(1)},${ax.y(p.netAprPct).toFixed(1)}`).join(' ');
}

/** The time range both series are drawn on: the oldest first point to the newest last point. */
export function domainOf(...histories: readonly (WindowHistory | null | undefined)[]): [number, number] | null {
  const ts = histories.flatMap((h) => (h ? h.points.map((p) => p.t) : []));
  return ts.length === 0 ? null : [Math.min(...ts), Math.max(...ts)];
}

/** The three date labels under the chart: the start, the middle and `now`. */
export function dateLabels(domain: readonly [number, number]): [string, string, string] {
  return [dayMonth(domain[0]), dayMonth((domain[0] + domain[1]) / 2), 'now'];
}

/**
 * A row's sparkline: the net APR over the week, scaled to its own range, in a w × h box with `pad` around.
 * The hourly points are averaged into at most `buckets` so the line reads as a shape at 88 px.
 */
export function sparkline(
  points: readonly { netAprPct: number }[],
  w: number,
  h: number,
  pad = 2,
  buckets = 28,
): string {
  if (points.length === 0) return '';
  const values = bucketMeans(points.map((p) => p.netAprPct), buckets);
  const lo = Math.min(...values);
  const range = Math.max(...values) - lo || 1;
  const last = Math.max(values.length - 1, 1);
  return values
    .map((v, i) => `${(pad + (i * (w - 2 * pad)) / last).toFixed(1)},${(h - pad - ((v - lo) / range) * (h - 2 * pad)).toFixed(1)}`)
    .join(' ');
}

function bucketMeans(values: readonly number[], buckets: number): number[] {
  if (values.length <= buckets) return [...values];
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * values.length) / buckets);
    const to = Math.floor(((b + 1) * values.length) / buckets);
    const slice = values.slice(from, Math.max(to, from + 1));
    out.push(slice.reduce((s, v) => s + v, 0) / slice.length);
  }
  // Averaging flattens the newest hour; keep the real last value so the line ends where the number is.
  out[out.length - 1] = values[values.length - 1] ?? 0;
  return out;
}
