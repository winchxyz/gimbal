// The readers the engine scans, per mode: the three desk venues, plus the watch-only venues.

import type { Mode, VenueId } from '@gimbal/shared';
import { HyperliquidReader } from './venues/hyperliquid.ts';
import { OrderlyReader } from './venues/orderly.ts';
import { PhoenixReader } from './venues/phoenix.ts';
import type { RecordLine } from './venues/recorder.ts';
import { ReplayVenue } from './venues/replay.ts';
import type { Clock, VenueReader, WatchReader } from './venues/venue.ts';

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

/** One ReplayVenue per desk venue in a recording, on `clock`. Watch-only venues are not recorded yet. */
export function replayReaders(lines: readonly RecordLine[], clock: Clock): Readers {
  const ids = [...new Set(lines.map((l) => l.venue))].sort() as VenueId[];
  return { venues: ids.map((id) => new ReplayVenue(lines, clock, id)), watch: [], close: () => {} };
}
