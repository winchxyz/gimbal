// The Windows screen's two engine reads, as hooks: the owner's strategy (`GET /strategy`) and the 7-day
// histories (`GET /windows/history`). They go through `engineApi()`, so the fake and the engine look the same here.
import type { StrategyConfig } from '@gimbal/shared';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createStore } from '../stream/hub.ts';
import { engineApi } from '../stream/start.ts';
import { needsHistory, reduceHistory, type HistoryState } from './history.ts';

// ---------- strategy ----------

export interface StrategyState {
  status: 'loading' | 'ready' | 'error';
  value: StrategyConfig | null; // the last good one stays while a refresh fails
  error: string | null;
}

type StrategyAction = { kind: 'ready'; value: StrategyConfig } | { kind: 'error'; error: string };

const strategyStore = createStore<StrategyState, StrategyAction>(
  (state, action) =>
    action.kind === 'ready'
      ? { status: 'ready', value: action.value, error: null }
      : { status: 'error', value: state.value, error: action.error },
  { status: 'loading', value: null, error: null },
);

/** The owner changes the rules on another screen, so ask again now and then. */
const STRATEGY_REFRESH_MS = 30_000;

export function useStrategy(): StrategyState {
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const value = await (await engineApi()).strategy();
        if (!stopped) strategyStore.dispatch({ kind: 'ready', value });
      } catch (error) {
        if (!stopped) strategyStore.dispatch({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    };
    void load();
    const timer = setInterval(load, STRATEGY_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  return useSyncExternalStore(strategyStore.subscribe, strategyStore.getState);
}

// ---------- history ----------

const historyStore = createStore(reduceHistory, {} as HistoryState);
const HISTORY_CHECK_MS = 30_000;

async function loadHistory(id: string): Promise<void> {
  historyStore.dispatch({ kind: 'start', id, at: Date.now() });
  try {
    const history = await (await engineApi()).windowHistory(id);
    historyStore.dispatch({ kind: 'ready', id, history, at: Date.now() });
  } catch (error) {
    historyStore.dispatch({ kind: 'error', id, error: error instanceof Error ? error.message : String(error), at: Date.now() });
  }
}

/** Makes sure every id has a fresh history (or is being fetched) and returns all of them. */
export function useHistories(ids: readonly string[]): HistoryState {
  const wanted = useRef(ids);
  wanted.current = ids;
  const key = ids.join('\n');

  useEffect(() => {
    const check = () => {
      const state = historyStore.getState();
      for (const id of wanted.current) if (needsHistory(state[id], Date.now())) void loadHistory(id);
    };
    check();
    const timer = setInterval(check, HISTORY_CHECK_MS);
    return () => clearInterval(timer);
  }, [key]);

  return useSyncExternalStore(historyStore.subscribe, historyStore.getState);
}

/** Asks again for one window's history now, from the chart's "Try again". */
export function retryHistory(id: string): void {
  void loadHistory(id);
}
