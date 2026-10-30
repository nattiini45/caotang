import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore } from '../../packages/store/src/index.js';
import type { FlatBlock } from '../../packages/exporter/src/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import { PREVIEW_SCENE_CAP, countPhrase, draftListing, holdsOf } from '../../apps/desktop/src/components/export-preview-model.js';
import { PROOF_CHAR_CAP, proofExcerpt } from '../../apps/desktop/src/components/export-proof-model.js';

/**
 * The export dialog's Preview (exporter.md §4, the Draft and the Proof): the rows the Draft lists and its cap
 * (components/export-preview-model.ts), the Proof's cut (components/export-proof-model.ts), and the session's `previewExport` and
 * `proofExport`, which are reads: they write nothing, run no command and leave no undo entry.
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

const scene = (n: number, title: string, body: string): FlatBlock => ({ kind: 'scene', docId: `n_SCENE${String(n).padStart(5, '0')}`, title, body, number: n });

test('a Draft lists the title page, each chapter with its scenes and words, and the break between two scenes of a chapter', () => {
  const blocks: FlatBlock[] = [
    { kind: 'frontmatter', fmKind: 'titlepage' },
    scene(1, 'Prologue', 'One two three.'),
    { kind: 'chapter', title: 'Chapter One', level: 1, number: 1 },
    scene(1, 'The Landing', 'The boat came in.'),
    { kind: 'separator' },
    scene(2, 'The Storm', 'Wind.'),
  ];
  const listing = draftListing(blocks);
  expect(listing.titlePage).toBe(true);
  expect(listing.rows.map((row) => row.kind)).toEqual(['scene', 'chapter', 'scene', 'break', 'scene']);
  expect(listing.rows.filter((row) => row.kind === 'scene').map((row) => row.kind === 'scene' && [row.title, row.words])).toEqual([
    ['Prologue', 3],
    ['The Landing', 4],
    ['The Storm', 1],
  ]);
  expect([listing.shownScenes, listing.totalScenes]).toEqual([3, 3]);
});

test('a Draft with no title page block says so, and an empty one lists nothing', () => {
  expect(draftListing([scene(1, 'A', 'word')]).titlePage).toBe(false);
  const empty = draftListing([]);
  expect(empty.rows).toEqual([]);
  expect([empty.shownScenes, empty.totalScenes]).toEqual([0, 0]);
});

test('a Draft past the cap shows the first scenes, counts all of them, and ends on a scene, not on a heading or a break', () => {
  const blocks: FlatBlock[] = [{ kind: 'frontmatter', fmKind: 'titlepage' }];
  for (let chapter = 1; chapter <= 7; chapter += 1) {
    blocks.push({ kind: 'chapter', title: `Chapter ${chapter}`, level: 1, number: chapter });
    for (let n = 1; n <= 100; n += 1) {
      if (n > 1) blocks.push({ kind: 'separator' });
      blocks.push(scene(n, `Scene ${chapter}.${n}`, 'a b'));
    }
  }
  const listing = draftListing(blocks);
  expect(PREVIEW_SCENE_CAP).toBe(300);
  expect(listing.shownScenes).toBe(300);
  expect(listing.totalScenes).toBe(700);
  // Three whole chapters, and the fourth begins after the cap, so its heading is not shown either.
  expect(listing.rows.filter((row) => row.kind === 'chapter')).toHaveLength(3);
  expect(listing.rows.at(-1)?.kind).toBe('scene');
  expect(listing.rows.at(-1)).toMatchObject({ title: 'Scene 3.100' });

  const midChapter = draftListing(blocks, 250);
  expect(midChapter.shownScenes).toBe(250);
  expect(midChapter.rows.filter((row) => row.kind === 'chapter')).toHaveLength(3);
  expect(midChapter.rows.at(-1)).toMatchObject({ kind: 'scene', title: 'Scene 3.50' });
});

test('the words for a compile’s counts are the format’s own', () => {
  const counts = { chapterCount: 2, sceneCount: 3, blockCount: 9, wordCount: 1204 };
  expect(holdsOf({ ...counts, format: 'md' })).toBe('2 chapters, 3 scenes, 1,204 words');
  expect(holdsOf({ ...counts, format: 'fountain' })).toBe('3 scenes in 2 sections, 1,204 words');
  expect(holdsOf({ ...counts, format: 'shot-list-csv' })).toBe('9 shots');
  expect(holdsOf({ ...counts, format: 'coherence-md' })).toBe('the coherence report');
  expect(countPhrase(1, 'scene')).toBe('1 scene');
});

test('session.previewExport reads the project and writes nothing: no file, no command, no undo entry, no compile log row', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  await session.exportsReady();
  const logged = session.log.length;
  const groups = session.undo.groups().length;
  const version = session.getVersion();

  const draft = session.previewExport({ selection: { kind: 'manuscript' }, format: 'md' });
  session.previewExport({ selection: { kind: 'manuscript' }, format: 'fountain' });
  session.previewExport({ selection: { kind: 'manuscript' }, format: 'docx' });
  await session.exportsIdle();

  expect(draft.kind).toBe('draft');
  expect(draft.kind === 'draft' && draft.sceneCount).toBeGreaterThan(0);
  expect(session.log.length).toBe(logged);
  expect(session.undo.groups().length).toBe(groups);
  expect(session.getVersion()).toBe(version);
  expect(session.exportFailures()).toEqual([]);
  expect(await session.readExport('exports/compile-log.json')).toBeNull();
  expect(await session.readExport(`exports/${state.manifest.project.name}.md`)).toBeNull();
});

test('a Proof shows a short file whole, and cuts a long one at a line end near the cap, saying how much it shows', () => {
  expect(PROOF_CHAR_CAP).toBe(60_000);
  expect(proofExcerpt('# Title\n\nText.\n')).toEqual({ text: '# Title\n\nText.\n', shownChars: 15, totalChars: 15 });

  const line = `${'a'.repeat(99)}\n`;
  const long = line.repeat(1000);
  const cut = proofExcerpt(long, 1050);
  expect(cut.text).toBe(line.repeat(10));
  expect([cut.shownChars, cut.totalChars]).toEqual([1000, 100_000]);

  // No line end in reach: the cut is at the cap, and never between the two halves of an emoji.
  const emoji = `${'b'.repeat(9)}😀tail`;
  expect(proofExcerpt(emoji, 10).text).toBe('b'.repeat(9));
  expect(proofExcerpt(emoji, 11).text).toBe(`${'b'.repeat(9)}😀`);
});

test('session.proofExport is the file the compile would write for a text format, none for a binary one, and writes nothing', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  await session.exportsReady();
  const logged = session.log.length;
  const groups = session.undo.groups().length;
  const version = session.getVersion();

  const proof = await session.proofExport({ selection: { kind: 'manuscript' }, format: 'md' });
  const word = await session.proofExport({ selection: { kind: 'manuscript' }, format: 'docx' });
  await session.exportsIdle();

  expect(proof.kind).toBe('text');
  expect(proof.kind === 'text' && proof.fileName).toBe(`${state.manifest.project.name}.md`);
  expect(proof.kind === 'text' && proof.text).toContain(`# ${state.manifest.project.name}`);
  expect(word).toEqual({ kind: 'none', format: 'docx' });
  expect(session.log.length).toBe(logged);
  expect(session.undo.groups().length).toBe(groups);
  expect(session.getVersion()).toBe(version);
  expect(session.exportFailures()).toEqual([]);
  expect(await session.readExport('exports/compile-log.json')).toBeNull();
  expect(await session.readExport(`exports/${state.manifest.project.name}.md`)).toBeNull();
});
