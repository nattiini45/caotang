import { assertNever, type Machine, type MachineTable } from '@caotang/machine';
import type { AgentSession, BudgetMeter, Decision, OfferAnswer, PendingCard, PermissionMode } from '@caotang/harness';
import type { InterruptedRunView, OfferView, PendingNote, QueuedMessage } from './agent.js';

export interface ControllerTurn {
  readonly owner: AbortController;
  readonly agent: AgentSession | null;
  readonly turnId: string | null;
  readonly meter: BudgetMeter | null;
  readonly mode: PermissionMode | null;
  readonly calls: number | null;
  readonly intent: string;
  readonly command: string | null;
  readonly provider: string | null;
}

export interface ParkedDecision {
  readonly pending: PendingCard;
  readonly resolve: (decision: Decision) => void;
}

export interface ApprovalHold extends ParkedDecision {
  readonly token: object;
  readonly waitMessage: string | null;
}

export interface ParkedOffer {
  readonly view: OfferView;
  readonly resolve: (answer: OfferAnswer) => void;
}

interface Common {
  readonly queue: { readonly messages: readonly QueuedMessage[]; readonly paused: boolean };
  readonly notes: { readonly pending: readonly PendingNote[]; readonly early: readonly { readonly noteId: string; readonly text: string }[] };
  readonly interrupted: readonly InterruptedRunView[];
}

export type AgentState = Common & (
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting'; readonly turn: ControllerTurn }
  | { readonly kind: 'running'; readonly turn: ControllerTurn }
  | { readonly kind: 'parked-on-card'; readonly turn: ControllerTurn; readonly decision: ParkedDecision }
  | { readonly kind: 'approving'; readonly turn: ControllerTurn; readonly approval: ApprovalHold }
  | { readonly kind: 'parked-on-offer'; readonly turn: ControllerTurn; readonly offer: ParkedOffer }
  | { readonly kind: 'stopping'; readonly turn: ControllerTurn }
  | { readonly kind: 'detached'; readonly turn: ControllerTurn | null; readonly from: 'idle' | 'starting' | 'running' | 'stopping' }
);

export type AgentStateEvent =
  | { readonly type: 'begin'; readonly turn: ControllerTurn }
  | { readonly type: 'ready'; readonly turn: ControllerTurn }
  | { readonly type: 'turn'; readonly owner: AbortController; readonly patch: Partial<Pick<ControllerTurn, 'turnId' | 'intent' | 'command' | 'provider'>> }
  | { readonly type: 'card'; readonly decision: ParkedDecision }
  | { readonly type: 'answer'; readonly approval?: object }
  | { readonly type: 'approval-notice'; readonly token: object; readonly message: string }
  | { readonly type: 'approval-finished'; readonly token: object }
  | { readonly type: 'repark'; readonly token: object }
  | { readonly type: 'offer'; readonly offer: ParkedOffer }
  | { readonly type: 'offer-error'; readonly held: ParkedOffer; readonly error: string }
  | { readonly type: 'offer-answered' }
  | { readonly type: 'stop' }
  | { readonly type: 'finish'; readonly owner: AbortController; readonly keepEarly?: boolean }
  | { readonly type: 'attach' }
  | { readonly type: 'detach' }
  | { readonly type: 'queue'; readonly messages?: readonly QueuedMessage[]; readonly paused?: boolean }
  | { readonly type: 'notes'; readonly pending?: readonly PendingNote[]; readonly early?: Common['notes']['early'] }
  | { readonly type: 'interrupted'; readonly runs: readonly InterruptedRunView[] };

const same = (kind: AgentState['kind']) => ({ queue: [kind], notes: [kind], interrupted: [kind] });

export const agentControllerTable: MachineTable<AgentState, AgentStateEvent> = {
  id: 'agent.controller', initial: 'idle', final: [],
  on: {
    idle: { ...same('idle'), begin: ['starting'], detach: ['detached'] },
    starting: { ...same('starting'), ready: ['running', 'starting'], turn: ['starting'], stop: ['stopping'], finish: ['idle', 'starting'], detach: ['detached'] },
    running: { ...same('running'), turn: ['running'], card: ['parked-on-card'], offer: ['parked-on-offer'], stop: ['stopping'], finish: ['idle', 'running'], detach: ['detached'] },
    'parked-on-card': { ...same('parked-on-card'), turn: ['parked-on-card'], card: ['parked-on-card'], answer: ['running', 'approving'], stop: ['stopping'], finish: ['idle', 'parked-on-card'], detach: ['detached'] },
    approving: { ...same('approving'), turn: ['approving'], card: ['parked-on-card'], 'approval-notice': ['approving'], 'approval-finished': ['running', 'approving'], repark: ['parked-on-card', 'approving'], stop: ['stopping'], finish: ['idle', 'approving'], detach: ['detached'] },
    'parked-on-offer': { ...same('parked-on-offer'), turn: ['parked-on-offer'], offer: ['parked-on-offer'], 'offer-error': ['parked-on-offer'], 'offer-answered': ['running'], stop: ['stopping'], finish: ['idle', 'parked-on-offer'], detach: ['detached'] },
    stopping: { ...same('stopping'), ready: ['stopping'], turn: ['stopping'], finish: ['idle', 'stopping'], detach: ['detached'] },
    detached: { ...same('detached'), begin: ['detached'], ready: ['detached'], turn: ['detached'], stop: ['detached'], finish: ['detached'], attach: ['idle', 'starting', 'running', 'stopping'] },
  },
};

export const initialAgentState = (): AgentState => ({ kind: 'idle', queue: { messages: [], paused: false }, notes: { pending: [], early: [] }, interrupted: [] });
export const controllerTurn = (state: AgentState): ControllerTurn | null => state.kind === 'idle' ? null : state.turn;

function common(state: AgentState): Common {
  return { queue: state.queue, notes: state.notes, interrupted: state.interrupted };
}

export function stepAgentState(state: AgentState, event: AgentStateEvent): AgentState {
  const turn = controllerTurn(state);
  switch (event.type) {
    case 'queue': {
      const messages = event.messages ?? state.queue.messages;
      return { ...state, queue: { messages, paused: messages.length > 0 && (event.paused ?? state.queue.paused) } };
    }
    case 'notes':
      return { ...state, notes: { pending: event.pending ?? state.notes.pending, early: event.early ?? state.notes.early } };
    case 'interrupted':
      return { ...state, interrupted: event.runs };
    case 'begin':
      if (turn !== null) return state;
      return state.kind === 'detached'
        ? { ...state, turn: event.turn, from: 'starting' }
        : { ...common(state), kind: 'starting', turn: event.turn };
    case 'ready':
      if (turn?.owner !== event.turn.owner) return state;
      if (state.kind === 'starting') return { ...common(state), kind: 'running', turn: event.turn };
      if (state.kind === 'stopping') return { ...state, turn: event.turn };
      return state.kind === 'detached' ? { ...state, turn: event.turn, from: state.from === 'stopping' ? 'stopping' : 'running' } : state;
    case 'turn':
      if (turn?.owner !== event.owner || state.kind === 'idle') return state;
      return { ...state, turn: { ...turn, ...event.patch } };
    case 'card':
      if (state.kind !== 'running' && state.kind !== 'parked-on-card' && state.kind !== 'approving') return state;
      return { ...common(state), kind: 'parked-on-card', turn: state.turn, decision: event.decision };
    case 'answer':
      if (state.kind !== 'parked-on-card') return state;
      return event.approval === undefined
        ? { ...common(state), kind: 'running', turn: state.turn }
        : { ...common(state), kind: 'approving', turn: state.turn, approval: { ...state.decision, token: event.approval, waitMessage: null } };
    case 'approval-notice':
      return state.kind === 'approving' && state.approval.token === event.token
        ? { ...state, approval: { ...state.approval, waitMessage: event.message } } : state;
    case 'approval-finished':
      return state.kind === 'approving' && state.approval.token === event.token
        ? { ...common(state), kind: 'running', turn: state.turn } : state;
    case 'repark':
      return state.kind === 'approving' && state.approval.token === event.token
        ? { ...common(state), kind: 'parked-on-card', turn: state.turn, decision: state.approval } : state;
    case 'offer':
      return state.kind === 'running' || state.kind === 'parked-on-offer'
        ? { ...common(state), kind: 'parked-on-offer', turn: state.turn, offer: event.offer } : state;
    case 'offer-error':
      return state.kind === 'parked-on-offer' && state.offer === event.held
        ? { ...state, offer: { ...state.offer, view: { ...state.offer.view, error: event.error } } } : state;
    case 'offer-answered':
      return state.kind === 'parked-on-offer' ? { ...common(state), kind: 'running', turn: state.turn } : state;
    case 'stop':
      if (turn === null || state.kind === 'stopping') return state;
      return state.kind === 'detached' ? { ...state, from: 'stopping' } : { ...common(state), kind: 'stopping', turn };
    case 'finish': {
      if (turn?.owner !== event.owner) return state;
      const fields = { ...common(state), notes: { ...state.notes, early: event.keepEarly === true ? state.notes.early : [] } };
      return state.kind === 'detached' ? { ...fields, kind: 'detached', turn: null, from: 'idle' } : { ...fields, kind: 'idle' };
    }
    case 'detach':
      if (state.kind === 'detached') return state;
      return { ...common(state), kind: 'detached', turn, from: state.kind === 'idle' || state.kind === 'starting' || state.kind === 'stopping' ? state.kind : 'running' };
    case 'attach':
      if (state.kind !== 'detached') return state;
      if (state.turn === null) return { ...common(state), kind: 'idle' };
      return { ...common(state), kind: state.from === 'idle' ? 'running' : state.from, turn: state.turn };
    default:
      return assertNever(event);
  }
}

export const agentControllerMachine: Machine<AgentState, AgentStateEvent> = { table: agentControllerTable, step: stepAgentState };
