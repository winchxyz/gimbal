import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitCopy } from './waitCopy.ts';

const HANDS = 'No window clears the entry rules; best BONK 14.8 % net: serve opens short hyperliquid, long phoenix only (as pair-mainnet open); bonk-orderly-hyperliquid is long orderly, short hyperliquid';

test('the hands refusal says what the desk can open, and names the closest window', () => {
  const c = waitCopy(HANDS, { minNetAprPct: 5 });
  assert.equal(
    c.text,
    "No window clears your 5 % minimum right now. Closest: BONK, 14.8 % net, but the desk can't open it (it trades long Phoenix / short Hyperliquid only).",
  );
  assert.equal(c.mapped, true);
  assert.equal(c.raw, HANDS);
});

test('without the owner’s minimum the sentence does not invent one', () => {
  assert.match(waitCopy(HANDS).text, /^No window clears your entry rules right now\. Closest: BONK, 14\.8 % net, but the desk can't open it/);
  assert.match(waitCopy(HANDS, { minNetAprPct: 7.5 }).text, /^No window clears your 7\.5 % minimum right now\./);
  assert.match(waitCopy(HANDS, { minNetAprPct: null }).text, /^No window clears your entry rules/);
});

test('a window under the minimum reads the minimum from the engine’s own line', () => {
  const raw = 'No window clears the entry rules; best LTC 8.1 % net: 8.1 % net, under your 10 % minimum';
  assert.equal(waitCopy(raw).text, 'No window clears your 10 % minimum right now. Closest: LTC, 8.1 % net.');
});

test('the policy market refusal', () => {
  const raw = "No window clears the entry rules; best ZRO 12.0 % net: ZRO is not a market both legs list in the desk's policy (BTC, ETH)";
  assert.equal(
    waitCopy(raw, { minNetAprPct: 5 }).text,
    'No window clears your 5 % minimum right now. Closest: ZRO, 12.0 % net, but ZRO is not one of the markets in your policy.',
  );
});

test('the margin refusal gets one sentence', () => {
  const raw = 'No window clears the entry rules; best DOGE 9.1 % net: $4.20 free margin on Phoenix at 2x opens $0.00 a leg in whole lots, under the $5.00 minimum: the loop does not move margin to open';
  assert.equal(
    waitCopy(raw, { minNetAprPct: 5 }).text,
    'No window clears your 5 % minimum right now. Closest: DOGE, 9.1 % net, but Phoenix has only $4.20 free margin, too little to open a leg, and the desk does not move margin to open.',
  );
});

test('the cost refusals: the carry does not pay the round trip, or nets under the minimum', () => {
  const never = 'No window clears the entry rules; best SOL 6.0 % net: Over a 3-day hold (assumed: the engine rules set none), the 7-day spread of 4.0 % APR (the smaller of the 7- and 14-day means) pays $0.30 at $50.00 a leg, no more than the $0.52 round trip (4 fills $0.20, slippage $0.12, basis buffer $0.20; 10.4 bps): it never pays it back';
  assert.equal(
    waitCopy(never, { minNetAprPct: 5 }).text,
    'No window clears your 5 % minimum right now. Closest: SOL, 6.0 % net, but its carry does not cover the $0.52 cost of opening and closing it (it never pays it back).',
  );
  const days = never.replace('it never pays it back', 'it takes 6.5 days to pay it back');
  assert.match(waitCopy(days).text, /\(6\.5 days to pay it back\)\.$/);
  const only = 'No window clears the entry rules; best SOL 6.0 % net: Over a 3-day hold (assumed), the 7-day spread of 9.0 % APR pays $1.00 at $50.00 a leg, more than the $0.52 round trip (4 fills), but it nets only 3.1 % APR over the hold, under your 5 % minimum';
  assert.equal(
    waitCopy(only).text,
    'No window clears your entry rules right now. Closest: SOL, 6.0 % net, but after costs it nets only 3.1 % over a typical hold, under your 5 % minimum.',
  );
});

test('the other gates: history, spreads, capacity, risk check, stale numbers, watch only', () => {
  const closest = (gate: string) => waitCopy(`No window clears the entry rules; best X 9.0 % net: ${gate}`, { minNetAprPct: 5 }).text;
  assert.match(closest('watch only'), /but it is watch-only, so the desk will not trade it\.$/);
  assert.match(closest('its numbers are stale'), /but its numbers are out of date\.$/);
  assert.match(closest('no 7-day spread yet'), /but it has no 7-day spread yet\.$/);
  assert.match(closest('the 14-day spread is -2.0 %'), /but its 14-day spread is -2\.0 %\.$/);
  assert.match(closest('this hour pays -1.0 %: it does not agree with the multi-day spread'), /but this hour pays -1\.0 %, against its multi-day trend\.$/);
  assert.match(closest('capacity $900.00, under the $2,000.00 a $50.00 leg needs'), /but its market is too thin for a \$50\.00 leg \(capacity \$900\.00\)\.$/);
  assert.match(closest('refused by the NEAR AI risk check: one spike, held out for 3.5 h more'), /but the NEAR AI risk check refused it, so it is held out for 3\.5 h more\.$/);
  assert.match(closest('No 7-day funding history on both legs yet: the spread is not known'), /no 7-day funding history on both legs yet\.$/);
  assert.match(closest('14-day history loading: the 7-day spread of 5.0 % APR is in'), /its 14-day history is still loading\.$/);
  assert.match(closest('The 7-day spread (5.0 % APR) and the 14-day spread (-1.0 % APR) point opposite ways: no steady carry'), /point opposite ways\.$/);
});

test('an unknown gate keeps the engine’s words inside a known frame, and is not marked as mapped', () => {
  const c = waitCopy('No window clears the entry rules; best X 9.0 % net: Books 30 s old', { minNetAprPct: 5 });
  assert.equal(c.text, 'No window clears your 5 % minimum right now. Closest: X, 9.0 % net: Books 30 s old.');
  assert.equal(c.mapped, false);
});

test('a veto of another window rides along as its own sentence', () => {
  const raw = `${HANDS}; ETH refused by the NEAR AI risk check: thin book, held out for 2.0 h more`;
  assert.match(waitCopy(raw, { minNetAprPct: 5 }).text, / ETH was refused by the NEAR AI risk check and is held out for 2\.0 h more\.$/);
});

test('a window warming up toward its hours', () => {
  assert.equal(
    waitCopy('XLM 14.2 % net, 2 of 3 hours above 10 %').text,
    'XLM clears your 10 % minimum at 14.2 % net. The desk opens it after 3 hours in a row: 2 so far.',
  );
  assert.match(waitCopy('XLM 14.2 % net, 0 of 1 hours above 10 %; its price refreshes first').text, /after 1 hour in a row: 0 so far\.$/);
});

test('a window ready but not sizable', () => {
  assert.equal(
    waitCopy('XLM 14.2 % net is ready, but $2.00 free margin on Hyperliquid at 3x leaves nothing to open').text,
    'XLM is ready at 14.2 % net, but Hyperliquid has only $2.00 free margin, too little to open a leg.',
  );
  assert.match(waitCopy('XLM 14.2 % net is ready, but no lot sizes for XLM: its size cannot be rounded to whole lots').text, /lot sizes are not known yet/);
  const odd = waitCopy('XLM 14.2 % net is ready, but something new');
  assert.equal(odd.text, 'XLM is ready at 14.2 % net, but the desk cannot size it: something new.');
  assert.equal(odd.mapped, false);
});

test('cooling down, auto off, trading off, no window, unknown held numbers', () => {
  assert.equal(
    waitCopy(`Cooling down after the exit, 3.2 h left; ${HANDS.replace('No', 'no')}`, { minNetAprPct: 5 }).text,
    "Cooling down after the last exit, 3.2 h left. No window clears your 5 % minimum right now. Closest: BONK, 14.8 % net, but the desk can't open it (it trades long Phoenix / short Hyperliquid only).",
  );
  assert.equal(waitCopy('Auto is off: the engine watches and you act by hand; the desk holds BONK').text, 'Auto is off, so the desk only watches and you act by hand.');
  assert.match(waitCopy('GIMBAL_TRADE is not 1: the engine watches, rescues and journals, and trades nothing').text, /^Trading is switched off on this engine/);
  assert.equal(waitCopy('No desk window in this scan').text, 'None of the windows in the last scan is one the desk can trade.');
  assert.equal(
    waitCopy('Held pair numbers unknown: BONK P&L is not a number (NaN); nothing is decided on BONK').text,
    'Some numbers for the held BONK pair are missing, so the desk leaves it alone until they are back.',
  );
});

test('a string nothing knows comes back as sent, trimmed', () => {
  const c = waitCopy('  Hold BONK: 14.8 % net; day 2  ');
  assert.deepEqual(c, { text: 'Hold BONK: 14.8 % net; day 2', raw: 'Hold BONK: 14.8 % net; day 2', mapped: false });
  assert.equal(waitCopy('').text, '');
  assert.equal(waitCopy('Cooling down after the exit, 1.0 h left; something odd').mapped, false);
});
