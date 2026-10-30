import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { WindowHistory } from '@gimbal/shared';
import type { HistoryEntry } from './history.ts';
import { axes, dateLabels, domainOf, niceScale, polyline } from './chart.ts';
import { pct } from './format.ts';

interface Props {
  symbol: string;
  history: HistoryEntry | undefined;
  /** The held window, drawn behind in grey; null when the selected window is the held one or nothing is held. */
  held: { symbol: string; history: HistoryEntry | undefined } | null;
  minimum: number | null;
  onRetry(): void;
}

const HEIGHT = 168;
const PHONE_HEIGHT = 148;

/** Width of an element, kept up to date, so the chart is drawn at its real pixel size (text does not scale). */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Hourly net APR over 7 days (design/HANDOFF.md, Chart): the selected window in ink at 2 px, the held one in ink-2 at 1.5 px. */
export function Chart({ symbol, history, held, minimum, onRetry }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const own = history?.history ?? null;
  const behind = held?.history?.history ?? null;
  const height = width > 0 && width < 520 ? PHONE_HEIGHT : HEIGHT;

  const drawing = useMemo(() => {
    if (!own || width === 0) return null;
    const domain = domainOf(own, behind);
    if (!domain) return null;
    const values = [...own.points, ...(behind?.points ?? [])].map((p) => p.netAprPct);
    const scale = niceScale(values, minimum);
    const ax = axes({ width, height, domain, scale, minimum });
    return { ax, labels: dateLabels(domain), own: lineOf(own, ax), behind: behind ? lineOf(behind, ax) : null };
  }, [own, behind, width, height, minimum]);

  return (
    <div className="w-chart" ref={ref}>
      <div className="cap">
        <span>
          Net APR, 7 days ·{' '}
          <span className="own">{'—'} {symbol}</span>
          {held ? <span className="behind"> &nbsp;{'—'} {held.symbol}, held</span> : null}
        </span>
        {minimum !== null ? <span>- - your minimum</span> : null}
      </div>
      {drawing ? (
        <svg width={width} height={height} role="img" aria-label={`${symbol} net APR over 7 days, now ${pct(own?.points.at(-1)?.netAprPct ?? 0)}`}>
          {drawing.ax.grid.map((g) => (
            <g key={g.value}>
              <line x1={0} x2={drawing.ax.plotRight} y1={g.y} y2={g.y} stroke="var(--line)" />
              <text x={drawing.ax.plotRight + 8} y={g.y + 4}>{g.value}%</text>
            </g>
          ))}
          {drawing.ax.minimumY !== null ? (
            <line x1={0} x2={drawing.ax.plotRight} y1={drawing.ax.minimumY} y2={drawing.ax.minimumY} stroke="var(--ink-2)" strokeDasharray="3 4" />
          ) : null}
          {drawing.behind ? <polyline points={drawing.behind.points} fill="none" stroke="var(--ink-2)" strokeWidth={1.5} /> : null}
          <polyline points={drawing.own.points} fill="none" stroke="var(--ink)" strokeWidth={2} />
          {drawing.behind?.last ? <circle cx={drawing.behind.last.x} cy={drawing.behind.last.y} r={3} fill="var(--ink-2)" /> : null}
          {drawing.own.last ? <circle cx={drawing.own.last.x} cy={drawing.own.last.y} r={4} fill="var(--ink)" /> : null}
          <text x={0} y={height - 2}>{drawing.labels[0]}</text>
          <text x={drawing.ax.plotRight / 2} y={height - 2} textAnchor="middle">{drawing.labels[1]}</text>
          <text x={drawing.ax.plotRight} y={height - 2} textAnchor="end">{drawing.labels[2]}</text>
        </svg>
      ) : (
        <ChartPlaceholder height={height} entry={history} onRetry={onRetry} />
      )}
    </div>
  );
}

function lineOf(history: WindowHistory, ax: ReturnType<typeof axes>) {
  const last = history.points.at(-1);
  return { points: polyline(history.points, ax), last: last ? { x: ax.x(last.t), y: ax.y(last.netAprPct) } : null };
}

// Three things, as every error here says: what failed, what is still safe, what to do.
function ChartPlaceholder({ height, entry, onRetry }: { height: number; entry: HistoryEntry | undefined; onRetry(): void }) {
  if (entry?.status === 'error') {
    return (
      <div className="w-chart-msg" style={{ height }}>
        <span className="wt">Can’t load the 7-day chart.</span>
        <span className="g"> The numbers beside it are current and the desk is unaffected. </span>
        <button type="button" className="btn quiet" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  return <div className="w-chart-sk sk" style={{ height }} aria-label="Loading the 7-day chart" />;
}
