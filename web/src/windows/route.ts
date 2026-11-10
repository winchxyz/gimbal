// Markets has three views of the scan (`#/markets` the pairs, `#/markets/assets`, `#/markets/venues`) and a page per
// pair (`#/markets/<id>`), so a link can point at any of them and Back returns to the list. A pair's id is
// `<asset>-<venue>-<venue>`, never one of the two view words. The shell's own `screenFromHash` stops at the first
// slash, so it still reads all of these as the Markets screen. A link from before the redesign (`#/windows/<id>`)
// still opens.
import { useCallback, useEffect, useMemo, useState } from 'react';

const PREFIX = /^#\/?(?:markets|windows)\/([^/?]+)/;

export type MarketsView = 'pairs' | 'assets' | 'venues';

export const MARKETS_VIEWS: readonly { id: MarketsView; label: string }[] = [
  { id: 'pairs', label: 'Pairs' },
  { id: 'assets', label: 'Assets' },
  { id: 'venues', label: 'Venues' },
];

const isViewWord = (segment: string): segment is 'assets' | 'venues' => segment === 'assets' || segment === 'venues';

export function marketsViewFromHash(hash: string): MarketsView {
  const segment = PREFIX.exec(hash)?.[1];
  return segment !== undefined && isViewWord(segment) ? segment : 'pairs';
}

export const hashForView = (view: MarketsView): string => (view === 'pairs' ? '#/markets' : `#/markets/${view}`);

export function windowIdFromHash(hash: string): string | null {
  const match = PREFIX.exec(hash);
  if (!match?.[1] || isViewWord(match[1])) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null; // a hand-edited hash that is not valid percent-encoding
  }
}

export const hashForWindow = (id: string | null): string => (id === null ? '#/markets' : `#/markets/${encodeURIComponent(id)}`);

export interface WindowRoute {
  /** The window named in the address, or null. */
  id: string | null;
  /** Which view of the scan the address names; the pairs when it names a pair or nothing. */
  view: MarketsView;
  /** Push a history entry: the phone's "open the detail page". */
  open(id: string): void;
  /** Change the address without a history entry: the desktop's row selection. */
  replace(id: string | null): void;
}

export function useWindowRoute(): WindowRoute {
  const [id, setId] = useState(() => windowIdFromHash(window.location.hash));
  const [view, setView] = useState(() => marketsViewFromHash(window.location.hash));

  useEffect(() => {
    const onChange = () => {
      setId(windowIdFromHash(window.location.hash));
      setView(marketsViewFromHash(window.location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const open = useCallback((next: string) => {
    window.location.hash = hashForWindow(next); // fires hashchange, which updates the state above
  }, []);

  const replace = useCallback((next: string | null) => {
    window.history.replaceState(null, '', hashForWindow(next)); // does not fire hashchange
    setId(next);
  }, []);

  return useMemo(() => ({ id, view, open, replace }), [id, view, open, replace]);
}

/** The phone layout: one column, the list and the detail are separate pages (same breakpoint as app.css). */
export function usePhone(): boolean {
  const query = '(max-width: 1023px)';
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setPhone(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return phone;
}
