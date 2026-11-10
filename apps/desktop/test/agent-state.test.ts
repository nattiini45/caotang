import { expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import type { PendingCard } from '@caotang/harness';
import type { OfferView } from '../src/app/agent.js';
import { agentControllerMachine, initialAgentState, stepAgentState, type AgentState, type AgentStateEvent, type ControllerTurn } from '../src/app/agent-state.js';

const owner = new AbortController();
const other = new AbortController();
const turn: ControllerTurn = { owner, agent: null, turnId: 'turn-1', meter: null, mode: null, calls: null, intent: 'Write.', command: null, provider: null };
const decision = { pending: { kind: 'plan', turnId: 'turn-1', card: {} } as PendingCard, resolve: () => undefined };
const offer = { view: {} as OfferView, resolve: () => undefined };
const token = {};
const common = initialAgentState();
const states: AgentState[] = [common,
  { ...common, kind: 'starting', turn }, { ...common, kind: 'running', turn },
  { ...common, kind: 'parked-on-card', turn, decision },
  { ...common, kind: 'approving', turn, approval: { ...decision, token, waitMessage: null } },
  { ...common, kind: 'parked-on-offer', turn, offer }, { ...common, kind: 'stopping', turn },
  { ...common, kind: 'detached', turn: null, from: 'idle' },
  ...(['starting', 'running', 'stopping'] as const).map((from): AgentState => ({ ...common, kind: 'detached', turn, from })),
];

it('checks every controller phase, ownership guard and event against its table', () => {
  const events: AgentStateEvent[] = [
    { type: 'begin', turn }, { type: 'ready', turn }, { type: 'ready', turn: { ...turn, owner: other } },
    { type: 'turn', owner, patch: { turnId: 'turn-2' } }, { type: 'turn', owner: other, patch: {} },
    { type: 'card', decision }, { type: 'answer' }, { type: 'answer', approval: token },
    { type: 'approval-notice', token, message: 'Wait.' }, { type: 'approval-notice', token: {}, message: 'Wrong owner.' },
    { type: 'approval-finished', token }, { type: 'approval-finished', token: {} }, { type: 'repark', token }, { type: 'repark', token: {} },
    { type: 'offer', offer }, { type: 'offer-error', held: offer, error: 'Unavailable.' },
    { type: 'offer-error', held: { ...offer }, error: 'Stale.' }, { type: 'offer-answered' },
    { type: 'stop' }, { type: 'finish', owner }, { type: 'finish', owner, keepEarly: true }, { type: 'finish', owner: other },
    { type: 'attach' }, { type: 'detach' }, { type: 'queue', messages: [], paused: true },
    { type: 'queue', messages: [{ id: 'queued-1', intent: 'Next.', options: {} }], paused: true },
    { type: 'notes', pending: [{ noteId: 'n', text: 'Note.', lands: 'next-model-call' }], early: [{ noteId: 'n', text: 'Note.' }] },
    { type: 'interrupted', runs: [] },
  ];
  expect(checkMachine(agentControllerMachine, { states, events })).toEqual([]);
});

it('keeps only the owning decision in its card and approval states', () => {
  let state = stepAgentState(states[2]!, { type: 'card', decision });
  state = stepAgentState(state, { type: 'answer', approval: token });
  expect(state).toMatchObject({ kind: 'approving', approval: { token, pending: decision.pending } });
  expect(stepAgentState(state, { type: 'repark', token: {} })).toBe(state);
  state = stepAgentState(state, { type: 'repark', token });
  expect(state).toMatchObject({ kind: 'parked-on-card', decision });
  state = stepAgentState(state, { type: 'stop' });
  expect(state.kind).toBe('stopping');
  expect('decision' in state).toBe(false);
  expect(stepAgentState(state, { type: 'card', decision })).toBe(state);
  expect(stepAgentState(state, { type: 'finish', owner: other })).toBe(state);
  expect(stepAgentState(state, { type: 'finish', owner }).kind).toBe('idle');
});

it('carries an unfinished turn through detach and attach without retaining a parked choice', () => {
  const detached = stepAgentState(states[3]!, { type: 'detach' });
  expect(detached).toMatchObject({ kind: 'detached', turn, from: 'running' });
  expect('decision' in detached).toBe(false);
  expect(stepAgentState(detached, { type: 'card', decision })).toBe(detached);
  expect(stepAgentState(detached, { type: 'attach' })).toMatchObject({ kind: 'running', turn });
  expect(stepAgentState(stepAgentState(detached, { type: 'finish', owner }), { type: 'attach' }).kind).toBe('idle');
});

it('updates queue, note and interrupted-run sub-state without changing foreground ownership', () => {
  let state = stepAgentState(states[2]!, { type: 'queue', messages: [{ id: 'q', intent: 'Next.', options: {} }], paused: true });
  state = stepAgentState(state, { type: 'notes', early: [{ noteId: 'n', text: 'Note.' }] });
  state = stepAgentState(state, { type: 'finish', owner });
  expect(state).toMatchObject({ kind: 'idle', queue: { paused: true }, notes: { early: [] } });
  state = stepAgentState(state, { type: 'queue', messages: [] });
  expect(state.queue.paused).toBe(false);
});
