import { taskStatusTable } from '../apps/desktop/src/app/task-store.js';
import { sprintTable } from '../packages/furniture/src/sprint.js';
import { eventQueueTable } from '../packages/sdk/src/run.js';
import { writerStopTable } from '../packages/sdk/src/writer-stop.js';
import { confirmationRoundTable } from '../packages/mcp-server/src/confirm.js';

export const machineTables = [sprintTable, taskStatusTable, eventQueueTable, writerStopTable, confirmationRoundTable] as const;
