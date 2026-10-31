// The Security screen's data: the desk the engine names, read from the contract it names. The engine says which desk and
// which contract (`DeskState`); the page reads the policy, the config and the owner's keys itself, over NEAR RPC, so
// nothing on the screen is the engine's word about what the contract enforces.
//
// Where the chain is: the real RPC for testnet and mainnet. A replay has none (a recording has no contract), and the
// development fake stream reads the fake world (dev.ts), so the screen renders without a live desk.
import { useCallback, useEffect, useState } from 'react';
import type { Mode } from '@gimbal/shared';
import { rpcChain, type Chain } from '../onboarding/chain.ts';
import { useStream } from '../stream/hub.ts';
import { deskMissing } from '../windows/model.ts';
import { netOf } from './explorer.ts';
import { loadSecurity, type SecurityData, type SecurityTarget } from './load.ts';

/** How often a screen that has its data reads it again: a key added or a policy signed shows within a minute. */
export const REFRESH_MS = 60_000;
/** How often a failed read is tried again by itself. */
export const RETRY_MS = 15_000;

export type SecurityView =
  /** The engine has not named a desk yet, or the contract has not answered. */
  | { status: 'loading' }
  /** No desk: the engine has none, or the contract has none by that id. */
  | { status: 'empty' }
  /** The engine replays a recording: there is no contract to read. */
  | { status: 'replay' }
  | { status: 'error'; message: string; at: number; target: SecurityTarget | null }
  /** `stale` is set when the last read failed and what is shown is from an earlier one. */
  | { status: 'ready'; data: SecurityData; stale: { error: string; at: number } | null };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The chain to read: null for a replay. */
async function chainFor(target: SecurityTarget & { owner: string }, fake: boolean): Promise<Chain | null> {
  // A recording has no contract, in development too (`?net=replay`), so the screen can be seen as a replay shows it.
  if (target.mode === 'replay') return null;
  // The build replaces DEV with false, so this branch and the fake behind it are not in a production bundle.
  if (import.meta.env.DEV && fake) {
    const { fakeSecurityChain } = await import('./dev.ts');
    return fakeSecurityChain(target, window.location.search);
  }
  return rpcChain(netOf(target.mode));
}

type Loaded = { kind: 'ready'; data: SecurityData } | { kind: 'empty' } | { kind: 'error'; message: string; at: number } | { kind: 'replay' };

// What the last visit read, so coming back to the tab shows it at once and reads again behind it.
let remembered: { key: string; data: SecurityData } | null = null;
const rememberedFor = (key: string | null): Loaded | null => (key !== null && remembered?.key === key ? { kind: 'ready', data: remembered.data } : null);

export function useSecurity(): { view: SecurityView; retry(): void } {
  const desk = useStream((s) => s.desk);
  const source = useStream((s) => s.source);
  const noDesk = useStream((s) => deskMissing(s.windows));

  const deskId = desk?.deskId ?? null;
  const contractId = desk?.contract ?? null;
  const owner = desk?.owner ?? null;
  const mode: Mode | null = desk?.mode ?? null;
  const fake = source === 'fake';
  const key = deskId === null ? null : `${fake ? 'fake' : 'chain'}|${mode}|${contractId}|${deskId}`;

  const [loaded, setLoaded] = useState<Loaded | null>(() => rememberedFor(key));
  const [failure, setFailure] = useState<{ message: string; at: number } | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    setLoaded(rememberedFor(key));
    setFailure(null);
    if (key === null || deskId === null || contractId === null || owner === null || mode === null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async (): Promise<void> => {
      const target = { contractId, deskId, mode, owner };
      try {
        const chain = await chainFor(target, fake);
        if (!alive) return;
        if (chain === null) {
          setLoaded({ kind: 'replay' });
          return;
        }
        const data = await loadSecurity(chain, { contractId, deskId, mode });
        if (!alive) return;
        setFailure(null);
        if (data === null) {
          remembered = null;
          setLoaded({ kind: 'empty' });
        } else {
          remembered = { key, data };
          setLoaded({ kind: 'ready', data });
        }
        timer = setTimeout(() => void run(), REFRESH_MS);
      } catch (error) {
        if (!alive) return;
        // What was read before stays on the screen, marked; with nothing read yet the screen says it cannot read.
        const failed = { message: messageOf(error), at: Date.now() };
        setFailure(failed);
        setLoaded((now) => (now?.kind === 'ready' ? now : { kind: 'error', ...failed }));
        timer = setTimeout(() => void run(), RETRY_MS);
      }
    };
    void run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, tries, fake, deskId, contractId, owner, mode]);

  const retry = useCallback(() => {
    remembered = null;
    setTries((n) => n + 1);
  }, []);

  if (desk === null) return { view: noDesk ? { status: 'empty' } : { status: 'loading' }, retry };
  if (loaded === null) return { view: { status: 'loading' }, retry };
  if (loaded.kind === 'empty') return { view: { status: 'empty' }, retry };
  if (loaded.kind === 'replay') return { view: { status: 'replay' }, retry };
  if (loaded.kind === 'error') {
    return { view: { status: 'error', message: loaded.message, at: loaded.at, target: { contractId: desk.contract, deskId: desk.deskId, mode: desk.mode } }, retry };
  }
  return { view: { status: 'ready', data: loaded.data, stale: failure === null ? null : { error: failure.message, at: failure.at } }, retry };
}
