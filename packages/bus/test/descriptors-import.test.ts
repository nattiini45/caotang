/**
 * `binder.importTree`'s descriptor (import-preview.md §5, issue #267): the shared import preview's commit, validated whole before
 * anything is written.
 *
 * What is pinned: the gate's class (never for an agent, compensable, async); the tree in reading order with parents by index,
 * folders in folders allowed and a document straight under the manuscript refused; research placement for front matter; the
 * vocabulary terms the import adds; the picture refs; the codex rows checked by `codex.importBatch`'s own validator against the
 * new documents, with `node` handed back; and one refusal that lists every failing node.
 */

import { describe, expect, it } from 'vitest';

import { COMMAND_REGISTRY, type PerOpFailure } from '../src/index.js';
import { IMPORT_TREE_NODES_MAX, binderImportTree } from '../src/descriptors-import.js';
import { CHAPTER_ONE, MANUSCRIPT, makeSnapshot } from './fixtures.js';

const SCENE = 'The ferry came at noon. Mara watched it.';
const BOOK = [
  { type: 'folder', title: 'Part One' },
  { type: 'folder', title: 'Chapter 1: The Landing', parent: 0 },
  { type: 'document', title: 'Chapter 1 · 1', parent: 1, body: SCENE },
  { type: 'document', title: 'Before chapter 1', place: 'research', body: 'For my mother.' },
];

function failuresOf(result: ReturnType<typeof binderImportTree.validate>): PerOpFailure[] {
  expect(result.ok).toBe(false);
  if (result.ok) return [];
  return (result.error.details?.['failures'] as PerOpFailure[] | undefined) ?? [];
}

describe('binder.importTree — the descriptor', () => {
  it('is the writer’s alone, compensable, async and registered by the bus', () => {
    expect(COMMAND_REGISTRY['binder.importTree'].descriptor).toBe(binderImportTree);
    expect(binderImportTree.agentRisk).toBe('never');
    expect(binderImportTree.undo).toBe('compensable');
    expect(binderImportTree.asyncApply).toBe(true);
  });

  it('accepts a Part → Chapter → Scene tree under the manuscript, with front matter in research', () => {
    const result = binderImportTree.validate({ nodes: BOOK }, makeSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parentId).toBe(MANUSCRIPT);
    expect(result.value.nodes.map((node) => node.parent ?? node.place ?? null)).toEqual([null, 0, 1, 'research']);
  });

  it('imports under a chapter of this project, where a document may sit at the top', () => {
    const result = binderImportTree.validate({ parentId: CHAPTER_ONE, nodes: [{ type: 'document', title: 'Loose scene', body: 'x' }] }, makeSnapshot());
    expect(result.ok).toBe(true);
  });

  it('refuses a document straight under the manuscript, a parent that is not an earlier folder, and a body on a folder, in one refusal', () => {
    const failures = failuresOf(
      binderImportTree.validate(
        {
          nodes: [
            { type: 'document', title: 'Loose', body: 'x' },
            { type: 'folder', title: 'Chapter', body: 'not here' },
            { type: 'document', title: 'Orphan', parent: 5 },
            { type: 'document', title: 'Child of a scene', parent: 0 },
            { type: 'document', title: '   ' },
          ],
        },
        makeSnapshot(),
      ),
    );
    expect(failures.map((failure) => failure.target)).toEqual(['nodes[0]', 'nodes[1].body', 'nodes[2].parent', 'nodes[3].parent', 'nodes[4].title', 'nodes[4]']);
    expect(failures[0]?.message).toContain('A document goes inside a chapter');
  });

  it('takes a status the import adds by name, and refuses one that is neither held nor added', () => {
    const ok = binderImportTree.validate(
      { nodes: [{ type: 'folder', title: 'C' }, { type: 'document', title: 'S', parent: 0, status: 'Beta read', label: 'act-1' }], vocabulary: { statuses: ['Beta read'] } },
      makeSnapshot(),
    );
    expect(ok.ok).toBe(true);
    const failures = failuresOf(binderImportTree.validate({ nodes: [{ type: 'folder', title: 'C' }, { type: 'document', title: 'S', parent: 0, status: 'Beta read' }] }, makeSnapshot()));
    expect(failures[0]?.target).toBe('nodes[1].status');
  });

  it('refuses a term to add that the project already holds by name', () => {
    const snapshot = makeSnapshot();
    const named = { ...snapshot, manifest: { ...snapshot.manifest, vocabulary: { ...snapshot.manifest.vocabulary, statuses: [{ id: 'draft', name: 'Draft' }] } } };
    const result = binderImportTree.validate({ nodes: [{ type: 'folder', title: 'C' }], vocabulary: { statuses: ['draft'] } }, named);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('already the term "draft"');
  });

  it('checks the codex rows against the new documents with codex.importBatch’s own rules, and hands back the node index', () => {
    const from = SCENE.indexOf('Mara');
    const result = binderImportTree.validate({ nodes: BOOK, codex: { entries: [{ name: 'Mara', type: 'character', node: 2, cite: { from, to: from + 4, quote: 'Mara' } }] } }, makeSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.codex?.entries[0]).toMatchObject({ name: 'Mara', node: 2 });
    expect(result.value.codex?.entries[0]).not.toHaveProperty('attachTo');

    // A collision with the codex is refused, never merged; a quote that is not the text at its offsets is refused.
    const collision = binderImportTree.validate({ nodes: BOOK, codex: { entries: [{ name: 'elena', node: 2, cite: { from, to: from + 4, quote: 'Mara' } }] } }, makeSnapshot());
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.error.message).toMatch(/^codex: /);
    const misquoted = binderImportTree.validate({ nodes: BOOK, codex: { entries: [{ name: 'Mara', node: 2, cite: { from: 0, to: 4, quote: 'Mara' } }] } }, makeSnapshot());
    expect(misquoted.ok).toBe(false);
    // `node` must name an imported document.
    expect(failuresOf(binderImportTree.validate({ nodes: BOOK, codex: { entries: [{ name: 'Mara', node: 1, cite: { from, to: from + 4, quote: 'Mara' } }] } }, makeSnapshot()))[0]?.target).toBe('codex.entries[0].node');
  });

  it('takes pictures with unique import: refs and staging ids, and refuses a path as a ref', () => {
    const nodes = [{ type: 'folder', title: 'C' }, { type: 'document', title: 'S', parent: 0, body: '![Map](import:media/image1.png)' }];
    expect(binderImportTree.validate({ nodes, pictures: [{ ref: 'import:media/image1.png', stagingId: 'stg_1', alt: 'Map' }] }, makeSnapshot()).ok).toBe(true);
    const failures = failuresOf(
      binderImportTree.validate(
        { nodes, pictures: [{ ref: '../assets/x.png', stagingId: 'stg_1' }, { ref: 'import:a.png', stagingId: 'stg_2' }, { ref: 'import:a.png', stagingId: 'stg_3' }, { ref: 'import:b.png', stagingId: 'stg_2' }] },
        makeSnapshot(),
      ),
    );
    expect(failures.map((failure) => failure.target)).toEqual(['pictures[0].ref', 'pictures[2].ref', 'pictures[3].stagingId']);
  });

  it('refuses an empty tree, a tree over the cap, and a media folder as the destination', () => {
    expect(binderImportTree.validate({ nodes: [] }, makeSnapshot()).ok).toBe(false);
    const many = Array.from({ length: IMPORT_TREE_NODES_MAX + 1 }, (_, i) => ({ type: 'folder', title: `F${i}` }));
    const over = binderImportTree.validate({ nodes: many }, makeSnapshot());
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe('limit-exceeded');
    const board = makeSnapshot({ extraNodes: [{ id: 'n_BOARD00000', parentId: CHAPTER_ONE, type: 'folder', kind: 'storyboard', title: 'Board' }] });
    expect(binderImportTree.validate({ parentId: 'n_BOARD00000', nodes: [{ type: 'folder', title: 'C' }] }, board).ok).toBe(false);
  });

  it('refuses a key a node does not carry', () => {
    const failures = failuresOf(binderImportTree.validate({ nodes: [{ type: 'folder', title: 'C', origin: 'import' }] }, makeSnapshot()));
    expect(failures[0]?.target).toBe('nodes[0].origin');
  });
});
