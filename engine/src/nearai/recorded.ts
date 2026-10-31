// The recorded NEAR AI replies the tests play back (fixtures/nearai/), and the sentence they answer. A file named
// SYNTHETIC-* was written by hand in the chat-completions format before a key existed; `npm run record-nearai -w
// engine` records a real reply next to it as policy-draft-eth-btc-<date>.json, and the tests then check both.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NEARAI_FIXTURES = fileURLToPath(new URL('../../fixtures/nearai/', import.meta.url));

/** The owner's sentence every policy-draft fixture answers. */
export const ETH_BTC_SENTENCE = 'Trade only ETH and BTC, at most $500 per leg, 3x leverage, stop if I lose 10%, and only enter above 15% net APR';

export const SYNTHETIC_ETH_BTC = 'SYNTHETIC-policy-draft-eth-btc.json';
const RECORDED_ETH_BTC = /^policy-draft-eth-btc-\d{4}-\d{2}-\d{2}\.json$/;

/** The file name a reply recorded on `date` (ms) gets. */
export function recordedName(date: number): string {
  return `policy-draft-eth-btc-${new Date(date).toISOString().slice(0, 10)}.json`;
}

/** Every reply to ETH_BTC_SENTENCE in the fixtures: the synthetic one first, then the recorded ones, oldest first. */
export function ethBtcReplies(): { file: string; synthetic: boolean }[] {
  const recorded = readdirSync(NEARAI_FIXTURES).filter((f) => RECORDED_ETH_BTC.test(f)).sort();
  return [
    { file: join(NEARAI_FIXTURES, SYNTHETIC_ETH_BTC), synthetic: true },
    ...recorded.map((f) => ({ file: join(NEARAI_FIXTURES, f), synthetic: false })),
  ];
}
