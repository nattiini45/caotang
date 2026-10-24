import { expect, test } from '@playwright/test';

import type { ActivityEntry, UndoGroup } from '../../packages/bus/src/index.js';

import {
  activityRows,
  issuerLabel,
  isViewEvent,
  sourceBadge,
  timeLabel,
  titleOf,
  visibleActivityCount,
} from '../../apps/desktop/src/app/activity-model.js';

/** One executed command, as the bus writes its row (command-bus.md §8). */
function row(command: string, summary: string, undoGroupId?: string): ActivityEntry {
  return {
    at: 1_700_000_000_000,
    command,
    issuedBy: 'user',
    source: 'native',
    affected: [],
    summary,
    ...(undoGroupId === undefined ? {} : { undoGroupId }),
  };
}

function group(id: string): UndoGroup {
  return { id, kind: 'user-gesture', at: 1, label: 'restore to before this action', entries: [] };
}

test('the rows are newest first, and the view events are hidden unless the writer asks for them', () => {
  const log = [
    row('binder.create', 'created a scene'),
    row('view.setSelection', 'selected it'),
    row('binder.rename', 'renamed it'),
  ];
  const none = () => undefined;

  const hidden = activityRows(log, { showViews: false, groupOf: none });
  expect(hidden.map((item) => item.entry.command)).toEqual(['binder.rename', 'binder.create']);
  // The position in the whole log is kept, so the list can key its rows as the log grows.
  expect(hidden.map((item) => item.index)).toEqual([2, 0]);

  const shown = activityRows(log, { showViews: true, groupOf: none });
  expect(shown.map((item) => item.title)).toEqual(['Renamed', 'Selection changed', 'New item']);
});

test('an undo is offered once per group, on its newest row, and only while the group is still in the undo store', () => {
  const groups = new Map([['g1', group('g1')]]);
  const log = [
    row('binder.rename', 'first rename', 'g1'),
    row('binder.rename', 'second rename', 'g1'),
    row('doc.write', 'a text save', 'g2'),
  ];

  const rows = activityRows(log, { showViews: false, groupOf: (id) => groups.get(id) });

  // Newest first: g2 is not in the store (it was undone), so it has no undo; g1's newest row has it, and its older row does not.
  expect(rows.map((item) => item.undo?.id ?? null)).toEqual([null, 'g1', null]);
});

test('a group that has been undone offers nothing, whatever its rows say', () => {
  const log = [row('binder.rename', 'renamed', 'gone')];
  const rows = activityRows(log, { showViews: false, groupOf: () => undefined });
  expect(rows[0]?.undo).toBeNull();
});

test('the limit keeps exactly the newest rows: zero keeps none, and a fraction is floored', () => {
  const log = [row('binder.create', 'one'), row('binder.rename', 'two'), row('notes.set', 'three')];
  const none = () => undefined;

  expect(activityRows(log, { showViews: false, groupOf: none, limit: 0 })).toEqual([]);
  expect(activityRows(log, { showViews: false, groupOf: none, limit: 2.5 }).map((item) => item.entry.command)).toEqual([
    'notes.set',
    'binder.rename',
  ]);
  expect(activityRows(log, { showViews: false, groupOf: none, limit: 3 })).toHaveLength(3);
});

test('a limit that is not a number holds none, so the window keeps the cost it exists to prevent', () => {
  const log = [row('binder.create', 'one'), row('binder.rename', 'two'), row('notes.set', 'three')];
  const none = () => undefined;

  // `Math.floor(NaN)` is `NaN`, and a check against `NaN` never ends: the window would hold every row of the log.
  expect(activityRows(log, { showViews: false, groupOf: none, limit: Number.NaN })).toEqual([]);
  // A limit of infinity is the one that says "all of them", and it is kept.
  expect(activityRows(log, { showViews: false, groupOf: none, limit: Number.POSITIVE_INFINITY })).toHaveLength(3);
  expect(activityRows(log, { showViews: false, groupOf: none })).toHaveLength(3);
});

test('the count and the rows agree, even over a log with a hole in it', () => {
  const log: (ActivityEntry | undefined)[] = [row('binder.create', 'one'), row('binder.rename', 'two'), row('notes.set', 'three')];
  // A hole the log's own append never makes. The rows refuse to build it; a count that saw it would leave "Show older"
  // one row short of zero forever, and one that read its command would throw.
  log[1] = undefined;
  const sparse = log as readonly ActivityEntry[];

  expect(visibleActivityCount(sparse, true)).toBe(2);
  expect(visibleActivityCount(sparse, false)).toBe(2);
  expect(activityRows(sparse, { showViews: true, groupOf: () => undefined })).toHaveLength(2);
});

test('every command has a person’s title, and an unknown name is shown as it is', () => {
  expect(titleOf('binder.move')).toBe('Moved');
  expect(titleOf('codex.upsert')).toBe('Codex entry saved');
  expect(titleOf('export.compileSelection')).toBe('Part of the manuscript exported');
  expect(titleOf('some.future.command')).toBe('some.future.command');
});

test('the source and the issuer are labelled for a reader', () => {
  expect(sourceBadge('native')).toBe('Native');
  expect(sourceBadge('mcp')).toBe('MCP');
  expect(issuerLabel('user')).toBe('You');
  expect(issuerLabel('agent')).toBe('Agent');
  expect(isViewEvent('view.setScroll')).toBe(true);
  expect(isViewEvent('binder.move')).toBe(false);
});

test('a row time is a clock time in the formatter locale, never the system locale by accident', () => {
  // Three in the morning is one in every locale; only the day-period convention differs, so the test does not depend on a timezone.
  const at = new Date(2026, 9, 31, 3, 4, 5).getTime();
  expect(timeLabel(at, 'en-US')).toBe('03:04:05 AM');
  expect(timeLabel(at, 'en-GB')).toBe('03:04:05');
  expect(timeLabel(at, 'de-DE')).toBe('03:04:05');
});
