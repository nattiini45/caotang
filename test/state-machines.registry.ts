import { taskStatusTable } from '../apps/desktop/src/app/task-store.js';
import { agentControllerTable } from '../apps/desktop/src/app/agent-state.js';
import { folderSaveTable } from '../apps/desktop/src/app/folder-save-model.js';
import { importPreviewTable } from '../apps/desktop/src/import-preview/phase.js';
import { exportCompileMachine, exportReadinessMachine } from '../apps/desktop/src/app/export-dialog-model.js';
import { encodingPanelMachine } from '../apps/desktop/src/app/encoding-dialog-model.js';
import { sidebarTable } from '../apps/desktop/src/components/shell/modern/sidebar-model.js';
import { menuTable } from '../apps/desktop/src/components/shell/modern/menu-model.js';
import { sprintTable } from '../packages/furniture/src/sprint.js';
import { reviewTable } from '../apps/desktop/src/app/coherence-review-state.js';
import { interfaceTable } from '../apps/desktop/src/app/interface.js';
import { exportJobMachine } from '../packages/exporter/src/export-job.js';
import { eventQueueTable } from '../packages/sdk/src/run.js';
import { writerStopTable } from '../packages/sdk/src/writer-stop.js';
import { confirmationRoundTable } from '../packages/mcp-server/src/confirm.js';
import { tabStopTable } from '../apps/desktop/src/app/tab-stop.js';
import { persistenceTable } from '../apps/desktop/src/app/persistence-model.js';
import { pendingEntryTable } from '../apps/desktop/src/app/pending-entry.js';
import { modalMachine } from '../apps/desktop/src/components/modal-stack.js';
import { findingStatusTable } from '../packages/bus/src/coherence.js';
import { callIdTable } from '../packages/bus/src/idempotency.js';
import { runtimeConnectionTable } from '../packages/store/src/runtime/store.js';
import { assetStagingTable } from '../packages/store/src/asset-staging.js';
import { assetRemovalHoldTable } from '../packages/store/src/asset-removals.js';
import { healthTable } from '../packages/mcp-client/src/health.js';
import { turnPhaseTable } from '../packages/harness/src/agent/turn-machine.js';
import { cardStatusTable } from '../packages/harness/src/agent/cards.js';
import { cardDecisionTable } from '../packages/harness/src/agent/card-decision.js';
import { budgetMeterTable } from '../packages/harness/src/agent/budget.js';

export const machineTables = [
  sprintTable, taskStatusTable, agentControllerTable, folderSaveTable, importPreviewTable,
  exportCompileMachine.table, exportReadinessMachine.table, encodingPanelMachine.table,
  sidebarTable, menuTable, findingStatusTable, callIdTable, runtimeConnectionTable,
  assetStagingTable, assetRemovalHoldTable, reviewTable, interfaceTable,
  turnPhaseTable, cardStatusTable,
  cardDecisionTable, budgetMeterTable,
  exportJobMachine.table, eventQueueTable, writerStopTable, confirmationRoundTable,
  tabStopTable, persistenceTable, pendingEntryTable, healthTable,
  modalMachine.table,
] as const;
