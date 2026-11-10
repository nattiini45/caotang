import { canMove, type Machine, type MachineTable } from '@caotang/machine';
import type { TurnPhase } from './events.js';

export type TurnPhaseState = { [K in TurnPhase]: { readonly kind: K } }[TurnPhase];
export type TurnPhaseEvent = { [K in TurnPhase]: { readonly type: K } }[TurnPhase];

export const turnPhaseTable: MachineTable<TurnPhaseState, TurnPhaseEvent> = {
  id: 'turn.phase',
  initial: 'started',
  final: ['done', 'failed', 'cancelled'],
  on: {
    started: {
      started: ['started'], planning: ['planning'], 'awaiting-approval': ['awaiting-approval'],
      running: ['running'], done: ['done'], failed: ['failed'], cancelled: ['cancelled'],
    },
    planning: {
      planning: ['planning'], 'awaiting-approval': ['awaiting-approval'], running: ['running'],
      retrying: ['retrying'], done: ['done'], failed: ['failed'], cancelled: ['cancelled'],
    },
    'awaiting-approval': {
      planning: ['planning'], 'awaiting-approval': ['awaiting-approval'], running: ['running'],
      retrying: ['retrying'], done: ['done'], failed: ['failed'], cancelled: ['cancelled'],
    },
    running: {
      planning: ['planning'], 'awaiting-approval': ['awaiting-approval'], running: ['running'],
      retrying: ['retrying'], done: ['done'], failed: ['failed'], cancelled: ['cancelled'],
    },
    retrying: {
      planning: ['planning'], 'awaiting-approval': ['awaiting-approval'], running: ['running'],
      retrying: ['retrying'], done: ['done'], failed: ['failed'], cancelled: ['cancelled'],
    },
    done: {},
    failed: {},
    cancelled: {},
  },
};

export const turnPhaseMachine: Machine<TurnPhaseState, TurnPhaseEvent> = {
  table: turnPhaseTable,
  step: (state, event) => canMove(turnPhaseTable, state.kind, event.type) ? { kind: event.type } : state,
};
