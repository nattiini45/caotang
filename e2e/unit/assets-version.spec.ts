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
  // The constructor lists the images without being awaited, and the listing below supersedes that one; waiting for the
  // versions to settle takes the baseline no straggler can still move.
  await session.refreshAssetRecords();
  const listed = await settled(session);

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

/**
 * Waits until the version has moved.
 *
 * The session says when it has moved (its own change notice), so the wait ends at the moment the
 * listing that moved it is done. A timer would add its own round to every wait, and the latch that
 * holds one moment at the front of the tab is a window of fixed length: a wait that spends part of
 * that window on a timer is a wait that can miss the window and see a listing the product never
 * made.
 */
async function moved(session: ProjectSession, from: number): Promise<void> {
  if (session.assetsVersion() > from) return;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let detach: (() => void) | null = null;
    const finish = (failure: Error | null): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      if (detach !== null) detach();
      if (failure === null) resolve();
      else reject(failure);
    };
    timer = setTimeout(() => finish(new Error('the images were not listed again')), 2000);
    detach = session.subscribe(() => {
      if (session.assetsVersion() > from) finish(null);
    });
    // The version can have moved between the check above and the subscription, so it is asked again.
    if (session.assetsVersion() > from) finish(null);
  });
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

  // The document's visibility is the other half of the same moment, and the latch that answers a moment
  // holds it: the images are not listed a second time for the moment the focus already answered.
  // The signal is posted as soon as the listing has moved, and not after the version has settled: the
  // latch holds the moment for a window of fixed length, and a wait that spends part of that window
  // can miss it and see the listing of a later moment.
  const same = session.assetsVersion();
  fakeDocument.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(session.assetsVersion()).toBe(same);
  // And the one moment cost one listing: the version moved once, and not twice.
  expect(await settled(session)).toBe(before + 1);

  // A later moment is its own listing: the document's visibility, once the latch has let go.
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

test('one moment at the front asks for one listing, not one per signal', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({
    store,
    projectId: state.manifest.project.id,
    state,
    shadow: null,
  });
  await session.assets.attach(memoryFolder().handle);
  await session.refreshAssetRecords();
  const before = await settled(session);

  // A hidden tab coming to the front fires the window's focus and the document's visibilitychange for the same moment.
  // Both arrive in this turn of the event loop, and the moment costs one listing, not two.
  fakeWindow.dispatchEvent(new Event('focus'));
  fakeDocument.dispatchEvent(new Event('visibilitychange'));
  await moved(session, before);
  expect(await settled(session)).toBe(before + 1);

  // A later moment is its own listing: the latch of the first has let go.
  const after = session.assetsVersion();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fakeWindow.dispatchEvent(new Event('focus'));
  await moved(session, after);
  expect(await settled(session)).toBe(after + 1);
  await session.close();
});

test('one moment at the front asks for one listing even when the platform posts its two signals in different tasks', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({
    store,
    projectId: state.manifest.project.id,
    state,
    shadow: null,
  });
  await session.assets.attach(memoryFolder().handle);
  await session.refreshAssetRecords();
  const before = await settled(session);

  // The platform does not promise to post the two signals of one moment in the same task: the second can
  // arrive after the latch's own macrotask would have run, and the moment still costs one listing.
  fakeWindow.dispatchEvent(new Event('focus'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  fakeDocument.dispatchEvent(new Event('visibilitychange'));
  await moved(session, before);
  expect(await settled(session)).toBe(before + 1);
  await session.close();
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
