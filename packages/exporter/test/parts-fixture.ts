/**
 * A book with parts (#269): Part → Chapter → Scene, with a prologue and an epilogue at the top level beside the parts.
 *
 * ```
 * manuscript
 *   Prologue                 (a chapter at the top level)
 *     Before
 *   Part One                 (a part: it holds chapters)
 *     The Harbour            → Arrival, Lanterns
 *     The Island             → Crossing, Fog
 *     The Lamp               → Oil, Wick
 *   Part Two
 *     The Storm              → Wind, Glass
 *     The Wreck              → Rocks, Survivors
 *     The Dawn               → Ashore, Morning
 *   Epilogue                 (a chapter at the top level, after the parts)
 *     After
 * ```
 *
 * Two parts × three chapters × two scenes, plus the prologue and epilogue: the fixture the issue asks for. Not a test file.
 */

import { addDocument, addFolder, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';

export const PARTS_OPENED = new Date('2026-10-31T09:00:00.000Z');

export const PARTS_PROJECT_NAME = 'The Keeper in Two Parts';

export const PART_IDS = {
  prologue: 'n_PRE0000001',
  partOne: 'n_PARTA00001',
  partTwo: 'n_PARTB00001',
  epilogue: 'n_P0ST000001',
  harbour: 'n_HARB0R0001',
} as const;

/** The chapters of each part, with their two scenes, in binder order. */
export const PART_CHAPTERS: readonly { readonly part: 'partOne' | 'partTwo'; readonly title: string; readonly scenes: readonly [string, string] }[] = [
  { part: 'partOne', title: 'The Harbour', scenes: ['Arrival', 'Lanterns'] },
  { part: 'partOne', title: 'The Island', scenes: ['Crossing', 'Fog'] },
  { part: 'partOne', title: 'The Lamp', scenes: ['Oil', 'Wick'] },
  { part: 'partTwo', title: 'The Storm', scenes: ['Wind', 'Glass'] },
  { part: 'partTwo', title: 'The Wreck', scenes: ['Rocks', 'Survivors'] },
  { part: 'partTwo', title: 'The Dawn', scenes: ['Ashore', 'Morning'] },
];

/** A scene's body: one sentence that names it, so an output can be read for order. */
export function bodyOf(title: string): string {
  return `${title} happens here.`;
}

export function makePartsProject(): ProjectState {
  const state = createProjectState(createEmptyManifest(PARTS_PROJECT_NAME, PARTS_OPENED));
  state.manifest.project.id = 'p_PARTS00001';
  const now = PARTS_OPENED;

  addFolder(state, { parentId: 'manuscript', title: 'Prologue', now, id: PART_IDS.prologue });
  addDocument(state, { parentId: PART_IDS.prologue, title: 'Before', body: bodyOf('Before'), now });
  addFolder(state, { parentId: 'manuscript', title: 'Part One', now, id: PART_IDS.partOne });
  addFolder(state, { parentId: 'manuscript', title: 'Part Two', now, id: PART_IDS.partTwo });
  for (const chapter of PART_CHAPTERS) {
    const folder = addFolder(state, {
      parentId: PART_IDS[chapter.part],
      title: chapter.title,
      now,
      ...(chapter.title === 'The Harbour' ? { id: PART_IDS.harbour } : {}),
    });
    for (const scene of chapter.scenes) addDocument(state, { parentId: folder.id, title: scene, body: bodyOf(scene), now });
  }
  addFolder(state, { parentId: 'manuscript', title: 'Epilogue', now, id: PART_IDS.epilogue });
  addDocument(state, { parentId: PART_IDS.epilogue, title: 'After', body: bodyOf('After'), now });
  return state;
}
