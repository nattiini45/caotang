/**
 * Fixtures shared by the coherence tests. Projects are built with the store's own
 * primitives (`createEmptyManifest`, `addFolder`, `addDocument`), so a fixture
 * cannot drift from the shape the store really produces.
 */

import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  type CodexEntry,
  type ProjectState,
} from '@caotang/store';

import type { MentionDetector } from '../src/index.js';

export const NOW = new Date('2026-10-01T09:00:00.000Z');
export const LATER = new Date('2026-10-02T09:00:00.000Z');

export interface SceneSpec {
  readonly id: string;
  readonly title: string;
  readonly parent?: string;
  readonly body?: string;
  readonly status?: string | null;
  readonly synopsis?: string;
}

export interface FolderSpec {
  readonly id: string;
  readonly title: string;
  readonly parent?: string;
}

export function buildState(options: {
  readonly folders?: readonly FolderSpec[];
  readonly scenes?: readonly SceneSpec[];
  readonly research?: readonly SceneSpec[];
  readonly entries?: readonly CodexEntry[];
}): ProjectState {
  const manifest = createEmptyManifest('Fixture', NOW);
  manifest.codex = [...(options.entries ?? [])];
  const state = createProjectState(manifest, { now: NOW });
  for (const folder of options.folders ?? []) {
    addFolder(state, { id: folder.id, parentId: folder.parent ?? 'manuscript', title: folder.title, now: NOW });
  }
  for (const scene of options.scenes ?? []) {
    addDocument(state, {
      id: scene.id,
      parentId: scene.parent ?? 'manuscript',
      title: scene.title,
      body: scene.body ?? '',
      status: scene.status ?? null,
      synopsis: scene.synopsis ?? '',
      now: NOW,
    });
  }
  for (const scene of options.research ?? []) {
    addDocument(state, { id: scene.id, parentId: scene.parent ?? 'research', title: scene.title, body: scene.body ?? '', now: NOW });
  }
  return state;
}

export function entry(id: string, name: string, extra: Partial<CodexEntry> = {}): CodexEntry {
  return {
    id,
    name,
    aliases: [],
    type: 'character',
    description: `${name}, described.`,
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...extra,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One dialogue anchor as a shot stores it (edit-anchors §2). */
export type Anchor = { from: number; to: number; exact: string; prefix: string; suffix: string; capturedRevision: number };

/** A storyboard shot node in the tree, as the storyboard writes one: a node of type `shot` with its metadata under `shot`. */
export function addShot(
  state: ProjectState,
  id: string,
  shot: { readonly durationSec?: number; readonly dialogue?: readonly { docId: string; anchor: Anchor }[] },
): void {
  const tree = state.manifest.tree;
  const node = {
    id,
    parentId: 'manuscript',
    type: 'shot',
    title: `Shot ${id}`,
    order: 10 * (tree.length + 1),
    status: null,
    label: null,
    keywords: [],
    synopsis: '',
    notes: '',
  } as (typeof tree)[number];
  Object.assign(node, {
    shot: {
      ...(shot.durationSec !== undefined ? { durationSec: shot.durationSec } : {}),
      ...(shot.dialogue !== undefined
        ? { dialogue: shot.dialogue.map((entry) => ({ kind: 'fountain-element', docId: entry.docId, anchor: entry.anchor })) }
        : {}),
    },
  });
  tree.push(node);
}

/** Counts whole-word occurrences of a term, the Latin-boundary rule of codex.md §4 rule 2. */
function countTerm(body: string, term: string): number {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'giu');
  return [...body.matchAll(pattern)].length;
}

/** A stand-in for codex's detector: names and aliases, case-insensitive, word-bounded. */
export const detect: MentionDetector = (body, entries) => {
  const hits = new Map<string, number>();
  for (const candidate of entries) {
    let total = 0;
    for (const term of [candidate.name, ...candidate.aliases]) total += countTerm(body, term);
    if (total > 0) hits.set(candidate.id, total);
  }
  return hits;
};
