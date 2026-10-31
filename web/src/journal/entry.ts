// How one `JournalEntry` is read, shared by the Journal screen and the Desk's "Latest" so both show an entry the
// same way. Pure, so `node --test` runs it as it is.
//
// `JournalEntry.numbers` has no fixed keys in docs/interfaces.md §2. The dashboard reads these, and shows nothing
// for one that is missing:
//   usd       the money effect of the entry, signed: funding received +, fees and costs −. For `deposit` and
//             `withdraw` it is the principal moved, which is not profit or loss.
//   feeUsd    a fee charged on top of `usd` (≤ 0), for a withdrawal or a deposit.
//   unpriced  1 or "true" when an order went out without the oracle price band; `venue` names it.
//   from, signedS, landedS   on a rescue: where the margin came from ("reserve" or a venue id), and the seconds
//             the MPC signature and the landing took.
import type { JournalEntry, Mode, TxRef } from '@gimbal/shared';
import { venueName } from '../windows/format.ts';

/** A numeric `numbers` value: a finite number, or a string that is one ("1050.00" keeps its decimals on the wire). */
export function numberOf(entry: Pick<JournalEntry, 'numbers'>, key: string): number | null {
  const value = entry.numbers[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

/** The signed money effect shown on the right of a row, or null when the entry has none. */
export const amountUsd = (entry: Pick<JournalEntry, 'numbers'>): number | null => numberOf(entry, 'usd');

/** A fee on top of the amount (≤ 0), or null. */
export const feeUsd = (entry: Pick<JournalEntry, 'numbers'>): number | null => numberOf(entry, 'feeUsd');

/**
 * An order sent without the oracle price band: the amber line under a row. The engine marks the entry with
 * `numbers.unpriced` (1 or "true") and may name the venue in `numbers.venue`; the contract's `signed` event
 * carries the same flag.
 */
export function unprotectedText(entry: Pick<JournalEntry, 'numbers'>): string | null {
  const flag = entry.numbers.unpriced;
  if (flag !== 1 && flag !== '1' && flag !== 'true') return null;
  const venue = entry.numbers.venue;
  return typeof venue === 'string' && venue.length > 0 ? `${venueName(venue)} leg sent without price protection` : 'Sent without price protection';
}

const two = (n: number) => String(n).padStart(2, '0');

/** `14:00`: the time of day, UTC like every date on the dashboard. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

// ---------- explorer links ----------

/** The word on a proof link. `TxRef.chain` decides it and nothing else: the address comes from `TxRef.url` as given. */
export const CHAIN_LABELS: Record<TxRef['chain'], string> = {
  near: 'NEAR',
  hyperliquid: 'Hyperliquid',
  solana: 'Solscan',
  arbitrum: 'Arbiscan',
};

/**
 * The contract's page on the NEAR explorer. This is the one link the dashboard builds itself, because it is not a
 * transaction (`TxRef.url`): the network picks the explorer, and a replay plays recorded mainnet data.
 */
export function contractUrl(contract: string, mode: Mode): string {
  const origin = mode === 'testnet' ? 'https://testnet.nearblocks.io' : 'https://nearblocks.io';
  return `${origin}/address/${encodeURIComponent(contract)}`;
}

/** `https://...` only: a link from the engine is opened in a new tab, so anything else (`javascript:`) is dropped. */
export function externalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** `9xQe…4Ta1`, `0x88b2…14d0`: enough of a hash to tell two apart. */
export function shortId(id: string): string {
  const head = id.startsWith('0x') ? 6 : 4;
  return id.length <= head + 5 ? id : `${id.slice(0, head)}…${id.slice(-4)}`;
}

export interface ProofLink {
  chain: TxRef['chain'];
  label: string;
  short: string;
  href: string;
}

/** One link per transaction the explorer can open, in the order the engine lists them. */
export function proofLinks(tx: readonly TxRef[]): ProofLink[] {
  const links: ProofLink[] = [];
  for (const t of tx) {
    const href = externalUrl(t.url);
    if (href !== null) links.push({ chain: t.chain, label: CHAIN_LABELS[t.chain], short: shortId(t.id), href });
  }
  return links;
}
