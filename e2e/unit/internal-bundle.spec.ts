import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore, writeProjectState, ZIP_ENGINE } from '../../packages/store/src/index.js';

import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import { exportStoredBundle } from '../../apps/desktop/src/app/lifecycle.js';

/**
 * The app's own copy of a project (lifecycle.ts `exportStoredBundle`).
 *
 * The folder-adopt flow keeps this browser's copy in memory as a bundle before it removes the copy
 * (lifecycle.ts `answerFolderDiffers`), and that bundle is the app's own, not the writer's: a file
 * the load could not read is named in the bundle's notices, which an adopt failure carries out with
 * its report, where the writer's own copy refuses it (write.ts `WriteOptions.copyFor`).
 *
 * The two kinds of file are told apart, because they are not the same thing: a codex file the copy
 * cannot carry is left out of it, while a document the load held is held by the copy as an empty
 * file. Saying "leaves it out" of a file the copy holds would be a lie.
 */

test('the app’s own copy leaves a file it cannot hold out of it, where the writer’s copy refuses', async () => {
  const state = sampleProjectState();
  // A codex file the load could not read: its bytes are not UTF-8 text, so the state holds no text for it. A real load
  // declines only entry files, and codex.md §3 names those `<entry-id>.md` (read.ts), so the fixture is shaped like one —
  // which also says the behavior below does not depend on the id's shape.
  state.declinedCodexFiles.add('c_7K2QX9M4A1.md');
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const projectId = state.manifest.project.id;

  // The writer's own copy refuses a file it cannot hold, so a bundle that would lose it is not made.
  await expect(exportStoredBundle(store, projectId)).rejects.toThrow(/not UTF-8/);

  // The app's own copy leaves it out and carries on, so the adopt flow can keep its safety copy.
  const bundle = await exportStoredBundle(store, projectId, 'internal');
  const { unzipSync } = await ZIP_ENGINE.load();
  const files = unzipSync(bundle.bytes);
  expect(files['codex/c_7K2QX9M4A1.md']).toBeUndefined();
  expect(files['caotang.json']).toBeDefined();
  // The omission is not silent: the bundle's notices name the file it leaves out.
  expect(bundle.notices.join(' ')).toContain('codex/c_7K2QX9M4A1.md');
  expect(bundle.omissions.join(' ')).toContain('codex/c_7K2QX9M4A1.md');
});

test('the app’s own copy holds a document the load declined as an empty file, and says that', async () => {
  const state = sampleProjectState();
  // A document the load could not read: its bytes are not UTF-8 text, so the state holds no body for it and
  // only the name of the file it could not read.
  const node = state.manifest.tree.find((item) => item.type === 'document');
  expect(node).toBeDefined();
  state.documents.delete(node!.id);
  state.declinedDocFiles.add(`${node!.id}.md`);
  // A cover this browser does not hold either, so the notices hold a notice that is not about a file.
  state.manifest.project.coverAssetId = 'a_NOHELD0001';
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const projectId = state.manifest.project.id;

  const bundle = await exportStoredBundle(store, projectId, 'internal');
  const { unzipSync } = await ZIP_ENGINE.load();
  const files = unzipSync(bundle.bytes);

  // The copy holds the file, and it holds it empty: the document is not left out of the copy.
  expect(files[`docs/${node!.id}.md`]).toBeDefined();
  const notices = bundle.notices.join(' ');
  expect(notices).toContain(`docs/${node!.id}.md`);
  expect(notices).toContain('holds an empty file in its place');
  expect(notices).not.toContain(`“docs/${node!.id}.md” is not UTF-8 text, so this copy leaves it out`);

  // The notices about the files are kept apart from the other notices: an adopt failure reports what the
  // copy does not hold, and a cover this browser does not hold says nothing about the files.
  expect(bundle.omissions.join(' ')).toContain('holds an empty file in its place');
  expect(bundle.omissions.join(' ')).not.toContain('cover image is not available');
  expect(notices).toContain('cover image is not available');
});
