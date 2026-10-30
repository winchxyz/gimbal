import { useStream } from '../stream/hub.ts';
import { ago, useNow } from '../ui/useNow.ts';
import { statusOf } from './status.ts';

/** The one line under the header on Desk and Rescue that changes colour for risk. */
export function StatusLine() {
  const desk = useStream((s) => s.desk);
  const now = useNow();

  if (!desk) {
    return (
      <div className="status loading">
        <span className="state dot">Loading</span>
        <span className="g">Reading both exchanges and the contract…</span>
      </div>
    );
  }

  const view = statusOf(desk);
  return (
    <div className={`status ${view.tone}`}>
      <span className="state dot">{view.word}</span>
      <span>{view.sentence}</span>
      <span className="g3 checked">Checked {ago(desk.updatedAt, now)}</span>
    </div>
  );
}
