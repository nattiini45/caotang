/**
 * A [command-bus.md §9](docs/architecture/command-bus.md) snapshot to validate
 * against — the shape of the real one, from project-format §2's worked example
 * (`docs/architecture/project-format.md` §2) so the fixtures are not invented.
 *
 * `ValidationSnapshot` is the bus's own read-view, declared in `src/command.ts`
 * because the dependency runs store → bus. `ProjectState` satisfies it
 * structurally; that assignability is pinned on the store's side in
 * `packages/store/test/bus-snapshot.test.ts`.
 */

import type { ValidationCoherence, ValidationNode, ValidationSnapshot } from '../src/index.js';

export const ROOT = 'root';
export const MANUSCRIPT = 'manuscript';
export const RESEARCH = 'research';
export const CHAPTER_ONE = 'n_7K2QX9M4A1';
export const THE_LANDING = 'n_3W8RN2TQ6C';
export const CHAPTER_TWO = 'n_5T4RW9KZB2';
export const CODEX_ENTRY = 'c_2H7KD4M9QP';
export const UNKNOWN_ID = 'n_ZZZZZZZZZZ';

export const BODY = 'Elena returns to the island.';
export const REVISION = 7;

function node(partial: Partial<ValidationNode> & Pick<ValidationNode, 'id' | 'parentId' | 'type'>): ValidationNode {
  return {
    title: partial.id,
    status: null,
    label: null,
    keywords: [],
    synopsis: '',
    notes: '',
    ...partial,
  };
}

export function makeSnapshot(overrides: {
  tree?: ValidationNode[];
  /**
   * Nodes appended to the default tree, for a row that needs a node the default lacks (a storyboard folder, a shot).
   * `tree` replaces the default tree outright; `extraNodes` adds to it, so the default is left as it is.
   */
  extraNodes?: readonly (Partial<ValidationNode> & Pick<ValidationNode, 'id' | 'parentId' | 'type'>)[];
  bodies?: Record<string, string>;
  statuses?: string[];
  labels?: string[];
  codex?: { id: string; name: string }[];
  /** The saved export recipes (exporter.md §2), for the rows whose refusals read them. Absent means none. */
  recipes?: { name: string; includeRootIds?: string[] }[];
  /** The coherence file (coherence.md §3), for the rows whose refusals read its findings, scene declarations or runs. */
  coherence?: ValidationCoherence;
  /** The project's skills (extensibility.md §10) by folder, each file as its path and the length of its bytes, for the skill rows. Absent means none. */
  skills?: Record<string, { path: string; length: number }[]>;
  /** The skills the writer turned off. Absent means every skill is on. */
  disabledSkills?: string[];
} = {}): ValidationSnapshot {
  const tree =
    overrides.tree ??
    [
      node({ id: ROOT, parentId: null, type: 'root', title: 'The Lighthouse Keeper' }),
      node({ id: MANUSCRIPT, parentId: ROOT, type: 'folder', title: 'Manuscript' }),
      node({ id: RESEARCH, parentId: ROOT, type: 'folder', title: 'Research' }),
      node({ id: CHAPTER_ONE, parentId: MANUSCRIPT, type: 'folder', title: 'Chapter 1' }),
      node({
        id: THE_LANDING,
        parentId: CHAPTER_ONE,
        type: 'document',
        title: 'The Landing',
        status: 'draft',
        label: 'act-1',
        keywords: ['sea', 'grief'],
        synopsis: 'Elena returns to the island.',
        notes: 'Fix pacing in the last three paragraphs.',
      }),
      node({ id: CHAPTER_TWO, parentId: MANUSCRIPT, type: 'folder', title: 'Chapter 2' }),
      ...(overrides.extraNodes ?? []).map((extra) => node(extra)),
    ];
  const bodies =
    overrides.bodies ?? ({ [THE_LANDING]: BODY } as Record<string, string>);
  const documents = new Map(
    Object.entries(bodies).map(([id, body]) => [id, { body, revision: REVISION }]),
  );
  return {
    manifest: {
      tree,
      vocabulary: {
        statuses: (overrides.statuses ?? ['draft', 'revised', 'final']).map((id) => ({ id })),
        labels: (overrides.labels ?? ['act-1', 'act-2']).map((id) => ({ id })),
      },
      codex: overrides.codex ?? [{ id: CODEX_ENTRY, name: 'Elena' }],
      ...(overrides.recipes === undefined ? {} : { recipes: overrides.recipes }),
      ...(overrides.disabledSkills === undefined ? {} : { disabledSkills: overrides.disabledSkills }),
    },
    documents,
    ...(overrides.coherence === undefined ? {} : { coherence: overrides.coherence }),
    ...(overrides.skills === undefined
      ? {}
      : { skills: new Map(Object.entries(overrides.skills).map(([folder, files]) => [folder, files.map((f) => ({ path: f.path, bytes: { length: f.length } }))])) }),
  };
}

/** A node carrying `keywords`, for the keyword-limit rules. */
export function nodeWithKeywords(keywords: string[]): ValidationNode {
  return node({
    id: THE_LANDING,
    parentId: CHAPTER_ONE,
    type: 'document',
    keywords,
  });
}
