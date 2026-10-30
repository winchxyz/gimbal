// "Alert me if it passes DOGE": a local alert, kept in this browser only. It is checked on every windows
// update while the screen is open; nothing is sent anywhere. Pure, so the matching and the storage format are tested.
import type { Window as FundingWindow } from '@gimbal/shared';

export interface Alert {
  id: string;
  windowId: string;      // the window to watch
  symbol: string;
  overId: string;        // the window it has to pass (the held one when the alert was made)
  overSymbol: string;
  overNetAprPct: number; // that window's net when the alert was made: used only if it is no longer listed
}

export const alertId = (windowId: string, overId: string): string => `${windowId}>${overId}`;

export function makeAlert(watch: FundingWindow, over: FundingWindow): Alert {
  return {
    id: alertId(watch.id, over.id),
    windowId: watch.id,
    symbol: watch.symbol,
    overId: over.id,
    overSymbol: over.symbol,
    overNetAprPct: over.netAprPct,
  };
}

export interface Reached {
  alert: Alert;
  window: FundingWindow;
  /** What it passed, in net APR now. */
  overNetAprPct: number;
}

/** The alerts whose window is now above the one it had to pass. */
export function reached(alerts: readonly Alert[], windows: readonly FundingWindow[]): Reached[] {
  const out: Reached[] = [];
  for (const alert of alerts) {
    const watched = windows.find((w) => w.id === alert.windowId);
    if (!watched) continue;
    const over = windows.find((w) => w.id === alert.overId)?.netAprPct ?? alert.overNetAprPct;
    if (watched.netAprPct > over) out.push({ alert, window: watched, overNetAprPct: over });
  }
  return out;
}

export const toggleAlert = (alerts: readonly Alert[], alert: Alert): Alert[] =>
  alerts.some((a) => a.id === alert.id) ? alerts.filter((a) => a.id !== alert.id) : [...alerts, alert];

export const hasAlert = (alerts: readonly Alert[], watchId: string, overId: string): boolean =>
  alerts.some((a) => a.id === alertId(watchId, overId));

const KEY = 'gimbal.windows.alerts';

/** Reads what `saveAlerts` wrote; anything unreadable is an empty list, never an error. */
export function parseAlerts(raw: string | null): Alert[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (a): a is Alert =>
        typeof a === 'object' &&
        a !== null &&
        typeof a.id === 'string' &&
        typeof a.windowId === 'string' &&
        typeof a.symbol === 'string' &&
        typeof a.overId === 'string' &&
        typeof a.overSymbol === 'string' &&
        typeof a.overNetAprPct === 'number',
    );
  } catch {
    return [];
  }
}

export function loadAlerts(): Alert[] {
  try {
    return parseAlerts(window.localStorage.getItem(KEY));
  } catch {
    return []; // storage blocked: the alert lives for this visit only
  }
}

export function saveAlerts(alerts: readonly Alert[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(alerts));
  } catch {
    // storage blocked or full: nothing else to do
  }
}
