/**
 * `filters[]` and `goals[]` on load — binder-filters §4, goals-progress §2.2/§3.
 *
 * Both arrays hold the author's own saved work, and neither was checked when a
 * `caotang.json` was opened. A manifest carrying `"filters": {}` reached the
 * writer as an object with no `.map` on it, so every save of that project died;
 * a goal missing its `comparator` reached the serializer, which wrote the bare
 * word `undefined` into the file and made the next open unparseable.
 *
 * **The convention locked here is the one `recipes[]` already sets in
 * validate.ts**: a malformed entry is *dropped with a warning* and the load
 * goes on. A refusal would be the wrong answer in both cases, and the specs say
 * so in the same words — binder-filters §4 ("a broken saved query must never
 * block a project load") and goals-progress §3 ("unknown comparator/metric →
 * goal dropped with load warning"). A saved query is a view over the tree, not
 * the tree: a project whose one filter is broken still has documents, and
 * refusing to open it would turn a cosmetic fault into a lost project.
 *
 * The two halves of the rule are kept apart, because the two kinds of field
 * cost different things: a **required** field the entry cannot do without (a
 * filter's `id`, a goal's `comparator`) takes the entry with it, because the
 * serializer writes those unconditionally; an **optional** field that is
 * malformed (a filter's `root`, a goal's `deadline`) is dropped on its own and
 * the entry is kept, because the field has a documented meaning when absent.
 */

import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FILE,
  MemoryArtifactFs,
  createEmptyManifest,
  createProjectState,
  readProject,
  validateManifest,
  writeProject,
  type Manifest,
  type ProjectGoal,
  type SavedFilter,
} from '../src/index.js';

const T = new Date('2026-10-18T08:00:00.000Z');
const ISO = T.toISOString();

/** A saved filter of the spec's shape (binder-filters §2). */
const GOOD_FILTER: SavedFilter = {
  id: 'q_01H2K3M4N5',
  name: 'Drafts about the sea',
  root: 'manuscript',
  criteria: { statusId: 'draft' },
  createdAt: ISO,
  updatedAt: ISO,
};

/** A project goal of the spec's shape (goals-progress §2.2). */
const GOOD_GOAL: ProjectGoal = {
  id: 'g_01H2K3M4N5',
  nodeId: 'manuscript',
  metric: 'words',
  comparator: 'at-least',
  target: 80_000,
  createdAt: ISO,
  updatedAt: ISO,
};

function base(): Manifest {
  return createEmptyManifest('The Lighthouse Keeper', T);
}

describe('filters[] on load (binder-filters §4)', () => {
  it('keeps a saved filter as it is, with no warning', () => {
    const m = base();
    m.filters = [GOOD_FILTER];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.manifest?.filters).toEqual([GOOD_FILTER]);
  });

  it('drops a filters value that is not an array, with a warning, and the project still opens', () => {
    const m = base();
    (m as unknown as Record<string, unknown>)['filters'] = {};

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('filters');
    expect(r.manifest).not.toHaveProperty('filters');
  });

  it('drops a filter that is not a saved filter, and keeps the ones that are', () => {
    const m = base();
    m.filters = [GOOD_FILTER, { id: 'q_02H2K3M4N5' } as never, 'not a filter' as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(['filters[1]', 'filters[2]']));
    expect(r.manifest?.filters).toEqual([GOOD_FILTER]);
  });

  it('drops a filter whose criteria are not an object — a broken saved query must never block a load', () => {
    const m = base();
    m.filters = [{ ...GOOD_FILTER, criteria: 'the sea' } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('filters[0]');
    expect(r.manifest?.filters).toEqual([]);
  });

  it('drops a filter it could not write back — one with no id to name it by', () => {
    const m = base();
    m.filters = [{ name: 'Nameless', criteria: {}, createdAt: ISO, updatedAt: ISO } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('filters[0]');
    expect(r.manifest?.filters).toEqual([]);
  });

  it('drops a root it does not know and keeps the filter, which then searches both roots', () => {
    const m = base();
    m.filters = [{ ...GOOD_FILTER, root: 'somewhere-else' } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.manifest?.filters).toEqual([{ ...GOOD_FILTER, root: undefined }]);
    expect(r.manifest?.filters?.[0]).not.toHaveProperty('root');
  });
});

describe('goals[] on load (goals-progress §2.2 and §3)', () => {
  it('keeps a goal as it is, with no warning', () => {
    const m = base();
    m.goals = [GOOD_GOAL];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.manifest?.goals).toEqual([GOOD_GOAL]);
  });

  it('drops a goals value that is not an array, with a warning, and the project still opens', () => {
    const m = base();
    (m as unknown as Record<string, unknown>)['goals'] = { 'g_1': GOOD_GOAL };

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('goals');
    expect(r.manifest).not.toHaveProperty('goals');
  });

  it('drops a goal whose comparator or metric this build does not know (goals-progress §3)', () => {
    const m = base();
    m.goals = [
      { ...GOOD_GOAL, comparator: 'roughly' } as never,
      { ...GOOD_GOAL, metric: 'pages' } as never,
      { ...GOOD_GOAL, kind: 'yearly' } as never,
    ];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(['goals[0]', 'goals[1]', 'goals[2]']));
    expect(r.manifest?.goals).toEqual([]);
  });

  it('drops a goal missing a field it cannot do without — its comparator', () => {
    const m = base();
    const { comparator: _comparator, ...withoutComparator } = GOOD_GOAL;
    m.goals = [withoutComparator as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('goals[0]');
    expect(r.manifest?.goals).toEqual([]);
  });

  it('drops a goal whose target is not a positive whole number', () => {
    const m = base();
    m.goals = [{ ...GOOD_GOAL, target: 0 } as never, { ...GOOD_GOAL, target: 'lots' } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(['goals[0]', 'goals[1]']));
    expect(r.manifest?.goals).toEqual([]);
  });

  // goals-progress §2.2: "Dangling on load (folder deleted) → goal kept but
  // flagged 'target missing' in the UI, matches nothing (same posture as
  // unknown vocabulary ids; never blocks load)."
  it('keeps a goal whose node is gone, and says so, because a missing target is not a broken goal', () => {
    const m = base();
    m.goals = [{ ...GOOD_GOAL, nodeId: 'n_GONE000001' }];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.manifest?.goals).toEqual([{ ...GOOD_GOAL, nodeId: 'n_GONE000001' }]);
    expect(r.warnings.map((w) => w.path)).toContain('goals[0].nodeId');
  });

  // goals-progress §2.2: "Weekly and monthly goals only (a project goal
  // carrying one is refused at save and dropped on load)."
  it('drops a project goal that carries a reset day', () => {
    const m = base();
    m.goals = [{ ...GOOD_GOAL, resetDay: 3 } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('goals[0]');
    expect(r.manifest?.goals).toEqual([]);
  });

  it('keeps a weekly goal with a reset day, and drops one whose reset day is not a weekday', () => {
    const weekly: ProjectGoal = { ...GOOD_GOAL, kind: 'weekly', resetDay: 0 };
    const monthly: ProjectGoal = { ...GOOD_GOAL, kind: 'monthly', resetDay: 'last' };
    const m = base();
    m.goals = [
      weekly,
      { ...GOOD_GOAL, kind: 'weekly', resetDay: 9 } as never,
      monthly,
      { ...GOOD_GOAL, kind: 'monthly', resetDay: 31 } as never,
    ];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.manifest?.goals).toEqual([weekly, monthly]);
    expect(r.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(['goals[1]', 'goals[3]']));
  });

  // manifest.ts: "Absent (an older manifest) means words."
  it('gives an absent metric the meaning the spec gives it — words', () => {
    const m = base();
    const { metric: _metric, ...withoutMetric } = GOOD_GOAL;
    m.goals = [withoutMetric as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.manifest?.goals).toEqual([{ ...GOOD_GOAL, metric: 'words' }]);
  });

  it('drops a deadline that is not a day, and keeps the goal it was on', () => {
    const m = base();
    m.goals = [{ ...GOOD_GOAL, deadline: '2026-02-30' } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('goals[0].deadline');
    expect(r.manifest?.goals).toEqual([GOOD_GOAL]);
  });
});

describe('a manifest whose filters or goals are malformed still saves', () => {
  it('loads, saves, and the file it wrote is JSON a next open can read', async () => {
    // The whole point: neither array was checked on load, so the values below
    // reached the writer, and the save either died on them or wrote a manifest
    // the next open could not parse.
    const fs = new MemoryArtifactFs();
    await writeProject(fs, createProjectState(base()), { now: T });
    const manifest = JSON.parse(await fs.read(MANIFEST_FILE)) as Record<string, unknown>;
    manifest['filters'] = {};
    manifest['goals'] = [{ id: 'g_01H2K3M4N5', nodeId: 'manuscript' }];
    fs.putFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

    const loaded = await readProject(fs);
    expect(loaded.state.manifest.filters).toBeUndefined();
    expect(loaded.state.manifest.goals).toEqual([]);

    await writeProject(fs, loaded.state, { now: T });

    const written = await fs.read(MANIFEST_FILE);
    expect(() => JSON.parse(written)).not.toThrow();
    expect(written).not.toContain('undefined');
  });
});
