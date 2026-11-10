import { taskStatusTable } from '../apps/desktop/src/app/task-store.js';
import { folderSaveTable } from '../apps/desktop/src/app/folder-save-model.js';
import { importPreviewTable } from '../apps/desktop/src/import-preview/phase.js';
import { exportCompileMachine, exportReadinessMachine } from '../apps/desktop/src/app/export-dialog-model.js';
import { encodingPanelMachine } from '../apps/desktop/src/app/encoding-dialog-model.js';
import { sidebarTable } from '../apps/desktop/src/components/shell/modern/sidebar-model.js';
import { menuTable } from '../apps/desktop/src/components/shell/modern/menu-model.js';
import { sprintTable } from '../packages/furniture/src/sprint.js';
import { reviewTable } from '../apps/desktop/src/app/coherence-review-state.js';
import { interfaceTable } from '../apps/desktop/src/app/interface.js';

export const machineTables = [sprintTable, taskStatusTable, folderSaveTable, importPreviewTable,
  exportCompileMachine.table, exportReadinessMachine.table, encodingPanelMachine.table, sidebarTable, menuTable, reviewTable, interfaceTable] as const;
