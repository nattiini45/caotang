/**
 * Fixtures for the media adapters: shots folders, dialogue containers and comic books, built with the store's own
 * primitives so a fixture cannot drift from the node shapes the store really holds.
 */

import { addDocument, addNode, type ProjectState, type TreeNode } from '@caotang/store';

import { NOW } from './fixtures.js';

export interface ShotSpec {
  readonly id: string;
  readonly title?: string;
  readonly image?: string;
  readonly durationSec?: unknown;
}

function node(state: ProjectState, id: string): TreeNode {
  const found = state.manifest.tree.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
}

/** `<Scene Title> — Shots` beside the scene, as `shots.derive` makes it. */
export function addShots(state: ProjectState, options: { readonly id: string; readonly title: string; readonly parent?: string; readonly kind?: string | null; readonly shots?: readonly ShotSpec[] }): TreeNode {
  const folder = addNode(state, {
    id: options.id,
    parentId: options.parent ?? 'manuscript',
    title: options.title,
    type: 'folder',
    ...(options.kind === null ? {} : { kind: options.kind ?? 'storyboard' }),
    now: NOW,
  });
  for (const shot of options.shots ?? []) {
    const created = addNode(state, { id: shot.id, parentId: folder.id, title: shot.title ?? shot.id, type: 'shot', now: NOW });
    const stored: Record<string, unknown> = {};
    if (shot.image !== undefined) stored['image'] = shot.image;
    if (shot.durationSec !== undefined) stored['durationSec'] = shot.durationSec;
    created.shot = stored;
  }
  return folder;
}

export const INK = ['=== start ===', 'Anna: Hello.', '* [Ask] -> ask', '* [Leave] -> END', '=== ask ===', 'Ben: Fine.', '-> start', ''].join('\n');

export function addDialogue(state: ProjectState, options: { readonly id: string; readonly title?: string; readonly parent?: string; readonly body?: string }): TreeNode {
  return addDocument(state, {
    id: options.id,
    parentId: options.parent ?? 'manuscript',
    title: options.title ?? options.id,
    body: options.body ?? INK,
    type: 'dialogue',
    kind: 'branching',
    now: NOW,
  });
}

export interface PageSpec {
  readonly id: string;
  readonly title?: string;
  readonly panels?: readonly { readonly assetId?: string }[];
}

export function addComicBook(
  state: ProjectState,
  options: { readonly id: string; readonly title?: string; readonly parent?: string; readonly scriptDocId?: unknown; readonly readingDirection?: string; readonly pages?: readonly PageSpec[] },
): TreeNode {
  const book = addNode(state, { id: options.id, parentId: options.parent ?? 'manuscript', title: options.title ?? options.id, type: 'folder', kind: 'comic', now: NOW });
  const settings: Record<string, unknown> = { readingDirection: options.readingDirection ?? 'ltr' };
  if (options.scriptDocId !== undefined) settings['scriptDocId'] = options.scriptDocId;
  book.comic = settings;
  for (const page of options.pages ?? []) {
    const created = addNode(state, { id: page.id, parentId: book.id, title: page.title ?? page.id, type: 'comic-page', now: NOW });
    created.comicPage = { size: 'us-comic', panels: (page.panels ?? []).map((panel, at) => ({ id: `${page.id}-p${at}`, rect: [0, 0, 1, 1], balloons: [], ...(panel.assetId !== undefined ? { assetId: panel.assetId } : {}) })) };
  }
  return book;
}

export function removeNode(state: ProjectState, id: string): void {
  const at = state.manifest.tree.indexOf(node(state, id));
  state.manifest.tree.splice(at, 1);
}
