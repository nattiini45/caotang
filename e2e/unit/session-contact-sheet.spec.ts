import { expect, test } from '@playwright/test';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { addShotNode, addStoryboardFolder } from '../../packages/storyboard/src/index.js';
import {
  MemoryIndexedDb,
  createEmptyManifest,
  createProjectState,
  openRuntimeStore,
  type ExportCommandDigest,
  type ProjectState,
} from '../../packages/store/src/index.js';

/**
 * The storyboard contact sheet a desktop compile writes (storyboard.md §6): a PDF in the session's export store, with the picture
 * the shot holds read from the session's asset store, so the card draws it and the compile log names no missing picture.
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

const NOW = new Date(Date.UTC(2026, 9, 17, 9, 0, 0));
const FOLDER = 'n_SBFOLDER01';
const SHOT = 'n_SHOTA00001';
// A valid asset id: `a_` and ten Crockford base32 characters (no I, L, O or U).
const ASSET = 'a_ABCDEF2345';
/** A 1×1 PNG: a real image the PDF engine can embed. */
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

function board(): ProjectState {
  const state = createProjectState(createEmptyManifest('Film', NOW, { locale: 'en-US' }));
  addStoryboardFolder(state, { parentId: 'manuscript', title: 'Scene 1 — Shots', id: FOLDER, now: NOW });
  addShotNode(state, { parentId: FOLDER, id: SHOT, title: 'Wide', stored: { shotSize: 'WS', durationSec: 4, image: ASSET }, now: NOW });
  return state;
}

test('a contact-sheet compile writes a PDF that draws the picture the shot holds', async () => {
  const state = board();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  await session.assets.writeBytes(`assets/${ASSET}.png`, PNG);
  await session.refreshAssetRecords();
  await session.exportsReady();

  const outcome = session.dispatch('export.compileSelection', { includeRootIds: [FOLDER], format: 'contact-sheet-pdf' });
  if (!outcome.ok) throw new Error(`the compile was refused: ${outcome.error.message}`);
  const digest = outcome.value.result as ExportCommandDigest;
  await session.exportsIdle();
  expect(session.exportFailures()).toEqual([]);

  expect(digest.output).toBe('exports/Scene 1 — Shots (contact sheet).pdf');
  const written = (await session.readExport(digest.output)) ?? new Uint8Array();
  expect(new TextDecoder().decode(written.slice(0, 5))).toBe('%PDF-');
  expect(digest.notes.join('\n')).not.toContain('caption');
  expect(digest.notes).toContain('contact sheet: 1 page of 15 shots each, A4');
});
