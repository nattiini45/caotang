/**
 * Fixtures for the timeline tests. Projects are built with the store's own primitives so a fixture cannot drift from the
 * shape the store really produces.
 */

import { emptyCoherenceFile, type CoherenceFile, type Finding, type SceneMeta } from '@caotang/coherence';
import { addDocument, addFolder, createEmptyManifest, createProjectState, type CodexEntry, type ProjectState } from '@caotang/store';

export const NOW = new Date('2026-10-01T09:00:00.000Z');

export interface SceneSpec {
  readonly id: string;
  readonly title?: string;
  readonly parent?: string;
  readonly body?: string;
  readonly kind?: string;
  readonly status?: string | null;
}

export interface FolderSpec {
  readonly id: string;
  readonly title?: string;
  readonly parent?: string;
}

export function project(options: {
  readonly folders?: readonly FolderSpec[];
  readonly scenes?: readonly SceneSpec[];
  readonly research?: readonly SceneSpec[];
  readonly entries?: readonly CodexEntry[];
  readonly language?: string;
}): ProjectState {
  const manifest = createEmptyManifest('Fixture', NOW);
  manifest.codex = [...(options.entries ?? [])];
  if (options.language !== undefined) manifest.project.language = options.language;
  const state = createProjectState(manifest, { now: NOW });
  for (const folder of options.folders ?? []) {
    addFolder(state, { id: folder.id, parentId: folder.parent ?? 'manuscript', title: folder.title ?? folder.id, now: NOW });
  }
  for (const scene of options.scenes ?? []) {
    addDocument(state, {
      id: scene.id,
      parentId: scene.parent ?? 'manuscript',
      title: scene.title ?? scene.id,
      body: scene.body ?? '',
      status: scene.status ?? null,
      now: NOW,
    });
    if (scene.kind !== undefined) {
      const node = state.manifest.tree.find((candidate) => candidate.id === scene.id);
      if (node !== undefined) node.kind = scene.kind;
    }
  }
  for (const scene of options.research ?? []) {
    addDocument(state, { id: scene.id, parentId: scene.parent ?? 'research', title: scene.title ?? scene.id, body: scene.body ?? '', now: NOW });
  }
  return state;
}

export function coherence(sceneMeta: Record<string, SceneMeta>, findings: Finding[] = []): CoherenceFile {
  return { ...emptyCoherenceFile(), sceneMeta, findings };
}

export function sceneList(ids: readonly string[], parent?: string): SceneSpec[] {
  return ids.map((id) => ({ id, ...(parent !== undefined ? { parent } : {}) }));
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

export function finding(
  id: string,
  checkId: string,
  docIds: readonly string[],
  extra: Partial<Finding> = {},
): Finding {
  return {
    id,
    runId: 'r_1',
    class: 'deterministic',
    checkId,
    type: checkId.split('.')[1] ?? 'x',
    severity: 'info',
    status: 'open',
    factGroup: `${checkId}|${id}`,
    evidence: docIds.map((docId) => ({ docId, quote: '', from: 0, to: 0 })),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    message: id,
    ...extra,
  } as Finding;
}
