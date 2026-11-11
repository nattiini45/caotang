import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';
import type { RuntimeStore } from '@caotang/store';
import type { AppServices } from './services.js';

export interface BootResources {
  readonly store: RuntimeStore;
  readonly services: AppServices;
  readonly notice: string | null;
}

export type BootPhase =
  | { readonly kind: 'opening' }
  | ({ readonly kind: 'settling-interface' } & BootResources)
  | ({ readonly kind: 'ready' } & BootResources)
  | { readonly kind: 'failed'; readonly error: string; readonly newer: boolean };

export type BootEvent =
  | ({ readonly type: 'opened' } & BootResources)
  | { readonly type: 'ready' }
  | { readonly type: 'failed'; readonly error: string; readonly newer: boolean };

export const bootTable: MachineTable<BootPhase, BootEvent> = {
  id: 'app.boot', initial: 'opening', final: ['ready', 'failed'],
  on: {
    opening: { opened: ['settling-interface'], failed: ['failed'] },
    'settling-interface': { ready: ['ready'], failed: ['failed'] },
    ready: {}, failed: {},
  },
};

export const bootMachine = defineMachine(bootTable, (state, event): BootPhase => {
  switch (event.type) {
    case 'opened': return state.kind === 'opening'
      ? { kind: 'settling-interface', store: event.store, services: event.services, notice: event.notice } : state;
    case 'ready': return state.kind === 'settling-interface' ? { ...state, kind: 'ready' } : state;
    case 'failed': return state.kind === 'opening' || state.kind === 'settling-interface'
      ? { kind: 'failed', error: event.error, newer: event.newer } : state;
    default: return assertNever(event);
  }
});
