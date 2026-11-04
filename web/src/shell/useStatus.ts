// The status line's view of the desk, as a hook: the status line and the phone's page buttons read the same one.
import type { DeskState } from '@gimbal/shared';
import { isReadOnly } from '../remote/readonly.ts';
import { useStream } from '../stream/hub.ts';
import { bestEnterable } from '../windows/model.ts';
import { useStrategy } from '../windows/useEngine.ts';
import { actionsOf, downVenues, statusOf, type StatusActionsView, type StatusView } from './status.ts';

export interface StatusState {
  desk: DeskState;
  view: StatusView;
  actions: StatusActionsView;
}

/** The first line of docs/interfaces.md §2's order that applies, plus the buttons for it; null until a desk arrives. */
export function useStatus(screen: 'desk' | 'rescue'): StatusState | null {
  const desk = useStream((s) => s.desk);
  const health = useStream((s) => s.health);
  const windows = useStream((s) => s.windows);
  const strategy = useStrategy().value;
  if (!desk) return null;

  const auto = strategy?.auto ?? null;
  const view = statusOf(desk, {
    down: downVenues(desk, health),
    auto,
    remote: isReadOnly(),
    minNetAprPct: strategy?.minNetAprPct ?? null,
    bestNetAprPct: windows ? (bestEnterable(windows)?.netAprPct ?? null) : null,
  });
  return { desk, view, actions: actionsOf(view, { auto, screen, mode: desk.mode }) };
}
