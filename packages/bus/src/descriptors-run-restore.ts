import type { CommandDescriptor, ProjectRestoreRunParams } from './command.js';
import { invalid, requireDeclaredParams, requireNonBlankString } from './params.js';
import { ok } from './result.js';

export const projectRestoreRun: CommandDescriptor<ProjectRestoreRunParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'compensable',
  validate(params) {
    const record = requireDeclaredParams('project.restoreRun', params);
    if (!record.ok) return record;
    const runId = requireNonBlankString(record.value, 'runId', { maxChars: 160 });
    if (!runId.ok) return runId;
    if (!/^[A-Za-z0-9_-]+$/u.test(runId.value)) return invalid('the run id is not a local run id', 'choose a run from this project', 'runId');
    return ok({ runId: runId.value });
  },
};
