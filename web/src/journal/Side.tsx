import type { DeskState, JournalEntry, Window as FundingWindow } from '@gimbal/shared';
import { signedUsd } from '../desk/format.ts';
import { Flash } from '../ui/Flash.tsx';
import { contractUrl } from './entry.ts';
import { attributionOf, countsOf, sinceLabel, sinceNote } from './model.ts';

const money = (value: number | null): string => (value === null ? '—' : signedUsd(value));
const positive = (value: number | null): string | undefined => (value !== null && value > 0 ? 'pos' : undefined);

/**
 * The column beside the feed: the net since the first entry and where it came from, the counts, and the contract.
 * It reads every entry, not only the filtered ones.
 */
export function Side({ entries, desk, windows }: { entries: readonly JournalEntry[]; desk: DeskState | null; windows: readonly FundingWindow[] | null }) {
  const a = attributionOf(desk?.pnl ?? null, entries);
  const counts = countsOf(entries);
  const note = desk ? sinceNote(desk, windows) : null;
  const explorer = desk ? contractUrl(desk.contract, desk.mode) : null;

  return (
    <aside className="j-side" aria-label="Summary">
      <h3>{sinceLabel(entries)}</h3>
      <div className="big">
        <Flash value={a.netUsd}>{money(a.netUsd)}</Flash>
      </div>
      {note ? <p>{note}</p> : null}

      <div className="j-attr">
        <div>
          <span>Funding received</span>
          <span className={positive(a.fundingUsd)}>
            <Flash value={a.fundingUsd}>{money(a.fundingUsd)}</Flash>
          </span>
        </div>
        <div>
          <span>Trading fees</span>
          <span>
            <Flash value={a.feesUsd}>{money(a.feesUsd)}</Flash>
          </span>
        </div>
        <div>
          <span>Basis at entry and exit</span>
          <span>
            <Flash value={a.basisUsd}>{money(a.basisUsd)}</Flash>
          </span>
        </div>
        <div>
          <span>Transfers, rescue, app fees</span>
          <span>
            <Flash value={a.otherUsd}>{money(a.otherUsd)}</Flash>
          </span>
        </div>
        <div className="tot">
          <span>Net</span>
          <span>{money(a.netUsd)}</span>
        </div>
      </div>

      <div className="j-counts">
        <div>
          <b>
            <Flash value={counts.signed} />
          </b>
          <span>actions signed by the contract</span>
        </div>
        <div>
          {/* Gimbal holds no private key: the contract owns the accounts and asks the MPC network to sign (CLAUDE.md). */}
          <b className="lvl">0</b>
          <span>signed by a private key</span>
        </div>
        <div>
          <b>
            <Flash value={counts.refused} />
          </b>
          <span>refused by your policy</span>
        </div>
        <div>
          <b>
            <Flash value={counts.vetoed} />
          </b>
          <span>vetoed by NEAR AI</span>
        </div>
      </div>

      <div className="j-contract">
        <p>Every row is an event the contract emitted on NEAR. Open any link to check it yourself.</p>
        {desk ? (
          <p>
            <span className="mono">
              {desk.contract} · {desk.deskId}
            </span>
            {explorer ? (
              <>
                &nbsp;{' '}
                <a href={explorer} target="_blank" rel="noreferrer noopener">
                  NEAR explorer ↗
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
