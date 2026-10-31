// Records one real NEAR AI reply to the policy-draft prompt, for the tests to play back:
//   npm run record-nearai -w engine [-- --out fixtures/nearai/<name>.json]
// Sends ETH_BTC_SENTENCE (src/nearai/recorded.ts) with the engine's own prompt and model, and writes NEAR AI's
// response body as it came, plus a `_comment` saying where it is from, to fixtures/nearai/policy-draft-eth-btc-
// <date>.json. Reads NEAR_AI_API_KEY from the environment or the repo's .env; the key is never printed.

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NearAiClient, parseJsonObject } from '../nearai/client.ts';
import { draftMessages, parseDraftAnswer } from '../nearai/policy-draft.ts';
import { ETH_BTC_SENTENCE, NEARAI_FIXTURES, recordedName } from '../nearai/recorded.ts';
import { errorMessage } from '../venues/recorder.ts';

const { values } = parseArgs({ options: { out: { type: 'string' } } });

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const key = process.env.NEAR_AI_API_KEY?.trim();
if (key === undefined || key === '') fail('NEAR_AI_API_KEY is not set (in the environment or the repo .env)');

const out = resolve(values.out ?? join(NEARAI_FIXTURES, recordedName(Date.now())));
const client = new NearAiClient({ apiKey: key });
try {
  const started = Date.now();
  const { content, raw } = await client.complete(draftMessages(ETH_BTC_SENTENCE), { json: true });
  const ms = Date.now() - started;
  // A reply that is not a draft is still written (the test then shows what the model did), but said so here.
  let check = 'a draft';
  try {
    const parsed = parseDraftAnswer(parseJsonObject(content));
    check = `a draft (${parsed.notes.length} type notes)`;
  } catch (err) {
    check = `NOT a draft: ${errorMessage(err)}`;
  }
  const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : { raw };
  const comment = `Recorded from NEAR AI Cloud (${client.model}) on ${new Date().toISOString()} by npm run record-nearai -w engine, `
    + 'for ETH_BTC_SENTENCE in src/nearai/recorded.ts.';
  writeFileSync(out, `${JSON.stringify({ _comment: comment, ...body }, null, 2)}\n`);
  console.log(`record-nearai: ${ms} ms, reply is ${check}`);
  console.log(content);
  console.log(`record-nearai: wrote ${out}`);
} catch (err) {
  fail(errorMessage(err));
}

function fail(msg: string): never {
  console.error(`record-nearai: ${msg}`);
  process.exit(1);
}
