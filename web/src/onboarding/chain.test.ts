import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAddresses, desksOf, parseDesk, readConfig, readDesk, RPC_URLS, rpcChain, tokenBalance } from './chain.ts';
import { FakeWorld } from './fakes.ts';
import { addressesFrom } from './derive.ts';

/** A fetch that answers from a list of canned bodies, one per call, and records the URLs it was asked. */
function fakeFetch(answers: unknown[]): { fetcher: typeof fetch; urls: string[]; bodies: unknown[] } {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  let i = 0;
  const fetcher = (async (url: string, init?: { body?: string }) => {
    urls.push(url);
    bodies.push(init?.body ? JSON.parse(init.body) : null);
    const answer = answers[i++];
    if (answer instanceof Error) throw answer;
    return { ok: true, status: 200, json: async () => answer } as Response;
  }) as typeof fetch;
  return { fetcher, urls, bodies };
}

const bytes = (value: unknown): number[] => Array.from(new TextEncoder().encode(JSON.stringify(value)));

test('a view call sends call_function with base64 arguments and decodes the JSON result', async () => {
  const { fetcher, bodies } = fakeFetch([{ jsonrpc: '2.0', result: { result: bytes({ owner: 'a.near' }), logs: [] } }]);
  const chain = rpcChain('testnet', ['https://rpc.example'], fetcher);
  assert.deepEqual(await chain.view('c.testnet', 'get_desk', { desk_id: 'd' }), { owner: 'a.near' });
  const params = (bodies[0] as { params: Record<string, string> }).params;
  assert.equal(params.request_type, 'call_function');
  assert.equal(params.account_id, 'c.testnet');
  assert.equal(params.method_name, 'get_desk');
  assert.equal(atob(params.args_base64!), '{"desk_id":"d"}');
});

test('an empty result is null; the contract’s own refusal is thrown and not retried elsewhere', async () => {
  const empty = fakeFetch([{ result: { result: [], logs: [] } }]);
  assert.equal(await rpcChain('testnet', ['u1'], empty.fetcher).view('c', 'get_desk'), null);

  const refused = fakeFetch([{ error: { cause: { name: 'CONTRACT_EXECUTION_ERROR' }, data: 'wasm execution failed: E_NO_DESK' } }, { result: { result: [] } }]);
  await assert.rejects(rpcChain('testnet', ['u1', 'u2'], refused.fetcher).view('c', 'get_desk'), /E_NO_DESK/);
  assert.deepEqual(refused.urls, ['u1'], 'a view that failed is the contract’s answer: the second endpoint is not asked');
});

test('an endpoint that is down is skipped for the next one; all down says so', async () => {
  const second = fakeFetch([new Error('connect ECONNREFUSED'), { result: { result: bytes('x') } }]);
  assert.equal(await rpcChain('testnet', ['u1', 'u2'], second.fetcher).view('c', 'm'), 'x');
  assert.deepEqual(second.urls, ['u1', 'u2']);

  const none = fakeFetch([new Error('down 1'), new Error('down 2')]);
  await assert.rejects(rpcChain('testnet', ['u1', 'u2'], none.fetcher).view('c', 'm'), /NEAR RPC did not answer: down 2/);
});

test('access keys: full access and function-call keys, with the methods they may call', async () => {
  const { fetcher } = fakeFetch([
    {
      result: {
        keys: [
          { public_key: 'ed25519:full', access_key: { nonce: 1, permission: 'FullAccess' } },
          { public_key: 'ed25519:op', access_key: { nonce: 2, permission: { FunctionCall: { allowance: '5000', receiver_id: 'c.testnet', method_names: ['hl_order', 'sol_sign'] } } } },
          { public_key: 'ed25519:odd', access_key: { permission: { Other: {} } } },
        ],
      },
    },
  ]);
  assert.deepEqual(await rpcChain('testnet', ['u'], fetcher).accessKeys('a.testnet'), [
    { publicKey: 'ed25519:full', permission: 'FullAccess' },
    { publicKey: 'ed25519:op', permission: { receiverId: 'c.testnet', methodNames: ['hl_order', 'sol_sign'], allowance: '5000' } },
  ]);
});

test('get_desk: the fields onboarding uses, amounts as BigInt; null is no desk', () => {
  assert.equal(parseDesk(null), null);
  const desk = parseDesk({
    owner: 'a.near',
    operator: null,
    paused: false,
    policy: {},
    evm_address: '0xabc',
    solana: { authority: 'A', usdc_ata: 'B', phusd_ata: 'C', phoenix_trader: 'D' },
    orderly_account_id: '0x01',
    orderly_receiver: null,
    ledger: { deposited: '1050000000', idle_usdc: '0' },
  })!;
  assert.equal(desk.owner, 'a.near');
  assert.equal(desk.ledger.deposited, 1_050_000_000n);
  assert.equal(desk.orderly_receiver, null);
  assert.throws(() => parseDesk({ owner: 'a.near' }), /no solana, policy or ledger/);
  assert.throws(() => parseDesk({ owner: '', solana: {}, policy: {}, ledger: {} }), /owner/);
  assert.throws(() => parseDesk('x'), /not an object/);
});

test('the views through a chain: desk, owner’s desks, config, balances', async () => {
  const world = new FakeWorld();
  assert.equal(await readDesk(world.chain, world.contractId, 'nope'), null);
  assert.deepEqual(await desksOf(world.chain, world.contractId, 'a.testnet'), []);
  assert.deepEqual(await readConfig(world.chain, world.contractId), { network: 'Testnet', mpc: world.mpc });
  await assert.rejects(readConfig({ ...world.chain, view: async () => ({ hello: 1 }) }, 'x.near'), /did not answer config\(\) like a gimbal contract/);
  world.giveUsdc(3.5);
  assert.equal(await tokenBalance(world.chain, world.usdcToken, world.account), 3_500_000n);
  await assert.rejects(tokenBalance({ ...world.chain, view: async () => 7 }, 't', 'a'), /did not answer with an amount/);
});

test('deriveAddresses asks the MPC contract for both keys with the gimbal contract as predecessor', async () => {
  const world = new FakeWorld();
  const asked: unknown[] = [];
  const chain = { ...world.chain, view: async (c: string, m: string, a?: object) => { asked.push([c, m, a]); return world.chain.view(c, m, a); } };
  const got = await deriveAddresses(chain, world.mpc, world.contractId, 'desk-07');
  assert.deepEqual(asked, [
    [world.mpc, 'derived_public_key', { path: 'gimbal/desk-07/evm', predecessor: world.contractId, domain_id: 0 }],
    [world.mpc, 'derived_public_key', { path: 'gimbal/desk-07/sol', predecessor: world.contractId, domain_id: 1 }],
  ]);
  const evm = (await world.chain.view(world.mpc, 'derived_public_key', { path: 'gimbal/desk-07/evm', domain_id: 0 })) as string;
  const sol = (await world.chain.view(world.mpc, 'derived_public_key', { path: 'gimbal/desk-07/sol', domain_id: 1 })) as string;
  assert.deepEqual(got, addressesFrom(evm, sol));
  assert.match(got.evm_address, /^0x[0-9a-f]{40}$/);
  await assert.rejects(deriveAddresses({ ...world.chain, view: async () => 5 }, world.mpc, world.contractId, 'd'), /did not answer with keys/);
});

test('FastNEAR is asked first on both networks; the near.org endpoints are only the fallback', async () => {
  assert.deepEqual(RPC_URLS.testnet, ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']);
  assert.deepEqual(RPC_URLS.mainnet, ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org']);
  const { fetcher, urls } = fakeFetch([new Error('fetch failed'), { jsonrpc: '2.0', result: { keys: [] } }]);
  await rpcChain('testnet', undefined, fetcher).accessKeys('a.testnet');
  assert.deepEqual(urls, ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']);
});
