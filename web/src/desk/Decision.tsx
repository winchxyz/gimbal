import type { StrategyDecision } from '@gimbal/shared';
import { writeControls } from '../remote/readonly.ts';
import { useManualSend } from '../ui/useManualSend.ts';
import { cx } from '../ui/cx.ts';
import { confirmText } from '../windows/manual.ts';
import { decisionLine } from './decision.ts';

interface Props {
  decision: StrategyDecision | null;
  now: number;
  /** The held pair can be closed: both legs are open. */
  held: boolean;
  /** The symbol being held, when the page knows it (for the sentence only). */
  symbol: string | null;
  /** The status line says the owner should act (`needs`): the filled pill. */
  urgent: boolean;
  /** The owner's minimum net APR (`StrategyConfig`), for the wait sentence; null until it is read. */
  minNetAprPct?: number | null;
}

/**
 * What the strategy loop decided and why, under the status line, with the owner's override on the same line:
 * Close both legs, after a confirm. The engine answers at once with ok or the reason it refused; the work itself arrives
 * as Journal and Desk events, so the answer is shown here and nothing else changes.
 */
export function DecisionBar({ decision, now, held, symbol, urgent, minNetAprPct = null }: Props) {
  const line = decisionLine(decision, now, { minNetAprPct });
  // Read-only view: the line says what the loop decided; the override is not offered.
  const canClose = held && writeControls().close;
  const send = useManualSend(canClose ? { kind: 'close', symbol } : null);
  if (line === null && !canClose) return null;

  return (
    <div className="d-decision" data-testid="decision-line">
      {line ? (
        <p className="say">
          <span className="word">{line.word}</span>
          <span className="reason" title={line.raw !== line.reason ? line.raw : undefined}>{line.reason}</span>
          <span className="g3 when">{line.when}</span>
        </p>
      ) : (
        <span className="say" />
      )}
      {canClose ? (
        send.asking ? (
          <span className="end" role="alertdialog" aria-label="Confirm">
            <span className="ink">{confirmText({ kind: 'close', symbol })}</span>
            <button type="button" className="btn quiet" onClick={send.cancel}>Cancel</button>
            <button type="button" className="btn primary" onClick={send.confirm}>Close both legs</button>
          </span>
        ) : (
          <span className="end">
            {send.sending ? <span className="g" role="status">Sending to the engine…</span> : null}
            {send.outcome ? (
              <span className={cx('out', send.outcome.tone === 'sent' ? 'ok' : 'wt')} role="status">
                {send.outcome.title}: {send.outcome.text}
              </span>
            ) : null}
            <button type="button" className={cx('btn', urgent && 'primary')} disabled={send.sending} onClick={send.ask}>
              Close position
            </button>
          </span>
        )
      ) : null}
    </div>
  );
}
