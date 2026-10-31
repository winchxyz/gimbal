#!/usr/bin/env node
// Deploys contract/target/near/gimbal.wasm to a FRESH testnet account and initialises it with the
// Mock price source, no referral codes and Orderly's testnet broker.
//
//   node tools/testnet/deploy.mjs gimbal-<suffix>.testnet [--owner <owner>.testnet]
//
// The account is created with the testnet faucet helper and its new key is written to
// .keys/<account>.json (gitignored); no key value is printed. An account that exists already is only
// deployed to when it has no code: the script never redeploys over a live contract.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, account, actions, loadKey, newKey, panicOf, rpc, send, sleep, view } from './near.mjs';

const KEPT = ['gimbal-fcf135.testnet', 'gimbal-c2-fcf135.testnet', 'gimbal-c2o-fcf135.testnet'];
const MPC = 'v1.signer-prod.testnet';
// The treasury's Hyperliquid builder for test desks: an address nobody holds funds at.
const TEST_BUILDER = '0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c';

const args = process.argv.slice(2);
const contract = args.find((a) => !a.startsWith('--'));
const ownerAt = args.indexOf('--owner');
const owner = ownerAt >= 0 ? args[ownerAt + 1] : 'gimbal-owner-fcf135.testnet';
if (!contract || !/^gimbal-[a-z0-9-]+\.testnet$/.test(contract)) {
  console.error('usage: node tools/testnet/deploy.mjs gimbal-<suffix>.testnet [--owner <account>]');
  process.exit(2);
}
if (KEPT.includes(contract)) {
  console.error(`${contract} is kept as it is; deploy to a fresh account`);
  process.exit(2);
}

const exists = async (id) => {
  try {
    return await account(id);
  } catch (e) {
    if (/UNKNOWN_ACCOUNT|does not exist/.test(e.message)) return null;
    throw e;
  }
};

let state = await exists(contract);
if (!state) {
  if (existsSync(join(ROOT, '.keys', `${contract}.json`))) {
    console.error(`.keys/${contract}.json exists but the account does not; remove it or pick another name`);
    process.exit(1);
  }
  const publicKey = newKey(contract);
  const res = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: contract, newAccountPublicKey: publicKey }),
  });
  console.log(`faucet helper: HTTP ${res.status}`);
  for (let i = 0; i < 20 && !state; i++) {
    await sleep(3000);
    state = await exists(contract);
  }
  if (!state) throw new Error(`${contract} was not created`);
}
console.log(`${contract}: ${Number(BigInt(state.amount) / 10n ** 21n) / 1000} NEAR`);

if (state.code_hash !== '11111111111111111111111111111111') {
  console.log(`${contract} has code already (${state.code_hash}); not redeploying`);
} else {
  const wasm = readFileSync(join(ROOT, 'contract', 'target', 'near', 'gimbal.wasm'));
  const init = {
    network: 'Testnet',
    mpc: MPC,
    price_source: 'Mock',
    treasury: {
      near: owner,
      hl_builder: TEST_BUILDER,
      referral_codes: { hyperliquid: null, orderly: null, phoenix: null },
    },
    fees: { performance_bps: 1000, hl_builder_tenth_bps: 10 },
    orderly: { broker_id: 'woofi_dex', chain_id: 421614 },
  };
  const key = loadKey(contract);
  const out = await send(key, contract, [actions.deploy(wasm), actions.call('new', init, 100n)]);
  if (out.failure) throw new Error(`deploy ${out.hash}: ${panicOf(out.failure)}`);
  console.log(`deployed ${wasm.length} bytes and initialised: tx ${out.hash} (${out.burntTgas} TGas)`);
}

console.log('version', await view(contract, 'version'));
console.log('config', JSON.stringify(await view(contract, 'config')));
await rpc('status', []).then((s) => console.log('chain', s.chain_id, 'block', s.sync_info.latest_block_height));
