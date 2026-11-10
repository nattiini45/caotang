import { taskStatusTable } from '../apps/desktop/src/app/task-store.js';
import { sidebarTable } from '../apps/desktop/src/components/shell/modern/sidebar-model.js';
import { menuTable } from '../apps/desktop/src/components/shell/modern/menu-model.js';
import { sprintTable } from '../packages/furniture/src/sprint.js';
import { tabStopTable } from '../apps/desktop/src/app/tab-stop.js';
import { persistenceTable } from '../apps/desktop/src/app/persistence-model.js';
import { pendingEntryTable } from '../apps/desktop/src/app/pending-entry.js';

export const machineTables = [sprintTable, taskStatusTable, sidebarTable, menuTable, tabStopTable, persistenceTable, pendingEntryTable] as const;
