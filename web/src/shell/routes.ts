import { useEffect, useState } from 'react';

// The four sections (UX: Desk, Markets, Journal, Safety). The header and the phone tab bar list them the same way.
export const SCREENS = [
  { id: 'desk', label: 'Desk' },
  { id: 'markets', label: 'Markets' },
  { id: 'journal', label: 'Journal' },
  { id: 'safety', label: 'Safety' },
] as const;

export type ScreenId = (typeof SCREENS)[number]['id'];

/**
 * The five sections before the redesign, and where each lives now: Windows became Markets; Rescue and Security are
 * one Safety screen. Old links (a shared `#/windows/<id>`, a bookmark of `#/rescue`) still land on the right screen.
 */
const OLD_IDS: Readonly<Record<string, ScreenId>> = { windows: 'markets', rescue: 'safety', security: 'safety' };

// Hash routes need no server rewrites, so the same build works from the dev server, the engine or
// any static host.
export const hrefOf = (id: ScreenId): string => `#/${id}`;

export function screenFromHash(hash: string): ScreenId {
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return SCREENS.find((s) => s.id === id)?.id ?? OLD_IDS[id] ?? 'desk';
}

/** Onboarding is not one of the sections: it has its own header and no tabs, and the sections never link to it. */
export const ONBOARDING_HREF = '#/onboarding';

/** The remote-engine settings form. Like onboarding it is not one of the sections: no tabs, and only the header links to it. */
export const CONNECT_HREF = '#/connect';

export const isConnectHash = (hash: string): boolean => /^#\/?connect(?:[/?]|$)/.test(hash);

function useHashFlag(test: (hash: string) => boolean): boolean {
  const [on, setOn] = useState<boolean>(() => test(window.location.hash));
  useEffect(() => {
    const onChange = () => setOn(test(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, [test]);
  return on;
}

export const useConnectRoute = (): boolean => useHashFlag(isConnectHash);

/** The public live view's owner unlock (remote/OwnerUnlock.tsx): a page of its own, like the settings form. */
export const OWNER_HREF = '#/owner';

export const isOwnerHash = (hash: string): boolean => /^#\/?owner(?:[/?]|$)/.test(hash);

export const useOwnerRoute = (): boolean => useHashFlag(isOwnerHash);

export function isOnboardingHash(hash: string): boolean {
  return /^#\/?onboarding(?:[/?]|$)/.test(hash);
}

export const useOnboardingRoute = (): boolean => useHashFlag(isOnboardingHash);

export function useScreen(): ScreenId {
  const [screen, setScreen] = useState<ScreenId>(() => screenFromHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setScreen(screenFromHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return screen;
}
