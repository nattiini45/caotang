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
    readonly limit: number;
  },
): ActivityWindow {
  const rows = activityRows(entries, {
    showViews: options.showViews,
    groupOf: options.groupOf,
    limit: options.limit,
  });
  const pinned = pinNewestUndoable(entries, rows, options.groupOf);
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
 * window already carries an Undo (or nothing is left to undo).
 *
 * The undo affordance rides on each group's newest row. Because the window keeps the newest rows and
 * the newest undoable group's row is the newest of the undoable ones, either it is in the window or
 * every undoable row is behind it — so a scan from the newest for the first group the undo store
 * still holds finds exactly the row to pin, and it is older than every row the window kept.
 */
function pinNewestUndoable(
  entries: readonly ActivityEntry[],
  rows: readonly ActivityRow[],
  groupOf: (id: string) => UndoGroup | undefined,
): ActivityRow | null {
  if (rows.some((row) => row.undo !== null)) return null;
  const seen = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const groupId = entry.undoGroupId;
    if (groupId === undefined || seen.has(groupId)) continue;
    seen.add(groupId);
    const undo = groupOf(groupId);
    if (undo === undefined) continue;
    return { index, entry, title: titleOf(entry.command), undo };
  }
  return null;
}
