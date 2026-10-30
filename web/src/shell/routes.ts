import { useEffect, useState } from 'react';

// Order follows design/screens: the header nav and the phone tab bar list the sections the same way.
export const SCREENS = [
  { id: 'desk', label: 'Desk' },
  { id: 'windows', label: 'Windows' },
  { id: 'journal', label: 'Journal' },
  { id: 'rescue', label: 'Rescue' },
  { id: 'security', label: 'Security' },
] as const;

export type ScreenId = (typeof SCREENS)[number]['id'];

// Hash routes need no server rewrites, so the same build works from the dev server, the engine or
// any static host.
export const hrefOf = (id: ScreenId): string => `#/${id}`;

export function screenFromHash(hash: string): ScreenId {
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return SCREENS.find((s) => s.id === id)?.id ?? 'desk';
}

export function useScreen(): ScreenId {
  const [screen, setScreen] = useState<ScreenId>(() => screenFromHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setScreen(screenFromHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return screen;
}
