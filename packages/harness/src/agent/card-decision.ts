import type { CommandError } from '@caotang/bus';
import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

import { refusal } from '../errors.js';
import { applyEdit, type EditableSteps, type PlanEdit } from './cards.js';

export const MAX_CARD_STALLS = 5;

interface Round {
  readonly editable: EditableSteps;
  readonly revision: number;
  readonly edits: number;
  readonly retries: number;
  readonly stalls: number;
  readonly notice?: string;
}

export type OpenCardDecision = Round & ({ readonly kind: 'shown' } | { readonly kind: 'held'; readonly reason: string });

interface Result {
  readonly editable: EditableSteps;
  readonly edits: number;
  readonly retries: number;
}

export type CardDecisionState =
  | OpenCardDecision
  | { readonly kind: 'retrying'; readonly previous: OpenCardDecision }
  | { readonly kind: 'editing'; readonly previous: OpenCardDecision; readonly next: EditableSteps; readonly applied: number; readonly notice?: string }
  | (Result & { readonly kind: 'approved'; readonly auto?: true; readonly acceptedCut?: true })
  | (Result & { readonly kind: 'cancelled' })
  | (Result & { readonly kind: 'refused'; readonly error: CommandError });

export type CardDecisionEvent =
  | { readonly type: 'show' }
  | { readonly type: 'hold'; readonly reason: string }
  | { readonly type: 'approve'; readonly approvable: boolean; readonly canAcceptCut: boolean; readonly acceptTruncated?: boolean; readonly auto?: true; readonly notice: string }
  | { readonly type: 'cancel' }
  | { readonly type: 'retry' }
  | { readonly type: 'edit'; readonly edits: readonly PlanEdit[] }
  | { readonly type: 'redrafted'; readonly editable: EditableSteps; readonly refusal?: string }
  | { readonly type: 'refuse'; readonly error: CommandError };

export const cardDecisionTable: MachineTable<CardDecisionState, CardDecisionEvent> = {
  id: 'card.decision', initial: 'shown', final: ['approved', 'cancelled', 'refused'],
  on: {
    shown: {
      show: ['shown'], hold: ['held'], approve: ['approved', 'shown', 'refused'], cancel: ['cancelled'],
      retry: ['retrying'], edit: ['editing', 'shown', 'refused'], refuse: ['refused'],
    },
    held: {
      show: ['held'], hold: ['held'], approve: ['approved', 'held', 'refused'], cancel: ['cancelled'],
      retry: ['retrying'], edit: ['editing', 'held', 'refused'], refuse: ['refused'],
    },
    retrying: { redrafted: ['shown', 'held', 'refused'] },
    editing: { redrafted: ['shown', 'held', 'refused'] },
    approved: {}, cancelled: {}, refused: {},
  },
};

function stalled(state: OpenCardDecision, notice: string | undefined): CardDecisionState {
  const stalls = state.stalls + 1;
  return stalls < MAX_CARD_STALLS
    ? { ...state, stalls, notice }
    : {
      kind: 'refused', editable: state.editable, edits: state.edits, retries: state.retries,
      error: refusal('permission-denied', `the card was decided ${MAX_CARD_STALLS} times without a change that could be applied, so the turn stopped`, {
        correctiveHint: 'fix the step the card names, or cancel the card',
      }),
    };
}

export function decideCard(state: CardDecisionState, event: CardDecisionEvent): CardDecisionState {
  if (state.kind === 'approved' || state.kind === 'cancelled' || state.kind === 'refused') return state;
  if (state.kind === 'retrying' || state.kind === 'editing') {
    if (event.type !== 'redrafted') return state;
    const previous = state.previous;
    if (state.kind === 'retrying') {
      const next = { ...previous, retries: previous.retries + 1, revision: previous.revision + 1 };
      return event.refusal === undefined
        ? { ...next, editable: event.editable, stalls: 0, notice: undefined }
        : stalled(next, event.refusal);
    }
    return event.refusal === undefined
      ? { ...previous, editable: event.editable, edits: previous.edits + state.applied, revision: previous.revision + 1, stalls: 0, notice: state.notice }
      : stalled(previous, event.refusal);
  }
  switch (event.type) {
    case 'show':
      return state.notice === undefined ? state : { ...state, notice: undefined };
    case 'hold':
      return { ...state, kind: 'held', reason: event.reason, notice: event.reason };
    case 'approve': {
      if (event.auto === true && state.kind === 'held') return state;
      const acceptedCut = event.acceptTruncated === true && event.canAcceptCut;
      return event.approvable || acceptedCut
        ? {
          kind: 'approved', editable: state.editable, edits: state.edits, retries: state.retries,
          ...(event.auto === true ? { auto: true } : {}), ...(acceptedCut ? { acceptedCut: true } : {}),
        }
        : stalled(state, event.notice);
    }
    case 'cancel':
      return { kind: 'cancelled', editable: state.editable, edits: state.edits, retries: state.retries };
    case 'retry':
      return { kind: 'retrying', previous: state };
    case 'edit': {
      let next = state.editable;
      let applied = 0;
      let notice: string | undefined;
      for (const edit of event.edits) {
        const result = applyEdit(next, edit);
        if (!result.ok) {
          notice = result.error;
          break;
        }
        next = result.value;
        applied += 1;
      }
      return applied === 0
        ? stalled(state, notice)
        : { kind: 'editing', previous: state, next, applied, notice };
    }
    case 'refuse':
      return { kind: 'refused', editable: state.editable, edits: state.edits, retries: state.retries, error: event.error };
    case 'redrafted':
      return state;
    default:
      return assertNever(event);
  }
}

export const cardDecisionMachine = defineMachine(cardDecisionTable, decideCard);
