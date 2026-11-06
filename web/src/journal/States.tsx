import type { Mode } from '@gimbal/shared';
import { writeControls } from '../remote/readonly.ts';
import { ONBOARDING_HREF } from '../shell/routes.ts';
import { notify } from '../ui/notice.ts';
import { clock, contractUrl } from './entry.ts';
import { Filters } from './Filters.tsx';
import { Sk } from './Sk.tsx';

/**
 * Loading (design/HANDOFF.md: labels stay, figures are placeholder bars). It has the same frame as the real page,
 * so nothing jumps when the entries arrive.
 */
export function JournalLoading() {
  return (
    <div className="j-page" aria-busy="true" aria-label="Loading the journal">
      <section className="j-top">
        <div>
          <h1>Journal</h1>
          <p className="j-desk">
            Everything the desk did, as the contract recorded it. <Sk w={262} h={20} />
          </p>
          <p className="j-phone">
            <Sk w={300} h={18} />
          </p>
        </div>
        <button type="button" className="btn j-desk" disabled>
          Export CSV
        </button>
      </section>

      <div className="j-summary j-phone">
        {['Since', 'Funding received', 'Fees, basis, transfers'].map((label) => (
          <div key={label}>
            <span>{label}</span>
            <Sk w={64} h={16} />
          </div>
        ))}
      </div>

      <Filters filter="all" counts={null} />

      <div className="j-grid">
        <section className="j-feed" aria-hidden="true">
          {[3, 2, 2].map((rows, day) => (
            <section key={day}>
              <div className="j-day">
                <Sk w={day === 0 ? 100 : 40} h={14} />
                <Sk w={44} h={14} />
              </div>
              {Array.from({ length: rows }, (_, i) => (
                <article key={i} className="j-evt">
                  <span className="j-lead">
                    <Sk w={34} h={14} className="t" />
                    <Sk w={52} h={14} className="k" />
                  </span>
                  <div className="what">
                    <Sk w={`${86 - ((day + i) % 3) * 12}%`} h={20} />
                    <Sk w={`${52 + ((day * 2 + i) % 3) * 10}%`} h={13} style={{ marginTop: 8 }} />
                  </div>
                  <div className="amt">
                    <Sk w={52} h={16} />
                  </div>
                  <div className="proof">
                    <Sk w={110} h={14} />
                  </div>
                </article>
              ))}
            </section>
          ))}
        </section>

        <aside className="j-side" aria-hidden="true">
          <h3>
            <Sk w={76} h={14} />
          </h3>
          <Sk w={146} h={48} />
          <Sk w="100%" h={36} style={{ marginTop: 14 }} />
          <div className="j-attr">
            {['Funding received', 'Trading fees', 'Basis at entry and exit', 'Transfers, rescue, app fees'].map((label) => (
              <div key={label}>
                <span>{label}</span>
                <Sk w={52} h={18} />
              </div>
            ))}
            <div className="tot">
              <span>Net</span>
              <Sk w={52} h={18} />
            </div>
          </div>
          <div className="j-counts">
            {['actions signed by the contract', 'signed by a private key', 'refused (sizing, policy or contract)', 'refused by the NEAR AI risk check'].map((label) => (
              <div key={label}>
                <Sk w={48} h={40} />
                <span>{label}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** No entry yet (design/HANDOFF.md, Journal: Empty). The deposit is the first entry, so money is how to start. */
export function JournalEmpty({ mode }: { mode: Mode | null }) {
  return (
    <div className="j-state">
      <div className="j-state-msg">
        <div className="lab">Journal</div>
        <h1>Nothing here yet</h1>
        <p>
          Every action the desk takes will appear here as an event the contract wrote on NEAR, with a link to check it. Your deposit will be the
          first.
        </p>
        {mode === 'replay' || !writeControls().money ? null : (
          <div className="go">
            <a className="btn primary" href={ONBOARDING_HREF}>
              {mode === 'testnet' ? 'Get test USDC' : 'Add funds'}
            </a>
            <button
              type="button"
              className="btn"
              onClick={() => notify('A replay is a mode of the engine, started where the engine runs. Nothing changed.')}
            >
              Watch a replay
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export interface ErrorProps {
  /** What the failed request said, e.g. `GET /state: 503`. */
  error: string | null;
  /** When it failed, ms. */
  at: number | null;
  /** The contract and network, for the explorer link; null while no desk has been read. */
  contract: { account: string; mode: Mode } | null;
  onRetry(): void;
}

/** The journal could not be read (design/HANDOFF.md, Journal: Error): what failed, that the desk is unaffected, what to do. */
export function JournalError({ error, at, contract, onRetry }: ErrorProps) {
  const when = at === null ? '' : ` at ${clock(at)} UTC`;
  const explorer = contract ? contractUrl(contract.account, contract.mode) : null;
  const why = error ? ` (${error})` : '';
  return (
    <div className="j-state">
      <div className="j-state-msg">
        <div className="lab">Journal</div>
        <h1>Can’t load the journal</h1>
        <p>
          The engine did not answer the request for it{when}
          {why}. The desk is still running; only this view is affected. Every event stays on chain and loads when the connection is back.
        </p>
        <div className="go">
          <button type="button" className="btn primary" onClick={onRetry}>
            Try again
          </button>
          {explorer ? (
            <a className="btn quiet" href={explorer} target="_blank" rel="noreferrer noopener">
              Open the NEAR explorer
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
