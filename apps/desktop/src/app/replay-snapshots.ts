/**
 * The project as each of the tab's last turns found it (agent-harness §8.1).
 *
 * A turn replay runs on the project as it was when the turn started, and the store has no such state: restoring goes through undo
 * groups, which take every later change with them and change the real project on the way. So the app keeps a copy itself, taken when
 * the trace records `turn.start`, for the same few turns the trace keeps and no longer than the tab lives. Nothing here is written to
 * the project, the app database or anywhere else: a snapshot is a copy of strings the store already holds, held in this page's memory.
 *
 * Off with the trace: with traces off nothing is recorded, so there is no recording to replay and no snapshot is taken either.
 */

import { cloneProjectState, type ProjectState } from '@caotang/store';

/** How many turns' starting states are kept: the same window the trace store keeps for a tab (`TraceStoreOptions.maxTurns` default). */
export const SNAPSHOTS_MAX = 5;

export class ReplaySnapshots {
  /** Oldest first, so the oldest is the one evicted. */
  private readonly kept: { readonly turnId: string; readonly state: ProjectState }[] = [];

  /** Keeps `state` as the project turn `turnId` started on, and drops the oldest once {@link SNAPSHOTS_MAX} are held. */
  keep(turnId: string, state: ProjectState): void {
    if (this.kept.some((entry) => entry.turnId === turnId)) return;
    this.kept.push({ turnId, state: cloneProjectState(state) });
    while (this.kept.length > SNAPSHOTS_MAX) this.kept.shift();
  }

  /** The project as that turn found it, or `undefined` when this tab did not record it. */
  of(turnId: string): ProjectState | undefined {
    return this.kept.find((entry) => entry.turnId === turnId)?.state;
  }

  /** Whether a replayed turn of this one can run on its own starting state. */
  has(turnId: string): boolean {
    return this.kept.some((entry) => entry.turnId === turnId);
  }

  /** Drops every snapshot, as clearing the trace does. */
  clear(): void {
    this.kept.length = 0;
  }
}
