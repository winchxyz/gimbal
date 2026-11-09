// The live view owner's entry: which windows offer it, why one cannot, what the confirm says, and what is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enterConfirmText, enterState, OWNER_MAX_LOSS_USD } from './enter.ts';
import { venueName } from './format.ts';
import { confirmText, outcomeOf, sendVia, type ManualAction } from './manual.ts';
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
});

test('the confirm says both legs, the venues, the size per leg, the most it may lose, the contract, and flat only', () => {
  const text = enterConfirmText(win({ symbol: 'SOL', longVenue: 'phoenix', shortVenue: 'hyperliquid' }), venueName, 25);
  assert.match(text, /^Enter SOL: long on Phoenix and short on Hyperliquid, up to \$25 a leg/);
  assert.match(text, /more than \$1\.00/);
  assert.match(text, /NEAR AI risk check/);
  assert.match(text, /contract checks every order against your policy/);
  assert.match(text, /opens from flat only/);
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
  assert.match(outcomeOf(enter, { ok: true }).text, /checks SOL again, asks the NEAR AI risk check, then opens both legs/);
  assert.equal(confirmText(enter), 'Enter SOL now?');
});
