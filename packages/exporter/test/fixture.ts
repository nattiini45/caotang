/**
 * A small, deliberately awkward project shared by the exporter tests.
 *
 * Its shape exercises every flatten rule at once:
 *
 * ```
 * manuscript
 *   Prologue                      (loose scene, `order` 5 — first, though created last)
 *   Chapter One
 *     The Landing                 (two paragraphs with inline marks)
 *     The Storm                   (an in-body thematic break)
 *   Chapter Two
 *     The Call                    (empty — skipped, with a note)
 *     Morning                     (the only scene, so no separator)
 *   Chapter Three
 *     Blank                       (empty — skipped, so Chapter Three gets no heading)
 * research
 *   Ferry timetable               (only compiled when named explicitly)
 * ```
 */

import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  type ProjectState,
} from '@caotang/store';

export const OPENED = new Date('2026-10-02T15:00:00.000Z');

/** The instant the compile tests stamp into the log and the EPUB metadata. */
export const COMPILED_AT = Date.parse('2026-10-08T09:30:00.000Z');

export const PROJECT_NAME = 'The Lighthouse Keeper';

export const IDS = {
  prologue: 'n_PROLOGUE1',
  chapterOne: 'n_CHAPTER01',
  landing: 'n_LANDING01',
  storm: 'n_STORM0001',
  chapterTwo: 'n_CHAPTER02',
  call: 'n_CALL000001',
  morning: 'n_MORNING01',
  chapterThree: 'n_CHAPTER03',
  blank: 'n_BLANK00001',
  timetable: 'n_TIMETABLE1',
} as const;

export const BODIES = {
  prologue: 'The keeper had been alone on the rock for nine years.',
  landing: 'The ferry was late, as always.\n\nElena *stepped* onto the **quay** and [waved](https://example.com/wave).',
  storm: 'He counted the ships, and the ships counted him.\n\n***\n\nThe glass fell all night.',
  morning: 'Light, at last.',
  timetable: 'Ferry at nine.',
} as const;

/** Declares a scene's export style on its binder node, as the Inspector's `binder.setMeta` does (exporter.md §2). */
export function withSceneStyle(state: ProjectState, id: string, style: string): ProjectState {
  const node = state.manifest.tree.find((entry) => entry.id === id);
  if (node === undefined) throw new Error(`the fixture has no node ${id}`);
  node.style = style;
  return state;
}

export function makeProject(): ProjectState {
  const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED));
  state.manifest.project.id = 'p_9XK2M4Q7RZ';

  addDocument(state, { parentId: 'manuscript', title: 'Prologue', body: BODIES.prologue, now: OPENED, id: IDS.prologue });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter One', now: OPENED, id: IDS.chapterOne });
  addDocument(state, { parentId: IDS.chapterOne, title: 'The Landing', body: BODIES.landing, now: OPENED, id: IDS.landing });
  addDocument(state, { parentId: IDS.chapterOne, title: 'The Storm', body: BODIES.storm, now: OPENED, id: IDS.storm });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter Two', now: OPENED, id: IDS.chapterTwo });
  addDocument(state, { parentId: IDS.chapterTwo, title: 'The Call', body: '   \n  ', now: OPENED, id: IDS.call });
  addDocument(state, { parentId: IDS.chapterTwo, title: 'Morning', body: BODIES.morning, now: OPENED, id: IDS.morning });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter Three', now: OPENED, id: IDS.chapterThree });
  addDocument(state, { parentId: IDS.chapterThree, title: 'Blank', body: '', now: OPENED, id: IDS.blank });
  addDocument(state, { parentId: 'research', title: 'Ferry timetable', body: BODIES.timetable, now: OPENED, id: IDS.timetable });

  // Created last, placed first: flatten must follow `order`, not creation.
  const prologue = state.manifest.tree.find((node) => node.id === IDS.prologue);
  if (prologue !== undefined) prologue.order = 5;

  return state;
}
