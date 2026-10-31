// Display names: every venue the scanner reads has one, and check texts use it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESK_VENUES } from '../scanner/pairs.ts';
import { venueName, venueNames } from './names.ts';
import { WATCH_VENUE_IDS } from './watch/index.ts';

test('every desk and watch venue has a display name, none of them its id', () => {
  for (const id of [...DESK_VENUES, ...WATCH_VENUE_IDS]) {
    const name = venueName(id);
    assert.notEqual(name, id, id);
    assert.match(name, /^[A-Za-z]/, id);
  }
  assert.equal(new Set([...DESK_VENUES, ...WATCH_VENUE_IDS].map(venueName)).size, DESK_VENUES.length + WATCH_VENUE_IDS.length);
  assert.deepEqual(['orderly', 'phoenix', 'dydx', 'okx', 'kucoin', 'gmx-arbitrum', 'hl-xyz'].map(venueName),
    ['Orderly', 'Phoenix', 'dYdX', 'OKX', 'KuCoin', 'GMX (Arbitrum)', 'trade.xyz']);
  // A venue added later without a name is shown by its id, not guessed at.
  assert.equal(venueName('newvenue'), 'newvenue');
});

test('venueNames joins as a sentence does', () => {
  assert.equal(venueNames([]), '');
  assert.equal(venueNames(['orderly']), 'Orderly');
  assert.equal(venueNames(['orderly', 'phoenix']), 'Orderly and Phoenix');
  assert.equal(venueNames(['aster', 'bitget', 'mexc']), 'Aster, Bitget and MEXC');
});
