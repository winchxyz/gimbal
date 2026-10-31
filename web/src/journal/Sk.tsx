import type { CSSProperties } from 'react';
import { cx } from '../ui/cx.ts';

/** A placeholder bar where a figure goes. */
export function Sk({ w, h, className, style }: { w: number | string; h: number; className?: string; style?: CSSProperties }) {
  return <i className={cx('j-sk', className)} style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}
