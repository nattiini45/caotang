import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, getBody, getRevision, openRuntimeStore, type ProjectState } from '../../packages/store/src/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';

import { IDS, project } from './fixtures.js';

/**
 * Working copies and the typing an editor holds (pictures.md §6.4). `asset.storeWorkingCopies` rewrites every inline reference to a
 * replaced picture in the stored bodies, and a mounted editor drops its copy of a body the store rewrote, so the session saves the
 * typing first and refuses the batch, rewriting nothing, while any of it could not be saved.
 *
 * The session wires its autosave to the page's visibility and page-hide events, which this file stands in for with event targets.
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

async function sessionFor(state: ProjectState): Promise<ProjectSession> {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  return new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
}

const INLINE = 'The lamp. ![The lamp](../assets/a_LAMP000001.jpg)';

test('typing that cannot be saved refuses the working copies, and no body or record is touched', async () => {
  const state = project();
  const session = await sessionFor(state);
  try {
    session.dispatch('doc.write', { docId: IDS.sceneA, body: INLINE });
    const stored = getBody(session.state, IDS.sceneA);
    const assets = JSON.stringify(session.state.manifest.assets ?? []);
    // The editor slot is behind the store (revision 0), so the flush cannot store what was typed into it.
    session.autosave.open(IDS.sceneA, { body: '', revision: 0 });
    session.autosave.noteEdit(IDS.sceneA, `${INLINE} Typed words that never reached the store.`);

    const result = await session.storeWorkingCopies(['a_LAMP000001']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('revision-conflict');
    expect(result.error.message).toContain('no working copy was stored and nothing was changed');
    expect(getBody(session.state, IDS.sceneA)).toBe(stored);
    expect(JSON.stringify(session.state.manifest.assets ?? [])).toBe(assets);
    // The typing is still the editor's, unsaved, for the writer to keep.
    expect(session.autosave.dirtyDocIds()).toContain(IDS.sceneA);
  } finally {
    session.close();
  }
});

test('typing that can be saved is stored before the working copies run, so the rewrite starts from it', async () => {
  const session = await sessionFor(project());
  try {
    session.dispatch('doc.write', { docId: IDS.sceneA, body: INLINE });
    session.autosave.open(IDS.sceneA, { body: getBody(session.state, IDS.sceneA), revision: getRevision(session.state, IDS.sceneA) });
    session.autosave.noteEdit(IDS.sceneA, `${INLINE} Typed and not yet saved.`);

    await session.storeWorkingCopies(['a_LAMP000001']);
    expect(session.autosave.dirtyDocIds()).not.toContain(IDS.sceneA);
    expect(getBody(session.state, IDS.sceneA)).toBe(`${INLINE} Typed and not yet saved.`);
  } finally {
    session.close();
  }
});
