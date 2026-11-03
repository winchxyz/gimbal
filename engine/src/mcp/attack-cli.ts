// `npm run attack`: run the scripted malicious operator requests (attacks.ts) against one desk and print a table —
// attack, the code the chain answered, and the NEAR transaction or "rejected before the chain, no tx" — then a
// before/after check of the NEAR ledger and the desk's Hyperliquid account value. Configure it like the MCP server
// (GIMBAL_CONTRACT_ID, DESK_ID, NEAR_NETWORK, OPERATOR_KEY_FILE, NEAR_RPC_URL) or with flags.
//
//   node engine/src/mcp/attack-cli.ts --contract <id> --desk <id> [--dry] [--meter] [--only a,b] [--key-file f]
//                                     [--env-file f] [--network testnet|mainnet] [--mainnet]
//   npm run attack -w engine -- --contract gimbal-final-fcf135.testnet --desk final-1 --dry
//
// A row passes only on exactly its expected refusal; anything else is FAIL with what came back.
// --dry (the default when no operator key file exists): build every request, print what would be sent and the code
// it expects, send nothing. --meter (testnet only): also run the hourly-cap attack, which signs post-only orders far
// from the market first (none posted). Mainnet needs --mainnet, and never runs --meter.

import { parseArgs } from 'node:util';
import { NearContractClient } from '../contract/near-client.ts';
import { NearViewTransport } from '../contract/near-transport.ts';
import type { DeskView } from '../contract/types.ts';
import { HL_MAINNET_URL, HL_TESTNET_URL } from '../venues/hyperliquid.ts';
import type { AttackDeps } from './attacks.ts';
import { held, keyProblems, report, runAttacks } from './attacks.ts';
import { connectDesk } from './connect.ts';
import { deskEnv, processEnv } from './env.ts';

const say = (line: string) => process.stdout.write(`${line}\n`);

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      contract: { type: 'string' }, desk: { type: 'string' }, network: { type: 'string' },
      'key-file': { type: 'string' }, 'env-file': { type: 'string' },
      dry: { type: 'boolean' }, meter: { type: 'boolean' }, only: { type: 'string' }, mainnet: { type: 'boolean' },
    },
  });
  if (values['env-file'] !== undefined) process.loadEnvFile(values['env-file']);
  const env = deskEnv(processEnv, {
    ...(values.contract === undefined ? {} : { contract: values.contract }),
    ...(values.desk === undefined ? {} : { desk: values.desk }),
    ...(values.network === undefined ? {} : { network: values.network }),
    ...(values['key-file'] === undefined ? {} : { keyFile: values['key-file'] }),
  }, { allowMainnet: values.mainnet === true });
  if (env.network === 'mainnet' && values.meter === true) throw new Error('refusing --meter on mainnet: it signs real orders');
  const dry = values.dry === true || !env.keyExists;
  const only = values.only === undefined ? undefined : values.only.split(',').map((s) => s.trim()).filter((s) => s !== '');

  const hlUrl = env.network === 'mainnet' ? HL_MAINNET_URL : HL_TESTNET_URL;
  const hlInfo = async (body: object): Promise<unknown> => {
    const res = await fetch(`${hlUrl}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Hyperliquid /info ${res.status}`);
    return res.json();
  };

  let deps: AttackDeps;
  let problems: string[] = [];
  if (dry) {
    // Views only: no key is loaded, nothing can be sent.
    const transport = new NearViewTransport({ network: env.network, ...(env.rpcUrl === undefined ? {} : { rpcUrl: env.rpcUrl }) });
    const client = new NearContractClient({ contractId: env.contractId, network: env.network, transport });
    deps = { network: env.network, contractId: env.contractId, deskId: env.deskId, contract: client, transport, hlInfo };
    if (!env.keyExists && values.dry !== true) say(`(no operator key file at ${env.keyFile}: dry run)`);
  } else {
    const c = connectDesk(env);
    deps = { network: env.network, contractId: env.contractId, deskId: env.deskId, contract: c.client, transport: c.transport, hlInfo };
    // Without the key on chain, or without allowance, every row would fail for the wrong reason: stop and say so.
    problems = await keyProblems(() => c.transport.allowance());
  }

  if (problems.length > 0) {
    const desk = await deps.contract.getDesk(env.deskId);
    const ledger = desk?.ledger ?? EMPTY_LEDGER;
    const run = { results: [], ledger: { before: ledger, after: ledger, hlBeforeE6: null, hlAfterE6: null, movedE6: 0n } };
    for (const line of report(run, env, true, problems)) say(line);
    say('\nFAIL: the operator key cannot run the attacks, so nothing was proven.');
    return 1;
  }

  const run = await runAttacks(deps, { dry, meter: values.meter === true, ...(only === undefined ? {} : { only }) });
  for (const line of report(run, env, dry)) say(line);
  if (dry) return 0;
  const ok = held(run, [], true);
  say(ok
    ? '\nPASS: the desk held. Every attack got exactly its refusal and no USDC moved.'
    : '\nFAIL: a row did not get its exact refusal, the Hyperliquid account was not read, or USDC moved.');
  return ok ? 0 : 1;
}

const EMPTY_LEDGER = { idle_usdc: '0', deposited: '0', withdrawn: '0', fees_paid: '0' } as unknown as DeskView['ledger'];

if (process.argv[1]?.endsWith('attack-cli.ts')) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; setTimeout(() => process.exit(), 300).unref(); })
    .catch((err) => { process.stderr.write(`attack: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(2); });
}
