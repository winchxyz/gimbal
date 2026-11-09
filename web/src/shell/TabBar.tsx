import type { ReactNode } from 'react';
import { SCREENS, hrefOf, type ScreenId } from './routes.ts';

// The tab icons from brand book C (Applications, phone): 1.6 px outlines on a 24 px grid, in the text colour.
const ICONS: Record<ScreenId, ReactNode> = {
  desk: <path d="M3.5 10h17M8.5 4.5v15M15.5 6.5v8" strokeLinecap="round" />, // a level line with a long and a short stroke
  markets: <path d="M4 18 L9.5 12 L13 15 L20 7" />,
  journal: <path d="M6 6h12M6 12h12M6 18h8" />,
  safety: <path d="M12 3.5 19 6v5.5c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6z" />,
};

/** Phone only: the sections move from the header to a bottom tab bar. */
export function TabBar({ screen }: { screen: ScreenId }) {
  return (
    <nav className="tabs" aria-label="Sections">
      {SCREENS.map((s) => (
        <a key={s.id} href={hrefOf(s.id)} className={s.id === screen ? 'on' : undefined} aria-current={s.id === screen ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            {ICONS[s.id]}
          </svg>
          {s.label}
        </a>
      ))}
    </nav>
  );
}
