/**
 * The project's pictures between the browser's copy and a project folder (project-format §2 `assets/`, storyboard.md §2.2), below the
 * page. A folder save copies every picture the browser holds; a folder holding another file under one of them is refused before any
 * picture is written; a bundle made from the projects list reads the browser's copy with no session open; and a folder opened here puts
 * its pictures into that copy, so a later open from the list still has them. A folder whose attach is refused is still read for its
 * pictures; the dangling-image check runs when a project opens, and only against a list that can be trusted (storyboard.md §2.2).
 *
 * The browser's copy is an in-memory IndexedDB here, set as the page's `indexedDB` for each test, the way the page's own is.
 */

import { expect, test } from '@playwright/test';

import { ProjectAssets } from '../../apps/desktop/src/app/project-assets.js';
import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { exportStoredBundle, imageDropNotice, openFolder, openProject, type Opened, type OpenOutcome } from '../../apps/desktop/src/app/lifecycle.js';
import { folderArtifactFs, folderBytes } from '../../apps/desktop/src/app/fs-access.js';
import { addShotNode, addStoryboardFolder, danglingImages } from '../../packages/storyboard/src/index.js';
import {
  MemoryIndexedDb,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  openRuntimeStore,
  writeProject,
  type ProjectState,
} from '../../packages/store/src/index.js';

import { zipEntries } from '../zip-entries.js';
import { filesIn, memoryFolder } from './memory-folder.js';

const globals = globalThis as unknown as Record<string, unknown>;
let previous: { document: unknown; window: unknown; indexedDB: unknown } | null = null;

test.beforeAll(() => {
  previous = { document: globals['document'], window: globals['window'], indexedDB: globals['indexedDB'] };
  // The session's autosave listens to the page's visibility and page-hide events, which these stand in for, as session-exports.spec does.
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});

test.afterAll(() => {
  if (previous === null) return;
  globals['document'] = previous.document;
  globals['window'] = previous.window;
  globals['indexedDB'] = previous.indexedDB;
});

const NOW = new Date('2026-10-09T09:00:00Z');
/** Valid asset ids: `a_` and ten Crockford base32 characters (no I, L, O or U). */
const PICTURE = 'a_ABCDEF2345';
const OTHER = 'a_BCDEFGHJKM';
/** A file that starts with the PNG signature, which is all the cover import checks. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x80, 0xff, 0xc3, 0x28, 0x00, 0x42]);

/** A project with one chapter and one scene, so the project has a body of its own. */
function manuscript(title: string): ProjectState {
  const state = createProjectState(createEmptyManifest(title, NOW));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', id: 'n_CH100000AA', now: NOW });
  addDocument(state, { parentId: 'n_CH100000AA', title: 'The Landing', id: 'n_SCA0000001', body: 'The boat came in with the tide.', now: NOW });
  return state;
}

async function openedOf(outcome: Promise<OpenOutcome>): Promise<Opened> {
  const result = await outcome;
  if (result.kind !== 'opened') throw new Error('expected the project to open, not to be offered a recovery');
  return result.opened;
}

test('a folder attached after a reload gets every picture the browser holds, not only the ones this page wrote', async () => {
  const factory = new MemoryIndexedDb();
  const first = new ProjectAssets();
  await first.persistFor('p_ATTACHALL01', factory);
  await first.writeBytes(`assets/${PICTURE}.png`, PNG);

  const reopened = new ProjectAssets();
  await reopened.persistFor('p_ATTACHALL01', factory);
  const { handle, tree } = memoryFolder();
  await reopened.attach(handle);

  expect(filesIn(tree).get(`assets/${PICTURE}.png`)).toEqual(PNG);
});

test('a folder holding another file under one of the pictures is refused before any picture is written', async () => {
  const factory = new MemoryIndexedDb();
  const first = new ProjectAssets();
  await first.persistFor('p_REFUSEALL01', factory);
  await first.writeBytes(`assets/${PICTURE}.png`, PNG);
  await first.writeBytes(`assets/${OTHER}.png`, PNG);

  // A page after a reload: both pictures are in the browser's copy only, so the clash is found there and not in memory.
  const reopened = new ProjectAssets();
  await reopened.persistFor('p_REFUSEALL01', factory);
  const { handle, tree } = memoryFolder();
  const theirs = Uint8Array.from([1, 2, 3]);
  await folderBytes(handle).writeBytes(`assets/${PICTURE}.png`, theirs);

  await expect(reopened.attach(handle)).rejects.toThrow(`assets/${PICTURE}.png`);
  expect(reopened.hasFolder()).toBe(false);
  // Nothing was written: the other picture is not in the folder, and the clashing file is as it was.
  expect([...filesIn(tree).keys()]).toEqual([`assets/${PICTURE}.png`]);
  expect(filesIn(tree).get(`assets/${PICTURE}.png`)).toEqual(theirs);
});

test('a bundle made from the projects list reads the browser’s copy of the pictures, with no session open', async () => {
  const factory = new MemoryIndexedDb();
  globals['indexedDB'] = factory;
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = manuscript('Listed Book');
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  expect((await session.importCover(PNG)).ok).toBe(true);
  await session.settle();

  // The projects list has no session for the project, so the bundle is made from the browser's copy alone.
  const bundle = await exportStoredBundle(store, state.manifest.project.id);
  expect(bundle.notices).toEqual([]);
  const pictures = [...zipEntries(bundle.bytes).keys()].filter((name) => name.startsWith('assets/'));
  expect(pictures).toHaveLength(1);
});

test('a folder opened here puts its pictures into the browser’s copy, so a later open from the list still has them', async () => {
  const factory = new MemoryIndexedDb();
  globals['indexedDB'] = factory;
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = manuscript('Folder Book');
  const { handle } = memoryFolder();
  await writeProject(folderArtifactFs(handle), state, { now: NOW });
  await folderBytes(handle).writeBytes(`assets/${PICTURE}.png`, PNG);

  const opened = await openedOf(openFolder(store, handle));
  await opened.session.close();

  // A later open from the list has no folder, so it reads the browser's copy, which must now hold the picture.
  const later = new ProjectAssets();
  await later.persistFor(state.manifest.project.id, factory);
  expect(later.presentIds().has(PICTURE)).toBe(true);
});

const BOARD = 'n_SBFOLDER01';
const SHOT = 'n_SHOTA00001';
const THEIRS = Uint8Array.from([1, 2, 3]);

/** A project whose one shot names `image`. */
function shotProject(image: string): ProjectState {
  const state = createProjectState(createEmptyManifest('Film', NOW));
  addStoryboardFolder(state, { parentId: 'manuscript', title: 'Shots', id: BOARD, now: NOW });
  addShotNode(state, { parentId: BOARD, id: SHOT, title: 'Wide', stored: { shotSize: 'WS', durationSec: 4, image }, now: NOW });
  return state;
}

/** The ids the shots of a session name that its pictures do not hold. */
function dangling(session: ProjectSession): string[] {
  return danglingImages(session.state.manifest.tree, session.assets.presentIds()).map((d) => d.assetId);
}

async function sessionOn(state: ProjectState): Promise<ProjectSession> {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  return new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
}

test('a folder whose attach is refused for a different file is still read: its pictures are present, and the browser’s copy is the one shown', async () => {
  const factory = new MemoryIndexedDb();
  const assets = new ProjectAssets();
  await assets.persistFor('p_REFUSEREAD1', factory);
  await assets.writeBytes(`assets/${PICTURE}.png`, PNG);
  const { handle, tree } = memoryFolder();
  await folderBytes(handle).writeBytes(`assets/${PICTURE}.png`, THEIRS);
  await folderBytes(handle).writeBytes(`assets/${OTHER}.png`, PNG);

  await assets.listFolder(handle);
  await expect(assets.attach(handle)).rejects.toThrow(`assets/${PICTURE}.png`);

  expect(assets.hasFolder()).toBe(false);
  expect([...assets.presentIds()].sort()).toEqual([PICTURE, OTHER]);
  expect(await assets.readBytes(`assets/${OTHER}.png`)).toEqual(PNG);
  expect(await assets.readBytes(`assets/${PICTURE}.png`)).toEqual(PNG);
  expect(await assets.has(`assets/${OTHER}.png`)).toBe(true);
  // The folder is as it was: reading it wrote nothing and overwrote nothing.
  expect(filesIn(tree).get(`assets/${PICTURE}.png`)).toEqual(THEIRS);
});

test('a shot keeps the picture a refused folder holds, and the one that differs from the browser’s copy, with no drop notice', async () => {
  globals['indexedDB'] = new MemoryIndexedDb();
  const session = await sessionOn(shotProject(OTHER));
  await session.assets.writeBytes(`assets/${PICTURE}.png`, PNG);
  const { handle } = memoryFolder();
  await folderBytes(handle).writeBytes(`assets/${PICTURE}.png`, THEIRS);
  await folderBytes(handle).writeBytes(`assets/${OTHER}.png`, PNG);

  await expect(session.attachFolder(handle)).rejects.toThrow(PICTURE);
  await session.settle();

  expect(session.imageNotices()).toEqual([]);
  expect(dangling(session)).toEqual([]);
  expect(session.assetsInFolder()).toBe(false);
  await session.close();
});

test('a shot naming the picture that differs from the browser’s copy keeps it', async () => {
  globals['indexedDB'] = new MemoryIndexedDb();
  const session = await sessionOn(shotProject(PICTURE));
  await session.assets.writeBytes(`assets/${PICTURE}.png`, PNG);
  const { handle } = memoryFolder();
  await folderBytes(handle).writeBytes(`assets/${PICTURE}.png`, THEIRS);

  await expect(session.attachFolder(handle)).rejects.toThrow(PICTURE);
  await session.settle();

  expect(session.imageNotices()).toEqual([]);
  expect(dangling(session)).toEqual([]);
  await session.close();
});

test('a folder refused for its compile log still lends its pictures to the shots', async () => {
  globals['indexedDB'] = new MemoryIndexedDb();
  const session = await sessionOn(shotProject(OTHER));
  const { handle } = memoryFolder();
  await folderBytes(handle).writeBytes(`assets/${OTHER}.png`, PNG);
  await folderBytes(handle).writeBytes('exports/compile-log.json', new TextEncoder().encode('{}'));

  await expect(session.attachFolder(handle)).rejects.toThrow();
  await session.settle();

  expect(session.exportsToFolder()).toBe(false);
  expect(session.imageNotices()).toEqual([]);
  expect(await session.assets.readBytes(`assets/${OTHER}.png`)).toEqual(PNG);
  await session.close();
});

test('with no browser copy and no folder listed nothing is dropped, and the check runs once a folder is listed', async () => {
  globals['indexedDB'] = undefined;
  const session = await sessionOn(shotProject(PICTURE));
  await session.settle();
  await session.checkImageReferences();
  expect(session.assets.listingAuthoritative()).toBe(false);
  expect(session.imageNotices()).toEqual([]);
  expect(dangling(session)).toEqual([PICTURE]);

  // A folder that holds the picture is a list that can be trusted, and the reference resolves.
  const { handle } = memoryFolder();
  await folderBytes(handle).writeBytes(`assets/${PICTURE}.png`, PNG);
  await session.attachFolder(handle);
  expect(session.assets.listingAuthoritative()).toBe(true);
  expect(session.imageNotices()).toEqual([]);
  expect(dangling(session)).toEqual([]);
  await session.close();
});

test('a folder that lists empty is a list that can be trusted: the reference is dropped, once', async () => {
  globals['indexedDB'] = undefined;
  const session = await sessionOn(shotProject(PICTURE));
  await session.settle();
  expect(session.imageNotices()).toEqual([]);

  await session.attachFolder(memoryFolder().handle);
  expect(session.imageNotices()).toHaveLength(1);
  expect(session.imageNotices()[0]).toContain(PICTURE);
  await session.checkImageReferences();
  expect(session.imageNotices()).toHaveLength(1);
  await session.close();
});

test('a browser copy that cannot be listed is not an empty one: nothing is dropped', async () => {
  // Reads of the asset store fail, as an unreadable database would; the store opens.
  class ListFails extends MemoryIndexedDb {
    override open(name: string, version?: number): IDBOpenDBRequest {
      const request = super.open(name, version);
      return new Proxy(request, {
        set(target, key, value: unknown) {
          if (key !== 'onsuccess' || typeof value !== 'function') return Reflect.set(target, key, value);
          target.onsuccess = function (this: IDBRequest<IDBDatabase>, ...args: [Event]) {
            const db = target.result;
            const transaction = db.transaction.bind(db);
            db.transaction = ((names: string | string[], mode?: IDBTransactionMode) => {
              if (mode === 'readonly') throw new Error('the asset store cannot be read');
              return transaction(names, mode);
            }) as typeof db.transaction;
            return (value as (event: Event) => void).apply(this, args);
          };
          return true;
        },
        get(target, key) {
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    }
  }
  globals['indexedDB'] = new ListFails();
  const session = await sessionOn(shotProject(PICTURE));
  await session.settle();
  expect(session.assets.durable()).toBe(false);
  expect((session.assets as unknown as { durableListFailed: boolean }).durableListFailed).toBe(true);
  expect(session.assets.listingAuthoritative()).toBe(false);
  expect(session.imageNotices()).toEqual([]);
  expect(dangling(session)).toEqual([PICTURE]);
  await session.close();
});

test('opening a project from the list runs the image check before any view opens, and the drop is saved', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = shotProject(PICTURE);
  const id = state.manifest.project.id;
  globals['indexedDB'] = new MemoryIndexedDb();
  const first = new ProjectSession({ store, projectId: id, state, shadow: null });
  await first.assets.writeBytes(`assets/${PICTURE}.png`, PNG);
  await first.settle();
  expect(first.imageNotices()).toEqual([]);
  await first.close();

  // The browser's copy is emptied, as cleared site data would: the file is gone and the reference dangles.
  globals['indexedDB'] = new MemoryIndexedDb();
  const opened = await openProject(store, id);
  expect(opened.imageNotices()).toHaveLength(1);
  expect(opened.imageNotices()[0]).toContain(PICTURE);
  expect(imageDropNotice(opened)).toHaveLength(1);
  // The board's own call has nothing left to do.
  await opened.checkImageReferences();
  expect(opened.imageNotices()).toHaveLength(1);
  await opened.close();

  const again = await openProject(store, id);
  expect(again.imageNotices()).toEqual([]);
  expect(imageDropNotice(again)).toEqual([]);
  await again.close();
});
