import { Flash } from '../ui/Flash.tsx';
import { dotColor } from '../ui/dot.ts';
import { ago, useNow } from '../ui/useNow.ts';
import { useStream } from './hub.ts';
import { STREAM_TYPES, type Connection } from './store.ts';

const CONNECTION: Record<Connection, { label: string; dot: string }> = {
  idle: { label: 'Not started', dot: 'var(--ink-3)' },
  connecting: { label: 'Connecting', dot: 'var(--ink-3)' },
  open: { label: 'Live', dot: 'var(--level)' },
  retrying: { label: 'Reconnecting', dot: 'var(--watch)' },
};

const count = (n: number) => n.toLocaleString('en-US');

/** What has arrived on the stream so far. Shown on every screen until the real screens replace it. */
export function StreamPanel() {
  const s = useStream((state) => state);
  const now = useNow(1000, 'page');
  const connection = CONNECTION[s.connection];
  const source = s.source === 'fake' ? 'Fake stream (development)' : 'Engine stream /events';

  return (
    <section className="stream" aria-label="Event stream">
      <div className="lab">Events received</div>
      <div className="count" data-testid="event-count">
        <Flash value={s.received}>{count(s.received)}</Flash>
      </div>
      <p className="src">
        <span className="dot" style={dotColor(connection.dot)}>
          {connection.label}
        </span>
        <span> · {source}</span>
      </p>
      <div className="rows">
        {STREAM_TYPES.map((type) => (
          <div key={type}>
            <span>{type}</span>
            <span>
              <Flash value={s.counts[type]}>{count(s.counts[type])}</Flash>
            </span>
          </div>
        ))}
        <div>
          <span>Last event</span>
          <span>{s.last ? `${s.last.type} · ${ago(s.last.at, now)}` : '—'}</span>
        </div>
        {s.rejected > 0 && (
          <div>
            <span>Dropped, not a StreamEvent</span>
            <span className="wt">{count(s.rejected)}</span>
          </div>
        )}
      </div>
    </section>
  );
}
