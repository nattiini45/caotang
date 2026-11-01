/**
 * A project for the model tests, built through the store's own constructors so the shape
 * is the one the app holds. Ids are fixed so a test can name a node.
 *
 *   manuscript
 *     Chapter 1 (folder, expanded by default)
 *       Scene A  (document, 4 words)
 *       Scene B  (document, 2 words)
 *       Scene C  (document)
 *       Deep     (folder, collapsed by default: it sits one level under a folder)
 *         Deep scene (document, 3 words)
 *     Chapter 2 (folder)
 *       Scene D  (document)
 *   research
 *     Note      (document)
 */

// The root package does not depend on the workspace packages, so the store is reached by its
// source path. The app's own modules resolve `@caotang/store` from apps/desktop; this is the
// same file, so the same module instance.
import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  type ProjectState,
} from '../../packages/store/src/index.js';

// Node ids must be "n_" plus ten Crockford base32 characters (project-format §2), so the
// fixture ids are shaped like the generated ones: readable, and valid to the loader.
export const IDS = {
  chapterOne: 'n_CH100000AA',
  chapterTwo: 'n_CH200000AA',
  sceneA: 'n_SCA0000001',
  sceneB: 'n_SCB0000001',
  sceneC: 'n_SCC0000001',
  deep: 'n_DEEP000001',
  deepScene: 'n_DSC0000001',
  sceneD: 'n_SCD0000001',
  note: 'n_NTE0000001',
} as const;

export function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('Fixture Book', new Date('2026-10-08T09:00:00Z'), { locale: 'en-US' }));
  const now = new Date('2026-10-08T09:00:00Z');
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', id: IDS.chapterOne, now });
  addDocument(state, { parentId: IDS.chapterOne, title: 'Scene A', id: IDS.sceneA, body: 'Four little words here', now });
  addDocument(state, { parentId: IDS.chapterOne, title: 'Scene B', id: IDS.sceneB, body: 'Two words', now });
  addDocument(state, { parentId: IDS.chapterOne, title: 'Scene C', id: IDS.sceneC, now });
  addFolder(state, { parentId: IDS.chapterOne, title: 'Deep', id: IDS.deep, now });
  addDocument(state, { parentId: IDS.deep, title: 'Deep scene', id: IDS.deepScene, body: 'Three words, then', now });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 2', id: IDS.chapterTwo, now });
  addDocument(state, { parentId: IDS.chapterTwo, title: 'Scene D', id: IDS.sceneD, now });
  addDocument(state, { parentId: 'research', title: 'Note', id: IDS.note, now });
  return state;
}
