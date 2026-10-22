/**
 * The activity log and the panel's window (command-bus.md §8).
 *
 * The log holds a row for every command the session has run, for the life of the tab, and the undo
 * groups name their rows (session.ts): the log keeps every row, and the panel shows a window of them.
 */

import { expect, test } from '@playwright/test';

import type { ActivityEntry } from '../../packages/bus/src/index.js';
import { MemoryIndexedDb, openRuntimeStore } from '../../packages/store/src/index.js';

import { activityMarkdown } from '../../apps/desktop/src/app/activity-model.js';
import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { activityWindow, ACTIVITY_PANEL_WINDOW, showOlderWindow } from '../../apps/desktop/src/components/activity-window.js';

import { IDS, project } from './fixtures.js';

/**
 * The session is the app's own, and it reads the window and the document to know when the tab is
 * hidden; Node has none, so they are stood in for (the agent's session spec does the same).
 */
const globals = globalThis as unknown as Record<string, unknown>;
let previous: { document: unknown; window: unknown } | null = null;

test.beforeAll(() => {
  previous = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});

test.afterAll(() => {
  if (previous === null) return;
  globals['document'] = previous.document;
  globals['window'] = previous.window;
});

async function sessionFor(): Promise<ProjectSession> {
  const state = project();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  return new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
}

/** One row of the log, as the bus writes it. */
function aRow(command: string, undoGroupId?: string): ActivityEntry {
  return {
    at: 1_700_000_000_000,
    command,
    issuedBy: 'user',
    source: 'native',
    affected: [],
    summary: `ran ${command}`,
    ...(undoGroupId === undefined ? {} : { undoGroupId }),
  };
}

/**
 * The agent's turn opens its own undo group, the way the bus opens it: the turn's first command decides
 * the group, and the turn's later commands share it.
 */
function anAgentTurn(session: ProjectSession, turnId: string): string {
  const target = session.undo.targetFor(
    {
      id: `cmd_${turnId}`,
      name: 'doc.write',
      params: { docId: IDS.sceneA, body: 'one' },
      issuedBy: 'agent',
      turnId,
      createdAt: 1_700_000_000_000,
    },
    1_700_000_000_000,
  );
  return session.undo.register(target, {
    kind: 'compensable',
    commandId: `cmd_${turnId}`,
    name: 'doc.write',
    label: 'restore to before this turn',
    restore: () => {},
  });
}

/** A log of `count` rows, as a sitting of writing leaves behind. */
function aLongLog(session: ProjectSession, count: number): void {
  for (let index = 0; index < count; index += 1) session.log.append(aRow(`command.${index}`));
}

test('an undo group still names its own row after the log has grown behind it', async () => {
  const session = await sessionFor();
  try {
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'one' });
    session.dispatch('doc.write', { docId: IDS.sceneB, body: 'two' });
    const [older, newer] = session.undo.groups().map((group) => group.id);
    // The writer's own typing is named by the scene it is in, in the writer's words.
    expect(session.undoLabel()).toBe('your typing in “Scene B”');
    const summary = session.log.entriesForGroup(newer!).at(-1)?.summary;

    // A long sitting puts thousands of rows in the log, and the undo groups stay on the stack.
    aLongLog(session, 600);
    expect(session.undo.groups()).toHaveLength(2);

    // The groups still name their own rows: the log keeps every row of the tab.
    expect(session.undoLabel()).toBe('your typing in “Scene B”');
    expect(session.laterChangesAfter(older!)).toEqual([summary]);
  } finally {
    await session.close();
  }
});

test('the log the session hands out keeps every row of the sitting', async () => {
  const session = await sessionFor();
  try {
    aLongLog(session, 600);
    // The undo groups are deliberately unbounded (command-bus A3), and the rows that name them are
    // the log's, so the log is not trimmed either.
    expect(session.log.entries()).toHaveLength(600);
    expect(session.log.entries()[0]?.command).toBe('command.0');
    expect(session.log.entries()[599]?.command).toBe('command.599');
  } finally {
    await session.close();
  }
});

test('the panel shows a window of the log, and the button opens the rows behind it', async () => {
  const session = await sessionFor();
  try {
    aLongLog(session, 600);
    const entries = session.log.entries();
    const none = (): undefined => undefined;

    // The window holds the newest rows, and the button names the ones behind it.
    const first = activityWindow(entries, {
      showViews: false,
      groupOf: none,
      newestUndoGroupId: session.newestUndoGroupId(),
      limit: ACTIVITY_PANEL_WINDOW,
    });
    expect(first.rows).toHaveLength(ACTIVITY_PANEL_WINDOW);
    expect(first.hidden).toBe(600 - ACTIVITY_PANEL_WINDOW);
    expect(first.showOlder).toBe('Show older (400 more)');
    expect(first.rows[0]?.entry.command).toBe('command.599');

    // The button opens one more window, and the rows behind it are the ones the log holds.
    const second = activityWindow(entries, {
      showViews: false,
      groupOf: none,
      newestUndoGroupId: session.newestUndoGroupId(),
      limit: showOlderWindow(ACTIVITY_PANEL_WINDOW),
    });
    expect(second.rows).toHaveLength(600 - ACTIVITY_PANEL_WINDOW);
    expect(second.hidden).toBe(600 - 2 * ACTIVITY_PANEL_WINDOW);
    expect(second.showOlder).toBe('Show older (200 more)');

    // Two windows cover the sitting, and then there is nothing older to show.
    const third = activityWindow(entries, {
      showViews: false,
      groupOf: none,
      newestUndoGroupId: session.newestUndoGroupId(),
      limit: showOlderWindow(showOlderWindow(ACTIVITY_PANEL_WINDOW)),
    });
    expect(third.rows).toHaveLength(600);
    expect(third.hidden).toBe(0);
    expect(third.showOlder).toBeNull();
  } finally {
    await session.close();
  }
});

test('a window full of view changes still shows the newest undo', async () => {
  const session = await sessionFor();
  try {
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'one' });
    const group = session.newestUndoGroupId();
    // A sitting of scrolling and selecting: more view events than the window holds, all of them newer than the
    // undoable change, and the panel's own "Show view changes" toggle counts them toward the window.
    for (let index = 0; index < ACTIVITY_PANEL_WINDOW + 100; index += 1) session.log.append(aRow('view.setScroll'));
    const entries = session.log.entries();

    const panel = activityWindow(entries, {
      showViews: true,
      groupOf: (id) => session.undo.group(id),
      newestUndoGroupId: session.newestUndoGroupId(),
      limit: ACTIVITY_PANEL_WINDOW,
    });
    // The window is the newest rows — all view events — plus the pinned row of the newest undoable group, so the
    // panel's one command is never hidden by the panel's own toggle.
    const undoRows = panel.rows.filter((row) => row.undo !== null);
    expect(undoRows).toHaveLength(1);
    expect(undoRows[0]?.undo?.id).toBe(group);
    expect(panel.rows).toHaveLength(ACTIVITY_PANEL_WINDOW + 1);
    expect(panel.rows[ACTIVITY_PANEL_WINDOW]?.entry.command).toBe('doc.write');
    // One doc.write plus 300 view events, less the 201 shown: the pinned row is shown, so it is not counted hidden.
    expect(panel.hidden).toBe(100);
  } finally {
    await session.close();
  }
});

test('the pinned undo row is a row the panel shows, and not one it leaves out', async () => {
  const session = await sessionFor();
  try {
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'one' });
    const group = session.newestUndoGroupId();
    // Rows the panel shows, all of them newer than the group's own row, push that row out of the window.
    for (let index = 0; index < 5; index += 1) session.log.append(aRow('command.filler'));
    // And the group's newest row in the whole log is a view event: a row the panel leaves out while
    // its own toggle is off.
    session.log.append(aRow('view.setScroll', group ?? undefined));

    const panel = activityWindow(session.log.entries(), {
      showViews: false,
      groupOf: (id) => session.undo.group(id),
      newestUndoGroupId: session.newestUndoGroupId(),
      limit: 2,
    });

    // The pinned row is the group's own row, the one the panel shows, and not the view event behind it.
    const pinned = panel.rows[panel.rows.length - 1];
    expect(pinned?.entry.command).toBe('doc.write');
    expect(pinned?.undo?.id).toBe(group);
    // The rows are newest first, the pinned row last.
    expect(panel.rows.map((row) => row.index)).toEqual([5, 4, 0]);
    // And the rows the panel hides are the rows it shows and does not: the view event is not one of them.
    expect(panel.hidden).toBe(3);
  } finally {
    await session.close();
  }
});

test('the window keeps the row of the Undo the panel offers, even when an older turn has the newest rows', async () => {
  const session = await sessionFor();
  try {
    // The agent's turn opens its group, and the writer types in the middle of it: the gesture opens a newer group,
    // so it is the newest one the undo store holds — and its row is older in the log than the turn's later rows.
    const turn = anAgentTurn(session, 'turn_1');
    session.log.append(aRow('doc.write', turn));
    session.dispatch('doc.write', { docId: IDS.sceneB, body: 'two' });
    const gesture = session.newestUndoGroupId();
    // The turn keeps working after the gesture, and puts more rows in the log than the window holds.
    for (let index = 0; index < ACTIVITY_PANEL_WINDOW + 100; index += 1) session.log.append(aRow('doc.write', turn));

    const panel = activityWindow(session.log.entries(), {
      showViews: false,
      groupOf: (id) => session.undo.group(id),
      newestUndoGroupId: session.newestUndoGroupId(),
      limit: ACTIVITY_PANEL_WINDOW,
    });

    // The one Undo the panel offers is the gesture's, and its row is in the window: the panel never hides it.
    const offered = panel.rows.filter((row) => row.undo?.id === gesture);
    expect(gesture).not.toBeNull();
    expect(offered).toHaveLength(1);
    expect(offered[0]?.entry.undoGroupId).toBe(gesture);
    // The turn's own row is in the window too, with its Undo — the panel shows that one disabled, and only the
    // newest group's is live (ActivityPanel.tsx).
    expect(panel.rows.filter((row) => row.undo !== null)).toHaveLength(2);
  } finally {
    await session.close();
  }
});

test('the Markdown export carries every row of the log, not only the panel’s window', async () => {
  const session = await sessionFor();
  try {
    aLongLog(session, 600);
    const markdown = activityMarkdown({
      title: 'Fixture Book',
      entries: session.log.entries(),
      turns: [],
    });

    // Every row of the log is a row of the table: the export is not the panel's window.
    const tableRows = markdown.split('\n').filter((line) => /^\| \d+ \|/.test(line));
    expect(tableRows).toHaveLength(600);
    expect(markdown).toContain('ran command.0');
    expect(markdown).toContain('ran command.599');
  } finally {
    await session.close();
  }
});

test('the Markdown export escapes backslashes before pipes in a summary, so a cell cannot be split', () => {
  const entry = (summary: string): ActivityEntry => ({
    at: 0,
    command: 'node.rename',
    issuedBy: 'user',
    source: 'native',
    affected: [],
    summary,
  });
  const markdown = activityMarkdown({
    title: 'Fixture Book',
    entries: [entry('a | b'), entry('ends with \\'), entry('a \\| b')],
    turns: [],
    now: 0,
  });
  const rows = markdown.split('\n').filter((line) => /^\| \d+ \|/.test(line));
  expect(rows).toHaveLength(3);
  expect(rows[0]).toContain('| a \\| b |');
  // A trailing backslash is doubled, so it cannot escape the pipe that closes the cell.
  expect(rows[1]).toContain('| ends with \\\\ |');
  // A literal backslash then a pipe becomes an escaped backslash then an escaped pipe.
  expect(rows[2]).toContain('| a \\\\\\| b |');
  // Reading escapes as pairs, every row keeps exactly seven cells.
  for (const row of rows) expect(row.replace(/\\./g, '').split('|')).toHaveLength(9);
});
