import type { Machine, MachineTable } from '@caotang/machine';

export type QuotaState = 'reserved' | 'writing' | 'committed' | 'aborted' | 'released';
export type QuotaLifecycleState = { kind: QuotaState };
export type QuotaEvent = { type: 'begin' | 'commit' | 'cancel' | 'abort' | 'settle' };

export const quotaTable = {
  id: 'sync-server.quota',
  initial: 'reserved',
  final: ['committed', 'released'],
  on: {
    reserved: { begin: ['writing'], cancel: ['released'], abort: ['aborted'] },
    writing: { commit: ['committed'], cancel: ['aborted'], abort: ['aborted'] },
    aborted: { settle: ['released'] },
    committed: {},
    released: {},
  },
} as const satisfies MachineTable<QuotaLifecycleState, QuotaEvent>;

export const quotaMachine: Machine<QuotaLifecycleState, QuotaEvent> = {
  table: quotaTable,
  step(state, event) {
    const row: Partial<Record<QuotaEvent['type'], readonly QuotaState[]>> = quotaTable.on[state.kind];
    const target = row[event.type]?.[0];
    return target ? { kind: target } : state;
  },
};
