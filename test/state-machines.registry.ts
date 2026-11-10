import { taskStatusTable } from '../apps/desktop/src/app/task-store.js';
import { sidebarTable } from '../apps/desktop/src/components/shell/modern/sidebar-model.js';
import { menuTable } from '../apps/desktop/src/components/shell/modern/menu-model.js';
import { sprintTable } from '../packages/furniture/src/sprint.js';
import { turnPhaseTable } from '../packages/harness/src/agent/turn-machine.js';
import { cardStatusTable } from '../packages/harness/src/agent/cards.js';
import { cardDecisionTable } from '../packages/harness/src/agent/card-decision.js';
import { budgetMeterTable } from '../packages/harness/src/agent/budget.js';

export const machineTables = [sprintTable, taskStatusTable, sidebarTable, menuTable, turnPhaseTable, cardStatusTable, cardDecisionTable, budgetMeterTable] as const;
