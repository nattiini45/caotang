import { expect, it } from 'vitest';
import type { GoalCheckpoint } from '@caotang/harness';
import { canonicalJson } from '@caotang/ids';

import { goalWatchOf } from '../src/app/goal-watch.js';

const spec = { kind: 'synopsis.filled', scope: { mode: 'full' } } as const;
const result = (distance: number) => ({ spec, key: canonicalJson(spec), label: 'Every synopsis is filled.', pass: distance === 0, distance, failures: [], skipped: [], notes: [] });
const checkpoint = (): GoalCheckpoint => ({
  goal: { id: 'g_0000000001', intent: 'Fill every synopsis.', checks: [spec], limits: { maxModelCalls: 8 }, maxIterations: 10 },
  iterations: [], results: [], nextIteration: 1,
  spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 },
});

it('shows unmeasured checks without claiming they passed or inventing a trend', () => {
  expect(goalWatchOf(checkpoint())).toMatchObject({ nextIteration: 1, maxIterations: 10, checks: [{ kind: 'synopsis.filled', pass: null, distance: null, history: [] }] });
});

it('projects the durable before/after history and shared spend without changing the checkpoint', () => {
  const saved = { ...checkpoint(), nextIteration: 3, results: [result(0)], spend: { ...checkpoint().spend, modelCalls: 3 }, iterations: [
    { n: 1, before: [result(3)], after: [result(1)] }, { n: 2, before: [result(1)], after: [result(0)] },
  ] } as GoalCheckpoint;
  const before = structuredClone(saved);
  expect(goalWatchOf(saved)).toMatchObject({ nextIteration: 3, spend: { modelCalls: 3 }, checks: [{ pass: true, distance: 0, history: [3, 1, 0] }] });
  expect(saved).toEqual(before);
});

it('does not render damaged result values as check results', () => {
  const saved = { ...checkpoint(), results: [null, { ...result(0), pass: 'yes', distance: NaN }, { ...result(5), pass: true }], iterations: [null, { n: 1, before: {}, after: [false] }] } as unknown as GoalCheckpoint;
  expect(goalWatchOf(saved).checks[0]).toMatchObject({ pass: null, distance: null, history: [] });
});

it('keeps remeasured distances between iterations and at the final saved checkpoint', () => {
  const saved = { ...checkpoint(), results: [result(0)], iterations: [
    { n: 1, before: [result(3)], after: [result(1)] }, { n: 2, before: [result(4)], after: [result(2)] },
  ] } as GoalCheckpoint;
  expect(goalWatchOf(saved).checks[0]?.history).toEqual([3, 1, 4, 2, 0]);
});

it('projects model judgments separately without fabricating deterministic measurements', () => {
  const saved = checkpoint();
  const verifier = { kind: 'verifier', scope: { mode: 'full' }, rubric: 'The departure is clear.', gate: false } as const;
  const watch = goalWatchOf({ ...saved, goal: { ...saved.goal, checks: [spec, verifier] }, results: [result(0)], verification: {
    key: canonicalJson(verifier), iteration: 1, status: 'complete', verdict: { pass: false, reasons: ['The departure still needs work.'] }, sources: [], omitted: 2, truncated: true,
  } });
  expect(watch.checks).toHaveLength(1);
  expect(watch.checks[0]).toMatchObject({ kind: 'synopsis.filled', pass: true, distance: 0, history: [0] });
  expect(watch.review).toEqual({ rubric: verifier.rubric, gate: false, status: 'complete', pass: false, reasons: ['The departure still needs work.'], iteration: 1, omitted: 2, truncated: true, uncertainUsage: false });
  expect(watch.review).not.toHaveProperty('distance');
  expect(watch.review).not.toHaveProperty('history');
});

it('retains unavailable and uncertain review outcomes without inventing a verdict', () => {
  const saved = checkpoint();
  const verifier = { kind: 'verifier', scope: { mode: 'full' }, rubric: 'The departure is clear.', gate: true } as const;
  const watch = goalWatchOf({ ...saved, goal: { ...saved.goal, checks: [verifier] }, verification: {
    key: canonicalJson(verifier), iteration: 1, status: 'unavailable', code: 'interrupted', sources: [], omitted: 0, truncated: false, uncertainUsage: true,
  } });
  expect(watch.checks).toEqual([]);
  expect(watch.review).toMatchObject({ gate: true, status: 'unavailable', code: 'interrupted', pass: null, reasons: [], uncertainUsage: true });
});

it('does not invent a covered iteration for an unavailable no-turn review', () => {
  const saved = checkpoint();
  const verifier = { kind: 'verifier', scope: { mode: 'full' }, rubric: 'The departure is clear.' } as const;
  const watch = goalWatchOf({ ...saved, goal: { ...saved.goal, checks: [spec, verifier] }, verification: {
    key: canonicalJson(verifier), iteration: 0, status: 'unavailable', code: 'no-changes', sources: [], omitted: 0, truncated: false,
  } });
  expect(watch.review).toMatchObject({ status: 'unavailable', iteration: null, pass: null });
});
