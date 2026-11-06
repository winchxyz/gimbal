import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * The column that scrolls a screen on the desktop, when it is not the shell's <main> itself (the Windows list, the
 * Journal feed). Spread on that element: the shell focuses it on a new screen, so Page Down, Space and the arrow keys
 * scroll what the reader is looking at.
 */
export const SCROLLER = { 'data-scroller': '', tabIndex: -1 } as const;

/** Focuses the screen's scrolling column inside `main`, or `main` itself when the screen has none. */
export function focusScroller(main: HTMLElement): void {
  (main.querySelector<HTMLElement>('[data-scroller]') ?? main).focus({ preventScroll: true });
}

/**
 * A callback ref for a scrolling column that appears after the shell has already moved the focus (a screen that shows
 * its loading state first): it takes the focus over from <main>, but never from a control the reader chose.
 */
export function takeFocus(el: HTMLElement | null): void {
  if (el === null) return;
  const active = document.activeElement;
  if (active === null || active === document.body || active.matches('main.page')) el.focus({ preventScroll: true });
}

/**
 * Whether a one-line element is cut off (its text is wider than the element), measured again when it resizes or
 * when `content` changes. Only a cut line needs its full text on hover and a way to read the rest.
 */
export function useCut<T extends HTMLElement>(content: unknown): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setCut(el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [content]);
  return [ref, cut];
}
