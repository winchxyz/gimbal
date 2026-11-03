// Prints the position book: one block per position (symbol, venues, entered, held hours, funding per leg, fees,
// transfers, net, actual APR against the forecast, exit reason) and the desk's totals.
//   npm run report [-- --state <dir>] [--book <book-....jsonl>] [--sync] [--testnet]
//   --state <dir>  GIMBAL_STATE_DIR: where serve keeps the book; default the per-user state directory
//   --book <file>  one book file; default every book-*.jsonl in the state directory
//   --sync         read the venues' ledgers first (read-only public endpoints, nothing signs). What it reads goes into
//                  this report only: serve's book is written by serve alone, so two writers never race on the file.
//   --testnet      with --sync: Hyperliquid testnet (Phoenix has no testnet)
// With no --sync it reads the book alone and needs no network.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PositionBook } from '../book/book.ts';
import { bookReport } from '../book/report.ts';
import { liveBookSources } from '../book/sources.ts';
import { bookFilesIn } from '../book/store.ts';
import { errorMessage } from '../venues/recorder.ts';
import { userStateDir } from '../trade/trader-state.ts';

export const REPORT_USAGE = 'usage: npm run report -- [--state <dir>] [--book <book-....jsonl>] [--sync] [--testnet]';

const env = (name: string) => process.env[name];

let values;
try {
  ({ values } = parseArgs({
    options: {
      state: { type: 'string' },
      book: { type: 'string' },
      sync: { type: 'boolean', default: false },
      testnet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  }));
} catch (err) {
  console.error(`${errorMessage(err)}\n${REPORT_USAGE}`);
  process.exit(2);
}
if (values.help) {
  console.log(REPORT_USAGE);
  process.exit(0);
}

const set = values.state ?? env('GIMBAL_STATE_DIR');
const dir = resolve(set !== undefined && set !== '' ? set : userStateDir(env));
const files = values.book !== undefined ? [resolve(values.book)] : bookFilesIn(dir);
if (files.length === 0) {
  console.log(`no position book in ${dir} (serve writes book-<mode>-<contract>-<desk>.jsonl there)`);
  process.exit(0);
}

let failed = false;
for (const path of files) {
  let book: PositionBook;
  try {
    const sources = values.sync ? liveBookSources({ network: values.testnet ? 'testnet' : 'mainnet' }) : null;
    // persist false: nothing is written, whatever --sync reads.
    book = new PositionBook({ dir, mode: 'mainnet', contractId: null, deskId: null, path, persist: false, sources });
  } catch (err) {
    console.error(`${path}: ${errorMessage(err)}`);
    failed = true;
    continue;
  }
  const notes: string[] = [`file ${path}`];
  if (values.sync) {
    const r = await book.sync();
    for (const l of r.lines) notes.push(`sync ${l.ok ? 'ok' : 'FAILED'}: ${l.text}`);
    notes.push('sync results are in this report only; the book file is unchanged');
  }
  console.log(bookReport(book.summary(), notes));
}
if (failed) process.exit(1);
