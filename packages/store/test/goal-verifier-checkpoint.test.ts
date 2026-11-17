import { expect, it } from 'vitest';

import { checkpointReadable, createGoalRun, markGoalsInterrupted, openGoalRecovery, readGoalRun } from '../src/runtime/goal-run-store.js';
import { MemoryIndexedDb } from '../src/runtime/memory-idb.js';
import { openRuntimeStore } from '../src/runtime/store.js';

const definition = { kind: 'verifier', rubric: 'The departure is clear.', scope: { mode: 'full' }, gate: true };
const source = { docId: 'n_VERIFY0001', hash: 'a'.repeat(64) };

function checkpoint() {
  return {
    goal: { id: 'verified-goal', intent: 'Clarify the departure.', checks: [definition], limits: { maxModelCalls: 10 } },
    iterations: [{ n: 1 }], results: [], nextIteration: 2,
    spend: { modelCalls: 1, promptTokens: 10, completionTokens: 5, estimatedTokens: 0, steps: 0, activeMs: 0 },
    pendingVerification: {
      key: JSON.stringify(definition), iteration: 1, phase: 'prepared', sources: [source],
      input: { rubric: definition.rubric, omitted: 0, truncated: false, excerpts: [{ docId: source.docId, title: 'Departure', field: 'body', before: 'Before dawn.', after: 'At dawn.', truncated: false }] },
    },
  };
}

it('stores verifier goals as version 2 while retaining legacy rows', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb(), 'goal-verifier-versions');
  try {
    const saved = checkpoint();
    await createGoalRun(store, { goalId: saved.goal.id, projectId: 'project-one', sessionId: 'session-one', checkpoint: saved, at: 1 });
    expect((await readGoalRun(store, saved.goal.id))?.schema).toBe(2);
    await markGoalsInterrupted(store, 'project-one', 2);
    expect((await openGoalRecovery(store, saved.goal.id)).kind).toBe('offer');
    const legacy = { ...saved, goal: { ...saved.goal, id: 'legacy-goal', checks: [{ kind: 'synopsis.filled', scope: { mode: 'full' } }] }, pendingVerification: undefined };
    expect(checkpointReadable(legacy)).toBe(true);
    await createGoalRun(store, { goalId: legacy.goal.id, projectId: 'project-one', sessionId: 'session-one', checkpoint: legacy, at: 1 });
    expect((await readGoalRun(store, legacy.goal.id))?.schema).toBe(1);
  } finally {
    store.close();
  }
});

it('refuses malformed or unsupported verifier definitions before offering recovery', () => {
  const saved = checkpoint();
  for (const bad of [{ ...definition, gate: 'true' }, { ...definition, rubric: ' ' }, { ...definition, rubric: 'x'.repeat(4001) }, { ...definition, approval: true }]) {
    expect(checkpointReadable({ ...saved, goal: { ...saved.goal, checks: [bad] } })).toBe(false);
  }
});

it('binds pending input to its exact check, completed actor iteration and source set', () => {
  const saved = checkpoint();
  expect(checkpointReadable(saved)).toBe(true);
  for (const pendingVerification of [
    { ...saved.pendingVerification, key: JSON.stringify({ ...definition, rubric: 'A different criterion.' }) },
    { ...saved.pendingVerification, iteration: 2 },
    { ...saved.pendingVerification, phase: 'unknown' },
    { ...saved.pendingVerification, sources: [] },
    { ...saved.pendingVerification, sources: [{ ...source, hash: 'not-a-hash' }] },
    { ...saved.pendingVerification, input: { ...saved.pendingVerification.input, rubric: 'A different criterion.' } },
    { ...saved.pendingVerification, input: { ...saved.pendingVerification.input, actorMessages: ['not allowed'] } },
    { ...saved.pendingVerification, input: { ...saved.pendingVerification.input, omitted: Infinity } },
    { ...saved.pendingVerification, input: { ...saved.pendingVerification.input, excerpts: [{ ...saved.pendingVerification.input.excerpts[0], after: 'x'.repeat(2001) }] } },
  ]) expect(checkpointReadable({ ...saved, pendingVerification })).toBe(false);
});

it('accepts only finite reservations in the reserved phase', () => {
  const saved = checkpoint();
  const reservation = { id: 'reservation-one', promptTokens: 50, maxOutputTokens: 500, price: { prompt: 0.01, completion: 0.02 } };
  expect(checkpointReadable({ ...saved, pendingVerification: { ...saved.pendingVerification, phase: 'reserved', reservation } })).toBe(true);
  for (const bad of [undefined, { ...reservation, maxOutputTokens: NaN }, { ...reservation, promptTokens: -1 }, { ...reservation, price: { prompt: 0.01, completion: Infinity } }]) {
    expect(checkpointReadable({ ...saved, pendingVerification: { ...saved.pendingVerification, phase: 'reserved', reservation: bad } })).toBe(false);
  }
  expect(checkpointReadable({ ...saved, pendingVerification: { ...saved.pendingVerification, reservation } })).toBe(false);
});

it('rejects fabricated, oversized or mismatched saved verdicts', () => {
  const saved = checkpoint();
  const verification = { key: JSON.stringify(definition), iteration: 1, status: 'complete', verdict: { pass: true, reasons: [] }, omitted: 0, truncated: false, sources: [source] };
  expect(checkpointReadable({ ...saved, pendingVerification: undefined, verification })).toBe(true);
  for (const bad of [
    { ...verification, verdict: { pass: 'true', reasons: [] } },
    { ...verification, verdict: { pass: false, reasons: [] } },
    { ...verification, verdict: { pass: true, reasons: ['x'.repeat(1001)] } },
    { ...verification, sources: [] },
    { ...verification, key: JSON.stringify({ ...definition, gate: false }) },
    { ...verification, status: 'unavailable', reason: 'No verdict.' },
  ]) expect(checkpointReadable({ ...saved, pendingVerification: undefined, verification: bad })).toBe(false);
  const outcome = { status: 'passed', reason: 'Every required check passes.' };
  expect(checkpointReadable({ ...saved, pendingVerification: undefined, outcome })).toBe(false);
  expect(checkpointReadable({ ...saved, pendingVerification: undefined, verification, outcome })).toBe(true);
  expect(checkpointReadable({ ...saved, pendingVerification: undefined, verification, outcome: { ...outcome, status: 'future-status' } })).toBe(false);
});
