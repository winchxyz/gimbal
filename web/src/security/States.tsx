import { writeControls } from '../remote/readonly.ts';
import { ONBOARDING_HREF } from '../shell/routes.ts';
import { clock } from '../journal/entry.ts';
import { ExtLink } from './ExtLink.tsx';
import { nearUrl, netOf } from './explorer.ts';
import type { SecurityTarget } from './load.ts';
import { readFailureText } from './words.ts';

/** No desk (design/HANDOFF.md, Security: Empty). */
export function SecurityEmpty() {
  return (
    <div className="s-state">
      <div className="s-state-msg">
        <div className="lab">Security</div>
        <h1>No desk yet</h1>
        <p>Once you create a desk, this page shows the accounts its contract controls, your policy, and what the operator can and cannot do.</p>
        {writeControls().onboarding ? (
          <div className="go">
            <a className="btn primary" href={ONBOARDING_HREF}>
              Create a desk
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The chain could not be read (design/HANDOFF.md, Security: Error): what failed, that the desk is unchanged, what to
 * do. The page reads again by itself, so Try again only brings that forward.
 */
export function SecurityError({ message, at, target, onRetry }: { message: string; at: number; target: SecurityTarget | null; onRetry(): void }) {
  const explorer = target === null ? null : nearUrl(target.contractId, netOf(target.mode));
  return (
    <div className="s-state">
      <div className="s-state-msg">
        <div className="lab">Security</div>
        <h1>Can’t read the contract</h1>
        <p>
          {readFailureText(message, clock(at))} Nothing about the desk has changed; this page reads the contract directly and will refresh when it can.
        </p>
        <div className="go">
          <button type="button" className="btn primary" onClick={onRetry}>
            Try again
          </button>
          {explorer === null ? null : (
            <ExtLink href={explorer} className="btn quiet">
              Open the contract in the explorer
            </ExtLink>
          )}
        </div>
      </div>
    </div>
  );
}
