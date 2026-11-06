/**
 * The one **New** model (modern-interface.md §7.8, #477): what a writer can make, in which order, and where it goes. Pure, so the
 * top ornament's **+ New**, the palette's New group and Classic's **New document ▾** list the same kinds in the same words and put
 * them in the same place.
 *
 * Where a new item goes (its *target chapter*): the chapter the selection is in, else the chapter of the open document, else none,
 * and then a new chapter is made first, so a create never stops at "needs a chapter". A chapter is a plain folder in the manuscript
 * (not a storyboard or a comic book, which hold only shots and pages). A new chapter goes beside the target chapter.
 *
 * Halls (#430) reorder the list through {@link orderNewKinds}; nothing is removed.
 */

import { t } from '@lingui/core/macro';
import { defaultTitleOf } from '@caotang/i18n';
import type { ProjectState, TreeNode } from '@caotang/store';

import type { MediaCreateSpec } from '../media/create-menu.js';
import { nodeById } from './binder-model.js';

export type NewKind = 'scene' | 'chapter' | 'screenplay' | 'dialogue' | 'storyboard' | 'comic';

/** Every kind, in the base order; the first group is prose, the second the script and story kinds. */
export const NEW_KINDS: readonly NewKind[] = ['scene', 'chapter', 'screenplay', 'dialogue', 'storyboard', 'comic'];
const PROSE: readonly NewKind[] = ['scene', 'chapter'];

/** Kinds whose own view needs a desktop (narrow-model.ts); a phone still makes them. */
export const DESKTOP_VIEW_KINDS: readonly NewKind[] = ['dialogue', 'storyboard'];

export interface NewEntry {
  readonly kind: NewKind;
  readonly label: string;
  /** One short line under the label. */
  readonly detail: string;
  /** The test id the entry carries: `new-<kind>`. */
  readonly testId: string;
}

export interface NewGroup {
  readonly id: 'write' | 'script';
  readonly head: string;
  readonly entries: readonly NewEntry[];
}

export function newLabel(kind: NewKind): string {
  switch (kind) {
    case 'scene':
      return t`Scene`;
    case 'chapter':
      return t`Chapter`;
    case 'screenplay':
      return t`Screenplay scene`;
    case 'dialogue':
      return t`Dialogue (Ink)`;
    case 'storyboard':
      return t`Storyboard`;
    case 'comic':
      return t`Comic`;
  }
}

function newDetail(kind: NewKind): string {
  switch (kind) {
    case 'scene':
      return t`A prose scene`;
    case 'chapter':
      return t`A folder for scenes`;
    case 'screenplay':
      return t`Fountain, with Pages`;
    case 'dialogue':
      return t`Branching, with a graph`;
    case 'storyboard':
      return t`Shots and an animatic`;
    case 'comic':
      return t`A comic book with its first page`;
  }
}

/**
 * The kinds in a hall's order (#430's `prominence.new`): the hall's kinds first, in its order, then every other kind in the base
 * order. Unknown or repeated kinds in the hint are ignored, and nothing is ever dropped.
 */
export function orderNewKinds(hint?: readonly string[]): NewKind[] {
  const first = (hint ?? []).filter((kind, at, all): kind is NewKind => (NEW_KINDS as readonly string[]).includes(kind) && all.indexOf(kind) === at);
  return [...first, ...NEW_KINDS.filter((kind) => !first.includes(kind))];
}

/** The menu's groups: Write (scene, chapter) and Script and story, each in the hall's order. */
export function newGroups(hint?: readonly string[]): NewGroup[] {
  const order = orderNewKinds(hint);
  const entry = (kind: NewKind): NewEntry => ({ kind, label: newLabel(kind), detail: newDetail(kind), testId: `new-${kind}` });
  return [
    { id: 'write', head: t`Write`, entries: order.filter((kind) => PROSE.includes(kind)).map(entry) },
    { id: 'script', head: t`Script and story`, entries: order.filter((kind) => !PROSE.includes(kind)).map(entry) },
  ];
}

function inManuscript(state: ProjectState, node: TreeNode): boolean {
  let at: TreeNode | undefined = node;
  for (let guard = 0; at !== undefined && guard < 64; guard += 1) {
    if (at.parentId === 'manuscript') return true;
    at = at.parentId === null ? undefined : nodeById(state, at.parentId);
  }
  return false;
}

/** A plain folder in the manuscript: a chapter (or a part), never a storyboard or comic book. */
function isChapter(state: ProjectState, node: TreeNode): boolean {
  return node.type === 'folder' && node.kind === undefined && inManuscript(state, node);
}

/** The chapter `nodeId` is, or is in; `null` when it is in none. */
export function chapterOf(state: ProjectState, nodeId: string | null): TreeNode | null {
  let at = nodeId === null ? undefined : nodeById(state, nodeId);
  for (let guard = 0; at !== undefined && guard < 64; guard += 1) {
    if (isChapter(state, at)) return at;
    at = at.parentId === null ? undefined : nodeById(state, at.parentId);
  }
  return null;
}

/** Where New puts things: the selection's chapter, else the open document's, else `null` (a chapter is made first). */
export function newTarget(state: ProjectState, selectedId: string | null, activeDocId: string | null): TreeNode | null {
  return chapterOf(state, selectedId) ?? chapterOf(state, activeDocId);
}

/** One step of a plan: a `binder.create`-shaped spec and the parent it goes into (`'$chapter'` is the chapter made by step one). */
export interface NewStep {
  readonly parentId: string;
  readonly spec: MediaCreateSpec;
}

/** The title of the chapter New makes, in the project's language: "Chapter" and the next number. */
export function nextChapterTitle(state: ProjectState, language?: string): string {
  const chapters = state.manifest.tree.filter((node) => node.parentId === 'manuscript' && node.type === 'folder').length;
  return [defaultTitleOf('chapter', language), String(chapters + 1)].join(' ');
}

/**
 * The creates that make `kind`: one, or two when there is no target chapter (the chapter first, then the item in it, its parent
 * written `'$chapter'`). A chapter goes beside the target chapter, or into the manuscript.
 */
export function newPlan(state: ProjectState, kind: NewKind, target: TreeNode | null, language?: string): NewStep[] {
  if (kind === 'chapter') {
    return [{ parentId: target?.parentId ?? 'manuscript', spec: { type: 'folder', title: nextChapterTitle(state, language) } }];
  }
  const steps: NewStep[] = [];
  let parentId = target?.id;
  if (parentId === undefined) {
    steps.push({ parentId: 'manuscript', spec: { type: 'folder', title: nextChapterTitle(state, language) } });
    parentId = '$chapter';
  }
  const spec: MediaCreateSpec =
    kind === 'scene'
      ? { type: 'document', title: defaultTitleOf('scene', language) }
      : kind === 'screenplay'
        ? { type: 'document', kind: 'screenplay', title: defaultTitleOf('scene', language) }
        : kind === 'dialogue'
          ? { type: 'dialogue', kind: 'branching', title: defaultTitleOf('dialogue', language) }
          : kind === 'storyboard'
            ? { type: 'folder', kind: 'storyboard', title: defaultTitleOf('storyboard', language) }
            : { type: 'folder', kind: 'comic', title: defaultTitleOf('comic', language) };
  steps.push({ parentId, spec });
  return steps;
}
