import type { CSSProperties } from 'react';

/** Colour of a `.dot` marker; `--dot` is read by the dot's ::before in app.css. */
export const dotColor = (color: string): CSSProperties => ({ '--dot': color }) as CSSProperties;
