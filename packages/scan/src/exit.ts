/**
 * What a scan's exit code says — [coherence.md §10](../../../docs/architecture/coherence.md). The code is a contract a workflow
 * branches on, so 7 is frozen: it means open findings at or above the `--fail-on` severity. The command's own codes (1 internal,
 * 2 usage, 3 locked) stay the command's.
 */

import { FINDING_SEVERITIES, type FindingSeverity } from '@caotang/coherence';

export const SCAN_EXIT = { Clean: 0, Findings: 7 } as const;
export type ScanExitCode = (typeof SCAN_EXIT)[keyof typeof SCAN_EXIT];

/** `--fail-on`: the lowest severity that fails the run, or `never` for a run that only reports. */
export const FAIL_ON_VALUES = [...FINDING_SEVERITIES, 'never'] as const;
export type FailOn = (typeof FAIL_ON_VALUES)[number];

/** The default threshold: an open error fails the run, a warning does not. */
export const DEFAULT_FAIL_ON: FailOn = 'error';

/** Most severe first, as the report orders them. */
const RANK: Readonly<Record<FindingSeverity, number>> = { error: 0, warning: 1, info: 2 };

export function severityRank(severity: FindingSeverity): number {
  return RANK[severity];
}

/** Whether `value` is a `--fail-on` value. */
export function isFailOn(value: string): value is FailOn {
  return (FAIL_ON_VALUES as readonly string[]).includes(value);
}

/** 7 when any open finding is at or above the threshold, otherwise 0. `never` is always 0. */
export function exitCodeFor(counts: Readonly<Record<FindingSeverity, number>>, failOn: FailOn): ScanExitCode {
  if (failOn === 'never') return SCAN_EXIT.Clean;
  const limit = RANK[failOn];
  const failing = FINDING_SEVERITIES.some((severity) => RANK[severity] <= limit && counts[severity] > 0);
  return failing ? SCAN_EXIT.Findings : SCAN_EXIT.Clean;
}
