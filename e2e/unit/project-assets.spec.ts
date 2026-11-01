import { expect, test } from '@playwright/test';

import {
  MemoryIndexedDb,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  openRuntimeStore,
  writeProject,
  type ProjectState,
  type RuntimeStore,
} from '../../packages/store/src/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import {
  exportBundle,
  exportStoredBundle,
  importBundle,
  openFolder,
  removeProject,
  type Opened,
  type OpenOutcome,
} from '../../apps/desktop/src/app/lifecycle.js';
import { folderArtifactFs, folderBytes, type DirectoryHandleLike } from '../../apps/desktop/src/app/fs-access.js';

import { zipEntries, textEntry } from '../zip-entries.js';
import { memoryFolder } from './memory-folder.js';

/** The opened project from an open or import that loaded cleanly. A recovery offer here would be a broken fixture. */
async function openedOf(outcome: Promise<OpenOutcome>): Promise<Opened> {
  const result = await outcome;
  if (result.kind !== 'opened') throw new Error('expected the project to open, not to be offered a recovery');
  return result.opened;
}

/**
 * Project export, below the browser: the cover image lives in the project's asset store, and the three places that
 * touch it agree. A bundle carries it and an import brings it back; a folder keeps it and a reopen reads it; a folder that
 * would overwrite it is refused. The EPUB is what a writer receives, so each check reads the package document it carries.
 *
 * The session's autosave listens to the page's visibility and page-hide events, which this file stands in for with event
 * targets, the same way session-exports.spec.ts does.
 */

const globals = globalThis as unknown as Record<string, unknown>;
let previous: { document: unknown; window: unknown; createImageBitmap: unknown; OffscreenCanvas: unknown } | null = null;

test.beforeAll(() => {
  previous = {
    document: globals['document'],
    window: globals['window'],
    createImageBitmap: globals['createImageBitmap'],
    OffscreenCanvas: globals['OffscreenCanvas'],
  };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
  // The EPUB cover goes through the app's canvas port now. This below-browser suite tests the asset store, not pixels, so its
  // stand-in decodes to 1×1, passes the canvas probe and writes the source PNG back unchanged.
  let source: Blob | null = null;
  globals['createImageBitmap'] = async (blob: Blob) => {
    source = blob;
    return { width: 1, height: 1, close: () => undefined };
  };
  globals['OffscreenCanvas'] = class {
    getContext() {
      return {
        fillRect: () => undefined,
        clearRect: () => undefined,
        drawImage: () => undefined,
        getImageData: () => ({ data: Uint8ClampedArray.from([254, 1, 127, 255]) }),
      };
    }
    async convertToBlob(options: { type: string }): Promise<Blob> {
      if (source === null) throw new Error('no picture was decoded');
      return (source as Blob).slice(0, (source as Blob).size, options.type);
    }
  };
});

test.afterAll(() => {
  if (previous === null) return;
  globals['document'] = previous.document;
  globals['window'] = previous.window;
  globals['createImageBitmap'] = previous.createImageBitmap;
  globals['OffscreenCanvas'] = previous.OffscreenCanvas;
});

const NOW = new Date('2026-10-08T09:00:00Z');
const COVER_ID = 'a_ABCDEFGHJK';
/** A 1×1 RGB PNG: no alpha to flatten, so the metadata-retaining export can pass its bytes through without a canvas. */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'), (char) => char.charCodeAt(0));

/** A project with one chapter and one scene that has words in it, so the EPUB has a section to carry the cover beside. */
function manuscript(title: string): ProjectState {
  const state = createProjectState(createEmptyManifest(title, NOW, { locale: 'en-US' }));
  // These are asset-store tests, not browser-transcoder tests: retain the fixture's bytes so no canvas is needed below the browser.
  const recipe = state.manifest.recipes?.[0];
  if (recipe !== undefined) recipe.options = { ...recipe.options, keepPictureMetadata: true };
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', id: 'n_CH100000AA', now: NOW });
  addDocument(state, {
    parentId: 'n_CH100000AA',
    title: 'The Landing',
    id: 'n_SCA0000001',
    body: 'The boat came in with the tide.',
    now: NOW,
  });
  return state;
}

async function sessionFor(store: RuntimeStore, state: ProjectState): Promise<ProjectSession> {
  return new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
}

/** The EPUB the session compiles, read back as its archive entries. */
async function epubOf(session: ProjectSession): Promise<Map<string, Uint8Array>> {
  await session.exportsReady();
  const outcome = session.dispatch('export.compile', { format: 'epub' });
  if (!outcome.ok) throw new Error(outcome.error.message);
  const output = (outcome.value.result as { output: string }).output;
  await session.exportsIdle();
  const bytes = await session.readExport(output);
  if (bytes === null) throw new Error(`no EPUB was written at ${output}`);
  return zipEntries(bytes);
}

/** The text of the package's stored identifier: the `pub-id` element, which is the one the EPUB is deduped on. */
function pubIdOf(entries: Map<string, Uint8Array>): string | undefined {
  return /<dc:identifier id="pub-id">([^<]+)<\/dc:identifier>/.exec(textEntry(entries, 'OEBPS/content.opf'))?.[1];
}

test('a cover survives a bundle: the copy imported after its project was removed still carries the cover in its EPUB', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = manuscript('Bundle Cover');
  const session = await sessionFor(store, state);
  const imported = await session.importCover(PNG);
  expect(imported.ok).toBe(true);

  const bundle = await exportBundle(store, session);
  expect(bundle.notices).toEqual([]);
  // Removing the project forgets the page's copy of its images, so the import has to bring the cover back from the bundle.
  await removeProject(store, state.manifest.project.id);
  const opened = await openedOf(importBundle(store, bundle.bytes, 'Bundle Cover.caotang'));
  expect(opened.copiedFrom).toBeNull();

  const entries = await epubOf(opened.session);
  expect(textEntry(entries, 'OEBPS/content.opf')).toContain('properties="cover-image"');
  expect(Array.from(entries.get('OEBPS/cover.png') ?? [])).toEqual(Array.from(PNG));
});

test('a cover written into a project folder is read back when the folder is opened again, and the EPUB carries it', async () => {
  const state = manuscript('Folder Cover');
  state.manifest.project.coverAssetId = COVER_ID;
  const { handle } = memoryFolder();
  await writeProject(folderArtifactFs(handle), state, { now: NOW });
  await folderBytes(handle).writeBytes(`assets/${COVER_ID}.png`, PNG);

  const opened = await openedOf(openFolder(await openRuntimeStore(new MemoryIndexedDb()), handle));
  expect(await opened.session.coverFileHeld()).toBe(true);
  expect(opened.session.assetsInFolder()).toBe(true);

  const entries = await epubOf(opened.session);
  expect(textEntry(entries, 'OEBPS/content.opf')).toContain('properties="cover-image"');
  expect(Array.from(entries.get('OEBPS/cover.png') ?? [])).toEqual(Array.from(PNG));
});

test('a folder project with no identifier keeps the one its first open made, so both EPUBs carry the same identifier', async () => {
  const state = manuscript('Folder Identity');
  delete state.manifest.project.identifier;
  delete state.manifest.project.language;
  const { handle } = memoryFolder();
  await writeProject(folderArtifactFs(handle), state, { now: NOW });

  const first = await openedOf(openFolder(await openRuntimeStore(new MemoryIndexedDb()), handle));
  const firstId = pubIdOf(await epubOf(first.session));
  // A project is open in one place at a time (project-lease.ts), so the first open is closed before the second.
  await first.session.close();
  const second = await openedOf(openFolder(await openRuntimeStore(new MemoryIndexedDb()), handle));
  const secondId = pubIdOf(await epubOf(second.session));

  expect(firstId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  expect(secondId).toBe(firstId);
});

test('a bundle made where the page does not hold the cover says so, and still carries the book', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = manuscript('Missing Cover');
  const session = await sessionFor(store, state);
  // The cover is named but no image was imported in this page, as after a reload.
  expect(session.dispatch('project.setMetadata', { patch: { coverAssetId: COVER_ID } }).ok).toBe(true);
  expect(await session.coverFileHeld()).toBe(false);
  await session.settle();

  const bundle = await exportStoredBundle(store, state.manifest.project.id);
  expect(bundle.notices.join(' ')).toContain('the cover image is not available in this browser');
  expect(zipEntries(bundle.bytes).has('caotang.json')).toBe(true);
});

test('a folder that refuses the write of its new identity is said so, and the project still opens on the identity it made', async () => {
  const state = manuscript('Read Only Identity');
  delete state.manifest.project.identifier;
  const { handle } = memoryFolder();
  await writeProject(folderArtifactFs(handle), state, { now: NOW });

  const opened = await openedOf(openFolder(await openRuntimeStore(new MemoryIndexedDb()), folderThatRefusesWrites(handle)));
  expect(opened.notices.join(' ')).toContain('could not be saved to the folder, so the next open may make another');
  expect(opened.session.state.manifest.project.identifier?.uuid).toMatch(/^urn:uuid:/);
});

test('a folder holding a different image under a name the project uses is refused, and its file is left as it was', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = manuscript('Clashing Cover');
  const session = await sessionFor(store, state);
  expect((await session.importCover(PNG)).ok).toBe(true);

  const { handle } = memoryFolder();
  const coverId = session.state.manifest.project.coverAssetId ?? '';
  const path = `assets/${coverId}.png`;
  const theirs = Uint8Array.from([1, 2, 3]);
  await folderBytes(handle).writeBytes(path, theirs);

  await expect(session.attachFolder(handle)).rejects.toThrow(path);
  expect(session.assetsInFolder()).toBe(false);
  expect(await folderBytes(handle).readBytes(path)).toEqual(theirs);
});

test('a folder refused for its compile log keeps none of the project\'s images', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = manuscript('Refused Log');
  const session = await sessionFor(store, state);
  expect((await session.importCover(PNG)).ok).toBe(true);

  const { handle } = memoryFolder();
  await folderArtifactFs(handle).writeAtomic('exports/compile-log.json', 'not a log');

  await expect(session.attachFolder(handle)).rejects.toThrow(/not valid JSON/);
  expect(session.assetsInFolder()).toBe(false);
  expect(await folderArtifactFs(handle).listFiles('assets')).toEqual([]);
});

/**
 * The folder with its writes refused: asked to create a folder or a file, it refuses, as a read-only folder does. Reads are
 * the folder's own, so a project opens from it and only the write-back of its identity fails.
 */
function folderThatRefusesWrites(handle: DirectoryHandleLike): DirectoryHandleLike {
  const refuse = (): never => {
    throw new Error('the folder is read-only');
  };
  return {
    kind: handle.kind,
    name: handle.name,
    async getDirectoryHandle(name, options) {
      if (options?.create) refuse();
      return folderThatRefusesWrites(await handle.getDirectoryHandle(name, options));
    },
    async getFileHandle(name, options) {
      if (options?.create) refuse();
      return handle.getFileHandle(name, options);
    },
    removeEntry: (name, options) => handle.removeEntry(name, options),
    entries: () => handle.entries(),
  };
}
