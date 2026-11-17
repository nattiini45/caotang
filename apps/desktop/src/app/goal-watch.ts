import { canonicalJson } from '@caotang/ids';
import type { BudgetSpend, CheckKind, GoalCheckpoint, RunLimits } from '@caotang/harness';

export interface GoalWatchCheck {
  readonly key: string;
  readonly kind: CheckKind | 'unreadable';
  readonly pass: boolean | null;
  readonly distance: number | null;
  readonly history: readonly number[];
  readonly min?: number;
  readonly max?: number;
  readonly maxWords?: number;
  readonly status?: string;
  readonly failures: readonly { readonly title: string; readonly detail: string }[];
  readonly skipped: number;
}

export interface GoalWatchView {
  readonly nextIteration: number;
  readonly completedIterations: number;
  readonly maxIterations: number | null;
  readonly limits: RunLimits;
  readonly spend: BudgetSpend;
  readonly checks: readonly GoalWatchCheck[];
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function resultIn(values: unknown, key: string): Record<string, unknown> | undefined {
  return Array.isArray(values) ? values.find((value: unknown): value is Record<string, unknown> => record(value) && value['key'] === key && typeof value['pass'] === 'boolean' && amount(value['distance']) && value['pass'] === (value['distance'] === 0)) : undefined;
}

export function goalWatchOf(checkpoint: GoalCheckpoint): GoalWatchView {
  return {
    nextIteration: checkpoint.nextIteration,
    completedIterations: checkpoint.iterations.filter((iteration: unknown) => record(iteration) && Number.isSafeInteger(iteration['n']) && Number(iteration['n']) > 0).length,
    maxIterations: checkpoint.goal.maxIterations ?? null,
    limits: { ...checkpoint.goal.limits },
    spend: { ...checkpoint.spend },
    checks: checkpoint.goal.checks.map((definition, index) => {
      const spec: unknown = definition;
      let key = `unreadable-${index}`;
      let kind: GoalWatchCheck['kind'] = 'unreadable';
      if (record(spec)) {
        try {
          key = canonicalJson(spec);
          if (spec.kind === 'coherence.clean' || spec.kind === 'words.between' || spec.kind === 'status.all' || spec.kind === 'synopsis.filled') kind = spec.kind;
        } catch {
          kind = 'unreadable';
        }
      }
      const current = kind === 'unreadable' ? undefined : resultIn(checkpoint.results, key);
      const history: number[] = [];
      for (const iteration of checkpoint.iterations) {
        if (!record(iteration)) continue;
        const before = resultIn(iteration['before'], key);
        if (before !== undefined && history.at(-1) !== before['distance']) history.push(before['distance'] as number);
        const after = resultIn(iteration['after'], key);
        if (after !== undefined) history.push(after['distance'] as number);
      }
      if (current !== undefined && history.at(-1) !== current['distance']) history.push(current['distance'] as number);
      const failures: GoalWatchCheck['failures'] = Array.isArray(current?.['failures'])
        ? current['failures'].flatMap((value: unknown) => record(value) && typeof value['title'] === 'string' && typeof value['detail'] === 'string' ? [{ title: value['title'], detail: value['detail'] }] : [])
        : [];
      return {
        key, kind, history, failures,
        pass: current === undefined ? null : current['pass'] as boolean,
        distance: current === undefined ? null : current['distance'] as number,
        ...(record(spec) && amount(spec['min']) ? { min: spec['min'] } : {}),
        ...(record(spec) && amount(spec['max']) ? { max: spec['max'] } : {}),
        ...(record(spec) && amount(spec['maxWords']) ? { maxWords: spec['maxWords'] } : {}),
        ...(record(spec) && typeof spec['status'] === 'string' ? { status: spec['status'] } : {}),
        skipped: Array.isArray(current?.['skipped']) ? current['skipped'].length : 0,
      };
    }),
  };
}
