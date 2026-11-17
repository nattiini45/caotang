import { expect, it } from 'vitest';

import { goalFromForm, initialGoalForm } from '../src/app/goal-form.js';

const context = { id: 'g_0000000001', scope: { mode: 'full' as const }, writeScope: { mode: 'full' as const }, coherenceChecks: ['timeline.order-drift'] as const };

it('builds explicit deterministic checks and shared limits without granting permission', () => {
  const result = goalFromForm({ ...initialGoalForm(), intent: 'Fill the synopses.', synopses: true, calls: '8', tokens: '2000', cost: '0.25', steps: '4', minutes: '1.5' }, context);
  expect(result).toMatchObject({ ok: true, goal: {
    id: context.id, intent: 'Fill the synopses.', checks: [{ kind: 'synopsis.filled', scope: context.scope }],
    limits: { maxModelCalls: 8, maxTokens: 2000, maxCostUsd: 0.25, maxSteps: 4, maxActiveMs: 90_000 }, maxIterations: 10, stallAfter: 2,
  } });
  if (result.ok) expect(result.goal).not.toHaveProperty('mode');
});

it('accepts zero call limits but refuses a form with no shared run limit', () => {
  expect(goalFromForm({ ...initialGoalForm(), intent: 'Check only.', synopses: true, calls: '0' }, context)).toMatchObject({ ok: true, goal: { limits: { maxModelCalls: 0 } } });
  expect(goalFromForm({ ...initialGoalForm(), intent: 'Fill the synopses.', synopses: true, calls: '' }, context)).toMatchObject({ ok: false, field: 'limits' });
});

it.each(['NaN', 'Infinity', '-1', '1.5', '9007199254740992'])('refuses an invalid model-call count: %s', (calls) => {
  expect(goalFromForm({ ...initialGoalForm(), intent: 'Work.', synopses: true, calls }, context)).toMatchObject({ ok: false, field: 'calls' });
});

it('refuses absent checks, reversed word bounds and an overflowed active-time conversion', () => {
  expect(goalFromForm({ ...initialGoalForm(), intent: 'Work.' }, context)).toMatchObject({ ok: false, field: 'checks' });
  expect(goalFromForm({ ...initialGoalForm(), intent: 'Work.', words: true, minWords: '100', maxWords: '20' }, context)).toMatchObject({ ok: false, field: 'maxWords' });
  expect(goalFromForm({ ...initialGoalForm(), intent: 'Work.', synopses: true, minutes: '1e308' }, context)).toMatchObject({ ok: false, field: 'minutes' });
});

it('keeps all four kinds scoped and uses only the explicitly selected coherence checks', () => {
  const result = goalFromForm({ ...initialGoalForm(), intent: 'Revise this scene.', clean: true, words: true, maxWords: '4000', status: true, synopses: true, targetStatus: 'final', synopsisWords: '40' }, { ...context, scope: { mode: 'doc', docIds: ['n_0000000001'] }, writeScope: { mode: 'doc', docIds: ['n_0000000001'] } });
  expect(result).toMatchObject({ ok: true, goal: { checks: [
    { kind: 'coherence.clean', checks: context.coherenceChecks }, { kind: 'words.between', max: 4000 }, { kind: 'status.all', status: 'final' }, { kind: 'synopsis.filled', maxWords: 40 },
  ] } });
  if (result.ok) expect(result.goal.checks.every((check) => check.scope.mode === 'doc')).toBe(true);
});
