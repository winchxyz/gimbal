import { useEffect } from 'react';
import { DeskScreen } from '../desk/DeskScreen.tsx';
import { Placeholder } from '../screens/Placeholder.tsx';
import { NoticeBar } from '../ui/NoticeBar.tsx';
import { WindowsScreen } from '../windows/WindowsScreen.tsx';
import { Header } from './Header.tsx';
import { SCREENS, useScreen } from './routes.ts';
import { StatusLine } from './StatusLine.tsx';
import { TabBar } from './TabBar.tsx';

// Screens with the status line under the header (design/components.html, Status line).
const WITH_STATUS = new Set(['desk', 'rescue']);

export function Shell() {
  const screen = useScreen();
  const label = SCREENS.find((s) => s.id === screen)?.label ?? '';

  useEffect(() => {
    document.title = `Gimbal · ${label}`;
    window.scrollTo(0, 0);
  }, [label]);

  return (
    <div className="app">
      <Header screen={screen} />
      {WITH_STATUS.has(screen) && <StatusLine screen={screen} />}
      <NoticeBar />
      <main className="page">
        {screen === 'desk' ? <DeskScreen /> : screen === 'windows' ? <WindowsScreen /> : <Placeholder screen={screen} />}
      </main>
      <TabBar screen={screen} />
    </div>
  );
}
