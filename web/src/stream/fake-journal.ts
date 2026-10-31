// Development only: the Journal's fake data, shaped exactly like the shared types. The entries follow the mockup
// (design/screens/desktop/journal.html): the days, the kinds, the reasons, the amounts, the links. Every value is
// made up. The three newest entries come from fake-desk.ts, which the Desk's "Latest" shows as well; this file adds
// the older ones, dated from `now` the way the mockup dates them from 27 Oct 14:02.
import type { JournalEntry, Mode } from '@gimbal/shared';
import type { EngineApi } from './api.ts';
import { fakeLatest } from './fake-desk.ts';
import { fakeTx } from './fake-explorer.ts';

const MIN = 60_000;
const HOUR = 3_600_000;

/** What the fake Journal shows, chosen with `?state=` (the same switch as the Windows screen). */
export type JournalScenario = 'normal' | 'loading' | 'empty' | 'error';

/** `ago(6, 3, 57)`: 6 days 3 hours 57 minutes before `now`. */
const before = (now: number, days: number, hours: number, minutes = 0): number => now - ((days * 24 + hours) * HOUR + minutes * MIN);

// Nine funding payments on LTC between 21 and 23 Oct, every six hours; together with the three newer funding
// entries they add up to the +$1.36 the fake desk reports as funding received.
const EARLIER_FUNDING_HOURS = [146, 140, 134, 128, 122, 116, 110, 104, 98];
const EARLIER_FUNDING_USD = [0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.11];

/** The older entries, newest first, without the three `fakeLatest` returns. */
function older(now: number, mode: Mode): JournalEntry[] {
  const near = (head: string, tail: string) => fakeTx('near', head, tail, mode);
  const solana = (head: string, tail: string) => fakeTx('solana', head, tail, mode);
  const earlier: JournalEntry[] = [
    ...EARLIER_FUNDING_HOURS.map((hours, i): JournalEntry => ({
      id: `fake-j-ltc-funding-${i}`,
      t: before(now, 0, hours, 2),
      kind: 'funding',
      summary: 'Funding paid on both legs · LTC',
      numbers: { usd: EARLIER_FUNDING_USD[i] ?? 0.08, symbol: 'LTC' },
      tx: [near(`Fq${i}a`, `${i}Zk9`)],
    })),
    {
      id: 'fake-j-ltc-open',
      t: before(now, 6, 3, 40),
      kind: 'enter',
      summary: 'Opened LTC · both legs filled 0.9 s apart',
      why: 'LTC paid the most of the windows open to the desk at the time.',
      numbers: { symbol: 'LTC', usd: -1.38 },
      tx: [near('Lt4c', 'o8Pq'), fakeTx('hyperliquid', '3c9a', 'e07f', mode), solana('5nVd', 'Rt2w')],
    },
    {
      id: 'fake-j-deposit',
      t: before(now, 6, 3, 57),
      kind: 'deposit',
      summary: 'Deposit of $1,050.00 landed on the desk through NEAR Intents',
      numbers: { usd: 1050 },
      tx: [near('Dn2a', 'Kq7s')],
    },
  ];

  return [
    {
      id: 'fake-j-veto',
      t: before(now, 0, 4, 50),
      kind: 'veto',
      summary: 'Skipped AVAX, long Orderly / short Hyperliquid at 9.1% net',
      why: 'one 8-hour spike; the 7-day median gap is 1.2%, so it would likely close before fees are earned back.',
      numbers: { symbol: 'AVAX', netAprPct: 9.1 },
      tx: [near('Fh2k', 'p0Zs')],
    },
    {
      id: 'fake-j-refused',
      t: before(now, 0, 7, 32),
      kind: 'refused',
      summary: 'Contract refused to open ZRO at 35.2% net',
      why: 'No trusted oracle price for ZRO. Unpriced assets need your opt-in in the policy.',
      numbers: { symbol: 'ZRO', code: 'E_ORACLE_STALE' },
      tx: [near('Cw7r', 'bE9n')],
    },
    {
      id: 'fake-j-rescue',
      t: before(now, 0, 19, 18),
      kind: 'rescue',
      summary: 'Moved $120.00 to Hyperliquid margin. The short had come within 13.8% of liquidation after DOGE rose 4.1%.',
      numbers: { usd: -0.31, from: 'reserve', signedS: 6.1, landedS: 52 },
      tx: [near('Lq3v', '8kRd'), solana('4uZp', 'Qe1x')],
    },
    {
      id: 'fake-j-settle-26',
      t: before(now, 0, 38, 2),
      kind: 'funding',
      summary: 'Phoenix daily settlement +$0.52',
      numbers: { usd: 0.52, symbol: 'DOGE' },
      tx: [near('Ta9m', 'c21H'), solana('Hh6s', 'Vn4c')],
    },
    {
      id: 'fake-j-withdraw',
      t: before(now, 0, 45, 42),
      kind: 'withdraw',
      summary: '$50.00 sent to demo-owner.near through NEAR Intents',
      numbers: { usd: -50, feeUsd: -0.14 },
      tx: [near('Pp1d', 'Z7aw')],
    },
    {
      id: 'fake-j-settle-25',
      t: before(now, 0, 62, 2),
      kind: 'funding',
      summary: 'Phoenix daily settlement +$0.06, first partial day',
      numbers: { usd: 0.06, symbol: 'DOGE' },
      tx: [near('Bx0f', '3sYe')],
    },
    ...earlier,
  ];
}

/** The mockup's journal, newest first: 9 entries over four days, then the 11 of 21 to 23 Oct that the feed folds. */
export function fakeJournal(now: number, mode: Mode): JournalEntry[] {
  return [...fakeLatest(now, 'level', mode), ...older(now, mode)].sort((a, b) => b.t - a.t);
}

/** `GET /state`'s journal for a scenario: `loading` never answers, `error` fails the way a timeout does. */
export function fakeJournalRead(scenario: JournalScenario, mode: Mode): EngineApi['journal'] {
  return async () => {
    switch (scenario) {
      case 'loading':
        return new Promise<JournalEntry[]>(() => {});
      case 'empty':
        return [];
      case 'error':
        throw new Error('GET /state: timed out after 10 s');
      case 'normal':
        return fakeJournal(Date.now(), mode);
    }
  };
}
