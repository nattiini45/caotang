import { taskStatusTable } from '../apps/desktop/src/app/task-store.js';
import { sidebarTable } from '../apps/desktop/src/components/shell/modern/sidebar-model.js';
import { menuTable } from '../apps/desktop/src/components/shell/modern/menu-model.js';
import { sprintTable } from '../packages/furniture/src/sprint.js';

export const machineTables = [sprintTable, taskStatusTable, sidebarTable, menuTable] as const;
