import { seededId } from '@caotang/ids';

import { TASKS_FORMAT_VERSION, type AgentTask, type TasksFile } from '../src/index.js';

export function task(seed: number, patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id: seededId('t', seed),
    name: `Task ${seed}`,
    enabled: true,
    schedule: { kind: 'daily', at: '09:00' },
    whenDue: 'offer',
    body: { kind: 'scan', scope: 'full' },
    permission: 'ask',
    ...patch,
  };
}

export const fileOf = (...tasks: AgentTask[]): TasksFile => ({ formatVersion: TASKS_FORMAT_VERSION, tasks });
