import { expect, it } from 'vitest';
import { lastRunsOf, withRun, type TaskRunRecord } from '../src/index.js';

it('reconciles one queued occurrence without duplicating it or advancing its original instant', () => {
  const queued: TaskRunRecord = { taskId: 't_RUN0000001', at: '2026-11-15T09:00:00.000Z', status: 'queued', trigger: 'due', summary: 'Preparing', requests: 0, promptTokens: 0, completionTokens: 0, queueTaskId: 'task_RUN0000001' };
  const next = { ...queued, at: '2026-11-16T09:00:00.000Z', queueTaskId: 'task_RUN0000002' };
  const ready = { ...queued, status: 'ready' as const, requests: 1, promptTokens: 10, completionTokens: 20 };
  const history = withRun(withRun(withRun([], queued), next), ready);
  expect(history).toEqual([next, ready]);
  expect(lastRunsOf({ [queued.taskId]: history })).toEqual({ [queued.taskId]: next.at });
});
