import { useEffect } from 'react';
import { DeskScreen } from '../desk/DeskScreen.tsx';
import { JournalScreen } from '../journal/JournalScreen.tsx';
import { OnboardingScreen } from '../onboarding/OnboardingScreen.tsx';
import { RescueScreen } from '../rescue/RescueScreen.tsx';
import { Placeholder } from '../screens/Placeholder.tsx';
import { SecurityScreen } from '../security/SecurityScreen.tsx';
import { Connect } from '../remote/Connect.tsx';
import { RemoteBar } from '../remote/RemoteBar.tsx';
import { READ_ONLY_TEXT, writeControls } from '../remote/readonly.ts';
import { NoticeBar } from '../ui/NoticeBar.tsx';
import { WindowsScreen } from '../windows/WindowsScreen.tsx';
import { ConnectionBar } from './ConnectionBar.tsx';
import { Header } from './Header.tsx';
import { SCREENS, useConnectRoute, useOnboardingRoute, useScreen } from './routes.ts';
import { StatusLine } from './StatusLine.tsx';
import { TabBar } from './TabBar.tsx';

// Screens with the status line under the header (design/components.html, Status line).
const WITH_STATUS = new Set(['desk', 'rescue']);

export function Shell() {
  const screen = useScreen();
  const onboarding = useOnboardingRoute();
  const connect = useConnectRoute();
  const label = connect ? 'Engine' : onboarding ? 'Set up' : (SCREENS.find((s) => s.id === screen)?.label ?? '');

  useEffect(() => {
    document.title = `Gimbal · ${label}`;
    window.scrollTo(0, 0);
  }, [label]);

  // The engine settings are a page of their own, without the tabs.
  if (connect) return <Connect />;

  // Read-only, the set-up flow would write to the engine and the owner's wallet at every step: there is nothing to show.
  if (onboarding && !writeControls().onboarding) {
    return (
      <div className="app">
        <Header screen="desk" />
        <RemoteBar />
        <main className="page">
          <p className="g" style={{ padding: 'var(--s-6) var(--gutter)' }}>
            {READ_ONLY_TEXT}
          </p>
        </main>
      </div>
    );
  }

  // Onboarding brings its own header and has no tab bar (design/screens/desktop/onboarding.html).
  if (onboarding) {
    return (
      <div className="app ob-app">
        <OnboardingScreen />
      </div>
    );
  }

  return (
    <div className="app">
      <Header screen={screen} />
      <RemoteBar />
      <ConnectionBar />
      {WITH_STATUS.has(screen) && <StatusLine screen={screen} />}
      <NoticeBar />
      <main className="page">
        {screen === 'desk' ? (
          <DeskScreen />
        ) : screen === 'windows' ? (
          <WindowsScreen />
        ) : screen === 'journal' ? (
          <JournalScreen />
        ) : screen === 'rescue' ? (
          <RescueScreen />
        ) : screen === 'security' ? (
          <SecurityScreen />
        ) : (
          <Placeholder screen={screen} />
        )}
      </main>
      <TabBar screen={screen} />
    </div>
  );
}
