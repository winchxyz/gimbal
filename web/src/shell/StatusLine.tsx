import { ago, useNow } from '../ui/useNow.ts';
import type { ScreenId } from './routes.ts';
import { StatusActions } from './StatusActions.tsx';
import { useStatus } from './useStatus.ts';

/** The one line under the header on Desk and Rescue that changes colour for risk. */
export function StatusLine({ screen }: { screen: ScreenId }) {
  const status = useStatus(screen === 'rescue' ? 'rescue' : 'desk');
  const now = useNow();

  if (!status) {
    return (
      <div className="status loading">
        <span className="state dot">Loading</span>
        <span className="g">Reading both exchanges and the contract…</span>
      </div>
    );
  }

  const { desk, view, actions } = status;
  return (
    <div className={`status ${view.tone}`}>
      <span className="state dot">{view.word}</span>
      <span className="say">
        {view.sentence}
        {view.detail ? <span className="g"> {view.detail}</span> : null}
      </span>
      {view.tone === 'down' ? null : <span className="g3 checked">Checked {ago(desk.updatedAt, now)}</span>}
      <StatusActions view={actions} className="end" />
    </div>
  );
}
