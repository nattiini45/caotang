import { taskStatusTable } from '../apps/desktop/src/app/task-store.js';
import { folderSaveTable } from '../apps/desktop/src/app/folder-save-model.js';
import { sprintTable } from '../packages/furniture/src/sprint.js';

export const machineTables = [sprintTable, taskStatusTable, folderSaveTable] as const;
