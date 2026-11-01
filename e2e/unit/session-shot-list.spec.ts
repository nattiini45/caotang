import { expect, test } from '@playwright/test';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { addShotNode, addStoryboardFolder } from '../../packages/storyboard/src/index.js';
import {
  EXPORTS_DIR,
  MemoryIndexedDb,
  createEmptyManifest,
  createProjectState,
  openRuntimeStore,
  type ExportCommandDigest,
  type ProjectState,
} from '../../packages/store/src/index.js';

/**
 * The shot list a desktop compile writes names each shot's image by its file in `assets/`. The exporter reads the images it names
 * from the map the session holds, and the session lists them again before an export is asked for, so a compile sees the images the
 * project holds, and a listing it cannot make refuses the compile rather than writing "has no file" for every image.
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

const NOW = new Date('2026-10-09T09:00:00Z');
const FOLDER = 'n_SBFOLDER01';
const SHOT = 'n_SHOTA00001';
// A valid asset id: `a_` and ten Crockford base32 characters (no I, L, O or U).
const ASSET = 'a_ABCDEF2345';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A film with one shot that holds an image, in a folder under the manuscript, so the manuscript's compile reaches it. */
function board(): ProjectState {
  const state = createProjectState(createEmptyManifest('Film', NOW, { locale: 'en-US' }));
  addStoryboardFolder(state, { parentId: 'manuscript', title: 'Scene 1 — Shots', id: FOLDER, now: NOW });
  addShotNode(state, { parentId: FOLDER, id: SHOT, title: 'Wide', stored: { shotSize: 'WS', durationSec: 4, image: ASSET }, now: NOW });
  return state;
}

async function sessionFor(state: ProjectState): Promise<ProjectSession> {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  return new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
}

test('a shot-list compile names the image a shot holds by its file in assets/, and writes no note that the file is missing', async () => {
  const session = await sessionFor(board());
  await session.assets.writeBytes(`assets/${ASSET}.png`, PNG);
  await session.exportsReady();

  const outcome = session.dispatch('export.compile', { format: 'shot-list-csv' });
  if (!outcome.ok) throw new Error(`the compile was refused: ${outcome.error.message}`);
  const digest = outcome.value.result as ExportCommandDigest;
  await session.exportsIdle();

  const written = new TextDecoder().decode((await session.readExport(digest.output)) ?? new Uint8Array());
  expect(written).toContain(`${ASSET}.png`);
  expect(digest.notes.join('\n')).not.toContain('has no file in assets/');
});

test('a slow image listing started earlier does not replace the newer listing a compile reads', async () => {
  const session = await sessionFor(board());
  await session.assets.writeBytes(`assets/${ASSET}.png`, PNG);
  await session.exportsReady();
  // The first listing from here on is held back and, when let go, reads an empty folder (as one taken before a bundle's images
  // loaded would); the second reads the folder as it is. The first finishes last.
  const real = session.assets.artifactFs();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opened = 0;
  session.assets.artifactFs = () => {
    opened += 1;
    if (opened > 1) return real;
    return {
      ...real,
      listFiles: async () => {
        await gate;
        return [];
      },
    };
  };
  const slow = session.refreshAssetRecords();
  await session.exportsReady();
  release();
  await slow;

  const outcome = session.dispatch('export.compile', { format: 'shot-list-csv' });
  if (!outcome.ok) throw new Error(`the compile was refused: ${outcome.error.message}`);
  const digest = outcome.value.result as ExportCommandDigest;
  await session.exportsIdle();
  const written = new TextDecoder().decode((await session.readExport(digest.output)) ?? new Uint8Array());
  expect(written).toContain(`${ASSET}.png`);
  expect(digest.notes.join('\n')).not.toContain('has no file in assets/');
});

test('a compile is refused, and writes no shot list, when the project’s images cannot be listed', async () => {
  const session = await sessionFor(board());
  await session.assets.writeBytes(`assets/${ASSET}.png`, PNG);
  // The folder the images sit in cannot be listed: the listing fails, and the compile that needs the images is refused with that error.
  const real = session.assets.artifactFs();
  session.assets.artifactFs = () => ({
    ...real,
    listFiles: async () => {
      throw new Error('EACCES: permission denied, scandir assets');
    },
  });
  await session.exportsReady();

  const outcome = session.dispatch('export.compile', { format: 'shot-list-csv' });
  // A refusal the writer can act on, which names the reason, and not a defect in the apply: nothing was exported.
  if (outcome.ok) throw new Error('the compile ran without the images it names');
  expect(outcome.error.code).toBe('io-error');
  expect(outcome.error.message).toContain('EACCES');
  expect(outcome.error.message).toContain('no export was written');

  // Nothing reaches exports/: no shot list, text or binary, once every queued write has settled.
  await session.exportsIdle();
  const held = [...(await session.exports.artifacts.listFiles(EXPORTS_DIR)), ...((await session.exports.bytes.listFiles?.(EXPORTS_DIR)) ?? [])];
  expect(held.filter((name) => name.endsWith('.csv'))).toEqual([]);
});
