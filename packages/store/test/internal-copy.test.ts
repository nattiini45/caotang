/**
 * Who a copy is for — `write.ts` `WriteOptions.copyFor`.
 *
 * ## The problem this option answers
 *
 * A file the load declined because its bytes are not UTF-8 text has no text to
 * carry: there is nothing to write it from. A copy that cannot hold it used to
 * leave it out silently, which is the one loss codex.md §3 calls "the direct
 * countermeasure to the Manuskript corpus" — so the write now *refuses* instead
 * (zip.ts's test names the refusal).
 *
 * The refusal is right for a copy the writer takes home. It is wrong for the
 * desktop's **safety bundle**: the 'use-folder' flow holds this browser's copy
 * in memory as a bundle before it removes the copy, so that an adopt which
 * fails can put it back. That bundle is not the writer's backup — it is the
 * app's own safety net — and a project that holds one unreadable file would
 * make the adopt impossible: the export would refuse, the writer could not
 * choose the folder's version, and the browser's copy would stay where it is
 * for ever.
 *
 * So the write takes one option, and the default is the refusal:
 *
 * - a **`user`** copy refuses, because it has to carry the whole project;
 * - an **`internal`** copy mirrors what the state holds: a codex file the load
 *   could not read has no entry and no text, so the copy leaves it out; a
 *   document the load held has no body, so the copy writes the empty body the
 *   browser's own copy shows. Both are named in the report.
 *
 * The author's own file is never touched by either: a save in place leaves the
 * file exactly as it is, and an internal copy writes into a copy of its own.
 */

import { describe, expect, it } from 'vitest';
import {
  MemoryArtifactFs,
  addDocument,
  createEmptyManifest,
  createProjectState,
  exportProjectZip,
  readProject,
  writeProject,
  type ProjectState,
} from '../src/index.js';

const T0 = new Date('2026-10-20T09:00:00.000Z');
const T1 = new Date('2026-10-20T09:30:00.000Z');

/** Bytes no UTF-8 decoder accepts. */
const NOT_TEXT = new Uint8Array([0xff, 0xfe, 0x41, 0x00]);

const CHAPTER = 'n_CHAPTR0001';
const HELD = 'n_HED0000001';
const STRAY_CODEX = 'codex/c_VANSHED002.md';

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('Keeper', T0));
  addDocument(state, { parentId: 'manuscript', title: 'Chapter 1', now: T0, id: CHAPTER });
  addDocument(state, { parentId: CHAPTER, title: 'Held', body: 'The ferry was late.', now: T0, id: HELD });
  return state;
}

/** A folder whose codex file the load cannot read, and whose document body it cannot read either. */
async function folderWithUnreadableFiles(): Promise<MemoryArtifactFs> {
  const fs = new MemoryArtifactFs();
  await writeProject(fs, project(), { now: T0 });
  await fs.writeBytesAtomic(STRAY_CODEX, NOT_TEXT);
  await fs.writeBytesAtomic(`docs/${HELD}.md`, NOT_TEXT);
  return fs;
}

describe('a copy the writer takes home refuses a file it cannot hold', () => {
  it('refuses a codex file the load declined, because its bytes are not text', async () => {
    const fs = await folderWithUnreadableFiles();
    const loaded = await readProject(fs, { now: T1 });
    expect([...loaded.state.declinedCodexFiles]).toEqual(['c_VANSHED002.md']);

    await expect(writeProject(new MemoryArtifactFs(), loaded.state, { now: T1 })).rejects.toThrow(/not UTF-8/);
  });

  it('refuses a document the load held, because it will not write an empty one in its place', async () => {
    const fs = await folderWithUnreadableFiles();
    const loaded = await readProject(fs, { now: T1 });
    expect(loaded.state.declinedDocFiles.has(`${HELD}.md`)).toBe(true);

    await expect(writeProject(new MemoryArtifactFs(), loaded.state, { now: T1 })).rejects.toThrow(/not UTF-8/);
  });

  it('is what a bundle is, so a bundle of such a project refuses as well', async () => {
    const fs = await folderWithUnreadableFiles();
    const loaded = await readProject(fs, { now: T1 });

    await expect(exportProjectZip(loaded.state, { now: T1 })).rejects.toThrow(/not UTF-8/);
  });
});

describe('an internal copy mirrors what the state holds', () => {
  it('leaves a codex file the load could not read out of the copy, and names it', async () => {
    const fs = await folderWithUnreadableFiles();
    const loaded = await readProject(fs, { now: T1 });

    const target = new MemoryArtifactFs();
    const report = await writeProject(target, loaded.state, { now: T1, copyFor: 'internal' });

    expect(await target.exists(STRAY_CODEX)).toBe(false);
    // The report names every file whose text the copy does not carry — this one
    // and the held document below.
    expect(report.omitted).toEqual([STRAY_CODEX, `docs/${HELD}.md`]);
  });

  it('writes the empty body a held document shows, so the copy still loads', async () => {
    const fs = await folderWithUnreadableFiles();
    const loaded = await readProject(fs, { now: T1 });

    const target = new MemoryArtifactFs();
    const report = await writeProject(target, loaded.state, { now: T1, copyFor: 'internal' });

    expect(report.omitted).toContain(`docs/${HELD}.md`);
    // The copy names a document, so it has to hold a file for it: a copy whose
    // manifest names a document it does not hold is a fatal load.
    const copied = await readProject(target, { now: T1 });
    expect(copied.report.ok).toBe(true);
    expect(copied.state.documents.get(HELD)?.body).toBe('');
  });

  it('leaves the author’s own file exactly as it is', async () => {
    const fs = await folderWithUnreadableFiles();

    await writeProject(fs, (await readProject(fs, { now: T1 })).state, { now: T1, copyFor: 'internal' });

    expect(await fs.readBytes(STRAY_CODEX)).toEqual(NOT_TEXT);
    expect(await fs.readBytes(`docs/${HELD}.md`)).toEqual(NOT_TEXT);
  });

  it('is a bundle too, so the safety bundle a failed adopt needs can be made', async () => {
    const fs = await folderWithUnreadableFiles();
    const loaded = await readProject(fs, { now: T1 });

    const bundle = await exportProjectZip(loaded.state, { now: T1, copyFor: 'internal' });

    expect(bundle.omitted).toEqual(expect.arrayContaining([STRAY_CODEX]));
    expect(bundle.entries).not.toContain(STRAY_CODEX);
  });

  it('is the writer’s choice, not the default: a user copy of the same project still refuses', async () => {
    const fs = await folderWithUnreadableFiles();
    const loaded = await readProject(fs, { now: T1 });

    await expect(exportProjectZip(loaded.state, { now: T1 })).rejects.toThrow(/not UTF-8/);
  });
});
