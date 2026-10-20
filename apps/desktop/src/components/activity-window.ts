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
 * the button that names how many are left.
 */

import type { ActivityEntry, UndoGroup } from '@caotang/bus';

import { activityRows, visibleActivityCount, type ActivityRow } from '../app/activity-model.js';

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
  const hidden = Math.max(0, visibleActivityCount(entries, options.showViews) - rows.length);
  return { rows, hidden, showOlder: hidden > 0 ? `Show older (${hidden} more)` : null };
}

/** The window the "Show older" button opens: one more window of rows. */
export function showOlderWindow(limit: number): number {
  return limit + ACTIVITY_PANEL_WINDOW;
}
