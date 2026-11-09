// The one status line in the header (UX: "Live · mainnet · checked 5 s ago"). It replaces the three bars the page had
// under the header (read-only line, engine-not-answering line, status line). Pure, so the wording is tested.
import type { DeskState, HealthMap, Mode } from '@gimbal/shared';
import type { Connection, Source } from '../stream/store.ts';
import { ago } from '../ui/useNow.ts';

/** The dot's colour: `live` mint (live and healthy), `watch` amber (live but degraded), `down` coral (offline or in
 * danger), `wait` grey (connecting, a replay, sample data: nothing live to judge). */
export type HeadlineTone = 'live' | 'watch' | 'down' | 'wait';

export interface Headline {
  tone: HeadlineTone;
  /** The short line itself. */
  text: string;
  /** The same for a phone header, where the network is left out of a live line. */
  short: string;
  /** One plain sentence more, on hover and for screen readers; null when the line says it all. */
  more: string | null;
}

export interface HeadlineInput {
  source: Source | null;
  connection: Connection;
  /** The network the engine reports (`GET /state` mode, or the desk's), null until it answers. */
  mode: Mode | null;
  /** When the numbers on the page were last checked: the desk's `updatedAt`, else the scan's time. */
  checkedAt: number | null;
  /** When the page last heard from the engine (its own clock), for "last read" while it does not answer. */
  heardAt: number | null;
  now: number;
  pageNow: number;
  /** A remote or hosted problem with its own wording (a token not accepted, a host with no engine). */
  problem: { title: string; text: string } | null;
  /** The public live view, unlocked with the owner token in this tab. */
  owner: boolean;
  /** A page that writes nothing (remote view, public live view): visitors are told once, on hover. */
  readOnly: boolean;
  /**
   * How the desk and its venues are: `watch` when a leg needs watching, a rescue runs or a venue is slow or down;
   * `danger` when a rescue failed and the desk needs the owner. Optional: none means healthy.
   */
  degraded?: 'watch' | 'danger' | null;
}

const VISITOR = 'Read-only for visitors: nothing done on this page can change the desk.';

export function headline(i: HeadlineInput): Headline {
  if (i.problem !== null) return same({ tone: 'down', text: i.problem.title, more: i.problem.text });
  if (i.source === 'sse' && i.connection === 'retrying') {
    const last = i.heardAt === null ? null : ago(i.heardAt, i.pageNow);
    return same({
      tone: 'down',
      text: last === null ? 'Engine not answering' : `Engine not answering · last read ${last}`,
      more: 'While the engine is down nothing new is entered or rescued, and your policy still holds on the contract. This page reconnects by itself.',
    });
  }
  if (i.mode === null || i.connection !== 'open') {
    return same({ tone: 'wait', text: i.connection === 'idle' && i.source !== null ? 'Not connected' : 'Connecting', more: null });
  }
  const checked = i.checkedAt === null ? null : `checked ${ago(i.checkedAt, i.now)}`;
  // The fake stream (development only, no engine): never called live.
  if (i.source === 'fake') return same({ tone: 'wait', text: join('Sample data, not live', checked), more: 'No engine answered, so this page shows made-up sample data.' });
  if (i.mode === 'replay') {
    return same({ tone: 'wait', text: join('Replay · recorded mainnet', checked), more: 'This engine plays recorded mainnet data back. It is not the live desk.' });
  }
  const who = i.owner ? 'owner' : null;
  return {
    tone: i.degraded === 'danger' ? 'down' : i.degraded === 'watch' ? 'watch' : 'live',
    text: join(['Live', i.mode, who].filter(Boolean).join(' · '), checked),
    short: join(['Live', who].filter(Boolean).join(' · '), checked),
    more: i.owner ? 'Owner unlocked in this tab: you can enter and close. The contract checks every order.' : i.readOnly ? VISITOR : null,
  };
}

const same = (h: Omit<Headline, 'short'>): Headline => ({ ...h, short: h.text });
const join = (head: string, tail: string | null): string => (tail === null ? head : `${head} · ${tail}`);

/**
 * The desk's own state for the dot: a failed rescue is danger; a leg on watch, a rescue running, or a venue of the
 * desk's legs slow or down is degraded. A venue the desk holds nothing on does not count.
 */
export function degradedOf(desk: DeskState | null, health: HealthMap | null): 'watch' | 'danger' | null {
  if (desk === null) return null;
  if (desk.rescueFailure) return 'danger';
  if (desk.health === 'watch' || desk.health === 'rescue') return 'watch';
  const venues = new Set<string>(desk.legs.map((l) => l.venue));
  for (const [venue, state] of Object.entries(health ?? {})) if (venues.has(venue) && state !== 'ok') return 'watch';
  return null;
}
