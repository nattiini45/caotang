import { expect, test } from '@playwright/test';

import {
  EXPORTS_DIR,
  MemoryIndexedDb,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  openRuntimeStore,
  type ProjectState,
} from '../../packages/store/src/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';

import { filesIn, memoryFolder, textOf, type Entry } from './memory-folder.js';

/**
 * The export path below the browser: a compile dispatched on a real session goes through the bus, the exporter's
 * queue and the export store, and lands in the folder the session has open. An undo removes it from both.
 *
 * The session wires its autosave to the page's visibility and page-hide events, which this file stands in for with
 * event targets, since Node has none of the page.
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

/** A project with one chapter and one scene that has words in it, so every renderer has something to write. */
function manuscript(): ProjectState {
  const now = new Date('2026-10-08T09:00:00Z');
  const state = createProjectState(createEmptyManifest('The Harbour', now, { locale: 'en-US' }));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', id: 'n_CH100000AA', now });
  addDocument(state, {
    parentId: 'n_CH100000AA',
    title: 'The Landing',
    id: 'n_SCA0000001',
    body: 'The boat came in with the tide.',
    now,
  });
  return state;
}

async function sessionFor(state: ProjectState): Promise<ProjectSession> {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  return new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
}

/** Dispatch a compile and return the path it reserved, once the exporter has written it. */
async function compile(session: ProjectSession, format: string): Promise<string> {
  // The UI contract (ExportDialog.tsx): the project's exports are listed first, so the lazy exporter is loaded before the dispatch.
  await session.exportsReady();
  const outcome = session.dispatch('export.compile', { format });
  if (!outcome.ok) throw new Error(outcome.error.message);
  const output = (outcome.value.result as { output: string }).output;
  await session.exportsIdle();
  return output;
}

test('an export compiles through the bus into the open folder, and its undo removes the file from the folder too', async () => {
  const session = await sessionFor(manuscript());
  try {
    const { handle, tree } = memoryFolder();
    await session.attachFolder(handle);
    await session.exportsReady();

    const output = await compile(session, 'md');

    expect(output).toBe(`${EXPORTS_DIR}/The Harbour.md`);
    expect(session.exportFailures()).toEqual([]);
    expect(session.exportsToFolder()).toBe(true);
    const bytes = await session.readExport(output);
    expect(bytes).not.toBeNull();
    expect(textOf(bytes ?? undefined)).toContain('The boat came in with the tide.');
    expect(textOf(filesIn(tree).get(output))).toContain('The boat came in with the tide.');
    expect(textOf(filesIn(tree).get(`${EXPORTS_DIR}/compile-log.json`))).toContain('"format": "md"');

    // The compile is one undo group, and its undo is the emitter's removal, in the session and the folder alike.
    expect(await session.undoLast()).toBe(true);
    await session.exportsIdle();
    expect(filesIn(tree).has(output)).toBe(false);
    expect(await session.readExport(output)).toBeNull();
  } finally {
    session.close();
  }
});

test('a compile after a folder is attached takes a name the folder already holds, rather than overwriting it', async () => {
  const session = await sessionFor(manuscript());
  try {
    const { handle, tree } = memoryFolder();
    // An export from an earlier session, already in the folder when it is opened.
    tree.children.set(EXPORTS_DIR, {
      kind: 'directory',
      children: new Map<string, Entry>([
        ['The Harbour.md', { kind: 'file', bytes: new TextEncoder().encode('earlier export') }],
      ]),
    });

    await session.attachFolder(handle);
    await session.exportsReady();
    const output = await compile(session, 'md');

    expect(output).toBe(`${EXPORTS_DIR}/The Harbour-2.md`);
    expect(textOf(filesIn(tree).get(`${EXPORTS_DIR}/The Harbour.md`))).toBe('earlier export');
  } finally {
    session.close();
  }
});

test('a folder whose compile log is corrupt is not attached, and exports stay in the session', async () => {
  const session = await sessionFor(manuscript());
  try {
    const { handle, tree } = memoryFolder();
    tree.children.set(EXPORTS_DIR, {
      kind: 'directory',
      children: new Map<string, Entry>([['compile-log.json', { kind: 'file', bytes: new TextEncoder().encode('{}') }]]),
    });

    await expect(session.attachFolder(handle)).rejects.toThrow(/not a JSON array/);
    expect(session.exportsToFolder()).toBe(false);

    const output = await compile(session, 'txt');
    expect(await session.readExport(output)).not.toBeNull();
    expect(filesIn(tree).has(output)).toBe(false);
    expect(textOf(filesIn(tree).get(`${EXPORTS_DIR}/compile-log.json`))).toBe('{}');
  } finally {
    session.close();
  }
});

test('a Word file compiles into the folder as the same bytes the session holds for its download', async () => {
  const session = await sessionFor(manuscript());
  try {
    const { handle, tree } = memoryFolder();
    await session.attachFolder(handle);
    await session.exportsReady();

    const output = await compile(session, 'docx');

    const downloaded = await session.readExport(output);
    expect(downloaded?.byteLength ?? 0).toBeGreaterThan(0);
    expect(filesIn(tree).get(output)).toEqual(downloaded);
  } finally {
    session.close();
  }
});

test('a compile made before the folder is saved does not overwrite the folder’s file of that name, and the save names the file', async () => {
  const session = await sessionFor(manuscript());
  try {
    // The compile happens first, so its name was reserved from memory: the folder is not known yet.
    await session.exportsReady();
    const output = await compile(session, 'md');
    const { handle, tree } = memoryFolder();
    tree.children.set(EXPORTS_DIR, {
      kind: 'directory',
      children: new Map<string, Entry>([
        ['The Harbour.md', { kind: 'file', bytes: new TextEncoder().encode('earlier export') }],
      ]),
    });

    await expect(session.attachFolder(handle)).rejects.toThrow(`${EXPORTS_DIR}/The Harbour.md`);
    expect(session.exportsToFolder()).toBe(false);
    expect(textOf(filesIn(tree).get(`${EXPORTS_DIR}/The Harbour.md`))).toBe('earlier export');
    expect(await session.readExport(output)).not.toBeNull();

    // Once the writer has moved the earlier export aside, the same folder attaches, and the compile lands in it.
    const folderExports = tree.children.get(EXPORTS_DIR);
    if (folderExports?.kind === 'directory') folderExports.children.delete('The Harbour.md');
    await session.attachFolder(handle);
    expect(textOf(filesIn(tree).get(output))).toContain('The boat came in with the tide.');
  } finally {
    session.close();
  }
});

test('a first-time attach whose lazy exporter download failed still attaches the folder, and the next compile retries the load', async () => {
  const session = await sessionFor(manuscript());
  try {
    const { handle, tree } = memoryFolder();
    // The first compile's lazy download of the exporter failed, so the session holds the rejected load. `loadExporter`
    // keeps no failed download (its catch resets the field), so the next compile asks again; the test sets the field
    // as that catch leaves it after a failure.
    const internals = session as unknown as { exporterModule: Promise<unknown> | null };
    const failed = Promise.reject(new Error('the exporter chunk did not load'));
    failed.catch(() => undefined); // handled here, so the worker never sees it as unhandled before attachFolder reads it
    internals.exporterModule = failed;

    // The failed load is not a refusal: the exports and the pictures are attached all the same.
    await session.attachFolder(handle);
    expect(session.exportsToFolder()).toBe(true);
    expect(session.assetsInFolder()).toBe(true);

    // The next compile loads the exporter again, over the folder that is already attached, and lands in it.
    internals.exporterModule = null;
    await session.exportsReady();
    const output = await compile(session, 'md');
    expect(session.exportFailures()).toEqual([]);
    expect(textOf(filesIn(tree).get(output))).toContain('The boat came in with the tide.');
  } finally {
    session.close();
  }
});
