// The Desk's measurements, drawn at their real pixel size: the held pair's room on the price axis, the cool-down as a
// length of time, the opening cost on a ruler, and the open markets on one scale against the owner's minimum.
import { VENUE_NAMES } from '../shell/status.ts';
import { Dim } from '../ui/Dim.tsx';
import { linear, niceStep } from '../ui/scale.ts';
import { useWidth } from '../ui/useWidth.ts';
import { pct } from '../windows/format.ts';
import { price } from './format.ts';
import { hhmm, spanText, type CoolDown, type MarketsPlot } from './flat.ts';
import type { Room } from './room.ts';

const HEIGHT = 176;
const Y_DIM = 78;
const Y_BEAM = 128;
const Y_TICK = Y_BEAM + 16;
const MINUS = '−';

const f = (n: number): string => n.toFixed(1);
const whole = (n: number): string => `${Math.floor(n)}%`;

interface CorridorProps {
  room: Room;
  /** The needle's state colour; null stays neutral (the rules are not read, or a venue is silent). */
  tone: string | null;
  /** Whether the owner's watch and rescue lines are known, so the zones have a length. */
  zones: boolean;
  label: string;
}

/** The pair's room: the price axis from one liquidation to the other, the legs as two spans, the price now on it. */
export function Corridor({ room, tone, zones, label }: CorridorProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  if (width === 0) return <div ref={ref} style={{ height: HEIGHT }} />;

  const k = room.corridor;
  const narrow = width < 640;
  const x = linear([k.lo, k.hi], [0.5, width - 0.5]);
  const x0 = x(0);
  const major = niceStep(k.hi - k.lo, narrow ? 4 : 12);
  const minor = major / 10;
  const ticks: { v: number; rank: 1 | 2 | 3 }[] = [];
  for (let i = Math.ceil(k.lo / minor); i <= Math.floor(k.hi / minor); i++) {
    const rank = i % 10 === 0 ? 1 : i % 5 === 0 ? 2 : 3;
    if (narrow && rank === 3) continue;
    ticks.push({ v: i * minor, rank });
  }
  const tickText = (v: number): string => (v === 0 ? '0' : `${v > 0 ? '+' : MINUS}${Number(Math.abs(v).toFixed(1))}%`);

  const words = (leg: Room['long'], name: string): string[] => [
    `${name} · ${legVenue(leg)} · ${whole(leg.distanceToLiqPct)} from liquidation`,
    `${name} · ${legVenue(leg)} · ${whole(leg.distanceToLiqPct)}`,
    `${name} ${whole(leg.distanceToLiqPct)}`,
  ];
  const longWords = words(room.long, 'long');
  const shortWords = words(room.short, 'short');
  const zone = (a: number, b: number, cls: string) => (Math.abs(x(b) - x(a)) < 0.5 ? null : <line x1={f(x(a))} x2={f(x(b))} y1={Y_BEAM} y2={Y_BEAM} className={cls} />);
  const mid = clampText(x0, width, narrow ? 40 : 60);

  return (
    <div ref={ref}>
      <svg className="ins" width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={label}>
        <text x={0} y={13} className="tl">Long liquidates</text>
        <text x={0} y={32} className="tv">{price(room.long.liqPx)}</text>
        <text x={width} y={13} textAnchor="end" className="tl">Short liquidates</text>
        <text x={width} y={32} textAnchor="end" className="tv">{price(room.short.liqPx)}</text>
        {narrow ? (
          <text x={f(mid)} y={54} textAnchor="middle" className="tv">{price(room.mark)}</text>
        ) : (
          <>
            <text x={f(mid)} y={13} textAnchor="middle" className="tl">{room.symbol} now</text>
            <text x={f(mid)} y={32} textAnchor="middle" className="tv">{price(room.mark)}</text>
          </>
        )}
        <line x1={f(x0)} x2={f(x0)} y1={narrow ? 62 : 42} y2={Y_TICK + 11} className={`needle ${tone ?? ''}`} />
        <Dim x1={x(k.lo)} x2={x0 - 9} y={Y_DIM} labels={longWords} />
        <Dim x1={x0 + 9} x2={x(k.hi)} y={Y_DIM} labels={shortWords} />
        <line x1={0.5} x2={width - 0.5} y1={Y_BEAM} y2={Y_BEAM} className="beam" />
        <line x1={0.5} x2={0.5} y1={Y_BEAM - 14} y2={Y_BEAM + 14} className="beam" />
        <line x1={width - 0.5} x2={width - 0.5} y1={Y_BEAM - 14} y2={Y_BEAM + 14} className="beam" />
        {zones ? (
          <>
            {zone(k.lo, k.longRescue, 'zr')}
            {zone(k.longRescue, k.longWatch, 'zw')}
            {zone(k.shortWatch, k.shortRescue, 'zw')}
            {zone(k.shortRescue, k.hi, 'zr')}
            <text x={8} y={Y_BEAM - 10} className="zr">rescue</text>
            <text x={54} y={Y_BEAM - 10} className="zw">watched</text>
            <text x={width - 8} y={Y_BEAM - 10} textAnchor="end" className="zr">rescue</text>
            <text x={width - 54} y={Y_BEAM - 10} textAnchor="end" className="zw">watched</text>
          </>
        ) : null}
        <circle cx={f(x0)} cy={Y_BEAM} r={3.5} className={`dot ${tone ?? ''}`} />
        {ticks.map(({ v, rank }) => (
          <g key={v}>
            <line x1={f(x(v))} x2={f(x(v))} y1={Y_TICK} y2={Y_TICK + (rank === 1 ? 11 : rank === 2 ? 7 : 4)} className={`tk${rank}`} />
            {rank === 1 && x(v) > 24 && x(v) < width - 24 ? <text x={f(x(v))} y={Y_TICK + 27} textAnchor="middle">{tickText(v)}</text> : null}
          </g>
        ))}
      </svg>
    </div>
  );
}

const legVenue = (leg: Room['long']): string => VENUE_NAMES[leg.venue];
/** Keeps a centred label clear of the two labels at the frame's ends. */
const clampText = (at: number, width: number, half: number): number => Math.min(width - 130 - half, Math.max(130 + half, at));

interface CoolDownLineProps {
  cool: CoolDown;
  now: number;
}

/** Nothing held: the cool-down as a length of time, with now on it. */
export function CoolDownLine({ cool, now }: CoolDownLineProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  if (width === 0) return <div ref={ref} style={{ height: HEIGHT }} />;

  const narrow = width < 640;
  const x = linear([cool.exitAt, cool.until], [0.5, width - 0.5]);
  const at = Math.min(cool.until, Math.max(cool.exitAt, now));
  const xn = x(at);
  const STEP = 600_000;
  const ticks: { t: number; rank: 1 | 2 | 3 }[] = [];
  for (let t = Math.ceil(cool.exitAt / STEP) * STEP; t <= cool.until; t += STEP) {
    const min = new Date(t).getUTCMinutes();
    const rank = min === 0 ? 1 : min === 30 ? 2 : 3;
    if (narrow && rank === 3) continue;
    ticks.push({ t, rank });
  }
  const since = spanText(at - cool.exitAt);
  const left = spanText(cool.until - at);
  const mid = clampText(xn, width, 30);

  return (
    <div ref={ref}>
      <svg className="ins" width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={`The cool-down after the last exit: ${left} left`}>
        <text x={0} y={13} className="tl">Last pair closed</text>
        <text x={0} y={32} className="tv">{cool.exact ? '' : 'about '}{hhmm(cool.exitAt)} UTC</text>
        <text x={width} y={13} textAnchor="end" className="tl">Entry possible from</text>
        <text x={width} y={32} textAnchor="end" className="tv">{hhmm(cool.until)} UTC</text>
        {narrow ? (
          <text x={f(mid)} y={54} textAnchor="middle" className="tv">{hhmm(at)}</text>
        ) : (
          <>
            <text x={f(mid)} y={13} textAnchor="middle" className="tl">Now</text>
            <text x={f(mid)} y={32} textAnchor="middle" className="tv">{hhmm(at)} UTC</text>
          </>
        )}
        <line x1={f(xn)} x2={f(xn)} y1={narrow ? 62 : 42} y2={Y_TICK + 11} className="needle" />
        <Dim x1={0.5} x2={xn - 9} y={Y_DIM} labels={[`${since} since the exit`, since]} />
        <Dim x1={xn + 9} x2={width - 0.5} y={Y_DIM} labels={[`${left} of cool-down left`, `${left} left`, left]} />
        <line x1={0.5} x2={width - 0.5} y1={Y_BEAM} y2={Y_BEAM} className="rail" />
        <line x1={0.5} x2={f(xn)} y1={Y_BEAM} y2={Y_BEAM} className="done" />
        <line x1={0.5} x2={0.5} y1={Y_BEAM - 14} y2={Y_BEAM + 14} className="beam" />
        <line x1={width - 0.5} x2={width - 0.5} y1={Y_BEAM - 14} y2={Y_BEAM + 14} className="beam" />
        <circle cx={f(xn)} cy={Y_BEAM} r={3.5} className="dot" />
        {ticks.map(({ t, rank }) => (
          <g key={t}>
            <line x1={f(x(t))} x2={f(x(t))} y1={Y_TICK} y2={Y_TICK + (rank === 1 ? 11 : rank === 2 ? 7 : 4)} className={`tk${rank}`} />
            {rank === 1 && x(t) > 30 && x(t) < width - 30 ? <text x={f(x(t))} y={Y_TICK + 27} textAnchor="middle">{hhmm(t)}</text> : null}
          </g>
        ))}
      </svg>
    </div>
  );
}

/** How much of the opening cost funding has paid back, on a ruler from 0 to 100%. */
export function PaybackRuler({ pct: done }: { pct: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  if (width === 0) return <div ref={ref} style={{ height: 48 }} />;
  const x = linear([0, 100], [0.5, width - 0.5]);
  const marks = Array.from({ length: 21 }, (_, i) => i * 5);
  return (
    <div ref={ref}>
      <svg className="ins" width={width} height={48} viewBox={`0 0 ${width} 48`} role="img" aria-label={`${done}% of the opening cost earned back`}>
        <line x1={0.5} x2={width - 0.5} y1={8} y2={8} className="rail" />
        <line x1={0.5} x2={f(x(done))} y1={8} y2={8} className="done" />
        <line x1={f(x(done))} x2={f(x(done))} y1={1} y2={15} className="beam" />
        {marks.map((v) => {
          const major = v % 25 === 0;
          return (
            <g key={v}>
              <line x1={f(x(v))} x2={f(x(v))} y1={18} y2={major ? 29 : v % 10 === 0 ? 25 : 22} className={major ? 'tk1' : 'tk2'} />
              {major ? <text x={f(x(v))} y={44} textAnchor={v === 0 ? 'start' : v === 100 ? 'end' : 'middle'}>{v}%</text> : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface MarketsDotsProps {
  plot: MarketsPlot;
  minimum: number | null;
}

/** The markets open to the desk on one scale, the owner's minimum as a line through all of them. A row opens its pair. */
export function MarketsDots({ plot, minimum }: MarketsDotsProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const rows = plot.rows;
  const narrow = width < 520;
  const rowH = narrow ? 46 : 38;
  const top = 30;
  const bottom = top + rows.length * rowH;
  const height = bottom + (minimum === null ? 8 : 28);
  if (width === 0) return <div ref={ref} style={{ height }} />;

  const labW = narrow ? 138 : 238;
  const valW = 62;
  const nets = rows.map((r) => r.netAprPct);
  const step = niceStep(Math.max(30, ...nets) - Math.min(0, ...nets), narrow ? 3 : 6);
  const lo = Math.min(0, Math.floor(Math.min(...nets) / step) * step);
  const hi = Math.max(step, Math.ceil(Math.max(30, ...nets) / step) * step);
  const x = linear([lo, hi], [labW, width - valW]);
  const grid: number[] = [];
  for (let g = lo; g <= hi + 1e-9; g += step) grid.push(Number(g.toFixed(6)));
  const xm = minimum === null ? null : x(minimum);
  const minWords = minimum === null ? '' : `your ${Number(minimum.toFixed(1))}% minimum`;

  return (
    <div ref={ref}>
      <svg className="ins" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Net rate a year of the markets open to the desk">
        {grid.map((g) => (
          <g key={g}>
            <line x1={f(x(g))} x2={f(x(g))} y1={top - 8} y2={bottom} className={g === 0 ? 'ax0' : 'gr'} />
            <text x={f(x(g))} y={12} textAnchor="middle">{g === 0 ? '0' : `${g < 0 ? MINUS : ''}${Math.abs(g)}%`}</text>
          </g>
        ))}
        {xm === null ? null : (
          <>
            <line x1={f(xm)} x2={f(xm)} y1={top - 8} y2={bottom + 6} className="min" />
            <text x={f(xm)} y={bottom + 22} className="mn" textAnchor={xm + minWords.length * 6.7 > width ? 'end' : 'start'}>{minWords}</text>
          </>
        )}
        {rows.map((r, i) => {
          const y = top + i * rowH + rowH / 2;
          return (
            <a key={r.id} href={`#/markets/${encodeURIComponent(r.id)}`} aria-label={`${r.symbol}, long ${r.venues.replace(' / ', ', short ')}, ${pct(r.netAprPct)} a year after costs`}>
              <rect x={0} y={y - rowH / 2} width={width} height={rowH} fill="transparent" />
              <g className={`mk ${r.held ? 'held' : r.under ? 'under' : ''}`}>
                <text x={0} y={narrow ? y - 2 : y + 4} className="ms">{r.symbol}</text>
                <text x={narrow ? 0 : 84} y={narrow ? y + 13 : y + 4} className={narrow ? 'mv sm' : 'mv'}>{r.venues}</text>
                <line x1={f(x(0))} x2={f(x(r.netAprPct))} y1={y} y2={y} className="st" />
                <circle cx={f(x(r.netAprPct))} cy={y} r={3.5} />
                <text x={width} y={y + 4} textAnchor="end" className="tv">{pct(r.netAprPct)}</text>
              </g>
            </a>
          );
        })}
      </svg>
    </div>
  );
}
