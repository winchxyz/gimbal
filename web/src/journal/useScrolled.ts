import { useEffect, useState } from 'react';

/** True once the page is scrolled down by more than `offset` px: the reader is no longer looking at the newest entries. */
export function useScrolled(offset = 160): boolean {
  const [scrolled, setScrolled] = useState(() => window.scrollY > offset);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > offset); // a state set to its current value does not render again
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [offset]);
  return scrolled;
}
