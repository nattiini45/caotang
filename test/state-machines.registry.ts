import { taskStatusTable } from '../apps/desktop/src/app/task-store.js';
import { sprintTable } from '../packages/furniture/src/sprint.js';
import { findingStatusTable } from '../packages/bus/src/coherence.js';
import { callIdTable } from '../packages/bus/src/idempotency.js';
import { runtimeConnectionTable } from '../packages/store/src/runtime/store.js';
import { assetStagingTable } from '../packages/store/src/asset-staging.js';
import { assetRemovalHoldTable } from '../packages/store/src/asset-removals.js';

export const machineTables = [sprintTable, taskStatusTable, findingStatusTable, callIdTable, runtimeConnectionTable, assetStagingTable, assetRemovalHoldTable] as const;
