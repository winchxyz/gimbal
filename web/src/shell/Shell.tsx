import { useEffect, useRef } from 'react';
import { DeskScreen } from '../desk/DeskScreen.tsx';
import { JournalScreen } from '../journal/JournalScreen.tsx';
import { OnboardingScreen } from '../onboarding/OnboardingScreen.tsx';
import { SafetyScreen } from '../safety/SafetyScreen.tsx';
import { Connect } from '../remote/Connect.tsx';
import { OwnerUnlock } from '../remote/OwnerUnlock.tsx';
import { isHostedLive, READ_ONLY_TEXT, writeControls } from '../remote/readonly.ts';
import { NoticeBar } from '../ui/NoticeBar.tsx';
import { focusScroller } from '../ui/scroller.ts';
import { WindowsScreen } from '../windows/WindowsScreen.tsx';
import { Header } from './Header.tsx';
import { SCREENS, useConnectRoute, useOnboardingRoute, useOwnerRoute, useScreen } from './routes.ts';
import { TabBar } from './TabBar.tsx';

export function Shell() {
  const screen = useScreen();
  const onboarding = useOnboardingRoute();
  // The public live view reads its own origin only: it has no engine settings to show.
  const connect = useConnectRoute() && !isHostedLive();
  // The owner's unlock exists on the public live view only.
  const owner = useOwnerRoute() && isHostedLive();
  const label = connect ? 'Engine' : owner ? 'Owner' : onboarding ? 'Set up' : (SCREENS.find((s) => s.id === screen)?.label ?? '');

  // On the desktop the document does not scroll: a screen scrolls inside <main>, or in a column of its own (the Markets
  // list, the Journal feed, marked `data-scroller`). A new screen starts at its top, and the element that scrolls it takes
  // the focus (without a ring: it is not a control), so the arrow keys, Page Down and Space scroll it at once. A column
  // that renders after a loading state takes the focus over from <main> itself (`takeFocus`).
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    document.title = `Gimbal · ${label}`;
    window.scrollTo(0, 0);
    const el = main.current;
    if (!el) return;
    el.scrollTop = 0;
    const active = document.activeElement;
    if (active === null || active === document.body || active.closest('.hdr, .tabs')) focusScroller(el);
  }, [label]);

  // The engine settings are a page of their own, without the tabs.
  if (connect) return <Connect />;
  if (owner) return <OwnerUnlock />;

  // Read-only, the set-up flow would write to the engine and the owner's wallet at every step: there is nothing to show.
  if (onboarding && !writeControls().onboarding) {
    return (
      <div className="app shell">
        <Header screen={null} />
        <main className="page">
          <p className="g" style={{ padding: 'var(--s-6) var(--gutter)' }}>
            {READ_ONLY_TEXT}
          </p>
        </main>
      </div>
    );
  }

  // Onboarding brings its own header and has no tab bar.
  if (onboarding) {
    return (
      <div className="app ob-app">
        <OnboardingScreen />
      </div>
    );
  }

  return (
    <div className="app shell">
      <Header screen={screen} />
      <main className="page" ref={main} tabIndex={-1} data-screen={screen}>
        {screen === 'desk' ? <DeskScreen /> : screen === 'markets' ? <WindowsScreen /> : screen === 'journal' ? <JournalScreen /> : <SafetyScreen />}
      </main>
      <NoticeBar />
      <TabBar screen={screen} />
    </div>
  );
}
