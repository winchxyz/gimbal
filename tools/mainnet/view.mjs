#!/usr/bin/env node
// Read-only checks for the runbook (tools/mainnet/README.md): a view of a mainnet Gimbal contract, or an account's
// access keys. Nothing is signed; mainnet only (mainnet ids, RPC endpoints that serve chain "mainnet").
//
//   node tools/mainnet/view.mjs <contract> config | version | prices
//   node tools/mainnet/view.mjs <contract> get_desk '{"desk_id":"<desk_id>"}'
//   node tools/mainnet/view.mjs <contract> desks_of '{"owner":"<owner>.near"}'
//   node tools/mainnet/view.mjs --keys <account>      public keys and their permissions

import { UsageError, isMain, run } from './cli.mjs';
import { accountLink, mainnetId, near } from './near.mjs';

export const VIEWS = ['config', 'version', 'prices', 'get_desk', 'desks_of'];
const USAGE = `usage: node tools/mainnet/view.mjs <contract> <${VIEWS.join('|')}> [<args json>]
       node tools/mainnet/view.mjs --keys <account>`;

const idOrUsage = (id, what) => {
  try {
    return mainnetId(id, what);
  } catch (e) {
    throw new UsageError(e.message);
  }
};

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--keys') {
    if (argv.length !== 2) throw new UsageError('--keys takes one account');
    const id = idOrUsage(argv[1], 'account');
    for (const k of await near.accessKeys(id)) {
      const p = k.access_key.permission;
      console.log(`${k.public_key}  ${p === 'FullAccess' ? 'FullAccess' : `FunctionCall receiver ${p.FunctionCall.receiver_id}, allowance ${p.FunctionCall.allowance ?? 'none'}, methods ${JSON.stringify(p.FunctionCall.method_names)}`}`);
    }
    console.log(accountLink(id));
    return;
  }
  const [contract, method, json] = argv;
  if (contract === undefined || method === undefined || argv.length > 3) throw new UsageError('a contract and a view are required');
  idOrUsage(contract, 'contract');
  if (!VIEWS.includes(method)) throw new UsageError(`${method} is not one of ${VIEWS.join(', ')}`);
  let args = {};
  if (json !== undefined) {
    try {
      args = JSON.parse(json);
    } catch {
      throw new UsageError('the args are not JSON');
    }
  }
  console.log(JSON.stringify(await near.view(contract, method, args), null, 2));
}

if (isMain(import.meta.url)) await run(main, USAGE);
