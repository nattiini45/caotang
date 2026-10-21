/**
 * The Activity panel's window (command-bus.md §8).
 *
 * The bus's log holds a row for every command the session has run, and it holds them for the life of
 * the tab: a sitting of writing puts thousands of rows in it. The panel renders the log whenever the
 * session changes, so the log's size was the panel's cost — every row was built and every row was in
 * the page.
 *
 * The log keeps every row, because the rest of the app needs them: the undo groups name their own
 * rows (session.ts), and the Markdown export carries the whole log (command-bus §8). The window is
 * the panel's own: it shows the newest rows of the log, and the older ones one window at a time, on
 * the button that names how many are left. The newest row that can still be undone is always in the
 * window, even when a sitting's view events would otherwise push it out, so the panel never hides
 * the one command it dispatches.
 */

import type { ActivityEntry, UndoGroup } from '@caotang/bus';

import { activityRows, titleOf, visibleActivityCount, type ActivityRow } from '../app/activity-model.js';

/**
 * How many rows the Activity panel shows at once.
 *
 * A window of rows covers a sitting's worth of reading, and keeps the panel's cost off the writer's
 * keystrokes: the rows behind it are not built and not in the page.
 */
export const ACTIVITY_PANEL_WINDOW = 200;

/** What the panel shows: the rows in its window, and the older ones it keeps back. */
export interface ActivityWindow {
  /** The rows to render, newest first. */
  readonly rows: readonly ActivityRow[];
  /** How many rows the log holds that the window keeps back. */
  readonly hidden: number;
  /** The button's name, or `null` when every row of the log is in the window. */
  readonly showOlder: string | null;
}

/**
 * The panel's window over the log: the newest rows, and the count of the ones behind them.
 *
 * `groupOf` answers from the undo store, so a group that can still be undone carries its affordance
 * on its newest row, as the whole log would have it.
 *
 * The window keeps the newest `limit` rows, and the panel's own "Show view changes" toggle counts
 * view events toward that limit. A sitting can put more view events after the newest undoable group
 * than the window holds, pushing every row that carries an Undo behind it — and the panel would then
 * offer none of the one command it dispatches. So the newest still-undoable group's row is pinned
 * into the window when the limit left it out (`pinNewestUndoable`).
 */
export function activityWindow(
  entries: readonly ActivityEntry[],
  options: {
    readonly showViews: boolean;
    readonly groupOf: (id: string) => UndoGroup | undefined;
    /**
     * The group the panel can undo: the newest one the undo store holds. Its row is the row that
     * carries the Undo the panel offers, and so the one the window has to hold.
     */
    readonly newestUndoGroupId: string | null;
    readonly limit: number;
  },
): ActivityWindow {
  const rows = activityRows(entries, {
    showViews: options.showViews,
    groupOf: options.groupOf,
    limit: options.limit,
  });
  const pinned = pinNewestUndoable(entries, rows, options.groupOf, options.newestUndoGroupId);
  const shown = pinned === null ? rows : [...rows, pinned];
  const hidden = Math.max(0, visibleActivityCount(entries, options.showViews) - shown.length);
  return { rows: shown, hidden, showOlder: hidden > 0 ? `Show older (${hidden} more)` : null };
}

/** The window the "Show older" button opens: one more window of rows. */
export function showOlderWindow(limit: number): number {
  return limit + ACTIVITY_PANEL_WINDOW;
}

/**
 * The newest row of the log that can still be undone, when the window left it out, or `null` when the
 * window already carries that row (or nothing is left to undo).
 *
 * The undo affordance rides on each group's newest row, and only the newest group the undo store holds
 * can be undone: the panel's other Undo buttons are disabled (ActivityPanel.tsx). So the row the window
 * has to carry is the newest row of *that* group, and the scan looks for it by its group rather than for
 * the first live group it meets on the way from the newest. The two are not the same: a gesture made in
 * the middle of an agent's turn mints a newer group whose rows are older in the log than the turn's
 * later rows, so a scan from the newest finds the turn's group — whose Undo is disabled — and pins
 * that, and the one Undo the panel offers stays behind the window.
 */
function pinNewestUndoable(
  entries: readonly ActivityEntry[],
  rows: readonly ActivityRow[],
  groupOf: (id: string) => UndoGroup | undefined,
  newestUndoGroupId: string | null,
): ActivityRow | null {
  if (newestUndoGroupId === null) return null;
  // The window already carries the row that offers the Undo: there is nothing to pin.
  if (rows.some((row) => row.undo?.id === newestUndoGroupId)) return null;
  const undo = groupOf(newestUndoGroupId);
  if (undo === undefined) return null;
  // The newest row of that group: the row that carries its claim in the whole log.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.undoGroupId !== newestUndoGroupId) continue;
    return { index, entry, title: titleOf(entry.command), undo };
  }
  return null;
}
