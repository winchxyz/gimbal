import { useLayoutEffect, useRef, type RefObject } from 'react';

const EASE = 'cubic-bezier(.25, .1, .25, 1)'; // --ease

/** `--dur` in ms; 0 under prefers-reduced-motion, which turns the animation off. */
function durMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dur').trim();
  const value = parseFloat(raw);
  if (Number.isNaN(value)) return 0;
  return raw.endsWith('ms') ? value : value * 1000;
}

/**
 * Animates rows to their new place when the order changes (design/HANDOFF.md: "animate the move over --dur").
 * Each element marked `data-flip="<id>"` is measured after every render; one that moved starts where it was and
 * slides to where it is. Positions are `offsetTop` inside the container, so scrolling the list changes nothing.
 */
export function useFlip(container: RefObject<HTMLElement | null>): void {
  const last = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const ms = durMs();
    const next = new Map<string, number>();
    for (const el of root.querySelectorAll<HTMLElement>('[data-flip]')) {
      const id = el.dataset.flip;
      if (!id) continue;
      const top = el.offsetTop;
      next.set(id, top);
      const before = last.current.get(id);
      if (ms > 0 && before !== undefined && Math.abs(before - top) > 1 && typeof el.animate === 'function') {
        el.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'translateY(0)' }], { duration: ms, easing: EASE });
      }
    }
    last.current = next;
  });
}
