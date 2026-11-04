// The engine's remote view masks the owner's and the operator's account ids ("gimb…near") and any standalone 64-hex string
// ("abcd…wxyz"). A page that reads the view must show them as plain labels: no explorer link, no "is this my account".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState } from '@gimbal/shared';
import { isAccountId, isMasked, proofLinks, shortId, contractUrl } from '../journal/entry.ts';
import { nearUrl } from '../security/explorer.ts';
import { parseEngineState } from '../stream/api.ts';
import { FAKE_STRATEGY } from '../stream/fake-windows.ts';
import { statusOf } from '../shell/status.ts';

const OWNER = 'gimb…near';
const OPERATOR = 'oper…near';
const DIGEST = 'ab12…ef90';

const desk = (overrides: Partial<DeskState> = {}): DeskState => ({
  deskId: 'main',
  owner: OWNER,
  contract: 'gimbal.near',
  mode: 'mainnet',
  legs: [],
  netDelta: 0,
  equityUsd: 1000,
  reserveUsd: 40,
  pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 },
  health: 'level',
  paused: null,
  rescueFailure: null,
  updatedAt: 0,
  ...overrides,
});

test('a state with masked accounts and digests is read like any other', () => {
  const state = parseEngineState({
    mode: 'mainnet',
    at: 1,
    windows: null,
    scan: null,
    strategy: FAKE_STRATEGY,
    desk: desk({ paused: { by: OPERATOR, at: 5 } }),
    journal: [{ id: 'e1', t: 1, kind: 'deposit', summary: `Deposit from ${OWNER}`, numbers: { digest: DIGEST }, tx: [] }],
    rescue: null,
    setup: null,
    health: null,
    decision: null,
  });
  assert.equal(state.desk?.owner, OWNER);
  assert.equal(state.desk?.paused?.by, OPERATOR);
  assert.equal(state.journal[0]?.numbers.digest, DIGEST);
});

test('a masked account is not an account id, so nothing links it', () => {
  for (const masked of [OWNER, OPERATOR, DIGEST]) {
    assert.equal(isMasked(masked), true);
    assert.equal(isAccountId(masked), false);
    assert.equal(nearUrl(masked, 'mainnet'), null);
    assert.equal(contractUrl(masked, 'mainnet'), null);
  }
  // the contract id and the desk id are not masked, and still link
  assert.equal(contractUrl('gimbal.near', 'mainnet'), 'https://nearblocks.io/address/gimbal.near');
});

test('in the remote view "Paused by" shows the masked label, never "you", even when it equals the masked owner', () => {
  const ownerPaused = desk({ paused: { by: OWNER, at: Date.UTC(2026, 10, 3, 12, 0) } });
  assert.match(statusOf(ownerPaused, { remote: true }).sentence, /^Paused by gimb…near on /);
  assert.doesNotMatch(statusOf(ownerPaused, { remote: true }).sentence, /you/);
  assert.match(statusOf(desk({ paused: { by: OPERATOR, at: 1 } }), { remote: true }).sentence, /^Paused by oper…near on /);
  // the local engine, which sends the real ids, still says "you"
  const real = desk({ owner: 'owner.near', paused: { by: 'owner.near', at: 1 } });
  assert.match(statusOf(real).sentence, /^Paused by you on /);
});

test('a proof link whose address was masked is not drawn; whole links are', () => {
  const links = proofLinks([
    { chain: 'near', id: 'EJ7m…t2Qa', url: 'https://nearblocks.io/address/gimb…near' },
    { chain: 'arbitrum', id: '0x88b2…14d0', url: `https://arbiscan.io/tx/0x${'8'.repeat(64)}` },
  ]);
  assert.deepEqual(links.map((l) => l.chain), ['arbitrum']);
});

test('a masked id is short enough to show as it is', () => {
  assert.equal(shortId(DIGEST), DIGEST);
  assert.equal(shortId(OWNER), OWNER);
});
