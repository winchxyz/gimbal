import type { ReactNode } from 'react';
import { cx } from '../ui/cx.ts';

/** A link to another site: it opens in a new tab and says so with the arrow, as the Journal's proof links do. */
export function ExtLink({ href, children, className, arrow = false }: { href: string; children: ReactNode; className?: string; arrow?: boolean }) {
  return (
    <a className={cx('s-ext', className)} href={href} target="_blank" rel="noreferrer noopener">
      {children}
      {arrow ? ' ↗' : null}
    </a>
  );
}
