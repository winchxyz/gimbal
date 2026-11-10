import { TICK_CHAR } from './scale.ts';

interface DimProps {
  x1: number;
  x2: number;
  y: number;
  /** The size, from the fullest wording to the shortest: the first that fits the line is written in a gap in it. */
  labels: readonly string[];
}

const f = (n: number): string => n.toFixed(1);

/**
 * A dimension line, as on a drawing: a tick at each end and the size written in a gap in the middle. When not even
 * the shortest wording fits the gap, it sits above an unbroken line.
 */
export function Dim({ x1, x2, y, labels }: DimProps) {
  if (x2 - x1 < 12) return null;
  const fits = (t: string) => x2 - x1 > t.length * TICK_CHAR + 44;
  const text = labels.find(fits) ?? labels[labels.length - 1] ?? '';
  const mid = (x1 + x2) / 2;
  const ends = (
    <>
      <line x1={f(x1)} x2={f(x1)} y1={y - 5} y2={y + 5} />
      <line x1={f(x2)} x2={f(x2)} y1={y - 5} y2={y + 5} />
    </>
  );
  if (!fits(text)) {
    // Too short for a gap: the wording goes over the line, and is left out where it would run past both ends.
    const over = text.length * TICK_CHAR < (x2 - x1) * 2.2;
    return (
      <g className="dim">
        {ends}
        <line x1={f(x1)} x2={f(x2)} y1={y} y2={y} />
        {over ? <text x={f(mid)} y={y - 10} textAnchor="middle">{text}</text> : null}
      </g>
    );
  }
  const gap = text.length * TICK_CHAR + 18;
  return (
    <g className="dim">
      {ends}
      <line x1={f(x1)} x2={f(mid - gap / 2)} y1={y} y2={y} />
      <line x1={f(mid + gap / 2)} x2={f(x2)} y1={y} y2={y} />
      <text x={f(mid)} y={y + 4} textAnchor="middle">{text}</text>
    </g>
  );
}
