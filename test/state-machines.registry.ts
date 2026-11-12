import { taskStatusTable } from '../apps/desktop/src/app/task-store.js';
import { agentControllerTable } from '../apps/desktop/src/app/agent-state.js';
import { recurringRunTable } from '../apps/desktop/src/app/recurring-state.js';
import { turnMarkerTable } from '../packages/harness/src/agent/turn-marker.js';
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
import { saveChannelTable } from '../apps/desktop/src/app/save-channel.js';
import { persistenceTable } from '../apps/desktop/src/app/persistence-model.js';
import { pendingEntryTable } from '../apps/desktop/src/app/pending-entry.js';
import { modalMachine } from '../apps/desktop/src/components/modal-stack.js';
import { findingStatusTable } from '../packages/bus/src/coherence.js';
import { callIdTable } from '../packages/bus/src/idempotency.js';
import { runtimeConnectionTable } from '../packages/store/src/runtime/store.js';
import { runStatusTable } from '../packages/store/src/runtime/run-log-store.js';
import { assetStagingTable } from '../packages/store/src/asset-staging.js';
import { assetRemovalHoldTable } from '../packages/store/src/asset-removals.js';
import { autosaveTable } from '../packages/store/src/runtime/autosave-machine.js';
import { healthTable } from '../packages/mcp-client/src/health.js';
import { turnPhaseTable } from '../packages/harness/src/agent/turn-machine.js';
import { cardStatusTable } from '../packages/harness/src/agent/cards.js';
import { cardDecisionTable } from '../packages/harness/src/agent/card-decision.js';
import { budgetMeterTable } from '../packages/harness/src/agent/budget.js';
import { editorSessionTable } from '../packages/editor/src/tiptap/session.js';
import { storeRebaseTable } from '../apps/desktop/src/app/store-rebase.js';
import { sessionTable } from '../apps/desktop/src/app/session-handle.js';
import { bootTable } from '../apps/desktop/src/app/boot-phase.js';
import { demoStartTable } from '../apps/desktop/src/app/demo-start.js';
import { homeOpenTable } from '../apps/desktop/src/app/home-open-flow.js';
import { providerVerificationTable } from '../packages/gateway/src/verification.js';

export const machineTables = [
  sprintTable, taskStatusTable, agentControllerTable, recurringRunTable, turnMarkerTable, folderSaveTable, importPreviewTable,
  exportCompileMachine.table, exportReadinessMachine.table, encodingPanelMachine.table,
  sidebarTable, menuTable, findingStatusTable, callIdTable, runtimeConnectionTable, runStatusTable,
  assetStagingTable, assetRemovalHoldTable, autosaveTable, reviewTable, interfaceTable,
  turnPhaseTable, cardStatusTable,
  cardDecisionTable, budgetMeterTable,
  exportJobMachine.table, eventQueueTable, writerStopTable, confirmationRoundTable,
  tabStopTable, persistenceTable, pendingEntryTable, healthTable,
  saveChannelTable,
  modalMachine.table,
  editorSessionTable,
  storeRebaseTable,
  sessionTable, bootTable, demoStartTable, homeOpenTable,
  providerVerificationTable,
] as const;
