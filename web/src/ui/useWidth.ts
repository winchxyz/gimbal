import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * The width of an element in whole pixels, kept up to date. An instrument is drawn at its real pixel size, so its
 * type never scales and a hairline stays one pixel; 0 until the element is measured.
 */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
