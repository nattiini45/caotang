import type { DeterministicCheckId, ScopeSpec } from '@caotang/coherence';
import { DEFAULT_MAX_ITERATIONS, DEFAULT_STALL_AFTER, HARD_MAX_ITERATIONS, type CheckSpec, type Goal, type RunLimits, type WriteScope } from '@caotang/harness';

export interface GoalFormValues {
  intent: string;
  clean: boolean;
  words: boolean;
  status: boolean;
  synopses: boolean;
  targetStatus: string;
  minWords: string;
  maxWords: string;
  synopsisWords: string;
  calls: string;
  tokens: string;
  cost: string;
  steps: string;
  minutes: string;
  iterations: string;
  stall: string;
}

export const initialGoalForm = (): GoalFormValues => ({
  intent: '', clean: false, words: false, status: false, synopses: false, targetStatus: 'draft',
  minWords: '', maxWords: '', synopsisWords: '', calls: '8', tokens: '', cost: '', steps: '', minutes: '',
  iterations: String(DEFAULT_MAX_ITERATIONS), stall: String(DEFAULT_STALL_AFTER),
});

export interface GoalFormContext {
  readonly id: string;
  readonly scope: ScopeSpec;
  readonly writeScope: WriteScope;
  readonly coherenceChecks: readonly DeterministicCheckId[];
}

export type GoalFormResult = { readonly ok: true; readonly goal: Goal } | {
  readonly ok: false;
  readonly field: keyof GoalFormValues | 'checks' | 'limits' | 'scope';
  readonly code: 'required' | 'number' | 'integer' | 'positive' | 'range' | 'checks-off';
};

export function goalFromForm(form: GoalFormValues, context: GoalFormContext): GoalFormResult {
  if (form.intent.trim() === '') return { ok: false, field: 'intent', code: 'required' };
  if (!form.clean && !form.words && !form.status && !form.synopses) return { ok: false, field: 'checks', code: 'required' };
  if (context.scope.mode === 'doc' && context.scope.docIds.length === 0) return { ok: false, field: 'scope', code: 'required' };
  if (form.clean && context.coherenceChecks.length === 0) return { ok: false, field: 'checks', code: 'checks-off' };
  const limits: Partial<Record<keyof RunLimits, number>> = {};
  for (const [field, dimension, integral, multiplier] of [
    ['calls', 'maxModelCalls', true, 1], ['tokens', 'maxTokens', false, 1], ['cost', 'maxCostUsd', false, 1],
    ['steps', 'maxSteps', true, 1], ['minutes', 'maxActiveMs', false, 60_000],
  ] as const) {
    if (form[field].trim() === '') continue;
    const value = Number(form[field]);
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(value * multiplier)) return { ok: false, field, code: 'number' };
    if (integral && !Number.isSafeInteger(value)) return { ok: false, field, code: 'integer' };
    limits[dimension] = value * multiplier;
  }
  if (Object.keys(limits).length === 0) return { ok: false, field: 'limits', code: 'required' };
  const counts: Partial<Record<'iterations' | 'stall' | 'minWords' | 'maxWords' | 'synopsisWords', number>> = {};
  for (const field of ['iterations', 'stall', ...(form.words ? ['minWords', 'maxWords'] as const : []), ...(form.synopses ? ['synopsisWords'] as const : [])] as const) {
    if (form[field].trim() === '') {
      if (field === 'iterations' || field === 'stall') return { ok: false, field, code: 'required' };
      continue;
    }
    const value = Number(form[field]);
    if (!Number.isSafeInteger(value) || value < 0) return { ok: false, field, code: 'integer' };
    if ((field === 'iterations' || field === 'stall' || field === 'synopsisWords') && value === 0) return { ok: false, field, code: 'positive' };
    counts[field] = value;
  }
  if (counts.iterations! > HARD_MAX_ITERATIONS) return { ok: false, field: 'iterations', code: 'range' };
  if (form.words && counts.minWords === undefined && counts.maxWords === undefined) return { ok: false, field: 'minWords', code: 'required' };
  if (counts.minWords !== undefined && counts.maxWords !== undefined && counts.minWords > counts.maxWords) return { ok: false, field: 'maxWords', code: 'range' };
  if (form.status && form.targetStatus.trim() === '') return { ok: false, field: 'targetStatus', code: 'required' };
  const scope = structuredClone(context.scope);
  const checks: CheckSpec[] = [];
  if (form.clean) checks.push({ kind: 'coherence.clean', scope, checks: [...context.coherenceChecks] });
  if (form.words) checks.push({ kind: 'words.between', scope, ...(counts.minWords === undefined ? {} : { min: counts.minWords }), ...(counts.maxWords === undefined ? {} : { max: counts.maxWords }) });
  if (form.status) checks.push({ kind: 'status.all', scope, status: form.targetStatus });
  if (form.synopses) checks.push({ kind: 'synopsis.filled', scope, ...(counts.synopsisWords === undefined ? {} : { maxWords: counts.synopsisWords }) });
  return { ok: true, goal: { id: context.id, intent: form.intent.trim(), checks, limits, maxIterations: counts.iterations!, stallAfter: counts.stall!, writeScope: structuredClone(context.writeScope) } };
}
