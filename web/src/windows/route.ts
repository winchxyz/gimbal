// `#/markets/<id>` opens one market. On the phone it is the detail page and Back closes it; on the desktop it
// is the selected row, so a link can point at a market. The shell's own `screenFromHash` stops at the first
// slash, so it still reads this as the Markets screen. A link from before the redesign (`#/windows/<id>`) still opens.
import { useCallback, useEffect, useMemo, useState } from 'react';

const PREFIX = /^#\/?(?:markets|windows)\/([^/?]+)/;

export function windowIdFromHash(hash: string): string | null {
  const match = PREFIX.exec(hash);
  if (!match?.[1]) return null;
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
  /** Push a history entry: the phone's "open the detail page". */
  open(id: string): void;
  /** Change the address without a history entry: the desktop's row selection. */
  replace(id: string | null): void;
}

export function useWindowRoute(): WindowRoute {
  const [id, setId] = useState(() => windowIdFromHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setId(windowIdFromHash(window.location.hash));
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

  return useMemo(() => ({ id, open, replace }), [id, open, replace]);
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
