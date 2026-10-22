/**
 * One turn as an async iterator of the loop's events, and the report the turn ends with.
 *
 * The loop is callback-shaped: it calls `emit` for every event and awaits `decide` for every card. `createEventQueue` is the other
 * side of `emit`: it holds the events until the caller reads them, so a caller that only wants the report never has to iterate.
 */

import type { AgentEvent, TurnReport } from '@caotang/harness';

/** The most events held for a caller that is not reading. Past it the oldest streamed text is dropped; no other event ever is. */
export const MAX_QUEUED_EVENTS = 4_096;

/** The events that stream text a long turn produces in thousands and a reader can do without. */
function isStreamedText(event: AgentEvent): boolean {
  return event.type === 'model.delta' || event.type === 'model.reasoning' || event.type === 'draft.delta';
}

export interface AgentRun extends AsyncIterable<AgentEvent> {
  /** Resolves when the turn ends and, with `write: true`, the folder is saved. Rejects only on an internal defect or a folder that changed under the project. */
  readonly report: Promise<TurnReport>;
}

export interface EventQueue {
  push(event: AgentEvent): void;
  /** No more events: an iterator drains what is held, then ends. */
  end(): void;
  /** No more events, and the turn failed: an iterator drains what is held, then throws. */
  fail(error: unknown): void;
  iterator(): AsyncIterableIterator<AgentEvent>;
}

export function createEventQueue(limit: number = MAX_QUEUED_EVENTS): EventQueue {
  const held: AgentEvent[] = [];
  let waiting: ((result: IteratorResult<AgentEvent>) => void) | undefined;
  let rejectWaiting: ((error: unknown) => void) | undefined;
  let closed = false;
  let failure: { readonly error: unknown } | undefined;

  const settle = (): void => {
    if (waiting === undefined || rejectWaiting === undefined) return;
    const next = held.shift();
    if (next !== undefined) {
      const resolve = waiting;
      waiting = rejectWaiting = undefined;
      resolve({ value: next, done: false });
    } else if (closed) {
      const [resolve, reject] = [waiting, rejectWaiting];
      waiting = rejectWaiting = undefined;
      if (failure === undefined) resolve({ value: undefined, done: true });
      else reject(failure.error);
    }
  };

  return {
    push(event) {
      if (closed) return;
      held.push(event);
      if (held.length > limit) {
        const dropped = held.findIndex(isStreamedText);
        if (dropped >= 0) held.splice(dropped, 1);
      }
      settle();
    },
    end() {
      closed = true;
      settle();
    },
    fail(error) {
      closed = true;
      failure = { error };
      settle();
    },
    iterator() {
      let finished = false;
      const iterator: AsyncIterableIterator<AgentEvent> = {
        next() {
          if (finished) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<AgentEvent>>((resolve, reject) => {
            waiting = (result) => {
              if (result.done === true) finished = true;
              resolve(result);
            };
            rejectWaiting = (error) => {
              finished = true;
              reject(error);
            };
            settle();
          });
        },
        return() {
          finished = true;
          held.length = 0;
          return Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator]() {
          return iterator;
        },
      };
      return iterator;
    },
  };
}
