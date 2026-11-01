// The Rescue screen's reads and its one write. The step book is kept outside React and fed straight from the stream, so
// a rescue that began while another screen was open still has the times of the steps this page saw.
import type { RescueProgress } from '@gimbal/shared';
import { useSyncExternalStore } from 'react';
import { createStore, stream } from '../stream/hub.ts';
import { engineApi } from '../stream/start.ts';
import { emptyBook, observe, stressOutcome, type StepBook } from './model.ts';

const bookStore = createStore<StepBook, RescueProgress>(observe, emptyBook);

let seen: RescueProgress | null = null;
const feed = (): void => {
  const rescue = stream.getState().rescue;
  if (rescue === null || rescue === seen) return;
  seen = rescue;
  bookStore.dispatch(rescue);
};
stream.subscribe(feed);
feed();

export const useStepBook = (): StepBook => useSyncExternalStore(bookStore.subscribe, bookStore.getState);

/** Sends `POST /stress` and says what came of it; it never throws. */
export async function sendStress(): Promise<ReturnType<typeof stressOutcome>> {
  try {
    return stressOutcome(await (await engineApi()).stress());
  } catch (error) {
    return stressOutcome(error instanceof Error ? error : new Error(String(error)));
  }
}
