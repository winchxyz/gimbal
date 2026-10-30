import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A number that changed flashes once (ink to --ink-2 and back over --dur-fast), per design/HANDOFF.md.
 * Counts are never animated and the layout never moves.
 */
export function Flash({ value, children }: { value: unknown; children?: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation when values change faster than it runs
    el.classList.add('flash');
  }, [value]);
  return (
    <span ref={ref} onAnimationEnd={(e) => e.currentTarget.classList.remove('flash')}>
      {children ?? String(value)}
    </span>
  );
}
