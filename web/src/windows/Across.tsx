import { cx } from '../ui/cx.ts';
import { depth, rate, venueName } from './format.ts';
import { searchPairsFor } from './kept.ts';
import { hashForWindow } from './route.ts';
import { everyWords, type AssetRow, type PairRow } from './scanner.ts';

const NONE = <span className="g">—</span>;

/**
 * An asset on every venue its listed pairs are on, the lowest funding first: a long is paid most at the top of the
 * list, a short at the bottom. The two venues of the pair on the page are marked.
 */
export function AcrossVenues({ asset, row }: { asset: AssetRow; row: PairRow }) {
  const rates = asset.venues.map((v) => v.aprPct);
  const lo = Math.min(0, ...rates);
  const hi = Math.max(0, ...rates);
  const at = (v: number): string => `${(((v - lo) / (hi - lo || 1)) * 100).toFixed(2)}%`;
  return (
    <div className="tb-x">
      <table className="tb acr">
        <thead>
          <tr>
            <th />
            <th scope="col">This hour, a year</th>
            <th scope="col" className="acr-t" aria-hidden="true" />
            <th scope="col" className="acr-x">Mean, 7 days</th>
            <th scope="col" className="acr-x">Paid</th>
            <th scope="col">Open interest</th>
          </tr>
        </thead>
        <tbody>
          {asset.venues.map((v) => {
            const side = v.venue === row.w.longVenue ? 'long here' : v.venue === row.w.shortVenue ? 'short here' : null;
            return (
              <tr key={v.venue} className={cx(side !== null && 'on')}>
                <th scope="row">
                  {v.name}
                  {side === null ? (v.desk ? null : <small>watch-only</small>) : <small>{side}</small>}
                </th>
                <td>{rate(v.aprPct)}</td>
                <td className="acr-t" aria-hidden="true">
                  <div className="sc-track">
                    <i className="zero" style={{ left: at(0) }} />
                    <i className={cx('pt', side === null && 'off')} style={{ left: at(v.aprPct) }} />
                  </div>
                </td>
                <td className="acr-x">{v.apr7dPct === null ? NONE : rate(v.apr7dPct)}</td>
                <td className="g acr-x">{everyWords(v.settlement)}</td>
                <td>{v.oiUsd === null ? NONE : depth(v.oiUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** How many sibling pairs a page lists before it points at the scanner for the rest. */
const SHOWN = 6;

/** The other listed pairs on the same asset: the desk's first, each a link to its own page. */
export function OtherPairs({ symbol, pairs }: { symbol: string; pairs: readonly PairRow[] }) {
  if (pairs.length === 0) return <p className="pn-none">This is the only listed pair on {symbol}.</p>;
  return (
    <>
      <table className="tb acr">
        <thead>
          <tr>
            <th />
            <th scope="col">Spread now</th>
            <th scope="col">Net a year</th>
          </tr>
        </thead>
        <tbody>
          {pairs.slice(0, SHOWN).map(({ w, netPct }) => (
            <tr key={w.id} className="on">
              <th scope="row">
                <a href={hashForWindow(w.id)}>{venueName(w.longVenue)} {'→'} {venueName(w.shortVenue)}</a>
                {w.held ? <small className="up">held</small> : w.tradable ? null : <small>watch-only</small>}
              </th>
              <td>{rate(w.grossAprPct)}</td>
              <td>{netPct === null ? NONE : <span className={cx(netPct < 0 && 'down')}>{rate(netPct)}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pairs.length > SHOWN ? (
        <p className="pn-foot">
          <button type="button" className="lk" onClick={() => searchPairsFor(symbol)}>All {pairs.length + 1} {symbol} pairs in the scanner</button>
        </p>
      ) : null}
    </>
  );
}
