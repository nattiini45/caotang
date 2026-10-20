/**
 * The permanent round-trip gate for `filters[]` and `goals[]` (store-02).
 *
 * ## What this pins
 *
 * The load drops a malformed saved filter or goal with a warning and goes on
 * (binder-filters §4, goals-progress §3). That rule is the right one — a
 * broken saved query must never block a project load — and it makes the *drop
 * list* the one part of the manifest that can lose the author's own work
 * without anyone being told. The load's tolerance is therefore only safe while
 * the drop list is empty for everything the app itself writes.
 *
 * So this test holds a project state with **every filter and goal variant the
 * app can write**, writes it with the store's own serializer, reads it back
 * through the store's own load and validation, and says two things: nothing was
 * dropped, and what comes back is what went out.
 *
 * ## Why the fixture is derived rather than written out
 *
 * A fixture that lists the variants by hand goes stale the moment the bus
 * gains one, and a stale fixture is a green test that proves nothing. So:
 *
 * - the criterion keys are read from the bus that owns them — the bus publishes
 *   the list in the refusal it makes for a criterion it does not know — so a
 *   criterion the bus gains is in the next run's fixture;
 * - the goal enums are the bus's own exported unions, covered exhaustively
 *   (`Record<Union, true>`), so a variant the bus gains breaks this file's
 *   typecheck rather than passing silently.
 *
 * The round trip itself is the store's own: `writeProject` (which calls
 * `serializeManifest`) and `readProject` (which calls `validateManifest`). No
 * hand-written JSON stands in for either.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_REGISTRY,
  type FurnitureRoot,
  type GoalComparatorParam,
  type GoalKindParam,
  type GoalMetricParam,
  type ValidationSnapshot,
} from '@caotang/bus';
import {
  MemoryArtifactFs,
  createEmptyManifest,
  createProjectState,
  readProject,
  writeProject,
  type LoadResult,
  type ProjectGoal,
  type SavedFilter,
} from '../src/index.js';

const T = new Date('2026-10-20T08:00:00.000Z');
const ISO = T.toISOString();

/**
 * The bus's own enums, each one covered by the fixture below.
 *
 * `Record<Union, true>` is the exhaustive form: the bus adds a variant, this
 * file stops compiling, and the fixture has to grow with it. The runtime
 * assertions in the last test then say the fixture really does use every one.
 */
const GOAL_KINDS: Record<GoalKindParam, true> = { project: true, weekly: true, monthly: true };
const GOAL_METRICS: Record<GoalMetricParam, true> = { words: true, chars: true };
const GOAL_COMPARATORS: Record<GoalComparatorParam, true> = { 'at-least': true, 'at-most': true, about: true };
const FILTER_ROOTS: Record<FurnitureRoot, true> = { manuscript: true, research: true };

/** The vocabulary the bus's criterion checks read: one status to name, no tree. */
const SNAPSHOT: ValidationSnapshot = {
  manifest: {
    tree: [],
    vocabulary: { statuses: [{ id: 'draft' }], labels: [] },
  },
  documents: new Map(),
};

/**
 * The criterion keys this build accepts, taken from the bus that owns the list.
 *
 * The bus's own `CRITERIA_KEYS` is private to its module and the store must
 * not restate it — two records of one fact is how a list drifts. The bus
 * *publishes* the list in the refusal it makes for a criterion it does not
 * know, so that refusal is where the list is read from. A bus that changes the
 * refusal's wording breaks this test loudly, which is the right outcome: the
 * list has to come from somewhere, and it must come from the bus.
 */
function criterionKeys(): string[] {
  const probe = COMMAND_REGISTRY['binder.saveFilter'].descriptor.validate(
    { filter: { name: 'probe', criteria: { __not_a_criterion__: true } } },
    SNAPSHOT,
  );
  if (probe.ok) throw new Error('the bus accepted a criterion it does not know, so it publishes no list to read');
  const hint = probe.error.correctiveHint ?? '';
  const listed = /^a criterion is one of: (.+)$/.exec(hint);
  if (listed === null) {
    throw new Error(`the bus no longer publishes its criterion list in a refusal: "${hint}"`);
  }
  return (listed[1] as string)
    .split(',')
    .map((key) => key.trim());
}

/**
 * The five shapes a criterion value can hold (binder-filters §2's criteria, and
 * what the writer can write back as JSON).
 *
 * The store's rule is about the *value*, not the key: a criterion the writer
 * cannot write is a filter the writer cannot save. So every key is exercised
 * with every kind.
 */
const VALUE_KINDS = ['string', 'number', 'boolean', 'null', 'list'] as const;
type ValueKind = (typeof VALUE_KINDS)[number];

function criterionValue(kind: ValueKind, key: string): unknown {
  switch (kind) {
    case 'string':
      return `probe-${key}`;
    case 'number':
      return 42;
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'list':
      return [`probe-${key}`];
  }
}

/** A saved filter of the shape the store's own `binder.saveFilter` apply writes. */
function savedFilter(
  id: string,
  name: string,
  root: FurnitureRoot | undefined,
  criteria: Record<string, unknown>,
): SavedFilter {
  return {
    id,
    name,
    ...(root !== undefined ? { root } : {}),
    criteria,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

/** A project goal of the shape the store's own `project.saveGoal` apply writes. */
function projectGoal(
  id: string,
  metric: GoalMetricParam,
  comparator: GoalComparatorParam,
  target: number,
  extra: Partial<ProjectGoal> = {},
): ProjectGoal {
  return {
    id,
    nodeId: 'manuscript',
    metric,
    comparator,
    target,
    ...extra,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

const KEYS = criterionKeys();

/** One filter per value kind, each carrying every criterion key the bus accepts. */
function criteriaOfKind(kind: ValueKind): Record<string, unknown> {
  return Object.fromEntries(KEYS.map((key) => [key, criterionValue(kind, key)]));
}

const FILTERS: SavedFilter[] = [
  savedFilter('q_01H2K3M4N5', 'Every criterion, as a string', 'manuscript', criteriaOfKind('string')),
  savedFilter('q_02H2K3M4N5', 'Every criterion, as a number', 'research', criteriaOfKind('number')),
  savedFilter('q_03H2K3M4N5', 'Every criterion, as a boolean', undefined, criteriaOfKind('boolean')),
  savedFilter('q_04H2K3M4N5', 'Every criterion, as null', undefined, criteriaOfKind('null')),
  savedFilter('q_05H2K3M4N5', 'Every criterion, as a list', 'manuscript', criteriaOfKind('list')),
  savedFilter('q_06H2K3M4N5', 'A filter that matches everything', undefined, {}),
];

const GOALS: ProjectGoal[] = [
  // A project goal: no session kind, no reset day — the shape the apply writes.
  projectGoal('g_01H2K3M4N5', 'words', 'at-least', 80_000),
  projectGoal('g_02H2K3M4N5', 'chars', 'at-most', 400_000, { deadline: '2026-12-31' }),
  projectGoal('g_03H2K3M4N5', 'words', 'about', 75_000, { archived: false }),
  // A weekly goal: the reset day is a weekday.
  projectGoal('g_04H2K3M4N5', 'words', 'at-least', 2_000, { kind: 'weekly', resetDay: 0 }),
  projectGoal('g_05H2K3M4N5', 'chars', 'at-most', 12_000, { kind: 'weekly', resetDay: 6, deadline: '2027-01-01' }),
  projectGoal('g_06H2K3M4N5', 'chars', 'about', 9_000, { kind: 'weekly', resetDay: 3, archived: true }),
  // A monthly goal: the reset day is a day of the month, or `last`.
  projectGoal('g_07H2K3M4N5', 'words', 'at-least', 8_000, { kind: 'monthly', resetDay: 1 }),
  projectGoal('g_08H2K3M4N5', 'chars', 'at-most', 48_000, { kind: 'monthly', resetDay: 28 }),
  projectGoal('g_09H2K3M4N5', 'words', 'about', 7_500, {
    kind: 'monthly',
    resetDay: 'last',
    deadline: '2027-03-31',
    archived: false,
  }),
];

/** The store's own write and the store's own load, with nothing in between. */
async function writeAndRead(filters: SavedFilter[], goals: ProjectGoal[]): Promise<LoadResult> {
  const manifest = createEmptyManifest('The Lighthouse Keeper', T);
  manifest.filters = filters;
  manifest.goals = goals;

  const fs = new MemoryArtifactFs();
  await writeProject(fs, createProjectState(manifest), { now: T });
  return readProject(fs);
}

describe('every filter and goal the app can write, through the writer and the loader', () => {
  it('comes back with nothing dropped and nothing changed', async () => {
    const loaded = await writeAndRead(FILTERS, GOALS);

    expect(loaded.report.ok).toBe(true);
    expect(loaded.report.warnings).toEqual([]);
    expect(loaded.state.manifest.filters).toEqual(FILTERS);
    expect(loaded.state.manifest.goals).toEqual(GOALS);
  });

  it('writes them into the manifest as JSON a next open can read', async () => {
    const manifest = createEmptyManifest('The Lighthouse Keeper', T);
    manifest.filters = FILTERS;
    manifest.goals = GOALS;

    const fs = new MemoryArtifactFs();
    await writeProject(fs, createProjectState(manifest), { now: T });

    const text = await fs.read('caotang.json');
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toContain('undefined');
  });
});

describe('the fixture covers the whole vocabulary', () => {
  it('covers every criterion key the bus accepts, with every value kind', () => {
    const keys = criterionKeys();
    expect(keys.length).toBeGreaterThan(0);

    const kindFilters = FILTERS.slice(0, VALUE_KINDS.length);
    for (const filter of kindFilters) {
      expect(Object.keys(filter.criteria).sort()).toEqual([...keys].sort());
    }

    const kindOf = (value: unknown): string => {
      if (value === null) return 'null';
      if (Array.isArray(value)) return 'list';
      return typeof value;
    };
    expect(kindFilters.map((filter) => kindOf(Object.values(filter.criteria)[0]))).toEqual([...VALUE_KINDS]);
  });

  it('covers every goal kind, metric, comparator and reset-day shape the bus accepts', () => {
    expect(new Set(GOALS.map((goal) => goal.kind ?? 'project'))).toEqual(new Set(Object.keys(GOAL_KINDS)));
    expect(new Set(GOALS.map((goal) => goal.metric))).toEqual(new Set(Object.keys(GOAL_METRICS)));
    expect(new Set(GOALS.map((goal) => goal.comparator))).toEqual(new Set(Object.keys(GOAL_COMPARATORS)));

    expect(GOALS.filter((goal) => goal.kind === 'weekly').map((goal) => goal.resetDay)).toEqual(
      expect.arrayContaining([0, 6]),
    );
    expect(GOALS.filter((goal) => goal.kind === 'monthly').map((goal) => goal.resetDay)).toEqual(
      expect.arrayContaining([1, 28, 'last']),
    );
  });

  it('covers every filter root, with and without one', () => {
    expect(new Set(FILTERS.map((filter) => filter.root ?? 'none'))).toEqual(
      new Set([...Object.keys(FILTER_ROOTS), 'none']),
    );
  });

  it('covers every optional goal field, with and without it', () => {
    expect(GOALS.some((goal) => goal.deadline !== undefined)).toBe(true);
    expect(GOALS.some((goal) => goal.deadline === undefined)).toBe(true);
    expect(GOALS.some((goal) => goal.archived !== undefined)).toBe(true);
    expect(GOALS.some((goal) => goal.archived === undefined)).toBe(true);
  });
});
