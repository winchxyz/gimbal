// The readers the engine scans, per mode: the three desk venues, plus the watch-only venues.

import type { Mode } from '@gimbal/shared';
import { HyperliquidReader } from './venues/hyperliquid.ts';
import { OrderlyReader } from './venues/orderly.ts';
import { PhoenixReader } from './venues/phoenix.ts';
import type { RecordLine } from './venues/recorder.ts';
import { ReplayVenue, ReplayWatch } from './venues/replay.ts';
import type { AccountState, Clock, VenueReader, WatchReader } from './venues/venue.ts';
import { isDeskVenueId } from './venues/venue.ts';
import type { WatchVenueId } from './venues/watch/index.ts';
import { WATCH_VENUE_IDS, watchReaders } from './venues/watch/index.ts';

/** How old an account read the strategy loop's free margin may take (serve): one scan and a little. */
export const LOOP_ACCOUNT_MAX_AGE_MS = 7_000;

/**
 * `reader`'s account at `address`, as read at most `maxAgeMs` ago by anyone in the process when the reader keeps one
 * (PhoenixReader.accountWithin), else read now.
 */
export function accountWithin(reader: VenueReader, address: string, maxAgeMs: number): Promise<AccountState> {
  const within = (reader as VenueReader & { accountWithin?: (a: string, ms: number) => Promise<AccountState> }).accountWithin;
  return typeof within === 'function' ? within.call(reader, address, maxAgeMs) : reader.account(address);
}

export interface Readers {
  venues: VenueReader[];
  watch: WatchReader[];
  /** Releases sockets and SDK clients the readers opened. */
  close(): void;
}

/**
 * Live readers. Testnet reads Hyperliquid's and Orderly's testnets; Phoenix has no public testnet API, so it is read
 * on mainnet in both modes (read-only). The watch-only venues are passed in as `watch` (none by default).
 */
export function liveReaders(mode: Exclude<Mode, 'replay'>, clock?: Clock, watch: readonly WatchReader[] = []): Readers {
  const hyperliquid = new HyperliquidReader({ network: mode, ...(clock === undefined ? {} : { clock }) });
  const phoenix = new PhoenixReader(clock === undefined ? {} : { clock });
  const orderly = new OrderlyReader({ network: mode, ...(clock === undefined ? {} : { clock }) });
  return {
    venues: [hyperliquid, phoenix, orderly],
    watch: [...watch],
    close: () => {
      phoenix.close();
      orderly.close();
    },
  };
}

/**
 * One ReplayVenue per desk venue in a recording and one ReplayWatch per watch-only venue (recordings made before
 * the watch venues were recorded have none), on `clock`. The watch venues come in the live order, DEX first.
 */
export function replayReaders(lines: readonly RecordLine[], clock: Clock): Readers {
  const ids = [...new Set(lines.map((l) => l.venue))].sort();
  const desk = ids.filter(isDeskVenueId);
  const kinds = new Map(watchReaders().map((r) => [r.id, r.kind]));
  const watch = ids.filter((id) => !isDeskVenueId(id)).map((id) => {
    const kind = kinds.get(id);
    if (kind === undefined) throw new Error(`replay: ${id} in the recording is neither a desk nor a watch venue`);
    return id;
  }).sort((a, b) => WATCH_VENUE_IDS.indexOf(a as WatchVenueId) - WATCH_VENUE_IDS.indexOf(b as WatchVenueId));
  return {
    venues: desk.map((id) => new ReplayVenue(lines, clock, id)),
    watch: watch.map((id) => new ReplayWatch(lines, clock, id, kinds.get(id)!)),
    close: () => {},
  };
}
