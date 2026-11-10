import { Dim } from '../ui/Dim.tsx';
import { linear, niceStep, ticksOf, TICK_CHAR } from '../ui/scale.ts';
import { useWidth } from '../ui/useWidth.ts';
import { rate } from './format.ts';
import type { LegView } from './scanner.ts';

interface Props {
  long: LegView;
  short: LegView;
  /** The pair's spread this hour, a year: the size written between the two rates. */
  spreadPct: number;
  /** What the instrument says, for a reader who cannot see it. */
  label: string;
}

const HEIGHT = 176;
const RAISED = 40;
const Y_DIM = 78;
const Y_BEAM = 128;
const Y_TICK = Y_BEAM + 16;
/** The width of one character of a flag's first line (13 px, the brand's sans), for placing it without measuring. */
const FLAG_CHAR = 6.7;

const f = (n: number): string => n.toFixed(1);
/** `−10%`, `0`, `2.5%`: a tick on the rate axis. */
const tickText = (v: number): string => (v === 0 ? '0' : rate(v).replace(/\.0%$/, '%'));

interface Flag {
  leg: LegView;
  side: string;
  at: number;
  /** 1: the words run right of the needle; -1: left of it. */
  dir: 1 | -1;
  from: number;
  to: number;
}

/**
 * A pair as one measurement: the funding axis, each side's rate this hour as a needle on it, and the spread as the
 * dimension between the two. Hollow marks are each side's 7-day mean, where the week is read.
 */
export function SpreadScale({ long, short, spreadPct, label }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  if (width === 0) return <div ref={ref} style={{ height: HEIGHT }} />;

  const narrow = width < 640;
  const values = [0, long.aprPct, short.aprPct, ...(long.apr7dPct === null ? [] : [long.apr7dPct]), ...(short.apr7dPct === null ? [] : [short.apr7dPct])];
  const lo0 = Math.min(...values);
  const hi0 = Math.max(...values);
  // The outer values sit this far in from the frame, so a needle never lies on it and its flag has room outside.
  const inset = narrow ? 14 : Math.min(200, width * 0.16);
  const x = linear([lo0, hi0 === lo0 ? lo0 + 1 : hi0], [inset, width - inset]);
  const perPx = (hi0 - lo0 || 1) / (width - 2 * inset);
  const lo = lo0 - (inset - 0.5) * perPx;
  const hi = hi0 + (inset - 0.5) * perPx;
  const step = niceStep(hi - lo, narrow ? 4 : 10);

  const longLeft = long.aprPct <= short.aprPct;
  const place = (leg: LegView, side: string, outward: 1 | -1): Flag => {
    const at = x(leg.aprPct);
    const room = Math.max(`${side} · ${leg.name}`.length * FLAG_CHAR, 64) + 9;
    const dir: 1 | -1 = outward === -1 ? (at - room < 0 ? 1 : -1) : at + room > width ? -1 : 1;
    return { leg, side, at, dir, from: dir === 1 ? at : at - room, to: dir === 1 ? at + room : at };
  };
  const a = place(longLeft ? long : short, longLeft ? 'Long' : 'Short', -1);
  const b = place(longLeft ? short : long, longLeft ? 'Short' : 'Long', 1);
  // Two flags that would share a line: the first goes up a row.
  const raised = a.from < b.to && b.from < a.to;
  const top = raised ? -RAISED : 0;

  const flag = ({ leg, side, at, dir }: Flag, row: number) => (
    <g>
      <text x={f(at + dir * 9)} y={13 + row} textAnchor={dir === 1 ? 'start' : 'end'} className="tl">{side} · {leg.name}</text>
      <text x={f(at + dir * 9)} y={32 + row} textAnchor={dir === 1 ? 'start' : 'end'} className="tv">{rate(leg.aprPct)}</text>
      <line x1={f(at)} x2={f(at)} y1={2 + row} y2={Y_TICK + 11} className="needle" />
    </g>
  );

  const ticks = ticksOf(lo, hi, step / 5).map((v) => ({ v, major: Math.abs(v / step - Math.round(v / step)) < 1e-6 }));
  const majors = ticks.filter((t) => t.major);
  const widest = Math.max(0, ...majors.map((t) => tickText(t.v).length)) * TICK_CHAR + 14;
  const between = majors.length > 1 ? Math.abs(x(majors[1]!.v) - x(majors[0]!.v)) : width;
  const labelEvery = Math.max(1, Math.ceil(widest / between));

  return (
    <div ref={ref}>
      <svg className="ins" width={width} height={HEIGHT - top} viewBox={`0 ${top} ${width} ${HEIGHT - top}`} role="img" aria-label={label}>
        {flag(a, top)}
        {flag(b, 0)}
        <Dim x1={Math.min(a.at, b.at)} x2={Math.max(a.at, b.at)} y={Y_DIM} labels={[`spread ${rate(spreadPct)} a year`, `spread ${rate(spreadPct)}`, rate(spreadPct)]} />
        <line x1={0.5} x2={width - 0.5} y1={Y_BEAM} y2={Y_BEAM} className="beam" />
        {[long, short].map((leg) => (leg.apr7dPct === null ? null : <circle key={leg.venue} cx={f(x(leg.apr7dPct))} cy={Y_BEAM} r={3.5} className="ring" />))}
        <circle cx={f(a.at)} cy={Y_BEAM} r={3.5} className="dot" />
        <circle cx={f(b.at)} cy={Y_BEAM} r={3.5} className="dot" />
        {ticks.map(({ v, major }) => {
          if (narrow && !major) return null;
          const zero = v === 0;
          const show = major && (zero || Math.round(v / step) % labelEvery === 0) && x(v) > 22 && x(v) < width - 22;
          return (
            <g key={v}>
              <line x1={f(x(v))} x2={f(x(v))} y1={Y_TICK} y2={Y_TICK + (major ? 11 : 4)} className={zero ? 'beam' : major ? 'tk1' : 'tk3'} />
              {show ? <text x={f(x(v))} y={Y_TICK + 27} textAnchor="middle">{tickText(v)}</text> : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
