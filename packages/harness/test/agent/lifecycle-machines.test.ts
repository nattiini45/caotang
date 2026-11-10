import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';

import { createAgentPorts, createAgentSession, createContextPort, createTraceStore, type AgentEvent, type Decision, type PlanStep } from '../../src/index.js';
import { refusal } from '../../src/errors.js';
import { cardDecisionMachine, decideCard, MAX_CARD_STALLS, type CardDecisionEvent, type CardDecisionState, type OpenCardDecision } from '../../src/agent/card-decision.js';
import { cardStatusMachine, type CardStatus, type CardStatusEvent, type EditableSteps } from '../../src/agent/cards.js';
import { turnPhaseMachine, type TurnPhaseEvent, type TurnPhaseState } from '../../src/agent/turn-machine.js';
import { checkedHarness, makeState, STORM } from '../fixtures.js';
import { mockGateway } from './gateway.js';

const steps: PlanStep[] = [
  { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'Tagged' },
  { tool: 'meta.set', params: { targets: [STORM], label: 'act-2' }, expect: 'Labelled' },
];
const editable: EditableSteps = { steps, proposals: [undefined, undefined], stale: [false, false], origins: [0, 1], completed: [], superseded: [] };
const shown: OpenCardDecision = { kind: 'shown', editable, revision: 0, edits: 0, retries: 0, stalls: 0 };
const held: OpenCardDecision = { ...shown, kind: 'held', reason: 'Save the typing first.' };
const approve = { type: 'approve', approvable: true, canAcceptCut: false, notice: 'Not ready.' } as const;
const validEdit = { op: 'set', index: 0, path: ['expect'], value: 'The Storm is tagged.' } as const;
const invalidEdit = { op: 'drop', index: 99 } as const;

describe('the registered turn and card tables', () => {
  it('covers every turn phase and refuses moves from a terminal phase or back to started', () => {
    const kinds = ['started', 'planning', 'awaiting-approval', 'running', 'retrying', 'done', 'failed', 'cancelled'] as const;
    const states: TurnPhaseState[] = kinds.map((kind) => ({ kind }));
    const events: TurnPhaseEvent[] = kinds.map((type) => ({ type }));
    expect(checkMachine(turnPhaseMachine, { states, events })).toEqual([]);
    for (const kind of ['done', 'failed', 'cancelled'] as const) {
      const state = { kind };
      expect(turnPhaseMachine.step(state, { type: 'planning' })).toBe(state);
    }
    const running = { kind: 'running' } as const;
    expect(turnPhaseMachine.step(running, { type: 'started' })).toBe(running);
  });

  it('covers the status-card table without adding exits from finished cards', () => {
    const kinds = ['pending-approval', 'running', 'done', 'cancelled', 'failed'] as const;
    const states: CardStatus[] = kinds.map((kind) => ({ kind }));
    const events: CardStatusEvent[] = kinds.map((type) => ({ type }));
    expect(checkMachine(cardStatusMachine, { states, events })).toEqual([]);
  });

  it('covers every decision state, guard, stall boundary and ignored event without mutating inputs', () => {
    const states: CardDecisionState[] = [shown, held, { ...shown, stalls: 4 }, { ...held, stalls: 4 },
      { kind: 'retrying', previous: shown }, { kind: 'retrying', previous: held }, { kind: 'retrying', previous: { ...shown, stalls: 4 } },
      { kind: 'editing', previous: shown, next: editable, applied: 1 },
      { kind: 'editing', previous: held, next: editable, applied: 1 },
      { kind: 'editing', previous: { ...shown, stalls: 4 }, next: editable, applied: 1 },
      { kind: 'approved', editable, edits: 0, retries: 0 }, { kind: 'cancelled', editable, edits: 0, retries: 0 },
      { kind: 'refused', editable, edits: 0, retries: 0, error: refusal('invalid-params', 'Refused.') },
    ];
    const events: CardDecisionEvent[] = [
      { type: 'show' }, { type: 'hold', reason: 'Wait.' }, approve, { ...approve, auto: true },
      { ...approve, approvable: false }, { ...approve, approvable: false, canAcceptCut: true, acceptTruncated: true },
      { type: 'cancel' }, { type: 'retry' }, { type: 'edit', edits: [] }, { type: 'edit', edits: [validEdit] },
      { type: 'edit', edits: [invalidEdit] }, { type: 'edit', edits: [validEdit, invalidEdit] },
      { type: 'redrafted', editable }, { type: 'redrafted', editable, refusal: 'Draft refused.' },
      { type: 'refuse', error: refusal('invalid-params', 'Refused.') },
    ];
    const before = structuredClone(states);
    expect(checkMachine(cardDecisionMachine, { states, events })).toEqual([]);
    expect(states).toEqual(before);
  });
});

describe('card decisions own the retry and edit rounds', () => {
  it('keeps a held card manual after failed and successful retries', () => {
    let state = decideCard(held, { type: 'retry' });
    state = decideCard(state, { type: 'redrafted', editable, refusal: 'Draft refused.' });
    expect(state).toMatchObject({ kind: 'held', revision: 1, retries: 1, stalls: 1, reason: held.reason });
    state = decideCard(state, { type: 'retry' });
    state = decideCard(state, { type: 'redrafted', editable });
    expect(state).toMatchObject({ kind: 'held', revision: 2, retries: 2, stalls: 0 });
    expect(decideCard(state, { ...approve, auto: true })).toBe(state);
    expect(decideCard(state, approve)).toMatchObject({ kind: 'approved', retries: 2 });
  });

  it('keeps the last good card when an edited draft fails, and commits partial edit batches only after redrafting', () => {
    const editing = decideCard(shown, { type: 'edit', edits: [validEdit, invalidEdit] });
    expect(editing).toMatchObject({ kind: 'editing', applied: 1 });
    if (editing.kind !== 'editing') throw new Error('The valid first edit was not retained.');
    const failed = decideCard(editing, { type: 'redrafted', editable: editing.next, refusal: 'Draft refused.' });
    expect(failed).toMatchObject({ kind: 'shown', editable, revision: 0, edits: 0, stalls: 1 });
    const completed = decideCard(editing, { type: 'redrafted', editable: editing.next });
    expect(completed).toMatchObject({ kind: 'shown', edits: 1, revision: 1, stalls: 0, notice: expect.stringContaining('not in the plan') });
    expect(completed.kind === 'shown' && completed.editable.steps[0]?.expect).toBe(validEdit.value);
  });

  it('ends after five ineffective decisions and keeps the cut-text acceptance explicit', () => {
    let state: CardDecisionState = shown;
    for (let index = 0; index < MAX_CARD_STALLS; index += 1) state = decideCard(state, { ...approve, approvable: false });
    expect(state).toMatchObject({ kind: 'refused', error: { message: expect.stringContaining('5 times') } });
    expect(decideCard(state, approve)).toBe(state);
    expect(decideCard(shown, { ...approve, approvable: false, canAcceptCut: true, acceptTruncated: true })).toMatchObject({ kind: 'approved', acceptedCut: true });
  });
});

it('publishes the report before done and writes turn, card and decision transitions through the trace sink', async () => {
  const state = makeState();
  const events: AgentEvent[] = [];
  const trace = createTraceStore({ sessionId: 'machines' });
  const decisions: Decision[] = [{ action: 'edit', edits: [invalidEdit] }, { action: 'retry' }, { action: 'approve' }];
  const session = createAgentSession({
    sessionId: 'machines', harness: checkedHarness({ state, ports: createAgentPorts() }), gateway: await mockGateway([]),
    context: createContextPort({ state }), trace, decide: async () => decisions.shift() ?? { action: 'cancel' },
    emit: (event) => {
      if (event.type === 'turn' && event.phase === 'done') expect(events.some((seen) => seen.type === 'report' && seen.turnId === event.turnId)).toBe(true);
      events.push(event);
    },
  });
  const report = await session.submitPlan('Tag and label The Storm.', { steps }, { forcePlan: true });
  expect(report.status).toBe('applied');
  const rows = trace.records().filter((record) => record.kind === 'machine');
  expect(rows.map((row) => row.machine)).toEqual(expect.arrayContaining(['turn.phase', 'card.status', 'card.decision']));
  expect(rows.filter((row) => row.machine === 'card.decision').map((row) => [row.from, row.event, row.to])).toEqual([
    ['shown', 'edit', 'shown'], ['shown', 'show', 'shown'], ['shown', 'retry', 'retrying'],
    ['retrying', 'redrafted', 'shown'], ['shown', 'approve', 'approved'],
  ]);
  expect(rows.filter((row) => row.machine === 'card.status').map((row) => row.to)).toEqual(['running', 'done', 'running', 'done']);
  expect(rows.at(-1)).toMatchObject({ machine: 'turn.phase', from: 'running', event: 'done', to: 'done' });
  expect(trace.records().at(-1)?.kind).toBe('turn.end');
});
