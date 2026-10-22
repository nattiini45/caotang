/**
 * `filters[]` and `goals[]` on load — binder-filters §4, goals-progress §2.2/§3/§9.3.
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
 * malformed (a filter's unknown criterion key, a goal's `deadline` or
 * `resetDay`) is dropped on its own and the entry is kept, because the field
 * has a documented meaning when absent.
 *
 * The ids are checked as the bus checks them (`q_`/`g_` + 10 Crockford chars)
 * and must be unique in their array, because an entry the bus would refuse to
 * update or undo is one the author can never edit or delete again. A weekly or
 * monthly goal also has to keep goals-progress §9.3's invariants — it attaches
 * to the manuscript root, counts words, is `at-least` and takes no deadline —
 * for the same reason: every `project.saveGoal` refuses one that does not.
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

/**
 * A fresh copy, so an expectation is never the object under test: the validator
 * returns the manifest it was given and edits entries in place, so comparing an
 * entry against the very object that was put in compares a thing against itself
 * and can never fail.
 */
function copyOf<T>(value: T): T {
  return structuredClone(value);
}

function base(): Manifest {
  return createEmptyManifest('The Lighthouse Keeper', T);
}

describe('filters[] on load (binder-filters §4)', () => {
  it('keeps a saved filter as it is, with no warning, and leaves the input untouched', () => {
    const input = copyOf(GOOD_FILTER);
    const m = base();
    m.filters = [input];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.manifest?.filters).toEqual([copyOf(GOOD_FILTER)]);
    expect(input).toEqual(GOOD_FILTER);
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
    m.filters = [copyOf(GOOD_FILTER), { id: 'q_02H2K3M4N5' } as never, 'not a filter' as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(['filters[1]', 'filters[2]']));
    expect(r.manifest?.filters).toEqual([copyOf(GOOD_FILTER)]);
  });

  it('drops a filter whose criteria are not an object — a broken saved query must never block a load', () => {
    const m = base();
    m.filters = [{ ...copyOf(GOOD_FILTER), criteria: 'the sea' } as never];

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

  // The bus refuses an id that is not `q_` + 10 Crockford chars at every command
  // boundary, so a filter carrying one could never be renamed, re-criteria'd or
  // undone — it loads as a record nothing can touch. Same posture as codex ids.
  it('drops a filter whose id is not the shape the bus enforces', () => {
    const m = base();
    m.filters = [{ ...copyOf(GOOD_FILTER), id: 'banana' } as never, { ...copyOf(GOOD_FILTER), id: 'q_NOTANID01' } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(['filters[0]', 'filters[1]']);
    expect(r.manifest?.filters).toEqual([]);
  });

  it('drops a filter with no name the writer could show, and a second filter that repeats an id', () => {
    const m = base();
    m.filters = [
      { ...copyOf(GOOD_FILTER), name: '   ' } as never,
      copyOf(GOOD_FILTER),
      { ...copyOf(GOOD_FILTER), name: 'The second one' } as never,
    ];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(['filters[0]', 'filters[2].id']));
    expect(r.manifest?.filters).toEqual([copyOf(GOOD_FILTER)]);
  });

  // binder-filters §4: "unknown criteria keys are dropped with the one-time
  // unknown-field notice (project-format §6 rule)". Kept, a typo like `minWordz`
  // round-trips for ever and every bus command that replays the filter refuses
  // with no hint that the saved filter itself is at fault.
  it('drops a criterion key this build does not know, with a notice, and keeps the filter', () => {
    const m = base();
    m.filters = [{ ...copyOf(GOOD_FILTER), criteria: { statusId: 'draft', minWordz: 100 } } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('filters[0].criteria.minWordz');
    expect(r.manifest?.filters).toEqual([{ ...copyOf(GOOD_FILTER), criteria: { statusId: 'draft' } }]);
    // `toEqual` cannot tell a deleted key from one set to `undefined`, and an
    // undefined value is one the writer refuses (`cannot write ...: the value is
    // not there`), so the key has to be gone, not empty.
    expect(r.manifest?.filters?.[0]?.criteria).not.toHaveProperty('minWordz');
  });

  // binder-filters §2: "name ≤ 60 characters". The bus refuses a longer one at
  // every command boundary, so a loaded filter carrying one could never be
  // renamed — and the undo of a delete of it refuses, which leaves the deletion
  // permanent from the writer's side.
  it('drops a filter whose name is longer than the bus accepts', () => {
    const m = base();
    m.filters = [{ ...copyOf(GOOD_FILTER), name: 'x'.repeat(61) } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(['filters[0]']);
    expect(r.manifest?.filters).toEqual([]);
  });

  // The bus counts a name in code points, and the load counts it the same way:
  // a name of 31 emoji is 31 characters and not 62 UTF-16 units, so the bus
  // accepts it and the load keeps it. Counting it in `.length` here would drop
  // a name the bus accepts — a filter the author could never rename again.
  it('keeps a filter whose name is 31 emoji, which is 31 characters and not 62', () => {
    const m = base();
    const name = '🌊'.repeat(31);
    m.filters = [{ ...copyOf(GOOD_FILTER), name } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.manifest?.filters?.[0]?.name).toBe(name);
  });

  // The writer cannot write a non-finite number as JSON (`JSON.stringify` maps it
  // to `null`, silently changing the value), so the load does not keep one.
  it('drops a filter whose criterion is a number JSON cannot hold', () => {
    const m = base();
    m.filters = [{ ...copyOf(GOOD_FILTER), criteria: { minWords: Number.POSITIVE_INFINITY } } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('filters[0]');
    expect(r.manifest?.filters).toEqual([]);
  });

  it('drops a root it does not know and keeps the filter, which then searches both roots', () => {
    const m = base();
    m.filters = [{ ...copyOf(GOOD_FILTER), root: 'somewhere-else' } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.manifest?.filters).toEqual([{ ...copyOf(GOOD_FILTER), root: undefined }]);
    expect(r.manifest?.filters?.[0]).not.toHaveProperty('root');
  });
});

describe('goals[] on load (goals-progress §2.2 and §3)', () => {
  it('keeps a goal as it is, with no warning, and leaves the input untouched', () => {
    const input = copyOf(GOOD_GOAL);
    const m = base();
    m.goals = [input];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.manifest?.goals).toEqual([copyOf(GOOD_GOAL)]);
    expect(input).toEqual(GOOD_GOAL);
  });

  it('drops a goals value that is not an array, with a warning, and the project still opens', () => {
    const m = base();
    (m as unknown as Record<string, unknown>)['goals'] = { g_1: copyOf(GOOD_GOAL) };

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('goals');
    expect(r.manifest).not.toHaveProperty('goals');
  });

  it('drops a goal whose comparator or metric this build does not know (goals-progress §3)', () => {
    const m = base();
    m.goals = [
      { ...copyOf(GOOD_GOAL), id: 'g_01H2K3M4N5', comparator: 'roughly' } as never,
      { ...copyOf(GOOD_GOAL), id: 'g_02H2K3M4N5', metric: 'pages' } as never,
      { ...copyOf(GOOD_GOAL), id: 'g_03H2K3M4N5', kind: 'yearly' } as never,
    ];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(['goals[0]', 'goals[1]', 'goals[2]']));
    expect(r.manifest?.goals).toEqual([]);
  });

  it('drops a goal missing a field it cannot do without — its comparator', () => {
    const m = base();
    const { comparator: _comparator, ...withoutComparator } = copyOf(GOOD_GOAL);
    m.goals = [withoutComparator as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('goals[0]');
    expect(r.manifest?.goals).toEqual([]);
  });

  it('drops a goal whose id is not the shape the bus enforces, and a second goal that repeats an id', () => {
    const m = base();
    m.goals = [
      { ...copyOf(GOOD_GOAL), id: 'banana' } as never,
      copyOf(GOOD_GOAL),
      { ...copyOf(GOOD_GOAL), target: 40_000 } as never,
    ];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(['goals[0]', 'goals[2].id']));
    expect(r.manifest?.goals).toEqual([copyOf(GOOD_GOAL)]);
  });

  it('drops a goal whose target is not a positive whole number', () => {
    const m = base();
    m.goals = [
      { ...copyOf(GOOD_GOAL), id: 'g_01H2K3M4N5', target: 0 } as never,
      { ...copyOf(GOOD_GOAL), id: 'g_02H2K3M4N5', target: 'lots' } as never,
    ];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(['goals[0]', 'goals[1]']));
    expect(r.manifest?.goals).toEqual([]);
  });

  // An id is registered as taken only by a goal that is kept. A goal dropped
  // over another field never kept its id, so the later goal carrying the same
  // one is not a duplicate of a goal that is not there — and the message above
  // ("the first goal keeps it") stays true.
  it('keeps a well-formed goal whose id a dropped goal had carried', () => {
    const m = base();
    m.goals = [
      { ...copyOf(GOOD_GOAL), id: 'g_01H2K3M4N5', target: 0 } as never,
      { ...copyOf(GOOD_GOAL), id: 'g_01H2K3M4N5' } as never,
    ];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(['goals[0]']);
    expect(r.manifest?.goals).toEqual([copyOf(GOOD_GOAL)]);
  });

  // goals-progress §2.2: "Dangling on load (folder deleted) → goal kept but
  // flagged 'target missing' in the UI, matches nothing (same posture as unknown
  // vocabulary ids; never blocks load)."
  it('keeps a goal whose node is gone, and says so, because a missing target is not a broken goal', () => {
    const m = base();
    m.goals = [{ ...copyOf(GOOD_GOAL), nodeId: 'n_GONE000001' }];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.manifest?.goals).toEqual([{ ...copyOf(GOOD_GOAL), nodeId: 'n_GONE000001' }]);
    expect(r.warnings.map((w) => w.path)).toContain('goals[0].nodeId');
  });

  // goals-progress §2.2: "Weekly and monthly goals only (a project goal
  // carrying one is refused at save and dropped on load)."
  it('drops a project goal that carries a reset day', () => {
    const m = base();
    m.goals = [{ ...copyOf(GOOD_GOAL), resetDay: 3 } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('goals[0]');
    expect(r.manifest?.goals).toEqual([]);
  });

  // An optional field is dropped on its own, not with the goal: a malformed
  // `resetDay` leaves the goal on its window's default day (goals-progress §2.2),
  // exactly as a malformed `deadline` leaves it open-ended. Dropping the whole
  // goal would lose id, target, comparator and stamps over a field with a
  // spec-given default.
  it('keeps a weekly goal with a reset day, and drops a malformed one without dropping the goal', () => {
    const weekly: ProjectGoal = { ...copyOf(GOOD_GOAL), id: 'g_01H2K3M4N5', kind: 'weekly', resetDay: 0 };
    const monthly: ProjectGoal = { ...copyOf(GOOD_GOAL), id: 'g_03H2K3M4N5', kind: 'monthly', resetDay: 'last' };
    const m = base();
    m.goals = [
      copyOf(weekly),
      { ...copyOf(GOOD_GOAL), id: 'g_02H2K3M4N5', kind: 'weekly', resetDay: 9 } as never,
      copyOf(monthly),
      { ...copyOf(GOOD_GOAL), id: 'g_04H2K3M4N5', kind: 'monthly', resetDay: 31 } as never,
    ];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.manifest?.goals).toEqual([
      copyOf(weekly),
      { ...copyOf(GOOD_GOAL), id: 'g_02H2K3M4N5', kind: 'weekly' },
      copyOf(monthly),
      { ...copyOf(GOOD_GOAL), id: 'g_04H2K3M4N5', kind: 'monthly' },
    ]);
    expect(r.manifest?.goals?.[1]).not.toHaveProperty('resetDay');
    expect(r.manifest?.goals?.[3]).not.toHaveProperty('resetDay');
    expect(r.warnings.map((w) => w.path)).toEqual(
      expect.arrayContaining(['goals[1].resetDay', 'goals[3].resetDay']),
    );
  });

  // The bus reads `resetDay: null` as absent (goals-progress §4's table note),
  // so the load does the same rather than treating it as a malformed value.
  it('reads a null reset day as the absent one the bus reads it as', () => {
    const m = base();
    m.goals = [{ ...copyOf(GOOD_GOAL), kind: 'weekly', resetDay: null } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.manifest?.goals).toEqual([{ ...copyOf(GOOD_GOAL), kind: 'weekly' }]);
    expect(r.manifest?.goals?.[0]).not.toHaveProperty('resetDay');
    expect(r.warnings).toEqual([]);
  });

  // goals-progress §9.3: a weekly or monthly goal attaches to the manuscript
  // root, counts words, is `at-least` and takes no deadline. The bus refuses one
  // that breaks any of the four on every save and every undo, so a loaded one
  // would be a goal the author can never edit again — it is dropped instead.
  it('drops a session goal that breaks a §9.3 invariant the bus enforces on every save', () => {
    const m = base();
    m.goals = [
      { ...copyOf(GOOD_GOAL), id: 'g_01H2K3M4N5', kind: 'weekly', nodeId: 'n_GONE000001', resetDay: 1 } as never,
      { ...copyOf(GOOD_GOAL), id: 'g_02H2K3M4N5', kind: 'weekly', metric: 'chars', resetDay: 1 } as never,
      { ...copyOf(GOOD_GOAL), id: 'g_03H2K3M4N5', kind: 'monthly', comparator: 'at-most', resetDay: 1 } as never,
    ];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(['goals[0]', 'goals[1]', 'goals[2]']);
    expect(r.manifest?.goals).toEqual([]);
  });

  // The deadline is the one invariant an optional field can repair: a session
  // goal takes no deadline, and "no deadline" is the field's documented meaning
  // when absent — so the field goes and the goal stays.
  it('drops the deadline a session goal cannot carry, and keeps the goal', () => {
    const m = base();
    m.goals = [{ ...copyOf(GOOD_GOAL), kind: 'weekly', resetDay: 1, deadline: '2027-01-01' } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('goals[0].deadline');
    expect(r.manifest?.goals).toEqual([{ ...copyOf(GOOD_GOAL), kind: 'weekly', resetDay: 1 }]);
  });

  // manifest.ts: "Absent (an older manifest) means words."
  it('gives an absent metric the meaning the spec gives it — words', () => {
    const m = base();
    const { metric: _metric, ...withoutMetric } = copyOf(GOOD_GOAL);
    m.goals = [withoutMetric as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.manifest?.goals).toEqual([copyOf(GOOD_GOAL)]);
  });

  it('drops a deadline that is not a day, and keeps the goal it was on', () => {
    const m = base();
    m.goals = [{ ...copyOf(GOOD_GOAL), deadline: '2026-02-30' } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('goals[0].deadline');
    expect(r.manifest?.goals).toEqual([copyOf(GOOD_GOAL)]);
  });

  // The bus reads `deadline: null` as absent (goals-progress §4), the same way
  // it reads a null reset day, so the load does the same and says nothing: the
  // file said the goal has no deadline, and there is nothing to warn about.
  it('reads a null deadline as the absent one the bus reads it as', () => {
    const m = base();
    m.goals = [{ ...copyOf(GOOD_GOAL), deadline: null } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.manifest?.goals).toEqual([copyOf(GOOD_GOAL)]);
    expect(r.manifest?.goals?.[0]).not.toHaveProperty('deadline');
  });

  // A session goal takes no deadline, and `null` is the way a file says it has
  // none — so the session goal's own warning is not for it either.
  it('reads a null deadline on a session goal as the absent one too', () => {
    const m = base();
    m.goals = [{ ...copyOf(GOOD_GOAL), kind: 'weekly', resetDay: 1, deadline: null } as never];

    const r = validateManifest(m, { docFiles: [] });

    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.manifest?.goals).toEqual([{ ...copyOf(GOOD_GOAL), kind: 'weekly', resetDay: 1 }]);
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
