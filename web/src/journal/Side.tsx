import type { DeskState, JournalEntry, Window as FundingWindow } from '@gimbal/shared';
import { signedUsd } from '../desk/format.ts';
import { moneyTone } from '../desk/answer.ts';
import { Flash } from '../ui/Flash.tsx';
import { cx } from '../ui/cx.ts';
import { dayMonthTime } from '../windows/format.ts';
import { contractUrl } from './entry.ts';
import type { TrueCounts } from './counts.ts';
import { attributionOf, sinceLabel, sinceNote } from './model.ts';

const money = (value: number | null): string => (value === null ? '—' : signedUsd(value));
const positive = (value: number | null): string | undefined => (value !== null && value > 0 ? 'pos' : undefined);

/**
 * The counters (brand book C, Journal: Counts). True when the engine sent its counts over every entry it holds; over
 * the loaded page otherwise, and the note says which. A refusal row shows only when there is one to count.
 */
export function Counts({ counts, replay, className }: { counts: TrueCounts; replay: boolean; className?: string }) {
  const row = (label: string, n: number) => (
    <div className="kv">
      <span>{label}</span>
      <b>
        <Flash value={n} />
      </b>
    </div>
  );
  const since = counts.since === null ? '' : `, since ${dayMonthTime(counts.since)} UTC`;
  return (
    <section className={cx('j-cnt', className)} aria-label="Counts">
      <h3>Counts</h3>
      {row('Trades', counts.filters.trades)}
      {row(replay ? 'Simulated actions, nothing signed or sent' : 'Actions signed by the contract', counts.signed)}
      {/* Gimbal holds no private key: the contract owns the accounts and asks the MPC network to sign (CLAUDE.md). */}
      {replay ? null : row('Signed by a private key', 0)}
      {row('Funding payments', counts.filters.funding)}
      {row('Incidents', counts.incidents)}
      {counts.refused > 0 ? row('Refused: sizing, policy or contract', counts.refused) : null}
      {counts.vetoed > 0 ? row('Refused by the NEAR AI risk check', counts.vetoed) : null}
      {counts.held > 0 ? row('Held: no NEAR AI verdict', counts.held) : null}
      <p className="j-note">{counts.complete ? `Counted over every entry the engine holds${since}.` : `Counted over the entries loaded on this page${since}.`}</p>
    </section>
  );
}

/**
 * The column beside the feed: the net since the first entry and where it came from, the counts, and the contract.
 * It reads every entry, not only the filtered ones.
 */
export function Side({ entries, counts, desk, windows }: { entries: readonly JournalEntry[]; counts: TrueCounts; desk: DeskState | null; windows: readonly FundingWindow[] | null }) {
  const a = attributionOf(desk?.pnl ?? null, entries, desk?.legs ?? []);
  const note = desk ? sinceNote(desk, windows) : null;
  const replay = desk?.mode === 'replay';
  const explorer = desk && !replay ? contractUrl(desk.contract, desk.mode) : null;

  return (
    <aside className="j-side" aria-label="Summary">
      <Counts counts={counts} replay={replay} />
      <h3 className="j-since">{sinceLabel(entries)}</h3>
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
          <span className={moneyTone(a.netUsd) ?? undefined}>{money(a.netUsd)}</span>
        </div>
      </div>
      {counts.complete ? null : <p className="j-partial">Counted over the entries loaded on this page.</p>}

      <div className="j-contract">
        {replay ? (
          <p>A replay has no contract: every row is the engine’s own record, made on recorded mainnet prices. Nothing was signed or sent.</p>
        ) : (
          <p>Every row is an event the contract emitted on NEAR. Open any link to check it yourself.</p>
        )}
        {desk && !replay ? (
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
