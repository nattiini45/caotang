import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore, writeProjectState, ZIP_ENGINE } from '../../packages/store/src/index.js';

import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import { exportStoredBundle } from '../../apps/desktop/src/app/lifecycle.js';

/**
 * The app's own copy of a project (lifecycle.ts `exportStoredBundle`).
 *
 * The folder-adopt flow keeps this browser's copy in memory as a bundle before it removes the copy
 * (lifecycle.ts `answerFolderDiffers`), and that bundle is the app's own, not the writer's: a file
 * the load could not read is left out of it and named in the report, where the writer's own copy
 * refuses it (write.ts `WriteOptions.copyFor`).
 */

test('the app’s own copy leaves a file it cannot hold out of it, where the writer’s copy refuses', async () => {
  const state = sampleProjectState();
  // A codex file the load could not read: its bytes are not UTF-8 text, so the state holds no text for it.
  state.declinedCodexFiles.add('elena.md');
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const projectId = state.manifest.project.id;

  // The writer's own copy refuses a file it cannot hold, so a bundle that would lose it is not made.
  await expect(exportStoredBundle(store, projectId)).rejects.toThrow(/not UTF-8/);

  // The app's own copy leaves it out and carries on, so the adopt flow can keep its safety copy.
  const bundle = await exportStoredBundle(store, projectId, 'internal');
  const { unzipSync } = await ZIP_ENGINE.load();
  const files = unzipSync(bundle.bytes);
  expect(files['codex/elena.md']).toBeUndefined();
  expect(files['caotang.json']).toBeDefined();
});
