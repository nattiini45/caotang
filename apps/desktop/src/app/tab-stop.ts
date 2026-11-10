import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

import { readUnsentEntries, type UnsentStorage } from './unsent-copy.js';

export type StopCause = 'newer-text' | 'updated';

export type TabStopState =
  | { readonly kind: 'running' }
  | { readonly kind: 'stopped'; readonly cause: StopCause; readonly keptLatest: boolean };

export type TabStopEvent =
  | { readonly type: 'stop'; readonly cause: StopCause }
  | { readonly type: 'keep'; readonly landed: boolean };

export const tabStopTable: MachineTable<TabStopState, TabStopEvent> = {
  id: 'tab.stop', initial: 'running', final: [],
  on: { running: { stop: ['stopped'] }, stopped: { keep: ['stopped'] } },
};

export function stepTabStop(state: TabStopState, event: TabStopEvent): TabStopState {
  switch (event.type) {
    case 'stop':
      return state.kind === 'running' ? { kind: 'stopped', cause: event.cause, keptLatest: false } : state;
    case 'keep':
      return state.kind === 'stopped' ? { ...state, keptLatest: event.landed } : state;
    default:
      return assertNever(event);
  }
}

export const tabStopMachine = defineMachine(tabStopTable, stepTabStop);

export class TabStop {
  private state: TabStopState = { kind: 'running' };
  private readonly listeners = new Set<() => void>();

  constructor(readonly projectId: string, readonly stopId: string) {}

  readonly getSnapshot = (): TabStopState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  send(event: TabStopEvent): void {
    const next = stepTabStop(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  keptInBrowser(storage: UnsentStorage | undefined): boolean {
    return this.state.kind === 'stopped' && this.state.keptLatest &&
      readUnsentEntries(storage, this.projectId).some((entry) => entry.stopId === this.stopId);
  }
}
