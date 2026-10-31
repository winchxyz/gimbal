import { cx } from '../ui/cx.ts';
import type { StepView } from './flow.ts';

/** The steps down the left (design/screens/desktop/onboarding-rules.html, `.rail`). The phone shows "Step N of M" instead. */
export function Rail({ steps }: { steps: StepView[] }) {
  return (
    <aside className="rail" aria-label="Setup steps">
      <ol>
        {steps.map((s, i) => (
          <li key={s.id} className={cx('st', s.status)} aria-current={s.status === 'now' ? 'step' : undefined}>
            <i aria-hidden="true">{s.status === 'done' ? '✓' : i + 1}</i>
            <div>
              <b>{s.title}</b>
              <span>{s.sub}</span>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
