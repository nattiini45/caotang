import { taskStatusTable } from '../apps/desktop/src/app/task-store.js';
import { sprintTable } from '../packages/furniture/src/sprint.js';

export const machineTables = [sprintTable, taskStatusTable] as const;
