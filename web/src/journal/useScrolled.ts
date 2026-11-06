import { useEffect, useState, type RefObject } from 'react';

/**
 * The element that scrolls `el`: on the desktop the feed scrolls inside its own column, on the phone the page scrolls.
 * Null means the document.
 */
function scrollerOf(el: Element | null): Element | null {
  for (let at = el; at !== null && at !== document.body && at !== document.documentElement; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at;
  }
  return null;
}

const offsetOf = (el: Element | null): number => {
  const scroller = scrollerOf(el);
  return scroller === null ? window.scrollY : scroller.scrollTop;
};

/** Scrolls whatever holds `el` (its column, or the page) back to its top. */
export function scrollToTop(el: Element | null, behavior: ScrollBehavior): void {
  const scroller = scrollerOf(el);
  if (scroller === null) window.scrollTo({ top: 0, behavior });
  else scroller.scrollTo({ top: 0, behavior });
}

/**
 * True once whatever scrolls `ref` (its own column, or the page) is scrolled down by more than `offset` px: the reader
 * is no longer looking at the newest entries. Scroll events do not bubble, so one capturing listener on the document
 * hears the column and the page alike, whichever of them scrolls at this width.
 */
export function useScrolled(ref: RefObject<Element | null>, offset = 160): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(offsetOf(ref.current) > offset); // a state set to its current value does not render again
    onScroll();
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
    };
  }, [ref, offset]);
  return scrolled;
}
