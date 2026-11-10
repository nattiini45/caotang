import { sumUsage, type TaskRole, type UsageTotals } from '@caotang/gateway';

export interface UsageGroup extends UsageTotals {
  readonly profileId: string;
  readonly model: string;
  readonly role: TaskRole;
}

export function groupUsage(rows: readonly UsageGroup[]): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const row of rows) {
    const key = JSON.stringify([row.profileId, row.model, row.role]);
    const prior = groups.get(key);
    groups.set(key, {
      profileId: row.profileId, model: row.model, role: row.role,
      ...sumUsage(prior === undefined ? [row] : [prior, row]),
    });
  }
  return [...groups.values()];
}
