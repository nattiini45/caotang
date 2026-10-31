/**
 * The shared import preview's model (apps/desktop/src/import-preview/model.ts, issue #267): the manual edits, the binder rows, the
 * virtual window of the text pane, the header, the scan, and the one `binder.importTree` the preview commits.
 */

import { expect, test } from '@playwright/test';

import { COMMAND_REGISTRY } from '../../packages/bus/src/index.js';
import { pinFormatLocale } from '../../apps/desktop/src/i18n/locale.js';
import {
  NO_EDITS,
  addSplit,
  applyEdits,
  buildCommit,
  collisions,
  defaultCodexAnswer,
  editCount,
  estimateHeight,
  headerLine,
  initialSettings,
  isExcluded,
  mergeWithNext,
  move,
  networkLabel,
  nodeAtBlock,
  offsetsOf,
  removeSplit,
  rename,
  scanTree,
  toggleExcluded,
  unknownValues,
  visibleRange,
  visibleRows,
  type CommitInput,
  type PreviewNode,
  type PreviewPlan,
} from '../../apps/desktop/src/import-preview/model.js';
import { LIGHTHOUSE, lighthouseSource, longSource, planOf } from '../import-preview-fixture.js';

import { project } from './fixtures.js';

test.beforeAll(() => pinFormatLocale('en-US'));
test.afterAll(() => pinFormatLocale(undefined));

const SETTINGS = { chips: { chapters: 'heading-1' }, options: {} };

function plan(): PreviewPlan {
  return planOf(LIGHTHOUSE, SETTINGS, NO_EDITS.overrides);
}

function input(overrides: Partial<CommitInput> = {}): CommitInput {
  return {
    plan: plan(),
    edits: NO_EDITS,
    destination: 'manuscript',
    mapping: {},
    statuses: [{ id: 'draft', name: 'Draft' }],
    labels: [],
    statusAnswers: {},
    labelAnswers: {},
    codexRows: [],
    codexAnswers: {},
    codexHeld: [],
    pictures: [],
    ...overrides,
  };
}

test.describe('the manual edits', () => {
  test('× on a rule split overrides it, × on a manual split takes it back, and each counts as an edit', () => {
    let edits = removeSplit(NO_EDITS, 2);
    expect(edits.overrides.noSplit).toEqual([2]);
    expect(editCount(edits)).toBe(1);
    edits = addSplit(edits, 2, 'scene');
    expect(edits.overrides).toEqual({ noSplit: [], sceneAt: [2], chapterAt: [] });
    edits = removeSplit(edits, 2);
    expect(edits.overrides).toEqual({ noSplit: [], sceneAt: [], chapterAt: [] });
    expect(editCount(edits)).toBe(0);
  });

  test('merging a chapter with the next removes the next one’s split, and the source re-splits without it', () => {
    const edits = mergeWithNext(NO_EDITS, plan().tree, 'chapter-0');
    expect(edits.overrides.noSplit).toEqual([5]);
    const merged = planOf(LIGHTHOUSE, SETTINGS, edits.overrides);
    expect(merged.counts.chapters).toBe(2);
  });

  test('rename, exclude and reorder apply by node id over a fresh split', () => {
    let edits = rename(NO_EDITS, 'chapter-0', '  The Landing ');
    edits = toggleExcluded(edits, 'chapter-10');
    edits = move(edits, plan().tree, 'chapter-5', -1);
    const shown = applyEdits(plan().tree, edits);
    expect(shown.map((node) => node.title)).toEqual(['Chapter 2: Salt', 'The Landing', 'Chapter 3: The Lantern']);
    expect(isExcluded(edits, plan().tree, 'scene-11')).toBe(true);
    expect(rename(NO_EDITS, 'chapter-0', '   ')).toBe(NO_EDITS);
  });

  test('the binder rows carry level, set size and position, and a collapsed folder hides its children', () => {
    const rows = visibleRows(plan().tree, new Set());
    expect(rows).toHaveLength(8);
    expect(rows[1]).toMatchObject({ level: 2, setSize: 2, position: 1 });
    expect(visibleRows(plan().tree, new Set(['chapter-0']))).toHaveLength(6);
    expect(nodeAtBlock(plan().tree, 3)?.id).toBe('scene-2');
    expect(nodeAtBlock(plan().tree, 5)?.id).toBe('chapter-5');
  });
});

test.describe('the text pane at 200,000 words', () => {
  test('renders a window of about a screen, found by binary search, at the top and at the end', () => {
    const source = longSource(200_000);
    const long = source.plan({ chips: { chapters: 'heading-1' }, options: {} }, NO_EDITS.overrides);
    expect(long.counts.words).toBe(200_000);
    const offsets = offsetsOf(long.blocks.map((block) => estimateHeight(block)));
    const top = visibleRange(offsets, 0, 480);
    expect(top.start).toBe(0);
    expect(top.end - top.start).toBeLessThan(40);
    const end = visibleRange(offsets, (offsets[long.blocks.length] ?? 0) - 480, 480);
    expect(end.end).toBe(long.blocks.length);
    expect(end.end - end.start).toBeLessThan(40);
  });
});

test.describe('the header, the options and the report', () => {
  test('the header leaves out what is not there', () => {
    expect(headerLine(plan().counts, 0)).toBe('39 words · 3 chapters · 5 scenes · 1 image');
    expect(headerLine({ words: 84212, parts: 2, chapters: 24, scenes: 71, images: 0, comments: 12, footnotes: 9 }, 4)).toBe(
      '84,212 words · 2 parts · 24 chapters · 71 scenes · 12 comments · 9 footnotes · 4 codex rows',
    );
  });

  test('a network option starts off whatever the source says, and names the host, count and size (decision 10)', () => {
    const options = lighthouseSource().options();
    expect(initialSettings([], options).options).toEqual({ images: true, download: false });
    expect(networkLabel(options[1]!)).toBe('Download linked images (downloads 2 files, about 2.1 MB, from images.example.com)');
  });

  test('the scan lists each passage with the node it is in', () => {
    const scan = scanTree(plan().tree);
    expect(scan.total).toBe(1);
    expect(scan.rows[0]).toMatchObject({ nodeId: 'scene-6', where: 'Chapter 2: Salt · 1', kind: 'override-phrase' });
    expect(scan.sentence('book.docx')).toContain('book.docx: 1 passage that looks like instructions to an AI');
  });
});

test.describe('mapping', () => {
  test('a status the project does not hold, by id or by name, is listed once', () => {
    expect(unknownValues(['draft', 'Draft', 'Beta read', 'beta read', ' '], [{ id: 'draft', name: 'Draft' }])).toEqual(['Beta read', 'beta read']);
  });

  test('a codex row that collides with the codex or an earlier row starts as Skip', () => {
    const rows = lighthouseSource().codexRows?.() ?? [];
    const colliding = collisions(rows, ['The Lantern']);
    expect([...colliding].sort()).toEqual(['lantern', 'mara-2']);
    expect(defaultCodexAnswer('mara', colliding)).toEqual({ action: 'import' });
    expect(defaultCodexAnswer('mara-2', colliding)).toEqual({ action: 'skip' });
  });
});

test.describe('the commit', () => {
  test('one binder.importTree the bus accepts: folders with their scenes, in reading order', () => {
    const commit = buildCommit(input());
    expect(commit.documents).toBe(5);
    expect(commit.folders).toBe(3);
    expect(commit.unkept).toEqual([]);
    expect(commit.params.nodes.map((node) => [node.type, node.title, node.parent ?? null])).toEqual([
      ['folder', 'Chapter 1: The Landing', null],
      ['document', 'Chapter 1: The Landing · 1', 0],
      ['document', 'Chapter 1: The Landing · 2', 0],
      ['folder', 'Chapter 2: Salt', null],
      ['document', 'Chapter 2: Salt · 1', 3],
      ['document', 'Chapter 2: Salt · 2', 3],
      ['folder', 'Chapter 3: The Lantern', null],
      ['document', 'Chapter 3: The Lantern · 1', 6],
    ]);
    const checked = COMMAND_REGISTRY['binder.importTree'].descriptor.validate(commit.params, project() as never);
    expect(checked.ok).toBe(true);
  });

  test('an excluded chapter leaves its scenes and its pictures out, and says so', () => {
    const source = lighthouseSource();
    const pictures = source.pictures?.() ?? [];
    const kept = buildCommit(input({ pictures }));
    expect(kept.pictures.map((picture) => picture.ref)).toEqual(['import:media/image1.png']);
    const without = buildCommit(input({ pictures, edits: toggleExcluded(NO_EDITS, 'chapter-0') }));
    expect(without.pictures).toEqual([]);
    expect(without.notices).toContain('1 picture in left-out text was not imported.');
    expect(without.params.nodes.some((node) => node.title.startsWith('Chapter 1'))).toBe(false);
  });

  test('codex rows cite the first imported document that names them; a page-only row and a renamed row follow the answers', () => {
    const rows = lighthouseSource().codexRows?.() ?? [];
    const commit = buildCommit(input({ codexRows: rows, codexAnswers: { 'mara-2': { action: 'rename', name: 'Mara the Elder' }, lantern: { action: 'page' } } }));
    const entries = commit.params.codex?.entries ?? [];
    expect(entries.map((entry) => entry.name)).toEqual(['Mara']);
    expect(commit.params.codex?.pages).toEqual([{ title: 'The Lantern', body: 'The Lantern is the lighthouse’s old lamp.' }]);
    const mara = entries[0];
    const body = commit.params.nodes[mara?.node ?? -1]?.body ?? '';
    expect(body.slice(mara?.cite.from, mara?.cite.to)).toBe('Mara');
    // "Mara the Elder" is named nowhere in the text and has no page, so it is reported, not made.
    expect(commit.notices).toContain('“mara” is not named in the imported text, so its codex entry was not made.');
  });

  test('front matter goes to research, or into a folder of its own name in the manuscript, or is skipped with a notice', () => {
    const front: PreviewNode = { id: 'front', role: 'front', title: 'Before chapter 1', startBlock: 0, endBlock: 0, words: 3, body: 'For my mother.', place: 'research' };
    const base = plan();
    const withFront = (place: PreviewNode['place']): PreviewPlan => ({ ...base, tree: [{ ...front, place }, ...base.tree] });
    expect(buildCommit(input({ plan: withFront('research') })).params.nodes[0]).toMatchObject({ type: 'document', place: 'research' });
    const manuscript = buildCommit(input({ plan: withFront('manuscript') })).params.nodes;
    expect(manuscript.slice(0, 2)).toMatchObject([{ type: 'folder', title: 'Before chapter 1' }, { type: 'document', parent: 0 }]);
    const skipped = buildCommit(input({ plan: withFront('skip') }));
    expect(skipped.notices).toContain('“Before chapter 1” was left out, as chosen in the preview.');
  });

  test('a mapped field becomes metadata, and a status the writer adds rides in the vocabulary', () => {
    const base = plan();
    const scene: PreviewNode = { id: 's', role: 'scene', title: 'S', startBlock: 0, endBlock: 0, words: 1, body: 'x', fields: { state: 'Beta read', tags: ['harbour', 'night'], pov: 'Mara' } };
    const tree: PreviewNode[] = [{ id: 'c', role: 'chapter', title: 'C', startBlock: 0, endBlock: 0, words: 1, children: [scene] }];
    const commit = buildCommit(
      input({ plan: { ...base, tree }, mapping: { state: 'status', tags: 'keywords', pov: 'notes' }, statusAnswers: { 'Beta read': { action: 'add' } } }),
    );
    expect(commit.params.vocabulary).toEqual({ statuses: ['Beta read'] });
    expect(commit.params.nodes[1]).toMatchObject({ status: 'Beta read', keywords: ['harbour', 'night'], notes: 'pov: Mara' });
  });
});
