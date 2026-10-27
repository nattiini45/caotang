/**
 * Stages 1–2, select and flatten — exporter.md §2.
 *
 * Every assertion here is on the block list or the notes, because those are what
 * `preview` shows the user before anything is written (§4), and what the
 * compile log records afterwards. A flatten that drops a skip note would still
 * produce a sensible-looking artifact, so the notes are asserted in their own tests.
 */

import { describe, expect, it } from 'vitest';
import { flatten } from '../src/flatten.js';
import type { FlatBlock } from '../src/types.js';
import { BODIES, IDS, makeProject, OPENED } from './fixture.js';
import { addDocument, countBody } from '@caotang/store';

const TITLE_PAGE: FlatBlock = { kind: 'frontmatter', fmKind: 'titlepage' };

function kinds(blocks: readonly FlatBlock[]): string[] {
  return blocks.map((block) => {
    switch (block.kind) {
      case 'frontmatter':
        return `frontmatter:${block.fmKind}`;
      case 'chapter':
        return `chapter:${block.number}:${block.title}`;
      case 'scene':
        return `scene:${block.number}:${block.title}`;
      case 'separator':
        return 'separator';
      case 'backmatter':
        return `backmatter:${block.bmKind}`;
    }
  });
}

describe('flatten — the whole manuscript', () => {
  it('walks the tree depth-first in order, leading with the title page', () => {
    const state = makeProject();
    const result = flatten(state, { includeRootIds: ['manuscript'] }, { titlePage: true });

    expect(kinds(result.blocks)).toEqual([
      'frontmatter:titlepage',
      'scene:1:Prologue', // `order` 5, so first even though it was created last
      'chapter:1:Chapter One',
      'scene:1:The Landing',
      'separator', // between two scenes of one chapter
      'scene:2:The Storm',
      'chapter:2:Chapter Two',
      'scene:1:Morning', // The Call is empty, so Morning is Chapter Two's first scene
    ]);
    expect(result.blocks[0]).toEqual(TITLE_PAGE);
  });

  it('skips empty documents, says so in the notes, and gives no heading to a chapter left empty', () => {
    const result = flatten(makeProject(), { includeRootIds: ['manuscript'] }, { titlePage: true });

    expect(result.skippedDocs).toEqual(['Chapter Two → The Call', 'Chapter Three → Blank']);
    expect(result.notes).toEqual([
      'skipped: Chapter Two → The Call (empty)',
      'skipped: Chapter Three → Blank (empty)',
    ]);
    // Chapter Three had no emitted scene, so its heading is not written.
    expect(result.blocks.some((block) => block.kind === 'chapter' && block.title === 'Chapter Three')).toBe(false);
  });

  it('counts chapters, scenes and the words of the scenes it emitted, and no others', () => {
    const result = flatten(makeProject(), { includeRootIds: ['manuscript'] }, { titlePage: true });

    expect(result.chapterCount).toBe(2);
    expect(result.sceneCount).toBe(4);
    const expectedWords = [BODIES.prologue, BODIES.landing, BODIES.storm, BODIES.morning]
      .reduce((sum, body) => sum + countBody(body).words, 0);
    expect(result.wordCount).toBe(expectedWords);
  });

  it('keeps an in-body thematic break in the scene body, for the renderer to style', () => {
    const result = flatten(makeProject(), { includeRootIds: ['manuscript'] }, { titlePage: true });
    const storm = result.blocks.find((block) => block.kind === 'scene' && block.docId === IDS.storm);
    expect(storm?.kind === 'scene' && storm.body).toBe(BODIES.storm);
  });

  it('leaves the title page out when the options say so', () => {
    const result = flatten(makeProject(), { includeRootIds: ['manuscript'] }, { titlePage: false });
    expect(result.blocks.some((block) => block.kind === 'frontmatter')).toBe(false);
    expect(result.blocks[0]?.kind).toBe('scene');
  });

  it('does not compile research unless it is named', () => {
    const result = flatten(makeProject(), { includeRootIds: ['manuscript'] }, { titlePage: true });
    expect(result.blocks.some((block) => block.kind === 'scene' && block.docId === IDS.timetable)).toBe(false);
  });
});

describe('flatten — a part of the tree', () => {
  it('includes research when it is named, and gives a loose scene no chapter heading', () => {
    const result = flatten(makeProject(), { includeRootIds: ['research'] }, { titlePage: true });
    expect(kinds(result.blocks)).toEqual(['frontmatter:titlepage', 'scene:1:Ferry timetable']);
  });

  it('follows the binder order, not the order the caller listed the roots in', () => {
    const forward = flatten(makeProject(), { includeRootIds: [IDS.chapterOne, IDS.chapterTwo] }, { titlePage: false });
    const reversed = flatten(makeProject(), { includeRootIds: [IDS.chapterTwo, IDS.chapterOne] }, { titlePage: false });
    expect(kinds(reversed.blocks)).toEqual(kinds(forward.blocks));
    expect(kinds(forward.blocks)[0]).toBe('chapter:1:Chapter One');
  });

  it('includes a selected document under an unselected folder, with its folder heading', () => {
    const result = flatten(makeProject(), { includeRootIds: [IDS.morning] }, { titlePage: false });
    expect(kinds(result.blocks)).toEqual(['chapter:1:Chapter Two', 'scene:1:Morning']);
  });

  it('does not repeat a node named twice, nor a node named together with its parent', () => {
    const result = flatten(makeProject(), { includeRootIds: [IDS.chapterOne, IDS.landing] }, { titlePage: false });
    const scenes = result.blocks.filter((block) => block.kind === 'scene').map((block) => block.kind === 'scene' && block.docId);
    expect(scenes).toEqual([IDS.landing, IDS.storm]);
  });

  it('notes a root id the tree does not hold, and contributes nothing for it', () => {
    const result = flatten(makeProject(), { includeRootIds: ['n_NOSUCHNODE'] }, { titlePage: false });
    expect(result.blocks).toEqual([]);
    expect(result.notes).toEqual(['no node "n_NOSUCHNODE" in the tree, so it contributed nothing']);
  });

  it('applies docFilter to documents, and leaves a filtered document out without a note', () => {
    const result = flatten(
      makeProject(),
      { includeRootIds: ['manuscript'], docFilter: (doc) => doc.title !== 'The Storm' },
      { titlePage: false },
    );
    expect(result.blocks.some((block) => block.kind === 'scene' && block.docId === IDS.storm)).toBe(false);
    expect(result.notes.some((note) => note.includes('The Storm'))).toBe(false);
  });
});

describe('flatten — the separator rule', () => {
  it('puts a separator only between two scenes of one chapter, never at a chapter boundary', () => {
    const result = flatten(makeProject(), { includeRootIds: ['manuscript'] }, { titlePage: false });
    const separators = result.blocks.map((block, index) => (block.kind === 'separator' ? index : -1)).filter((i) => i >= 0);
    expect(separators).toHaveLength(1);
    const before = result.blocks[separators[0]! - 1];
    const after = result.blocks[separators[0]! + 1];
    expect(before?.kind === 'scene' && before.title).toBe('The Landing');
    expect(after?.kind === 'scene' && after.title).toBe('The Storm');
  });

  it('separates two scenes filed directly under Manuscript, which share no chapter', () => {
    // A loose scene has `chapter === undefined`, so two of them in a row share the same (absent) chapter. The
    // separator is the only boundary signal between them — the prose renderers emit no per-scene heading — so
    // dropping it would merge the two scenes into one in the compiled book.
    const state = makeProject();
    const epilogue = addDocument(state, { parentId: 'manuscript', title: 'Epilogue', body: BODIES.morning, now: OPENED, id: 'n_EPILOGUE1' });
    const prologue = state.manifest.tree.find((node) => node.id === IDS.prologue);
    // Place the epilogue directly after the prologue in the binder order, so the two loose scenes are adjacent.
    if (prologue !== undefined) epilogue.order = prologue.order + 1;
    const result = flatten(state, { includeRootIds: ['manuscript'] }, { titlePage: false });
    const first = result.blocks.findIndex((block) => block.kind === 'scene' && block.docId === IDS.prologue);
    const second = result.blocks.findIndex((block) => block.kind === 'scene' && block.docId === 'n_EPILOGUE1');
    expect(second).toBe(first + 2);
    expect(result.blocks[first + 1]?.kind).toBe('separator');
  });
});
