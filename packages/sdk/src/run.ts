/**
 * One turn as an async iterator of the loop's events, and the report the turn ends with.
 *
 * The loop is callback-shaped: it calls `emit` for every event and awaits `decide` for every card. `createEventQueue` is the other
 * side of `emit`: it holds the events until the caller reads them, so a caller that only wants the report never has to iterate.
 */

import type { AgentEvent, TurnReport } from '@caotang/harness';
import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

export type EventQueueState = { kind: 'open' } | { kind: 'ended' } | { kind: 'failed'; error: unknown };
export type EventQueueEvent = { type: 'end' } | { type: 'fail'; error: unknown };

export const eventQueueTable: MachineTable<EventQueueState, EventQueueEvent> = {
  id: 'sdk.events', initial: 'open', final: [],
  on: { open: { end: ['ended'], fail: ['failed'] }, ended: { fail: ['failed'] }, failed: { fail: ['failed'] } },
};

export const eventQueueMachine = defineMachine(eventQueueTable, (state, event): EventQueueState => {
  switch (event.type) {
    case 'end': return state.kind === 'open' ? { kind: 'ended' } : state;
    case 'fail': return { kind: 'failed', error: event.error };
    default: return assertNever(event);
  }
});

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
  const waiting: {
    owner: object;
    resolve(result: IteratorResult<AgentEvent>): void;
    reject(error: unknown): void;
  }[] = [];
  let state: EventQueueState = { kind: 'open' };

  const settle = (): void => {
    while (waiting.length > 0 && (held.length > 0 || state.kind !== 'open')) {
      const reader = waiting.shift()!;
      const next = held.shift();
      if (next !== undefined) reader.resolve({ value: next, done: false });
      else if (state.kind === 'failed') reader.reject(state.error);
      else reader.resolve({ value: undefined, done: true });
    }
  };

  return {
    push(event) {
      if (state.kind !== 'open') return;
      held.push(event);
      if (held.length > limit) {
        const dropped = held.findIndex(isStreamedText);
        if (dropped >= 0) held.splice(dropped, 1);
      }
      settle();
    },
    end() {
      state = eventQueueMachine.step(state, { type: 'end' });
      settle();
    },
    fail(error) {
      state = eventQueueMachine.step(state, { type: 'fail', error });
      settle();
    },
    iterator() {
      let finished = false;
      const iterator: AsyncIterableIterator<AgentEvent> = {
        next() {
          if (finished) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<AgentEvent>>((resolve, reject) => {
            waiting.push({
              owner: iterator,
              resolve(result) {
                if (result.done === true) finished = true;
                resolve(result);
              },
              reject(error) {
                finished = true;
                reject(error);
              },
            });
            settle();
          });
        },
        return() {
          finished = true;
          held.length = 0;
          for (let index = 0; index < waiting.length;) {
            if (waiting[index]!.owner === iterator) waiting.splice(index, 1)[0]!.resolve({ value: undefined, done: true });
            else index += 1;
          }
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
