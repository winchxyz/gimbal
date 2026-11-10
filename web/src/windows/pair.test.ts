import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WindowLeg } from '@gimbal/shared';
import { legsSentence, pairAnswer, pairAnswerText, statusSentence } from './pair.ts';
import { pairRow } from './scanner.ts';
import { win } from './testing.ts';

const leg = (aprPct: number): WindowLeg => ({
  symbol: 'SOL', ratePerHour: aprPct / 100 / 8760, apr7dPct: null, settlement: 'hourly', nextAt: 0, markPx: 100, oiUsd: 1e6, volume24hUsd: 1e6, move24hPct: null, readAt: 0,
});

test('a pair open to the desk says what it pays after costs', () => {
  const a = pairAnswer(win({ symbol: 'SOL', netAprPct: 11.24 }));
  assert.equal(pairAnswerText(a), 'SOL pays 11% a year after costs.');
  assert.equal(a.tone, 'up');
  assert.equal(pairAnswerText(pairAnswer(win({ symbol: 'ETH', netAprPct: 4.26 }))), 'ETH pays 4.3% a year after costs.');
});

test('the held pair, a losing one, one without its week, and one the policy refuses', () => {
  assert.equal(pairAnswerText(pairAnswer(win({ symbol: 'MON', netAprPct: 43.2, held: { since: 1 } }))), 'The desk holds MON: 43% a year after costs.');
  const losing = pairAnswer(win({ symbol: 'BTC', netAprPct: -3.14 }));
  assert.equal(pairAnswerText(losing), 'BTC costs more than it pays: −3.1% a year.');
  assert.equal(losing.tone, 'down');
  assert.equal(
    pairAnswerText(pairAnswer(win({ symbol: 'XPL', netAprPct: 70.3, grossApr7dPct: null }))),
    'XPL shows 70.3% a year after costs this hour. Its 7 days are still being read.',
  );
  const refused = win({ symbol: 'DOGE', netAprPct: 24, refused: { code: 'E_ASSET', reason: 'not in policy' } });
  assert.equal(pairAnswerText(pairAnswer(refused)), 'DOGE pays 24% a year after costs. Not allowed by your policy.');
  assert.equal(statusSentence(win({ refused: { code: 'E_NO_DESK', reason: 'no desk' } })), 'No desk exists yet, so nothing can be entered.');
  assert.equal(statusSentence(win({ note: 'stored SOL price stale: refreshed at open' })), 'Price is read again when it opens.');
  assert.equal(statusSentence(win()), '');
});

test('a watch-only pair shows its spread and says the desk cannot trade it', () => {
  const a = pairAnswer(win({ symbol: 'INIT', tradable: false, grossAprPct: 3776.4, netAprPct: 3776.4, longVenue: 'bybit', shortVenue: 'hyperliquid' }));
  assert.equal(pairAnswerText(a), 'INIT shows a 3,776% spread this hour. The desk only watches it.');
  assert.equal(a.tone, null);
});

test('the scale is read aloud by what each side does', () => {
  const both = pairRow(win({ symbol: 'SOL', longVenue: 'phoenix', shortVenue: 'hyperliquid', grossAprPct: 35, legs: { long: leg(-3.2), short: leg(31.8) } }));
  assert.equal(legsSentence(both), 'At this hour’s rate the long on Phoenix is paid 3.2% a year and the short on Hyperliquid is paid 31.8%: together 35.0%, before costs.');
  const paying = pairRow(win({ symbol: 'SOL', longVenue: 'phoenix', shortVenue: 'orderly', grossAprPct: 8, legs: { long: leg(10.95), short: leg(18.95) } }));
  assert.equal(legsSentence(paying), 'At this hour’s rate the long on Phoenix pays 10.9% a year and the short on Orderly is paid 18.9%: together 8.0%, before costs.');
  const flat = pairRow(win({ symbol: 'SOL', longVenue: 'phoenix', shortVenue: 'orderly', grossAprPct: -6, legs: { long: leg(0), short: leg(-6) } }));
  assert.equal(legsSentence(flat), 'At this hour’s rate the long on Phoenix pays nothing a year and the short on Orderly pays 6.0%: together the pair pays out 6.0%, before costs.');
  assert.equal(legsSentence(pairRow(win({ symbol: 'SOL', grossAprPct: 11.9 }))), 'The spread between Phoenix and Orderly is 11.9% a year at this hour\'s rates.');
});
