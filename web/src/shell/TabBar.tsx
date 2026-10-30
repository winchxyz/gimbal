import { SCREENS, hrefOf, type ScreenId } from './routes.ts';

/** Phone only: the sections move from the header to a bottom tab bar (design/screens/phone). */
export function TabBar({ screen }: { screen: ScreenId }) {
  return (
    <nav className="tabs" aria-label="Sections">
      {SCREENS.map((s) => (
        <a
          key={s.id}
          href={hrefOf(s.id)}
          className={s.id === screen ? 'on' : undefined}
          aria-current={s.id === screen ? 'page' : undefined}
        >
          <i aria-hidden="true" />
          {s.label}
        </a>
      ))}
    </nav>
  );
}
