// The live view owner's entry: which windows offer it, why one cannot, what the confirm says, and what is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '@gimbal/shared';
import { actingText, enterConfirmText, enterState, entryReason, entryResult, isOwnerEntryOn, OWNER_MAX_LOSS_USD, type PendingEntry } from './enter.ts';
import { venueName } from './format.ts';
import { actingOf, confirmText, outcomeOf, sendVia, type ManualAction } from './manual.ts';
import { win } from './testing.ts';

test('a tradable window from flat is open; the held one and watch-only ones offer nothing', () => {
  const sol = win({ symbol: 'SOL' });
  assert.deepEqual(enterState(sol, [sol]), { kind: 'open' });
  // The profit checks failing does not hide it: the engine waives those for an owner entry and says if anything else fails.
  const below = win({ symbol: 'ETH', checks: [{ ok: false, text: 'net 2 % is under your 5 % minimum' }] });
  assert.deepEqual(enterState(below, [below]), { kind: 'open' });
  assert.deepEqual(enterState(win({ tradable: false }), []), { kind: 'none' });
  const held = win({ symbol: 'XLM', held: { since: 1 } });
  assert.deepEqual(enterState(held, [held]), { kind: 'none' });
});

test('contract refusals, no desk, stale numbers, a NEAR AI refusal and a held pair keep it disabled, with why', () => {
  const reason = (w: ReturnType<typeof win>, all = [w]) => {
    const s = enterState(w, all);
    assert.equal(s.kind, 'blocked');
    return (s as { reason: string }).reason;
  };
  assert.match(reason(win({ refused: { code: 'E_ASSET', reason: 'market not in the policy' } })), /^The contract would refuse it \(E_ASSET\): Market not in the policy/);
  assert.match(reason(win({ refused: { code: 'E_SIZE', reason: 'over max_notional_usd' } })), /\(E_SIZE\)/);
  assert.match(reason(win({ refused: { code: 'E_NO_DESK', reason: 'no desk' } })), /no desk/);
  assert.match(reason(win({ stale: true })), /stale/);
  assert.match(reason(win({ veto: { verdict: 'veto', reasons: ['thin book'], model: 'm', at: 1 } })), /NEAR AI risk check refused it/);
  const heldXlm = win({ symbol: 'XLM', held: { since: 1 } });
  assert.match(reason(win({ symbol: 'SOL' }), [heldXlm, win({ symbol: 'SOL' })]), /^XLM is held\. An owner entry opens from flat only: close XLM first\.$/);
  // Auto off in the engine rules: the engine refuses every entry, so the button says why. Unknown (not read yet): open.
  const sol = win({ symbol: 'SOL' });
  assert.deepEqual(enterState(sol, [sol], false), { kind: 'blocked', reason: 'Auto is off in the engine rules, and the engine opens nothing while it is off.' });
  assert.deepEqual(enterState(sol, [sol], true), { kind: 'open' });
  assert.deepEqual(enterState(sol, [sol], null), { kind: 'open' });
});

test('the confirm says both legs, the venues, the size per leg, the most it may lose, the contract, and flat only', () => {
  const text = enterConfirmText(win({ symbol: 'SOL', longVenue: 'phoenix', shortVenue: 'hyperliquid' }), venueName, 25);
  assert.match(text, /^Enter SOL: long on Phoenix and short on Hyperliquid, up to \$25 a leg/);
  assert.match(text, /more than \$1\.00/);
  assert.match(text, /NEAR AI risk check/);
  assert.match(text, /contract checks every order against your policy/);
  assert.match(text, /opens from flat only/);
  assert.match(text, /maker orders first; what they leave after the maker window is taken with a taker order, within the same caps/);
  assert.doesNotMatch(text, /veto/i);
  assert.match(enterConfirmText(win(), venueName, null), /at the engine rules’ leg size/);
  assert.equal(OWNER_MAX_LOSS_USD, 1);
});

test('the entry is POST /rotate with demo { maxLossUsd }; the answers read as the other overrides do', async () => {
  const enter: ManualAction = { kind: 'enter', symbol: 'SOL', windowId: 'sol-phoenix-orderly', maxLossUsd: 1 };
  const calls: unknown[][] = [];
  const api = {
    rotate: async (...args: unknown[]) => (calls.push(args), { ok: false as const, reason: 'auto is off: nothing new is opened' }),
    close: async () => ({ ok: true as const }),
  };
  const out = await sendVia(api, enter);
  assert.deepEqual(calls, [['sol-phoenix-orderly', { maxLossUsd: 1 }]]);
  assert.deepEqual(out, { tone: 'refused', title: 'Not sent', text: 'The engine refused it. Auto is off: nothing new is opened. Nothing was opened.' });
  assert.equal(confirmText(enter), 'Enter SOL now?');
});

// ---------- after Enter: started, still running, and the act's result from the Journal ----------

const enterSol: ManualAction = { kind: 'enter', symbol: 'SOL', windowId: 'sol-phoenix-orderly', maxLossUsd: 1 };
const DEMO_ACTING = 'POST /rotate sol-phoenix-orderly (owner demo entry, at most $1.00)';

test('a 200 on Enter says the entry started, names the symbol, the maker then taker orders, and the Journal', () => {
  const started = outcomeOf(enterSol, { ok: true });
  assert.equal(started.tone, 'sent');
  assert.equal(started.title, 'Entry started');
  assert.match(`${started.title}: ${started.text}`, /^Entry started: SOL, .*watch the Journal\.$/);
  assert.match(started.text, /maker orders, then a taker order for what they leave, within the caps/);
  assert.doesNotMatch(started.text, /veto/i);
});

test('a 409 while the loop acts reads as the entry still running, never as "Not sent … Nothing was opened"', () => {
  const busy = outcomeOf(enterSol, { ok: false, reason: `the strategy loop is acting (${DEMO_ACTING}): try again when it is done` });
  assert.equal(busy.tone, 'running');
  assert.equal(busy.title, 'Still running');
  assert.match(busy.text, /^Your entry is still running\./);
  assert.doesNotMatch(busy.text, /Nothing was opened|refused/);
  assert.equal(actingOf(`the strategy loop is acting (${DEMO_ACTING}): try again when it is done`), DEMO_ACTING);
  assert.equal(actingOf('auto is off: nothing new is opened'), null);
  // The loop's own act, or a close: busy, said as what it is.
  assert.match(outcomeOf(enterSol, { ok: false, reason: 'the strategy loop is acting (enter zec-hyperliquid-phoenix): try again when it is done' }).text, /^The engine is acting \(enter zec-hyperliquid-phoenix\)\./);
  assert.match(outcomeOf(enterSol, { ok: false, reason: 'the strategy loop is acting (POST /close): try again when it is done' }).text, /^A close is running\./);
});

test('while the loop acts, Enter is disabled on every window with why; nothing acting leaves it open', () => {
  const sol = win({ symbol: 'SOL' });
  const eth = win({ symbol: 'ETH' });
  for (const w of [sol, eth]) {
    assert.deepEqual(enterState(w, [sol, eth], true, DEMO_ACTING), { kind: 'blocked', reason: actingText(DEMO_ACTING) });
  }
  assert.match(actingText(DEMO_ACTING), /^Your entry is still running\. .*watch the Journal\.$/);
  assert.deepEqual(enterState(sol, [sol], true, null), { kind: 'open' });
  assert.deepEqual(enterState(sol, [sol], true, ''), { kind: 'open' });
  // A held or watch-only window still offers nothing at all.
  assert.deepEqual(enterState(win({ tradable: false }), [], true, DEMO_ACTING), { kind: 'none' });
});

const line = (id: string, kind: JournalEntry['kind'], summary: string, numbers: JournalEntry['numbers'] = { window: 'sol-phoenix-orderly' }): JournalEntry =>
  ({ id, t: 1, kind, summary, numbers, tx: [] });
const TAG = '(owner demo entry: the profit checks are waived; round trip $0.04 estimated (+ $0.10 for a taker fallback after the maker window), at most $1.00 accepted)';
const pending = (seen: string[] = []): PendingEntry => ({ windowId: 'sol-phoenix-orderly', symbol: 'SOL', seen: new Set(seen) });

test('the act’s result comes from its Journal line: opened, opened by the taker fallback, partly, or not opened and why', () => {
  const older = line('a', 'refused', `enter sol-phoenix-orderly not carried out: ${TAG} an older refusal; nothing sent`);
  // Nothing new yet, or only lines of other windows and kinds: still waiting.
  assert.equal(entryResult([older], pending(['a'])), null);
  assert.equal(entryResult([line('b', 'wait', 'waiting'), line('c', 'refused', 'enter eth-x not carried out', { window: 'eth-phoenix-orderly' }), older], pending(['a'])), null);

  // The leg is numbers.legUsd (as sized); `usd` is the line's money effect, never shown as the leg.
  const opened = line('d', 'enter', `enter sol-phoenix-orderly, SOL short orderly, long phoenix, at most 0.2 SOL (20 USD) a leg at 2x, 8.6 % net (POST /rotate (manual)); ${TAG.slice(1, -1)}; risk ok; opened`, { window: 'sol-phoenix-orderly', legUsd: 20, usd: -0.01 });
  assert.deepEqual(entryResult([opened, older], pending(['a'])), { kind: 'opened', text: 'Opened SOL: both legs are open, $20.00 a leg. It shows on the Desk.' }, 'the demo tag naming the fallback’s cost is not a fallback');
  const byTaker = { ...opened, summary: `${opened.summary} (taker fallback: hyperliquid SELL IOC 500000 after the maker window filled 0.1 at 2512)` };
  assert.match(entryResult([byTaker], pending())!.text, /the taker fallback took the rest/);

  // Not opened: the reason after the window id, without the owner entry's tag, the symbol's lead and the later clauses.
  const maker = line('e', 'refused', `enter sol-phoenix-orderly: ${TAG} SOL not opened: the maker window filled nothing (hyperliquid post-only; no fill); NEAR AI risk check: passed`);
  assert.deepEqual(entryResult([maker], pending()), { kind: 'not', text: 'Not opened: The maker window filled nothing (hyperliquid post-only; no fill).' });
  const cost = line('f', 'refused', 'POST /rotate sol-phoenix-orderly not carried out: (owner demo entry, at most $1.00) its round trip, $0.90, plus $0.10 for the taker fallback is over the $1.00');
  assert.equal(entryResult([cost], pending())!.text, 'Not opened: Its round trip, $0.90, plus $0.10 for the taker fallback is over the $1.00.');
  // A refusal written without numbers still names its window.
  assert.equal(entryResult([line('g', 'refused', 'enter sol-phoenix-orderly not carried out: no lots; NEAR AI risk check: not asked', {})], pending())!.text, 'Not opened: No lots.');
  assert.deepEqual(entryResult([line('h', 'veto', `sol-phoenix-orderly ${TAG}: refused; not entered`)], pending()), { kind: 'not', text: 'Not opened: the NEAR AI risk check refused SOL. Nothing was sent.' });
  const partly = line('i', 'error', `enter sol-phoenix-orderly: ${TAG} one leg only filled; the venues hold SOL: held from now; ok`, { window: 'sol-phoenix-orderly', heldLegUsd: 10 });
  assert.deepEqual(entryResult([partly], pending()), { kind: 'partly', text: 'Opened SOL, partly: One leg only filled. The desk holds it from now.' });
  // The first new line is the result, even when later ones follow.
  assert.equal(entryResult([opened, maker], pending())!.kind, 'not');
  assert.doesNotMatch(JSON.stringify([maker, cost, partly].map((e) => entryResult([e], pending()))), /veto/i);
});

test('entryReason keeps parentheses inside the reason and falls back when there is none', () => {
  assert.equal(entryReason('enter w-1: (a (b; c) d) X not opened: cause (x; y); later', 'w-1', 'X'), 'Cause (x; y).');
  assert.equal(entryReason('enter w-1 not carried out: ', 'w-1', 'X'), 'The Journal has the reason.');
});

test('a window id is matched whole: an entry on sol-phoenix is not one on sol-phoenix-orderly', () => {
  assert.equal(isOwnerEntryOn(DEMO_ACTING, 'sol-phoenix-orderly'), true);
  assert.equal(isOwnerEntryOn(DEMO_ACTING, 'sol-phoenix'), false);
  assert.equal(isOwnerEntryOn('POST /rotate sol-phoenix-orderly', 'sol-phoenix-orderly'), false, 'a plain rotate is not an owner entry');
  const short: PendingEntry = { windowId: 'sol-phoenix', symbol: 'SOL', seen: new Set() };
  assert.equal(entryResult([line('x', 'refused', 'enter sol-phoenix-orderly not carried out: no lots', {})], short), null);
  assert.equal(entryResult([line('y', 'refused', 'enter sol-phoenix not carried out: no lots', {})], short)!.text, 'Not opened: No lots.');
});
