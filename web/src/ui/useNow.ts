import { useEffect, useState } from 'react';
import { useStream } from '../stream/hub.ts';

/**
 * The current time, refreshed every `everyMs`, for "4 s ago" labels. It is the engine's clock: in a replay that is the
 * recording's, so what the engine stamped reads as just now. `'page'` is this page's own clock, for what the page
 * stamped itself (when it last heard from the engine).
 */
export function useNow(everyMs = 1000, clock: 'engine' | 'page' = 'engine'): number {
  const skew = useStream((s) => s.skewMs);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return clock === 'page' ? now : now - skew;
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
