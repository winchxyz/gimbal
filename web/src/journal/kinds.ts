// What each kind of journal entry is: its word, its colour, the filter it is listed under and whether it moves
// principal. One table, typed against `JournalEntry['kind']`, so a kind added to docs/interfaces.md §2 is a compile
// error here until it is described.
import type { JournalEntry } from '@gimbal/shared';

export type Kind = JournalEntry['kind'];

/** The filters over the feed (design/screens/desktop/journal.html). `all` lists everything. */
export type FilterId = 'all' | 'trades' | 'funding' | 'money' | 'rescue' | 'refused';

/** `ink` is the full-strength grey of Open and Rotate; every other colour is a state (design/HANDOFF.md, Journal). */
export type Tone = 'ink' | 'watch' | 'danger';

export interface KindInfo {
  /** The word in the kind column. */
  label: string;
  /** Rescue and Veto amber, Refused red, Open and Rotate in ink, everything else grey. */
  tone: Tone | null;
  /** The filter other than All that lists it; null = only All does. */
  filter: Exclude<FilterId, 'all'> | null;
  /** The contract signed an action for it, so it counts toward "actions signed by the contract" (`signed` event, §1.6). */
  signed: boolean;
  /** Moves the owner's money in or out: it is not profit or loss, so it stays out of day totals and the net. */
  principal: boolean;
  /** `1 deposit`, `9 funding payments`: the kind counted in the line that folds older days. */
  noun: readonly [one: string, many: string];
}

export const KINDS: Record<Kind, KindInfo> = {
  window: { label: 'Window', tone: null, filter: null, signed: false, principal: false, noun: ['window', 'windows'] },
  enter: { label: 'Open', tone: 'ink', filter: 'trades', signed: true, principal: false, noun: ['open', 'opens'] },
  exit: { label: 'Close', tone: 'ink', filter: 'trades', signed: true, principal: false, noun: ['close', 'closes'] },
  rotate: { label: 'Rotate', tone: 'ink', filter: 'trades', signed: true, principal: false, noun: ['rotation', 'rotations'] },
  rescue: { label: 'Rescue', tone: 'watch', filter: 'rescue', signed: true, principal: false, noun: ['rescue', 'rescues'] },
  refused: { label: 'Refused', tone: 'danger', filter: 'refused', signed: false, principal: false, noun: ['refusal', 'refusals'] },
  veto: { label: 'Veto', tone: 'watch', filter: 'refused', signed: false, principal: false, noun: ['veto', 'vetoes'] },
  adl: { label: 'Deleveraged', tone: null, filter: 'trades', signed: false, principal: false, noun: ['forced close', 'forced closes'] },
  error: { label: 'Error', tone: null, filter: null, signed: false, principal: false, noun: ['error', 'errors'] },
  funding: { label: 'Funding', tone: null, filter: 'funding', signed: false, principal: false, noun: ['funding payment', 'funding payments'] },
  deposit: { label: 'Deposit', tone: null, filter: 'money', signed: true, principal: true, noun: ['deposit', 'deposits'] },
  withdraw: { label: 'Withdraw', tone: null, filter: 'money', signed: true, principal: true, noun: ['withdrawal', 'withdrawals'] },
  fee: { label: 'Fee', tone: null, filter: 'money', signed: false, principal: false, noun: ['fee', 'fees'] },
  wait: { label: 'Waiting', tone: null, filter: null, signed: false, principal: false, noun: ['wait', 'waits'] },
};

export interface FilterInfo {
  id: FilterId;
  /** The tab on the desktop. */
  label: string;
  /** The tab on the phone, where there is less room (design/screens/phone/journal.html). */
  short: string;
}

export const FILTERS: readonly FilterInfo[] = [
  { id: 'all', label: 'All', short: 'All' },
  { id: 'trades', label: 'Trades', short: 'Trades' },
  { id: 'funding', label: 'Funding', short: 'Funding' },
  { id: 'money', label: 'Money in and out', short: 'Money' },
  { id: 'rescue', label: 'Rescue', short: 'Rescue' },
  { id: 'refused', label: 'Refused and vetoed', short: 'Refused' },
];

export const filterLabel = (id: FilterId): string => FILTERS.find((f) => f.id === id)?.label ?? 'All';

export const inFilter = (kind: Kind, filter: FilterId): boolean => filter === 'all' || KINDS[kind].filter === filter;
