import { expect, test } from '@playwright/test';

import {
  defaultExpanded,
  dropRefusalText,
  enclosingFolders,
  newDocumentRefusalText,
  newFolderParent,
  newItemParent,
  planDrop,
  resolveZone,
  subtreeIds,
  summarizeSubtree,
  synopsisPreview,
  visibleRows,
  SYNOPSIS_PREVIEW_CHARS,
} from '../../apps/desktop/src/app/binder-model.js';

import { IDS, project } from './fixtures.js';

/** The titles of the visible rows, in order, with their depth — the shape a test reads. */
function rowsOf(expanded: Record<string, boolean> = {}) {
  return visibleRows(project(), expanded).map((row) => `${row.depth}:${row.node.title}`);
}

test.describe('what the binder shows', () => {
  test('sections are always shown; a folder opens one level by default and a deeper one stays closed', () => {
    expect(rowsOf()).toEqual([
      '-1:Manuscript',
      '0:Chapter 1',
      '1:Scene A',
      '1:Scene B',
      '1:Scene C',
      '1:Deep',
      '0:Chapter 2',
      '1:Scene D',
      '-1:Research',
      '0:Note',
    ]);
  });

  test('an explicit override wins over the default, in either direction', () => {
    expect(defaultExpanded(0)).toBe(true);
    expect(defaultExpanded(1)).toBe(false);
    const collapsed = rowsOf({ [IDS.chapterOne]: false });
    expect(collapsed).not.toContain('1:Scene A');
    const opened = rowsOf({ [IDS.deep]: true });
    expect(opened).toContain('2:Deep scene');
  });

  test('a row reports whether it can hold children and whether it has any', () => {
    const rows = visibleRows(project(), {});
    const chapter = rows.find((row) => row.kind === 'node' && row.node.id === IDS.chapterOne);
    const scene = rows.find((row) => row.kind === 'node' && row.node.id === IDS.sceneC);
    expect(chapter).toMatchObject({ container: true, expanded: true, hasChildren: true });
    expect(scene).toMatchObject({ container: false, hasChildren: false });
  });

  test('the subtree summary counts what a delete will remove, and the words of its documents', () => {
    const summary = summarizeSubtree(project(), IDS.chapterOne);
    expect(summary).toEqual({ title: 'Chapter 1', descendants: 5, documents: 4, words: 9 });
    expect(summarizeSubtree(project(), 'n_MISSING000')).toBeUndefined();
  });

  test('subtreeIds reaches every descendant, however deep', () => {
    const ids = subtreeIds(project(), IDS.chapterOne);
    expect([...ids].sort()).toEqual(
      [IDS.chapterOne, IDS.sceneA, IDS.sceneB, IDS.sceneC, IDS.deep, IDS.deepScene].sort(),
    );
  });
});

test.describe('the folders a node sits in', () => {
  test('nearest first, up to the section, which is never listed', () => {
    const titles = (id: string): string[] => enclosingFolders(project(), id).map((node) => node.title);
    expect(titles(IDS.deepScene)).toEqual(['Deep', 'Chapter 1']);
    expect(titles(IDS.sceneA)).toEqual(['Chapter 1']);
    expect(titles(IDS.chapterOne)).toEqual([]);
    expect(titles(IDS.note)).toEqual([]);
    expect(titles('n_MISSING000')).toEqual([]);
  });
});

test.describe('where a new item goes', () => {
  test('nothing selected goes into the manuscript; a folder takes it inside; a document leaves it beside', () => {
    const state = project();
    expect(newItemParent(state, null)).toBe('manuscript');
    expect(newItemParent(state, IDS.chapterOne)).toBe(IDS.chapterOne);
    expect(newItemParent(state, IDS.sceneA)).toBe(IDS.chapterOne);
    expect(newItemParent(state, 'research')).toBe('research');
    expect(newItemParent(state, 'n_GONE000000')).toBe('manuscript');
  });
});

test.describe('where a new folder goes', () => {
  test('always a section: the one selected, or the section a selection sits in, never a folder', () => {
    const state = project();
    expect(newFolderParent(state, null)).toBe('manuscript');
    expect(newFolderParent(state, 'manuscript')).toBe('manuscript');
    expect(newFolderParent(state, 'research')).toBe('research');
    // A folder under a section, a scene inside it, and a folder inside a folder (the fixture's Deep) all resolve up.
    expect(newFolderParent(state, IDS.chapterOne)).toBe('manuscript');
    expect(newFolderParent(state, IDS.sceneA)).toBe('manuscript');
    expect(newFolderParent(state, IDS.deep)).toBe('manuscript');
    expect(newFolderParent(state, IDS.deepScene)).toBe('manuscript');
    expect(newFolderParent(state, IDS.note)).toBe('research');
    expect(newFolderParent(state, 'n_GONE000000')).toBe('manuscript');
  });
});

test.describe('the pre-dispatch drop check', () => {
  test('dropping after a sibling lands at the index that leaves the moved node after it', () => {
    // Children of Chapter 1 are A, B, C, Deep. Moving A after B: the siblings without A are
    // [B, C, Deep], B is at 0, "after" is 1 — so `binder.move` gets index 1, and the order is B, A, C, Deep.
    const plan = planDrop(project(), IDS.sceneA, { nodeId: IDS.sceneB, zone: 'after' });
    expect(plan).toEqual({ ok: true, newParentId: IDS.chapterOne, index: 1 });
  });

  test('dropping before a sibling lands at its position among the others', () => {
    // Moving C before A: the others are [A, B, Deep]; A is at 0.
    const plan = planDrop(project(), IDS.sceneC, { nodeId: IDS.sceneA, zone: 'before' });
    expect(plan).toEqual({ ok: true, newParentId: IDS.chapterOne, index: 0 });
  });

  test('dropping into a folder appends to it, not counting the node being moved', () => {
    // Chapter 2 holds D; moving A into it appends: index 1.
    const plan = planDrop(project(), IDS.sceneA, { nodeId: IDS.chapterTwo, zone: 'into' });
    expect(plan).toEqual({ ok: true, newParentId: IDS.chapterTwo, index: 1 });
  });

  test('a drop that leaves the node exactly where it is is refused, and is not an error', () => {
    expect(planDrop(project(), IDS.sceneA, { nodeId: IDS.sceneB, zone: 'before' })).toEqual({
      ok: false,
      reason: 'same-place',
    });
    expect(planDrop(project(), IDS.sceneA, { nodeId: IDS.sceneA, zone: 'before' })).toEqual({
      ok: false,
      reason: 'same-place',
    });
  });

  test('a folder cannot be dropped into itself or into anything under it', () => {
    expect(planDrop(project(), IDS.chapterOne, { nodeId: IDS.chapterOne, zone: 'into' })).toEqual({
      ok: false,
      reason: 'cycle',
    });
    expect(planDrop(project(), IDS.chapterOne, { nodeId: IDS.deep, zone: 'into' })).toEqual({
      ok: false,
      reason: 'cycle',
    });
    expect(planDrop(project(), IDS.chapterOne, { nodeId: IDS.deepScene, zone: 'after' })).toEqual({
      ok: false,
      reason: 'cycle',
    });
  });

  test('a document is never a parent', () => {
    expect(planDrop(project(), IDS.sceneA, { nodeId: IDS.sceneB, zone: 'into' })).toEqual({
      ok: false,
      reason: 'not-a-container',
    });
  });

  test('a scene never lands directly under the manuscript, and a folder never lands inside a folder', () => {
    // A scene beside Chapter 2, or into the manuscript, would have no chapter (ui-modules §2.4).
    expect(planDrop(project(), IDS.sceneA, { nodeId: IDS.chapterTwo, zone: 'before' })).toEqual({ ok: false, reason: 'chapterless' });
    expect(planDrop(project(), IDS.sceneA, { nodeId: 'manuscript', zone: 'into' })).toEqual({ ok: false, reason: 'chapterless' });
    // New document with nothing selected asks for the manuscript as its parent (newItemParent). The button refuses that
    // parent in the same words the drop gives, and a chapter or a research parent is not refused.
    expect(newItemParent(project(), null)).toBe('manuscript');
    expect(newDocumentRefusalText('manuscript')).toBe(
      'A document goes inside a chapter, not directly under the manuscript. Select a chapter first, or make one with New folder.',
    );
    expect(newDocumentRefusalText(IDS.chapterOne)).toBeUndefined();
    expect(newDocumentRefusalText('research')).toBeUndefined();
    // The Deep folder beside a scene in Chapter 1, or into Chapter 2, would be a folder inside a folder.
    expect(planDrop(project(), IDS.deep, { nodeId: IDS.sceneB, zone: 'before' })).toEqual({ ok: false, reason: 'folder-in-folder' });
    expect(planDrop(project(), IDS.deep, { nodeId: IDS.chapterTwo, zone: 'into' })).toEqual({ ok: false, reason: 'folder-in-folder' });
    // A chapter beside another chapter is a chapter, and still allowed.
    expect(planDrop(project(), IDS.chapterTwo, { nodeId: IDS.chapterOne, zone: 'before' }).ok).toBe(true);
    // Research takes its documents directly, so a scene may sit beside its note.
    expect(planDrop(project(), IDS.sceneA, { nodeId: IDS.note, zone: 'before' }).ok).toBe(true);
  });

  test('a section cannot be moved, and nothing is placed beside one', () => {
    expect(planDrop(project(), 'manuscript', { nodeId: IDS.chapterTwo, zone: 'into' })).toEqual({
      ok: false,
      reason: 'fixed-root',
    });
    expect(planDrop(project(), IDS.sceneA, { nodeId: 'research', zone: 'before' })).toEqual({
      ok: false,
      reason: 'section-edge',
    });
    // Research already holds the note, so a drop into it appends after that one.
    expect(planDrop(project(), IDS.sceneA, { nodeId: 'research', zone: 'into' })).toEqual({
      ok: true,
      newParentId: 'research',
      index: 1,
    });
  });

  test('a drop with no target, or onto a node that is gone, names the missing target', () => {
    expect(planDrop(project(), IDS.sceneA, null)).toEqual({ ok: false, reason: 'no-target' });
    expect(planDrop(project(), IDS.sceneA, { nodeId: 'n_GONE000000', zone: 'into' })).toEqual({
      ok: false,
      reason: 'no-target',
    });
  });

  test('the refusals each have words for the status line', () => {
    expect(dropRefusalText('cycle')).toBe('An item cannot be moved into itself.');
    expect(dropRefusalText('not-a-container')).toBe('A document cannot hold other items.');
    expect(dropRefusalText('section-edge')).toBe('Drop it inside a section, not beside it.');
  });
});

test.describe('zones and previews', () => {
  test('the outer quarters are before and after; the middle is into for a folder and after for a document', () => {
    const state = project();
    const chapter = state.manifest.tree.find((node) => node.id === IDS.chapterOne)!;
    const scene = state.manifest.tree.find((node) => node.id === IDS.sceneA)!;
    expect(resolveZone(chapter, 0.1)).toBe('before');
    expect(resolveZone(chapter, 0.5)).toBe('into');
    expect(resolveZone(chapter, 0.9)).toBe('after');
    expect(resolveZone(scene, 0.5)).toBe('after');
    const section = state.manifest.tree.find((node) => node.id === 'manuscript')!;
    expect(resolveZone(section, 0.1)).toBe('into');
  });

  test('a synopsis preview is the first 120 characters, trimmed; blank text has none', () => {
    expect(synopsisPreview('   ')).toBeUndefined();
    expect(synopsisPreview('  Elena returns.  ')).toBe('Elena returns.');
    const long = 'x'.repeat(SYNOPSIS_PREVIEW_CHARS + 30);
    expect(synopsisPreview(long)).toBe(`${'x'.repeat(SYNOPSIS_PREVIEW_CHARS)}…`);
  });
});
