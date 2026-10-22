/**
 * §8 acceptance test — [project-format.md §8](docs/architecture/project-format.md).
 *
 * The spec states the hard acceptance test in one sentence:
 *
 *   "open artifact → mutate → export → diff against in-memory project state =
 *   empty; round-trip twice with a reorg in between = identical docs content."
 *
 * That is the whole reason the project folder is a folder of Markdown rather
 * than a database export: the files have to survive being the truth. This file
 * implements that sentence literally, in the order the spec states it.
 */

import { describe, expect, it } from 'vitest';
import {
  MemoryArtifactFs,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  moveNode,
  nodeById,
  readProject,
  setBody,
  writeProject,
  WORD_RULE_VERSION,
  type ProjectState,
} from '../src/index.js';

const OPENED = new Date('2026-09-28T01:00:00.000Z');
const EDITED = new Date('2026-09-28T01:30:00.000Z');
const REORGED = new Date('2026-09-28T01:45:00.000Z');

/**
 * Deterministic projection of everything the artifact is supposed to carry.
 *
 * `revision` is deliberately excluded: §4 makes it in-memory concurrency state
 * for the agent tools, and it is not in `caotang.json`, so it must not be part of
 * the round-trip diff. There is a separate assertion below that a reload
 * starts revisions at zero.
 */
function diffable(state: ProjectState): unknown {
  return {
    project: state.manifest.project,
    vocabulary: state.manifest.vocabulary,
    tree: state.manifest.tree,
    derived: state.manifest.derived,
    codex: state.manifest.codex,
    filters: state.manifest.filters,
    goals: state.manifest.goals,
    documents: [...state.documents.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({ id: r.id, body: r.body })),
  };
}

const bodies = (state: ProjectState): Record<string, string> =>
  Object.fromEntries(
    [...state.documents.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => [r.id, r.body]),
  );

const treeShape = (state: ProjectState): { id: string; parentId: string | null; order: number }[] =>
  state.manifest.tree.map((n) => ({ id: n.id, parentId: n.parentId, order: n.order }));

/** A project with real shape: two chapters, three scenes, vocabulary, codex. */
function buildProject(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  state.manifest.vocabulary.labels = [{ id: 'act-1', name: 'Act 1', color: '#d9a44a' }];

  const chapterOne = addFolder(state, {
    parentId: 'manuscript',
    title: 'Chapter 1',
    now: OPENED,
    id: 'n_CHAPTRS01A',
  });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 2', now: OPENED, id: 'n_CHAPTRS02B' });

  addDocument(state, {
    parentId: chapterOne.id,
    title: 'The Landing',
    body: 'The ferry was late, as always.\n\nElena counted the seconds between the horn and the swell.\n\n***\n\nLater, the light.',
    status: 'draft',
    label: 'act-1',
    keywords: ['sea', 'grief'],
    synopsis: 'Elena returns to the island after nine years.',
    notes: 'Fix pacing in the last three paragraphs.',
    now: OPENED,
    id: 'n_3W8RN2TQ6C',
  });
  addDocument(state, {
    parentId: chapterOne.id,
    title: 'The Keeper',
    body: '\nA body that opens with a blank line, on purpose.\n\nAnd a “curly” quote — em-dash — naïve façade.',
    status: 'revised',
    now: OPENED,
    id: 'n_7K2QX9M4A1',
  });
  addDocument(state, {
    parentId: 'n_CHAPTRS02B',
    title: 'The Light',
    body: 'A body with no trailing newline, exactly as the editor left it',
    now: OPENED,
    id: 'n_5H8QK2M9RT',
  });

  state.manifest.codex = [
    {
      id: 'c_5H8QK2M9RT',
      name: 'Elena Voss',
      aliases: ['Lena'],
      type: 'character',
      description: "The lighthouse keeper's daughter; returns after nine years abroad.",
      includePolicy: 'detected',
      caseSensitive: false,
      exclude: [],
      attachments: ['n_3W8RN2TQ6C'],
      keywords: ['protagonist'],
      origin: 'manual',
      sources: [],
      createdAt: OPENED.toISOString(),
      updatedAt: OPENED.toISOString(),
    },
  ];
  state.manifest.derived = {
    wordCounts: { n_3W8RN2TQ6C: 2143, n_7K2QX9M4A1: 512, n_5H8QK2M9RT: 88 },
    computedAt: OPENED.toISOString(),
    // Counted with the current words rule, so the open does not recompute these invented numbers.
    ruleVersion: WORD_RULE_VERSION,
  };
  return state;
}

describe('§8 acceptance — lossless round-trip', () => {
  it('open → mutate → export → diff against in-memory state is empty', async () => {
    const fs = new MemoryArtifactFs();
    const state = buildProject();

    // 1. Export the opened project, read it back, mutate, export again.
    await writeProject(fs, state, { now: OPENED });
    const opened = (await readProject(fs)).state;
    expect(diffable(opened)).toEqual(diffable(state));

    setBody(opened, 'n_3W8RN2TQ6C', 'The ferry was on time, for once.\n\nElena did not know what to do with that.');
    const node = nodeById(opened, 'n_3W8RN2TQ6C');
    if (!node) throw new Error('fixture lost its scene node');
    node.status = 'final';
    node.synopsis = 'Elena returns, and the sea is wrong.';
    addDocument(opened, {
      parentId: 'n_CHAPTRS02B',
      title: 'The Inventory',
      body: 'She counted lamps the way other people counted days.',
      now: EDITED,
      id: 'n_NEWSCNE001',
    });

    // 2. Export the mutated project and re-read it.
    await writeProject(fs, opened, { now: EDITED });
    const exported = (await readProject(fs)).state;

    // 3. The diff: the artifact is the state, not a lossy shadow of it.
    expect(diffable(exported)).toEqual(diffable(opened));
  });

  it('round-trips twice with a reorg in between, and docs content is identical', async () => {
    const fs = new MemoryArtifactFs();
    const state = buildProject();

    await writeProject(fs, state, { now: OPENED });
    const first = (await readProject(fs)).state;
    expect(bodies(first)).toEqual(bodies(state));
    // Captured *before* the reorg: `first` is mutated in place below, so
    // comparing it to `second` afterwards would compare the reorg to itself.
    const shapeBeforeReorg = treeShape(first);

    // The reorg: a chapter is renamed, a scene is dragged to another chapter,
    // and a sibling order is rewritten. No content is touched — that is the
    // point of opaque ids (§1).
    const chapterTwo = nodeById(first, 'n_CHAPTRS02B');
    if (!chapterTwo) throw new Error('fixture lost chapter 2');
    chapterTwo.title = 'Chapter Two: The Light';
    moveNode(first, 'n_3W8RN2TQ6C', { parentId: 'n_CHAPTRS02B', order: 25 });
    const keeper = nodeById(first, 'n_7K2QX9M4A1');
    if (keeper) keeper.order = 5;

    await writeProject(fs, first, { now: REORGED });
    const second = (await readProject(fs)).state;

    // Second round-trip, unchanged in between.
    await writeProject(fs, second, { now: REORGED });
    const third = (await readProject(fs)).state;

    // Docs content: byte-identical across the reorg, and the reorg is visible
    // in the structure. If the tree had *not* changed, this test would pass
    // vacuously — which is why both halves are asserted.
    expect(bodies(second)).toEqual(bodies(first));
    expect(bodies(third)).toEqual(bodies(first));
    expect(treeShape(second)).not.toEqual(shapeBeforeReorg);
    expect(nodeById(second, 'n_CHAPTRS02B')?.parentId).toBe('manuscript');
    expect(nodeById(second, 'n_3W8RN2TQ6C')?.parentId).toBe('n_CHAPTRS02B');
    expect(nodeById(second, 'n_CHAPTRS02B')?.title).toBe('Chapter Two: The Light');
    expect(diffable(third)).toEqual(diffable(second));
  });

  it('reloads with revisions at zero — concurrency state is not artifact content', async () => {
    const fs = new MemoryArtifactFs();
    const state = buildProject();
    setBody(state, 'n_3W8RN2TQ6C', 'edited once');
    setBody(state, 'n_3W8RN2TQ6C', 'edited twice');
    expect(state.documents.get('n_3W8RN2TQ6C')?.revision).toBe(2);

    await writeProject(fs, state, { now: OPENED });
    const reloaded = (await readProject(fs)).state;
    expect(reloaded.documents.get('n_3W8RN2TQ6C')?.revision).toBe(0);
  });

  it('is byte-stable: writing an unchanged project twice produces the same bytes', async () => {
    const fs = new MemoryArtifactFs();
    const state = buildProject();

    await writeProject(fs, state, { now: OPENED });
    const first = fs.snapshot();
    await writeProject(fs, state, { now: OPENED });
    const second = fs.snapshot();

    for (const path of Object.keys(first)) {
      expect(second[path], `drifted: ${path}`).toBe(first[path]);
    }
  });
});
