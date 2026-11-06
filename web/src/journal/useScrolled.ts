import { useEffect, useState, type RefObject } from 'react';

/**
 * The element that scrolls `el`: on the desktop the feed scrolls inside its own column, on the phone the page scrolls.
 * Null means the document.
 */
function scrollerOf(el: Element | null): HTMLElement | null {
  for (let at = el instanceof HTMLElement ? el : null; at !== null && at !== document.body; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at;
  }
  return null;
}

/** Scrolls whatever holds `el` (its column, or the page) back to its top. */
export function scrollToTop(el: Element | null, behavior: ScrollBehavior): void {
  const scroller = scrollerOf(el);
  if (scroller === null) window.scrollTo({ top: 0, behavior });
  else scroller.scrollTo({ top: 0, behavior });
}

/**
 * True once whatever scrolls `ref` (its own column, or the page) is scrolled down by more than `offset` px: the reader
 * is no longer looking at the newest entries. A column that can scroll less than `offset` counts as scrolled down once
 * it is off its top at all, so new entries never shift a feed the reader has moved. The scroller is looked up once, and
 * again only when the window resizes (the breakpoint decides whether the column or the page scrolls).
 */
export function useScrolled(ref: RefObject<Element | null>, offset = 160): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let target: HTMLElement | null = null;
    const read = () => {
      const top = target === null ? window.scrollY : target.scrollTop;
      const room = target === null ? document.documentElement.scrollHeight - window.innerHeight : target.scrollHeight - target.clientHeight;
      // a state set to its current value does not render again
      setScrolled(room > 0 && top > (room <= offset ? 0 : offset));
    };
    const bind = () => {
      (target ?? window).removeEventListener('scroll', read);
      target = scrollerOf(ref.current);
      (target ?? window).addEventListener('scroll', read, { passive: true });
      read();
    };
    bind();
    window.addEventListener('resize', bind, { passive: true });
    return () => {
      (target ?? window).removeEventListener('scroll', read);
      window.removeEventListener('resize', bind);
    };
  }, [ref, offset]);
  return scrolled;
}
