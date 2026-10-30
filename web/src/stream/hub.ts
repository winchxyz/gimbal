// One store for the whole app: the SSE client (or the fake) dispatches, components subscribe.
import { useSyncExternalStore } from 'react';
import { initialStreamState, reduceStream, type StreamAction, type StreamState } from './store.ts';

export interface Store<S, A> {
  getState(): S;
  dispatch(action: A): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S, A>(reduce: (state: S, action: A) => S, initial: S): Store<S, A> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const stream: Store<StreamState, StreamAction> = createStore(reduceStream, initialStreamState());

/** Selectors must return a slice of the state (not a new object), or React re-renders forever. */
export function useStream<T>(select: (state: StreamState) => T): T {
  return useSyncExternalStore(stream.subscribe, () => select(stream.getState()));
}
