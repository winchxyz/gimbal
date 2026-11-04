// The Security screen reads the owner's and the operator's accounts from the chain itself. In the remote view it must
// show them with the engine's mask and draw no explorer link for them; locally it is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Chain } from '../onboarding/chain.ts';
import { fakeSecurityWorld } from '../security/dev.ts';
import { nearUrl } from '../security/explorer.ts';
import { loadSecurity, type SecurityTarget } from '../security/load.ts';
import { fullAccessText, policyLines } from '../security/words.ts';
import { maskAccount, maskIf, maskIn } from './mask.ts';

const OWNER = 'ada-the-owner.testnet';
const OPERATOR = 'gimbal-operator-7.testnet';
const TARGET: SecurityTarget = { contractId: 'gimbal-c6-fcf135.testnet', deskId: 'main', mode: 'testnet' };

/** The fake chain, with an operator account set and the treasury paid to the owner, so every place an id can show is covered. */
async function world(): Promise<Chain> {
  const w = await fakeSecurityWorld(TARGET, { owner: OWNER, unpriced: false, noDesk: false });
  return {
    accessKeys: (account) => w.chain.accessKeys(account),
    view: async (contract, method, args) => {
      const answer = await w.chain.view(contract, method, args);
      if (typeof answer !== 'object' || answer === null) return answer;
      if (method === 'config') return { ...answer, treasury: { ...(answer as { treasury: object }).treasury, near: OWNER } };
      if (method === 'get_desk') return { ...answer, operator: OPERATOR };
      return answer;
    },
  };
}

/** Everything the screen prints from the data, as the components do: the ids come from `data.desk` and `data.config`. */
function printed(data: NonNullable<Awaited<ReturnType<typeof loadSecurity>>>): string {
  return [
    JSON.stringify(data.desk, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    JSON.stringify(data.config),
    policyLines(data.desk.policy, data.desk.owner).map((l) => l.text).join('\n'),
    fullAccessText(data.desk.owner, 1),
    `No function-call key for ${data.target.contractId} is on ${data.desk.owner}`,
    JSON.stringify([data.desk.evm_address, data.desk.solana, data.desk.orderly_account_id, data.desk.orderly_receiver]),
  ].join('\n');
}

test('the mask is the engine’s: first four, an ellipsis, last four; short ids are cut whole', () => {
  assert.equal(maskAccount(OWNER), 'ada-…tnet');
  assert.equal(maskAccount('a.near'), '…');
  assert.equal(maskIf(OWNER, [OWNER, null]), maskAccount(OWNER));
  assert.equal(maskIf('treasury.testnet', [OWNER]), 'treasury.testnet');
  assert.equal(maskIn(`account ${OWNER} does not exist; ${OWNER}`, [OWNER, OPERATOR, null]), `account ${maskAccount(OWNER)} does not exist; ${maskAccount(OWNER)}`);
});

test('remote: the Security data holds no full owner or operator id, and the ids are not links', async () => {
  const data = await loadSecurity(await world(), TARGET, 1, { mask: true });
  assert.ok(data);
  assert.equal(data.desk.owner, maskAccount(OWNER));
  assert.equal(data.desk.operator, maskAccount(OPERATOR));
  assert.equal(data.config.treasury, maskAccount(OWNER), 'a treasury that is the owner is masked too');
  const text = printed(data);
  assert.ok(!text.includes(OWNER), 'no full owner id');
  assert.ok(!text.includes(OPERATOR), 'no full operator id');
  assert.ok(text.includes(maskAccount(OWNER)) && text.includes(maskAccount(OPERATOR)));
  // no explorer link can be built from them
  assert.equal(nearUrl(data.desk.owner, 'testnet'), null);
  assert.equal(nearUrl(data.desk.operator ?? '', 'testnet'), null);
  // the contract id and the desk id stay whole, with their link
  assert.equal(data.target.contractId, TARGET.contractId);
  assert.equal(data.target.deskId, 'main');
  assert.match(nearUrl(data.target.contractId, 'testnet') ?? '', /^https:\/\/testnet\.nearblocks\.io\/address\/gimbal-c6-fcf135\.testnet$/);
  // the owner's keys were still read for the real account
  assert.equal(data.keys.length, 2);
});

test('remote: an RPC error that quotes the owner or the operator is masked', async () => {
  const w = await world();
  const failing: Chain = {
    view: w.view,
    accessKeys: async (account) => {
      throw new Error(`NEAR RPC: account ${account} does not exist; operator ${OPERATOR}`);
    },
  };
  await assert.rejects(loadSecurity(failing, TARGET, 1, { mask: true }), (e: Error) => !e.message.includes(OWNER) && !e.message.includes(OPERATOR) && e.message.includes(maskAccount(OWNER)));
  // locally the engine's own words are kept
  await assert.rejects(loadSecurity(failing, TARGET, 1), (e: Error) => e.message.includes(OWNER));
});

test('local: the owner and the operator are shown in full and link, as before', async () => {
  const data = await loadSecurity(await world(), TARGET, 1);
  assert.ok(data);
  assert.equal(data.desk.owner, OWNER);
  assert.equal(data.desk.operator, OPERATOR);
  assert.match(nearUrl(data.desk.owner, 'testnet') ?? '', /ada-the-owner\.testnet$/);
});

test('the Security screen asks for the mask in remote mode and takes the ids only from the data it was given', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'security');
  assert.match(readFileSync(join(dir, 'useSecurity.ts'), 'utf8'), /mask: isReadOnly\(\)/);
  for (const file of ['Head.tsx', 'Columns.tsx', 'Keys.tsx', 'Accounts.tsx', 'Facts.tsx']) {
    const code = readFileSync(join(dir, file), 'utf8');
    // an owner or operator id is read from the loaded desk (`desk.owner`, `desk.operator`) and never from the stream
    assert.ok(!/useStream/.test(code), `${file} reads the stream`);
  }
});
