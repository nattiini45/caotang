import { assertNever, type MachineTable } from '@caotang/machine';

export type RecurringRunState = { readonly kind: 'idle' }
  | { readonly kind: 'running' | 'recording'; readonly taskId: string };

export type RecurringRunEvent = { readonly type: 'start' | 'record' | 'finish'; readonly taskId: string };

export const recurringRunTable: MachineTable<RecurringRunState, RecurringRunEvent> = {
  id: 'recurring.run', initial: 'idle', final: [],
  on: {
    idle: { start: ['running'] },
    running: { record: ['recording', 'running'], finish: ['idle', 'running'] },
    recording: { finish: ['idle', 'recording'] },
  },
};

export function stepRecurringRun(state: RecurringRunState, event: RecurringRunEvent): RecurringRunState {
  switch (event.type) {
    case 'start':
      return state.kind === 'idle' ? { kind: 'running', taskId: event.taskId } : state;
    case 'record':
      return state.kind === 'running' && state.taskId === event.taskId ? { ...state, kind: 'recording' } : state;
    case 'finish':
      return state.kind !== 'idle' && state.taskId === event.taskId ? { kind: 'idle' } : state;
    default:
      return assertNever(event.type);
  }
}
