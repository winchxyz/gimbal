import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneLegCopy, orderlyRotateReason, refusedCopy, waitCopy } from './waitCopy.ts';

// The cost gate (decide.ts: gate `cost`) and the trader's reasons it carries (trade/carry-plan.ts: costRefusal).
const SPREAD = 'the expected spread over 3 days, $0.30, does not cover the round trip $0.52 (10.4 bps: 4 fills $0.20, slippage $0.12, basis buffer $0.20)';
const THIN = 'the phoenix book fills only $12.00 of $50.00 within the levels read: the round trip cannot be priced';
const NO_TOUCH = 'the hyperliquid book has no two-sided touch: the round trip cannot be priced';
const costGate = (why: string) => `No window clears the entry rules; best XLM 14.2 % net: the pair trader refused it for cost this hour: ${why}`;

test('the cost gate: the carry does not cover the round trip, and the desk tries again after the next hourly check', () => {
  assert.equal(
    waitCopy(costGate(SPREAD), { minNetAprPct: 5 }).text,
    'No market pays your 5 % minimum right now. Closest: XLM, 14.2 % net, but its carry does not cover the cost of opening and closing it ($0.30 expected over 3 days, against $0.52); the desk tries it again after the next hourly check, from zero.',
  );
  assert.equal(waitCopy(costGate(SPREAD)).mapped, true);
});

test('the cost gate: a book too thin to price the round trip, and an unknown cost reason', () => {
  assert.match(waitCopy(costGate(THIN), { minNetAprPct: 5 }).text, /but the Phoenix book is too thin to price opening and closing it; the desk tries it again after the next hourly check, from zero\.$/);
  assert.match(waitCopy(costGate(NO_TOUCH)).text, /but the Hyperliquid book is too thin to price/);
  assert.match(waitCopy(costGate('something new')).text, /but the pair trader would not open it for cost this hour; the desk tries it again after the next hourly check, from zero\.$/);
});

const HELD_OUT = (inner: string, tail = '; NEAR AI passed XLM') =>
  `enter xlm-phoenix-hyperliquid: open refused, nothing signed: ${inner}; xlm-phoenix-hyperliquid is held out of the entry rules until the hourly check at 2026-11-04T10:00:00.000Z and its hours start again${tail}`;

test('the loop line for an open refused for cost says when it is tried again', () => {
  const raw = HELD_OUT(SPREAD);
  const c = refusedCopy(raw);
  assert.equal(
    c?.text,
    'Opening xlm-phoenix-hyperliquid was refused: its carry does not cover the cost of opening and closing it ($0.30 expected over 3 days, against $0.52). It is out of the entry rules until the hourly check at 10:00 UTC, and its hours start again from zero.',
  );
  assert.equal(c?.raw, raw);
  assert.match(refusedCopy(HELD_OUT(THIN))?.text ?? '', /the Phoenix book is too thin to price opening and closing it\./);
});

test('an owner demo entry\'s refusal keeps the plain lead (the demo tag comes after it), so it reads the same', () => {
  const tag = '(owner demo entry: the profit checks are waived; round trip $0.04 estimated, at most $0.25 accepted) ';
  const raw = `enter xlm-phoenix-hyperliquid: ${tag}open refused, nothing signed: ${SPREAD}; xlm-phoenix-hyperliquid is held out of the entry rules until the hourly check at 2026-11-04T10:00:00.000Z and its hours start again; NEAR AI passed XLM`;
  const c = refusedCopy(raw);
  assert.equal(c?.mapped, true);
  assert.equal(c?.text, refusedCopy(HELD_OUT(SPREAD))?.text);
});

test('a rotation that closed the old pair first says the desk is flat; other refusals are left alone', () => {
  const raw = `rotate a-b: open refused, nothing signed: ${SPREAD}; a-b was closed, so the desk stays flat; b-c is held out of the entry rules until the hourly check at 2026-11-04T11:00:00.000Z and its hours start again; NEAR AI passed XLM`;
  assert.equal(refusedCopy(raw), null); // the window named differs from the one rotated into: not this shape
  const ok = `rotate a-b: open refused, nothing signed: ${SPREAD}; a-b was closed, so the desk stays flat; a-b is held out of the entry rules until the hourly check at 2026-11-04T11:00:00.000Z and its hours start again`;
  assert.match(refusedCopy(ok)?.text ?? '', /^Rotation into a-b was refused: .* at 11:00 UTC, and its hours start again from zero\. The old pair was closed, so the desk is flat\.$/);
  assert.equal(refusedCopy('enter xlm: open refused, nothing signed: the leverage is too high'), null);
  assert.equal(refusedCopy(''), null);
});

test('an enter or rotate the NEAR AI risk check held (no answer, no key, a rejected key) says it waits, not that it was refused', () => {
  const tail = 'held, not passed: the act waits; nothing sent; asked again at the next hourly check (2026-11-05T11:01:00.000Z); not a refusal, so no 6 h hold-out';
  const timeout = `enter sol-phoenix-hyperliquid not carried out: the NEAR AI risk check did not answer (no answer within 15 s, asked 2 times): ${tail}`;
  const c = refusedCopy(timeout);
  assert.equal(c?.mapped, true);
  assert.equal(c?.raw, timeout);
  assert.equal(c?.text, 'Opening sol-phoenix-hyperliquid is waiting: the NEAR AI risk check did not answer, so nothing was sent. '
    + 'The desk asks again at the next hourly check (11:01 UTC). This is not a refusal, so the market is not held out for 6 h.');
  assert.match(refusedCopy(`enter sol-phoenix-hyperliquid not carried out: no NEAR AI key, so the NEAR AI risk check cannot answer: ${tail}`)?.text ?? '',
    /^Opening sol-phoenix-hyperliquid is waiting: this engine has no NEAR AI key, so the NEAR AI risk check cannot answer\. Nothing was sent\./);
  assert.match(refusedCopy(`enter sol-phoenix-hyperliquid not carried out: NEAR AI key rejected (HTTP 401: invalid api key), so the NEAR AI risk check cannot answer: ${tail}`)?.text ?? '',
    /^Opening sol-phoenix-hyperliquid is waiting: NEAR AI rejected this engine's key/);
  // A rotate keeps the held pair; a manual (demo) one is not tried again by itself.
  const rotate = 'rotate sol-phoenix-hyperliquid -> eth-phoenix-hyperliquid not carried out: the NEAR AI risk check did not answer (NEAR AI answered HTTP 503: overloaded, asked 2 times): '
    + 'held, not passed: the act waits; sol-phoenix-hyperliquid is kept, nothing closed; asked again at the next hourly check (2026-11-05T11:01:00.000Z); not a refusal, so no 6 h hold-out';
  assert.equal(refusedCopy(rotate)?.text, 'Rotation from sol-phoenix-hyperliquid into eth-phoenix-hyperliquid is waiting: the NEAR AI risk check did not answer, so nothing was sent. '
    + 'sol-phoenix-hyperliquid is kept. The desk asks again at the next hourly check (11:01 UTC). This is not a refusal, so the market is not held out for 6 h.');
  const demo = 'enter zec-phoenix-hyperliquid not carried out: (owner demo entry: the profit checks are waived; round trip $0.04 estimated, at most $0.25 accepted) '
    + 'the NEAR AI risk check did not answer (no answer within 15 s, asked 2 times): held, not passed: the act waits; nothing sent; not tried again by itself: POST /rotate asks again; not a refusal, so no 6 h hold-out';
  assert.match(refusedCopy(demo)?.text ?? '', /^Opening zec-phoenix-hyperliquid is waiting: .* It is not tried again by itself: ask again with POST \/rotate\. This is not a refusal/);
});

test('hold lines in plain words', () => {
  assert.equal(
    waitCopy('Hold XLM: 12.0 % net of the exit, at least your 5 % minimum; day 2 of 7').text,
    'Holding XLM: it nets 12.0 % after the exit, at least your 5 % minimum. Day 2 of 7.',
  );
  assert.equal(
    waitCopy('Hold XLM: 3.0 % net of the exit, under your 5 % minimum, 2 of 6 hours before exit; day 3 of 7').text,
    'Holding XLM: it nets 3.0 % after the exit, under your 5 % minimum (2 of 6 hours before the desk exits). Day 3 of 7.',
  );
  assert.equal(
    waitCopy('Hold XLM: the spread flipped: this hour pays -1.0 %, 1 of 6 hours before exit; day 1 of 7').text,
    'Holding XLM: the spread has flipped, as this hour pays -1.0 % (1 of 6 hours before the desk exits). Day 1 of 7.',
  );
  assert.match(waitCopy('Hold XLM: the spread flipped: the 7-day spread is -0.5 %, 1 of 1 hour before exit; day 1 of 7').text, /the 7-day spread is -0\.5 % \(1 of 1 hours?/);
  assert.equal(
    waitCopy('Hold XLM: its window is not in this scan, so nothing is decided on it; day 2 of 7').text,
    'Holding XLM: its market is not in this scan, so the desk decides nothing on it for now. Day 2 of 7.',
  );
  assert.match(waitCopy('Hold XLM: its numbers are stale this scan, so nothing is decided on them; day 2 of 7').text, /^Holding XLM: its numbers are out of date this scan/);
});

test('hold lines with a rotation note', () => {
  const base = 'Hold XLM: 12.0 % net of the exit, at least your 5 % minimum; day 2 of 7';
  const head = 'Holding XLM: it nets 12.0 % after the exit, at least your 5 % minimum. Day 2 of 7.';
  assert.equal(waitCopy(`${base}; DOGE beats it by 4.2 pts, 2 of 4 hours`).text, `${head} DOGE beats it by 4.2 points: 2 of 4 hours toward a rotation.`);
  assert.equal(waitCopy(`${base}; DOGE beats it by 4.2 pts, but 3 rotations in 24 h is the most`).text, `${head} DOGE beats it by 4.2 points, but 3 rotations in 24 hours is the most the desk makes.`);
  assert.equal(waitCopy(`${base}; DOGE beats it by 4.2 pts, but its switch cost is not known`).text, `${head} DOGE beats it by 4.2 points, but its switch cost is not known.`);
  assert.equal(
    waitCopy(`${base}; DOGE beats it by 4.2 pts, but the $1.20 switch takes 5.5 days to pay back, 3.0 are left`).text,
    `${head} DOGE beats it by 4.2 points, but switching costs $1.20 and takes 5.5 days to pay back, with 3.0 left.`,
  );
  assert.equal(waitCopy(`${base}; your rotation rule is not a number: no rotation`).text, `${head} Your rotation rule is not a number, so the desk will not rotate.`);
  assert.match(waitCopy(`${base}; DOGE beats it by 4.2 pts, but $1.00 free margin on Phoenix at 2x leaves nothing to open`).text, /DOGE beats it by 4\.2 points, but Phoenix has only \$1\.00 free margin/);
  const odd = waitCopy(`${base}; something odd`);
  assert.equal(odd.text, `${head} something odd`);
  assert.equal(odd.mapped, false);
});

test('a hold line nothing knows comes back as sent', () => {
  const raw = 'Hold XLM: something else entirely; day 2 of 7';
  assert.deepEqual(waitCopy(raw), { text: raw, raw, mapped: false });
  assert.equal(waitCopy('Hold XLM').mapped, false);
});

const HANDS = 'No window clears the entry rules; best BONK 14.8 % net: serve opens short hyperliquid, long phoenix only (as pair-mainnet open); bonk-orderly-hyperliquid is long orderly, short hyperliquid';

const OFF_NOTE = "but the desk can't open it (it is long Orderly / short Hyperliquid, and this engine opens only long Phoenix / short Hyperliquid because Orderly pairs are switched off)";

test('the hands refusal with Orderly pairs off says what the desk can open, and names the closest window', () => {
  const c = waitCopy(HANDS, { minNetAprPct: 5 });
  assert.equal(c.text, `No market pays your 5 % minimum right now. Closest: BONK, 14.8 % net, ${OFF_NOTE}.`);
  assert.equal(c.mapped, true);
  assert.equal(c.raw, HANDS);
});

test('the same refusal for a pair that is not Orderly only names the direction; the id tail is optional', () => {
  const wrongWay = HANDS.replace('is long orderly, short hyperliquid', 'is long hyperliquid, short phoenix');
  assert.match(waitCopy(wrongWay, { minNetAprPct: 5 }).text, /but the desk can't open it \(it is long Hyperliquid \/ short Phoenix, and this engine opens only long Phoenix \/ short Hyperliquid\)\.$/);
  const noTail = 'No window clears the entry rules; best BONK 14.8 % net: serve opens short hyperliquid, long phoenix only (as pair-mainnet open)';
  assert.match(waitCopy(noTail).text, /but the desk can't open it \(this engine opens only long Phoenix \/ short Hyperliquid pairs\)\.$/);
});

test('with Orderly pairs on, a window outside the three venues, and the markets both legs list', () => {
  const venues = 'No window clears the entry rules; best BONK 14.8 % net: serve opens a pair on two of hyperliquid, orderly, phoenix; bonk-lighter-hyperliquid is long lighter, short hyperliquid';
  const v = waitCopy(venues, { minNetAprPct: 5 });
  assert.equal(
    v.text,
    'No market pays your 5 % minimum right now. Closest: BONK, 14.8 % net, but the desk opens a pair only on two of Hyperliquid, Orderly and Phoenix (this one is long Lighter / short Hyperliquid).',
  );
  assert.equal(v.mapped, true);
  const policy = "No window clears the entry rules; best ZRO 12.0 % net: ZRO is not a market both legs (long orderly, short hyperliquid) list in the desk's policy (BTC, ETH)";
  assert.equal(
    waitCopy(policy, { minNetAprPct: 5 }).text,
    'No market pays your 5 % minimum right now. Closest: ZRO, 12.0 % net, but ZRO is not in your policy on both Orderly and Hyperliquid.',
  );
});

test('without the owner’s minimum the sentence does not invent one', () => {
  assert.match(waitCopy(HANDS).text, /^No market passes your entry rules right now\. Closest: BONK, 14\.8 % net, but the desk can't open it/);
  assert.match(waitCopy(HANDS, { minNetAprPct: 7.5 }).text, /^No market pays your 7\.5 % minimum right now\./);
  assert.match(waitCopy(HANDS, { minNetAprPct: null }).text, /^No market passes your entry rules/);
});

test('a window under the minimum reads the minimum from the engine’s own line', () => {
  const raw = 'No window clears the entry rules; best LTC 8.1 % net: 8.1 % net, under your 10 % minimum';
  assert.equal(waitCopy(raw).text, 'No market pays your 10 % minimum right now. Closest: LTC, 8.1 % net.');
});

test('the policy market refusal', () => {
  const raw = "No window clears the entry rules; best ZRO 12.0 % net: ZRO is not a market both legs list in the desk's policy (BTC, ETH)";
  assert.equal(
    waitCopy(raw, { minNetAprPct: 5 }).text,
    'No market pays your 5 % minimum right now. Closest: ZRO, 12.0 % net, but ZRO is not one of the markets in your policy.',
  );
});

test('the margin refusal gets one sentence', () => {
  const raw = 'No window clears the entry rules; best DOGE 9.1 % net: $4.20 free margin on Phoenix at 2x opens $0.00 a leg in whole lots, under the $5.00 minimum: the loop does not move margin to open';
  assert.equal(
    waitCopy(raw, { minNetAprPct: 5 }).text,
    'No market pays your 5 % minimum right now. Closest: DOGE, 9.1 % net, but Phoenix has only $4.20 free margin, too little to open a leg, and the desk does not move margin to open.',
  );
});

test('the margin refusal names an Orderly leg too', () => {
  const raw = 'No window clears the entry rules; best DOGE 9.1 % net: $0.00 free margin on Orderly at 2x opens $0.00 a leg in whole lots, under the $5.00 minimum: the loop does not move margin to open';
  assert.equal(
    waitCopy(raw, { minNetAprPct: 5 }).text,
    'No market pays your 5 % minimum right now. Closest: DOGE, 9.1 % net, but Orderly has only $0.00 free margin, too little to open a leg, and the desk does not move margin to open.',
  );
  assert.match(waitCopy('XLM 14.2 % net is ready, but $2.00 free margin on Orderly at 3x leaves nothing to open').text, /^XLM is ready at 14\.2 % net, but Orderly has only \$2\.00 free margin/);
});

test('the cost refusals: the carry does not pay the round trip, or nets under the minimum', () => {
  const never = 'No window clears the entry rules; best SOL 6.0 % net: Over a 3-day hold (assumed: the engine rules set none), the 7-day spread of 4.0 % APR (the smaller of the 7- and 14-day means) pays $0.30 at $50.00 a leg, no more than the $0.52 round trip (4 fills $0.20, slippage $0.12, basis buffer $0.20; 10.4 bps): it never pays it back';
  assert.equal(
    waitCopy(never, { minNetAprPct: 5 }).text,
    'No market pays your 5 % minimum right now. Closest: SOL, 6.0 % net, but its carry does not cover the $0.52 cost of opening and closing it (it never pays it back).',
  );
  const days = never.replace('it never pays it back', 'it takes 6.5 days to pay it back');
  assert.match(waitCopy(days).text, /\(6\.5 days to pay it back\)\.$/);
  const only = 'No window clears the entry rules; best SOL 6.0 % net: Over a 3-day hold (assumed), the 7-day spread of 9.0 % APR pays $1.00 at $50.00 a leg, more than the $0.52 round trip (4 fills), but it nets only 3.1 % APR over the hold, under your 5 % minimum';
  assert.equal(
    waitCopy(only).text,
    'No market passes your entry rules right now. Closest: SOL, 6.0 % net, but after costs it nets only 3.1 % over a typical hold, under your 5 % minimum.',
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
  assert.equal(c.text, 'No market pays your 5 % minimum right now. Closest: X, 9.0 % net: Books 30 s old.');
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
    `Cooling down after the last exit, 3.2 h left. No market pays your 5 % minimum right now. Closest: BONK, 14.8 % net, ${OFF_NOTE}.`,
  );
  assert.equal(waitCopy('Auto is off: the engine watches and you act by hand; the desk holds BONK').text, 'Auto is off, so the desk only watches and you act by hand.');
  assert.match(waitCopy('GIMBAL_TRADE is not 1: the engine watches, rescues and journals, and trades nothing').text, /^Trading is switched off on this engine/);
  assert.equal(waitCopy('No desk window in this scan').text, 'None of the markets in the last scan is one the desk can trade.');
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

const NOT_ASKED = 'NEAR AI risk check: not asked (refused before it)';
const ORDERLY_HELD = "the held XLM pair has an Orderly leg (PERP_XLM_USDC): its close arms the trader's replay watch (Orderly takes a signed copy of an order for up to 300 s), so no other pair could open after it and the rotate would leave the desk flat";

test('a rotation out of a pair with an Orderly leg is refused before the risk check, and says the pair stays', () => {
  const raw = `rotate xlm-phoenix-orderly -> doge-phoenix-hyperliquid not carried out: ${ORDERLY_HELD}; xlm-phoenix-orderly is kept, nothing closed; ${NOT_ASKED}`;
  const c = refusedCopy(raw);
  assert.equal(
    c?.text,
    'Rotation from xlm-phoenix-orderly into doge-phoenix-hyperliquid was refused. The held XLM pair has an Orderly leg. Orderly takes a signed copy of an order for up to 5 minutes, so closing the leg blocks every new open for that long, and a rotation would leave the desk flat. The pair exits on its own rules instead. Nothing was closed, and the NEAR AI risk check was not asked.',
  );
  assert.equal(c?.raw, raw);
  // A manual rotate goes through the risk check first: its line ends with the check's own text.
  const manual = `rotate a -> b not carried out: ${ORDERLY_HELD}; a is kept, nothing closed; NEAR AI passed XLM`;
  assert.match(refusedCopy(manual)?.text ?? '', /^Rotation from a into b was refused\. .* Nothing was closed\.$/);
  // Any other reason for a kept pair is left alone.
  assert.equal(refusedCopy('rotate a -> b not carried out: the stored price is missing; a is kept, nothing closed; NEAR AI passed XLM'), null);
});

test('the engine’s manual-rotate answer for an Orderly leg reads as sentences', () => {
  assert.match(orderlyRotateReason(`not rotated: ${ORDERLY_HELD}`) ?? '', /^The held XLM pair has an Orderly leg\. Orderly takes a signed copy/);
  assert.equal(orderlyRotateReason('the engine is not running yet'), null);
});

test('an open the hands refuse is journaled before the risk check, in plain words for both flag states', () => {
  const off = `enter bonk-orderly-hyperliquid not carried out: serve opens short hyperliquid, long phoenix only (as pair-mainnet open); bonk-orderly-hyperliquid is long orderly, short hyperliquid; ${NOT_ASKED}`;
  assert.equal(
    refusedCopy(off)?.text,
    "Opening bonk-orderly-hyperliquid was refused: the desk can't open it (it is long Orderly / short Hyperliquid, and this engine opens only long Phoenix / short Hyperliquid because Orderly pairs are switched off). The NEAR AI risk check was not asked.",
  );
  const on = `rotate a-b not carried out: BONK is not a market both legs (long orderly, short phoenix) list in the desk's policy (ETH); ${NOT_ASKED}`;
  assert.equal(
    refusedCopy(on)?.text,
    'Rotation into a-b was refused: BONK is not in your policy on both Orderly and Phoenix. The NEAR AI risk check was not asked.',
  );
  assert.equal(refusedCopy(`enter a-b not carried out: the window is not in the last scan; ${NOT_ASKED}`)?.text, 'Opening a-b was refused: it is not in the last scan. The NEAR AI risk check was not asked.');
  assert.equal(refusedCopy(`enter a-b not carried out: something new; ${NOT_ASKED}`), null);
});

test('the lone-leg close: closing, failed and tried again, and not closed this check', () => {
  const closing = oneLegCopy('one leg open: orderly 1.5: closing it, reduce-only');
  assert.equal(closing?.text, 'Only one leg is open: 1.5 on Orderly. The desk is closing it with a reduce-only order.');
  assert.equal(
    oneLegCopy('one leg open: orderly 1.5: closing it, reduce-only; the last close failed, next try at 2026-11-04T10:05:30.000Z')?.text,
    'Only one leg is open: 1.5 on Orderly. The last close failed, so the desk tries again at 10:05 UTC.',
  );
  const failed = 'one leg open: orderly 1.5: the close did not end flat: Orderly rejected the order; tried again in 2 min 40 s';
  assert.equal(
    oneLegCopy(failed)?.text,
    'Only one leg is open: 1.5 on Orderly. The close did not finish: Orderly rejected the order. The desk tries again in 2 min 40 s.',
  );
  assert.equal(oneLegCopy(failed)?.raw, failed);
  assert.equal(
    oneLegCopy('one leg open: phoenix 3: not closed this check, a rescue is running')?.text,
    'Only one leg is open: 3 on Phoenix. It was not closed this check: a rescue is running.',
  );
  assert.equal(oneLegCopy('one leg open: phoenix 3: something new'), null);
  assert.equal(oneLegCopy('Hold XLM: x; day 1 of 7'), null);
  // The Desk line (an exit decision) goes through waitCopy.
  assert.equal(waitCopy('one leg open: orderly 1.5: closing it, reduce-only').text, closing?.text);
  assert.equal(waitCopy('one leg open: orderly 1.5: closing it, reduce-only').mapped, true);
});
