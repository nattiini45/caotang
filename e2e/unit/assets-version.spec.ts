import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore } from '../../packages/store/src/index.js';
import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';

import { memoryFolder } from './memory-folder.js';

/**
 * The session's assets version (session.ts): the views that show the project's images list them when
 * it moves, so a change of the session that leaves the images alone does not list them again.
 */

// The session is the app's own, and it reads the window and the document to know when the tab is
// hidden; Node has none, so they are stood in for (the agent's session spec does the same).
const globals = globalThis as unknown as Record<string, unknown>;
const fakeDocument = new EventTarget();
const fakeWindow = new EventTarget();
let previous: { document: unknown; window: unknown } | null = null;

test.beforeAll(() => {
  previous = { document: globals['document'], window: globals['window'] };
  globals['document'] = fakeDocument;
  globals['window'] = fakeWindow;
});

test.afterAll(() => {
  if (previous === null) return;
  globals['document'] = previous.document;
  globals['window'] = previous.window;
});

test('the assets version moves when the images are listed again, and not when the session changes', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({
    store,
    projectId: state.manifest.project.id,
    state,
    shadow: null,
  });
  await session.refreshAssetRecords();
  const listed = session.assetsVersion();

  // A change of the session that leaves the images alone does not move the version, so the views
  // that show them do not list them again.
  session.bump();
  expect(session.assetsVersion()).toBe(listed);

  // Listing the images again moves it, so a view that shows them lists them again.
  await session.refreshAssetRecords();
  expect(session.assetsVersion()).toBeGreaterThan(listed);
  await session.close();
});

/** The version the session's image listings have settled at. */
async function settled(session: ProjectSession): Promise<number> {
  let last = -1;
  let quiet = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const now = session.assetsVersion();
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    if (quiet >= 3) return now;
  }
  throw new Error('the image listings did not settle');
}

/** Waits until the version has moved, and answers the version it moved to. */
async function moved(session: ProjectSession, from: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (session.assetsVersion() > from) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the images were not listed again');
}

test('the images are listed again when the tab comes back to the front', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({
    store,
    projectId: state.manifest.project.id,
    state,
    shadow: null,
  });
  // A project with a folder: a picture can be put into it from outside the app.
  await session.assets.attach(memoryFolder().handle);
  await session.refreshAssetRecords();
  const before = await settled(session);

  // The window comes back to the front: the images are listed again, once.
  fakeWindow.dispatchEvent(new Event('focus'));
  await moved(session, before);
  expect(await settled(session)).toBe(before + 1);

  // The document's visibility is the other half of the same moment.
  const after = session.assetsVersion();
  fakeDocument.dispatchEvent(new Event('visibilitychange'));
  await moved(session, after);
  expect(await settled(session)).toBe(after + 1);

  // The listener belongs to the session, and the session lets it go when it closes.
  await session.close();
  const closed = session.assetsVersion();
  fakeWindow.dispatchEvent(new Event('focus'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(session.assetsVersion()).toBe(closed);
});

test('a project without a folder lists nothing when the tab comes back', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({
    store,
    projectId: state.manifest.project.id,
    state,
    shadow: null,
  });
  await session.refreshAssetRecords();
  const before = await settled(session);

  // There is no folder to pick a picture up from, so there is nothing to list.
  fakeWindow.dispatchEvent(new Event('focus'));
  fakeDocument.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(session.assetsVersion()).toBe(before);
  await session.close();
});
