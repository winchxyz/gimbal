import { useMemo } from 'react';
import { dayMonth, pct } from '../windows/format.ts';
import { linear, rateExtent, stepByTime } from './scale.ts';
import { useWidth } from './useWidth.ts';

export interface RatePoint {
  t: number;
  netAprPct: number;
}

interface Props {
  /** What is drawn, for a reader who cannot see it: `SOL, net a year over 7 days`. */
  label: string;
  /** Hourly net a year, oldest first; null while it is being read. */
  points: readonly RatePoint[] | null;
  /** `error`: the read failed and there is nothing older to draw. */
  status: 'loading' | 'ready' | 'error';
  /** Another market over the same days, drawn behind in grey: the held one, when looking at another. */
  behind?: readonly RatePoint[] | null;
  /** The owner's minimum, as a dotted line. */
  minimum: number | null;
  /** The hours a pair was held are drawn in the state colour. `to` null: still held. */
  held?: { from: number; to: number | null } | null;
  onRetry?(): void;
}

const HOUR = 3_600_000;
const PAD_RIGHT = 46;
const PAD_BOTTOM = 22;
const PAD_TOP = 8;

/** The week as an instrument reads it: hourly net a year as a stepped line, zero and the minimum as reference lines. */
export function RateChart({ label, points, status, behind = null, minimum, held = null, onRetry }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = width > 0 && width < 560 ? 200 : 250;

  const drawing = useMemo(() => {
    if (points === null || points.length === 0 || width === 0) return null;
    const pw = width - PAD_RIGHT;
    const ph = height - PAD_BOTTOM;
    const t0 = points[0]!.t;
    const t1 = points[points.length - 1]!.t + HOUR;
    const values = [...points, ...(behind ?? [])].map((p) => p.netAprPct);
    const extent = rateExtent([...values, ...(minimum === null ? [] : [minimum])], 5, 20);
    const x = linear([t0, t1], [0, pw]);
    const y = linear([extent.lo, extent.hi], [ph, PAD_TOP]);
    const series = (list: readonly RatePoint[]) => list.map((p) => ({ t: p.t, v: p.netAprPct }));
    const days: { x: number; label: string }[] = [];
    for (let t = Math.ceil(t0 / (24 * HOUR)) * 24 * HOUR; t < t1; t += 24 * HOUR) days.push({ x: x(t), label: dayMonth(t) });
    return {
      pw, ph, extent, y,
      own: stepByTime(series(points), x, y),
      held: held === null ? '' : stepByTime(series(points), x, y, held.from, held.to ?? Infinity),
      behind: behind === null || behind.length === 0 ? '' : stepByTime(series(behind), x, y, t0, t1),
      days,
      every: days.length * 56 > pw ? 2 : 1,
    };
  }, [points, behind, minimum, held, width, height]);

  return (
    <div ref={ref}>
      {drawing ? (
        <svg className="ins" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}, now ${pct(points?.at(-1)?.netAprPct ?? 0)}`}>
          {drawing.extent.ticks.map((g) => (
            <g key={g}>
              <line x1={0} x2={drawing.pw} y1={drawing.y(g).toFixed(1)} y2={drawing.y(g).toFixed(1)} className={g === 0 ? 'gr' : 'gr soft'} />
              <text x={width} y={(drawing.y(g) + 4).toFixed(1)} textAnchor="end">{g}%</text>
            </g>
          ))}
          {minimum === null ? null : <line x1={0} x2={drawing.pw} y1={drawing.y(minimum).toFixed(1)} y2={drawing.y(minimum).toFixed(1)} className="min" />}
          {drawing.behind === '' ? null : <path d={drawing.behind} className="cl behind" />}
          <path d={drawing.own} className="cl" />
          {drawing.held === '' ? null : <path d={drawing.held} className="cl held" />}
          {drawing.days.map((d, i) => (
            <g key={d.label}>
              <line x1={d.x.toFixed(1)} x2={d.x.toFixed(1)} y1={drawing.ph} y2={drawing.ph + 5} className="tk1" />
              {i % drawing.every === 0 && d.x < drawing.pw - 34 ? <text x={(d.x + 5).toFixed(1)} y={height - 4}>{d.label}</text> : null}
            </g>
          ))}
        </svg>
      ) : status === 'error' ? (
        <div className="ins-msg" style={{ height }}>
          <span className="watch-t">Can’t load the 7 days.</span>
          <span className="g"> The figures beside it are current and the desk is unaffected.</span>
          {onRetry ? <button type="button" className="btn quiet" onClick={onRetry}>Try again</button> : null}
        </div>
      ) : (
        <div className="ins-wait" style={{ height }} aria-label={`Reading ${label}`} />
      )}
    </div>
  );
}
