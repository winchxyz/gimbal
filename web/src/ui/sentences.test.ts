import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sentenceLines } from './sentences.ts';

const flat = (lines: ReturnType<typeof sentenceLines>) => lines.map((l) => l.map((p) => (p.kind === 'txt' ? p.text : `[${p.kind}:${p.text}]`)).join(''));

test('each sentence gets its own line; the figure and the ticker are set apart', () => {
  const lines = sentenceLines(['None pays your 5% minimum. The best, DOGE, pays ', { text: '3.1%', tone: 'up' }, ' a year.'], ['DOGE', 'BTC']);
  assert.deepEqual(flat(lines), ['None pays your 5% minimum.', 'The best, [tk:DOGE], pays [fig:3.1%] a year.']);
  assert.equal(lines[1]!.find((p) => p.kind === 'fig')!.tone, 'up');
});

test('a sentence that follows the figure starts a line; a decimal point does not', () => {
  const lines = sentenceLines(['Next best is ETH at ', { text: '4.5%' }, ' a year. MON, held, still leads.'], ['ETH', 'MON']);
  assert.deepEqual(flat(lines), ['Next best is [tk:ETH] at [fig:4.5%] a year.', '[tk:MON], held, still leads.']);
});

test('a ticker is marked only as a word of its own, the longest name first', () => {
  assert.deepEqual(flat(sentenceLines(['NEAR and NEARX; LINEAR is not one.'], ['NEAR', 'NEARX'])), ['[tk:NEAR] and [tk:NEARX]; LINEAR is not one.']);
  assert.deepEqual(flat(sentenceLines(['One line.', null, ''])), ['One line.']);
});
