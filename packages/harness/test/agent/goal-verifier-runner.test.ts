import { expect, it } from 'vitest';

import { getBody, setBody, type ProjectState } from '@caotang/store';

import { createBudgetMeter, createGoalRunner, recoverGoalVerifierCheckpoint, type AgentSession, type Goal, type GoalCheckpoint, type GoalVerifierPort, type TurnReport } from '../../src/index.js';
import type { GoalVerifierInput } from '../../src/agent/goal-verifier.js';
import type { GoalVerifierCallResult } from '../../src/agent/goal-verifier-call.js';
import { LANDING, makeState, STORM } from '../fixtures.js';

const scope = { mode: 'doc', docIds: [LANDING] } as const;
const rubric = 'The departure is clear.';

function goal(gate = false): Goal {
  return {
    id: 'verified-goal', intent: 'Clarify the departure and write its synopsis.', limits: { maxModelCalls: 10 },
    checks: [{ kind: 'synopsis.filled', scope }, { kind: 'verifier', scope, rubric, gate }],
  };
}

function fixture(edit?: (state: ProjectState, n: number) => void) {
  const state = makeState();
  const landing = state.manifest.tree.find(candidate => candidate.id === LANDING);
  if (landing !== undefined) landing.synopsis = '';
  let turns = 0;
  const session = {
    submit: async (): Promise<TurnReport> => {
      turns += 1;
      const node = state.manifest.tree.find(candidate => candidate.id === LANDING);
      if (node !== undefined) node.synopsis = 'The ferry departs at dawn.';
      setBody(state, LANDING, `The ferry departs at dawn. Revision ${turns}.`);
      edit?.(state, turns);
      return {
        turnId: `verified-turn-${turns}`, status: 'applied', summary: 'The departure is clear.', steps: [], cards: [], trace: [],
        tokens: { promptTokens: 0, completionTokens: 0, requests: 0 }, dropped: [], modelCalls: 1, mode: 'ask',
        budgetUse: { modelCalls: 1, tokens: 0, wordsChanged: 0, documents: 0, steps: 0 },
      };
    },
  } as unknown as AgentSession;
  const definition = goal();
  const meter = createBudgetMeter(definition.limits);
  return { state, session, meter, withheld: () => new Set<string>(), turns: () => turns, saveIteration: async () => {}, saveCheckpoint: async () => {} };
}

const verdict = (pass: boolean): GoalVerifierCallResult => ({ kind: 'complete', content: JSON.stringify({ pass, reasons: pass ? [] : ['The departure still needs work.'] }) });

it('keeps an advisory failure out of deterministic results and goal acceptance', async () => {
  const f = fixture();
  let calls = 0;
  const run = await createGoalRunner().start(goal(), { ...f, verifier: async () => { calls += 1; return verdict(false); } });
  expect(run.status).toBe('passed');
  expect(calls).toBe(1);
  expect(run.results.map(result => result.spec.kind)).toEqual(['synopsis.filled']);
  expect(run.verification).toMatchObject({ status: 'complete', verdict: { pass: false } });
  expect(run.iterations[0]?.distance).toEqual({ before: 1, after: 0 });
});

it.each([false, true])('remeasures deterministic gates after an asynchronous review (gate %s)', async gate => {
  const f = fixture();
  const statusScope = { mode: 'doc', docIds: [STORM] } as const;
  const node = f.state.manifest.tree.find(candidate => candidate.id === STORM);
  if (node === undefined) throw new Error('missing fixture document');
  node.status = 'draft';
  const definition: Goal = { ...goal(gate), checks: [...goal(gate).checks, { kind: 'status.all', scope: statusScope, status: 'draft' }] };
  const run = await createGoalRunner().start(definition, { ...f, verifier: async () => {
    await Promise.resolve();
    node.status = 'final';
    return verdict(true);
  } });
  expect(run.status).toBe('regressed');
  expect(run.results.find(result => result.spec.kind === 'status.all')?.pass).toBe(false);
  expect(run.verification).toMatchObject({ status: 'complete', verdict: { pass: true } });
  expect(f.turns()).toBe(1);
});

it.each([false, true])('keeps a live deterministic regression ahead of unavailable review (gate %s)', async gate => {
  const f = fixture();
  const node = f.state.manifest.tree.find(candidate => candidate.id === LANDING);
  if (node === undefined) throw new Error('missing fixture document');
  const run = await createGoalRunner().start(goal(gate), { ...f, verifier: async () => {
    await Promise.resolve();
    node.synopsis = '';
    return verdict(true);
  } });
  expect(run.status).toBe('regressed');
  expect(run.results[0]?.pass).toBe(false);
  expect(run.verification).toMatchObject({ status: 'unavailable', code: 'source' });
  expect(f.turns()).toBe(1);
});

it('requires an explicitly gated verdict while keeping deterministic distances pure', async () => {
  const f = fixture();
  let calls = 0;
  const run = await createGoalRunner().start(goal(true), { ...f, verifier: async () => verdict(++calls === 2) });
  expect(run.status).toBe('passed');
  expect(calls).toBe(2);
  expect(f.turns()).toBe(2);
  expect(run.iterations.map(iteration => iteration.distance)).toEqual([{ before: 1, after: 0 }, { before: 0, after: 0 }]);
});

it('does not spend another actor turn when an explicit gate cannot be verified', async () => {
  const f = fixture();
  const run = await createGoalRunner().start(goal(true), { ...f, verifier: async (): Promise<GoalVerifierCallResult> => ({ kind: 'failed', reason: 'The Background route is unavailable.' }) });
  expect(run.status).toBe('failed');
  expect(f.turns()).toBe(1);
  expect(run.verification).toMatchObject({ status: 'unavailable', reason: 'The Background route is unavailable.' });
});

it('reports malformed advisory output honestly without blocking deterministic success', async () => {
  const f = fixture();
  const run = await createGoalRunner().start(goal(), { ...f, verifier: async (): Promise<GoalVerifierCallResult> => ({ kind: 'complete', content: 'UNTRUSTED_BAD_REPLY' }) });
  expect(run.status).toBe('passed');
  expect(run.verification?.status).toBe('unavailable');
  expect(JSON.stringify(run.verification)).not.toContain('UNTRUSTED_BAD_REPLY');
});

it.each([false, true])('keeps an advisory budget refusal separate from an explicit gate (%s)', async gate => {
  const f = fixture();
  const definition = { ...goal(gate), limits: { maxModelCalls: 10, maxTokens: 1000 } };
  const stop = { dimension: 'tokens', limit: 1000, spent: 0, needed: 1500 } as const;
  const run = await createGoalRunner().start(definition, {
    ...f, meter: createBudgetMeter(definition.limits),
    verifier: async (): Promise<GoalVerifierCallResult> => ({ kind: 'budget', stop }),
  });
  expect(run.status).toBe(gate ? 'budget' : 'passed');
  expect(run.verification?.status).toBe('unavailable');
  if (gate) expect(run.budgetStop).toEqual(stop);
});

it('accepts a gated verdict completed on the last permitted call', async () => {
  const f = fixture();
  const definition = { ...goal(true), limits: { maxModelCalls: 1 } };
  const meter = createBudgetMeter(definition.limits);
  const run = await createGoalRunner().start(definition, { ...f, meter, verifier: async () => {
    const reserved = meter.reserve({ promptTokens: 10, maxOutputTokens: 20 });
    if (!reserved.ok) throw new Error('last-call fixture could not reserve');
    meter.settle(reserved.value, { promptTokens: 10, completionTokens: 5 });
    return verdict(true);
  } });
  expect(run.status).toBe('passed');
  expect(meter.spend().modelCalls).toBe(1);
});

it('does not invent an advisory verdict or call for an already-passing goal', async () => {
  const f = fixture();
  const node = f.state.manifest.tree.find(candidate => candidate.id === LANDING);
  if (node !== undefined) node.synopsis = 'The ferry departs at dawn.';
  let calls = 0;
  const run = await createGoalRunner().start(goal(), { ...f, verifier: async () => { calls += 1; return verdict(true); } });
  expect(run.status).toBe('passed');
  expect(f.turns()).toBe(0);
  expect(calls).toBe(0);
  expect(run.verification?.status).toBe('unavailable');
});

it('refuses an advisory-only goal because it has no acceptance condition', async () => {
  const f = fixture();
  const definition = goal();
  const run = await createGoalRunner().start({ ...definition, checks: definition.checks.filter(check => check.kind === 'verifier') }, { ...f, verifier: async () => verdict(true) });
  expect(run.status).toBe('refused');
  expect(run.reason).toBe('Choose another check or require the independent review to pass.');
  expect(f.turns()).toBe(0);
});

it.each(['iteration', 'checkpoint', 'both'] as const)('refuses a verifier goal without its durable %s saver before any actor or review', async missing => {
  const { saveIteration, saveCheckpoint, ...f } = fixture();
  let calls = 0;
  const run = await createGoalRunner().start(goal(), {
    ...f,
    ...(missing === 'iteration' || missing === 'both' ? {} : { saveIteration }),
    ...(missing === 'checkpoint' || missing === 'both' ? {} : { saveCheckpoint }),
    verifier: async () => { calls += 1; return verdict(true); },
  });
  expect(run.status).toBe('refused');
  expect(run.reason).toBe('Configure durable iteration and checkpoint saves before starting an independent review.');
  expect(f.turns()).toBe(0);
  expect(calls).toBe(0);
});

it('captures real before records and commits the actor iteration before verification', async () => {
  const f = fixture();
  const before = getBody(f.state, LANDING);
  let committed: GoalCheckpoint | undefined;
  const run = await createGoalRunner().start(goal(), {
    ...f,
    saveCheckpoint: async () => undefined,
    saveIteration: async checkpoint => { committed = structuredClone(checkpoint); },
    verifier: async (input: GoalVerifierInput) => {
      expect(committed?.nextIteration).toBe(2);
      expect(committed?.iterations).toHaveLength(1);
      expect(committed?.pendingVerification?.phase).toBe('prepared');
      expect(input.excerpts.find(excerpt => excerpt.field === 'body')).toMatchObject({ before, after: 'The ferry departs at dawn. Revision 1.' });
      return verdict(true);
    },
  });
  expect(run.status).toBe('passed');
});

it('does not send a verifier after Stop during its actor turn', async () => {
  const abort = new AbortController();
  const f = fixture(() => abort.abort());
  let calls = 0;
  const run = await createGoalRunner().start(goal(true), { ...f, signal: abort.signal, verifier: async () => { calls += 1; return verdict(true); } });
  expect(run.status).toBe('cancelled');
  expect(calls).toBe(0);
});

it.each([false, true])('keeps deterministic regression handling ahead of optional model work (%s)', async gate => {
  const f = fixture(state => {
    const node = state.manifest.tree.find(candidate => candidate.id === LANDING);
    if (node !== undefined) node.status = 'final';
  });
  const node = f.state.manifest.tree.find(candidate => candidate.id === LANDING);
  if (node !== undefined) node.status = 'draft';
  const definition = goal(gate);
  let calls = 0;
  const run = await createGoalRunner().start({ ...definition, checks: [...definition.checks, { kind: 'status.all', scope, status: 'draft' }] }, {
    ...f, verifier: async (): Promise<GoalVerifierCallResult> => { calls += 1; return { kind: 'failed', reason: 'The Background route is unavailable.' }; },
  });
  expect(run.status).toBe('regressed');
  expect(run.askBack?.options).toContain('restore to before this iteration');
  expect(calls).toBe(0);
});

it('cannot swallow an admission save failure as advisory feedback', async () => {
  const f = fixture();
  let sent = false;
  const verifier: GoalVerifierPort = async (_input, save, fence) => {
    await save({ phase: 'reserved', spend: f.meter.spend(), reservation: { id: 'held-verifier', promptTokens: 20, maxOutputTokens: 50 } });
    fence();
    sent = true;
    return verdict(true);
  };
  const run = await createGoalRunner().start(goal(), {
    ...f, verifier, saveIteration: async () => undefined,
    saveCheckpoint: async checkpoint => {
      if (checkpoint.pendingVerification?.phase === 'reserved') throw new Error('required save unavailable');
    },
  });
  expect(run.status).toBe('failed');
  expect(sent).toBe(false);
});

it('does not dispatch when the completed actor iteration cannot be committed', async () => {
  const f = fixture();
  let sent = false;
  const run = await createGoalRunner().start(goal(), {
    ...f, verifier: async () => { sent = true; return verdict(true); },
    saveIteration: async () => { throw new Error('required actor checkpoint unavailable'); },
    saveCheckpoint: async () => undefined,
  });
  expect(run.status).toBe('failed');
  expect(f.turns()).toBe(1);
  expect(sent).toBe(false);
});

async function preparedCheckpoint() {
  const f = fixture();
  let saved: GoalCheckpoint | undefined;
  await createGoalRunner().start(goal(true), {
    ...f, verifier: async () => verdict(true), saveCheckpoint: async () => undefined,
    saveIteration: async checkpoint => { saved = structuredClone(checkpoint); },
  });
  if (saved?.pendingVerification?.phase !== 'prepared') throw new Error('missing prepared fixture checkpoint');
  return { f, saved };
}

it('resumes a prepared verification without repeating its committed actor turn', async () => {
  const { f, saved } = await preparedCheckpoint();
  let calls = 0;
  for (const record of f.state.documents.values()) record.revision += 10;
  const run = await createGoalRunner().start(goal(true), {
    ...f, checkpoint: saved, meter: createBudgetMeter(saved.goal.limits, { restored: saved.spend }),
    verifier: async () => { calls += 1; return verdict(true); }, saveCheckpoint: async () => undefined,
  });
  expect(run.status).toBe('passed');
  expect(f.turns()).toBe(1);
  expect(calls).toBe(1);
});

it('does not verify stale text after an explicit recovery', async () => {
  const { f, saved } = await preparedCheckpoint();
  setBody(f.state, LANDING, 'A new departure written after the interruption.');
  let calls = 0;
  const run = await createGoalRunner().start(goal(true), {
    ...f, checkpoint: saved, meter: createBudgetMeter(saved.goal.limits, { restored: saved.spend }),
    verifier: async () => { calls += 1; return verdict(true); }, saveCheckpoint: async () => undefined,
  });
  expect(run.status).toBe('failed');
  expect(f.turns()).toBe(1);
  expect(calls).toBe(0);
  expect(run.verification?.status).toBe('unavailable');
});

it('does not launder formerly withheld before-text through a changed read boundary', async () => {
  const hidden = new Set([STORM]);
  const f = fixture(state => { hidden.clear(); setBody(state, STORM, 'A now-readable revision.'); });
  setBody(f.state, STORM, 'FORMERLY_WITHHELD_PASSAGE');
  const definition = goal();
  const run = await createGoalRunner().start({ ...definition, checks: definition.checks.map(check => check.kind === 'verifier' ? { ...check, scope: { mode: 'full' } } : check) }, {
    ...f, withheld: () => hidden, verifier: async input => {
      expect(JSON.stringify(input)).not.toContain('FORMERLY_WITHHELD_');
      expect(input.excerpts.some(excerpt => excerpt.docId === STORM)).toBe(false);
      return verdict(true);
    },
  });
  expect(run.status).toBe('passed');
  expect(run.verification?.status).toBe('complete');
});

it('conservatively accounts uncertain reservations once and never repeats them', async () => {
  const { f, saved } = await preparedCheckpoint();
  const pending = saved.pendingVerification;
  if (pending === undefined) throw new Error('missing pending fixture');
  const definition = { ...saved.goal, limits: { maxModelCalls: 10, maxTokens: 1000, maxCostUsd: 1, maxActiveMs: 5000 } };
  const interrupted: GoalCheckpoint = {
    ...saved, goal: definition, spend: { ...saved.spend, modelCalls: 2, promptTokens: 10, completionTokens: 5, costUsd: 0.01 },
    pendingVerification: { ...pending, phase: 'reserved', reservation: { id: 'uncertain-verifier', promptTokens: 20, maxOutputTokens: 50, price: { prompt: 1, completion: 2 } } },
  };
  const recovered = recoverGoalVerifierCheckpoint(interrupted);
  expect(recovered.uncertainUsage).toBe(true);
  expect(recovered.checkpoint.spend).toMatchObject({ modelCalls: 2, promptTokens: 945, completionTokens: 55, estimatedTokens: 985, costUsd: 1, activeMs: 5000 });
  expect(recovered.checkpoint.pendingVerification).toMatchObject({ phase: 'settled', uncertainUsage: true });
  expect(recovered.checkpoint.pendingVerification?.reservation).toBeUndefined();
  expect(recoverGoalVerifierCheckpoint(recovered.checkpoint)).toEqual(recovered);
  let calls = 0;
  const run = await createGoalRunner().start(definition, {
    ...f, checkpoint: recovered.checkpoint, meter: createBudgetMeter(definition.limits, { restored: recovered.checkpoint.spend }),
    verifier: async () => { calls += 1; return verdict(true); }, saveCheckpoint: async () => undefined,
  });
  expect(calls).toBe(0);
  expect(f.turns()).toBe(1);
  expect(run.verification).toMatchObject({ status: 'unavailable', uncertainUsage: true });
});
