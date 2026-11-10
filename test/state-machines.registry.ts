import { taskStatusTable } from '../apps/desktop/src/app/task-store.js';
import { folderSaveTable } from '../apps/desktop/src/app/folder-save-model.js';
import { importPreviewTable } from '../apps/desktop/src/import-preview/phase.js';
import { exportCompileMachine, exportReadinessMachine } from '../apps/desktop/src/app/export-dialog-model.js';
import { encodingPanelMachine } from '../apps/desktop/src/app/encoding-dialog-model.js';
import { sidebarTable } from '../apps/desktop/src/components/shell/modern/sidebar-model.js';
import { menuTable } from '../apps/desktop/src/components/shell/modern/menu-model.js';
import { sprintTable } from '../packages/furniture/src/sprint.js';
import { eventQueueTable } from '../packages/sdk/src/run.js';
import { writerStopTable } from '../packages/sdk/src/writer-stop.js';
import { confirmationRoundTable } from '../packages/mcp-server/src/confirm.js';
import { findingStatusTable } from '../packages/bus/src/coherence.js';
import { callIdTable } from '../packages/bus/src/idempotency.js';
import { runtimeConnectionTable } from '../packages/store/src/runtime/store.js';
import { assetStagingTable } from '../packages/store/src/asset-staging.js';
import { assetRemovalHoldTable } from '../packages/store/src/asset-removals.js';

export const machineTables = [
  sprintTable, taskStatusTable, folderSaveTable, importPreviewTable,
  exportCompileMachine.table, exportReadinessMachine.table, encodingPanelMachine.table,
  sidebarTable, menuTable, findingStatusTable, callIdTable, runtimeConnectionTable,
  assetStagingTable, assetRemovalHoldTable, eventQueueTable, writerStopTable, confirmationRoundTable,
] as const;
