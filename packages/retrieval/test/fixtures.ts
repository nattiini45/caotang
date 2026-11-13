import { addDocument, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';

export const id = (index: number): string => `n_${String(index).padStart(10, '0')}`;
export function project(bodies: readonly string[], language = 'en'): ProjectState {
  const now = new Date('2026-11-13T12:00:00.000Z');
  const state = createProjectState(createEmptyManifest('Lexical fixture', now));
  state.manifest.project.language = language;
  for (const [index, body] of bodies.entries()) addDocument(state, { id: id(index), parentId: 'manuscript', title: `Scene ${index}`, body, now });
  return state;
}

export function entry(state: ProjectState): void {
  state.manifest.codex = [{ id: 'c_SEARCH0001', name: 'Iona', aliases: ['The keeper'], type: 'character', description: 'The lighthouse keeper.', includePolicy: 'detected', caseSensitive: false, exclude: [], attachments: [], keywords: [], origin: 'manual', sources: [] }];
}
