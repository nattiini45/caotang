/**
 * What a coherence run reads — [coherence.md §5.1 and §6.2](../../../docs/architecture/coherence.md).
 *
 * Scenes are the manuscript's document nodes in binder order. A scene is
 * *scanned* when it sits under the Manuscript root, has a body, and is not
 * excluded. Empty scenes are skipped and named; research documents are scanned
 * only when a scope names them. Archived documents are never scanned (§5.1). The
 * spec says so, but the store has no archive concept yet, so the stand-in is a
 * status id of `archived`, and the test pins it.
 */

import { readShotMeta, shotFieldOf, SHOT_NODE_TYPE, type DialogueCoverage } from '@caotang/storyboard';
import { loadComicBook, loadComicPage, type ComicBookSettings, type ComicPageInput } from '@caotang/comic';
import { getBody, getRevision, type CodexEntry, type ProjectState, type TreeNode } from '@caotang/store';

import { ScopeError } from './errors.js';
import { EVIDENCE_QUOTE_LIMIT, type CoherenceFile, type Evidence, type SceneMeta } from './model.js';
import { codePointPrefix } from './text.js';
import { effectiveStoryParts, type StoryPart } from './timeline.js';

/** §6.2's three run scopes. A `doc` scope names exactly one document. */
export type ScopeSpec =
  | { readonly mode: 'doc'; readonly docIds: readonly string[] }
  | { readonly mode: 'changed' }
  | { readonly mode: 'full' };

/** A scanned document, in binder order. */
export interface ScannedScene {
  readonly docId: string;
  readonly title: string;
  readonly parentId: string | null;
  /** Position in the depth-first binder walk. Sibling order is respected. */
  readonly binderIndex: number;
  /** Folder ids above this scene, nearest last. Used by `timeline.window`. */
  readonly ancestorIds: readonly string[];
  readonly body: string;
  readonly revision: number;
  /** Declared metadata. Absent fields are absent, never defaulted here. */
  readonly meta: SceneMeta;
  /**
   * The effective story part (§5.2.2): this scene's own declaration, else the nearest folder's, else `main`. Derived from
   * the tree on every snapshot and never stored. Absent (a hand-built scene) reads as `main`.
   */
  readonly part?: StoryPart;
  /** The document kind the tree node declares (`screenplay`, and so on). Absent for prose. */
  readonly kind?: string;
}

export interface ManuscriptFolder {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly meta: SceneMeta;
}

/**
 * A storyboard shot, as the shot checks read it (storyboard.md §5). Read from the tree, not from a document,
 * because a shot has no body: its dialogue coverage is anchors into the screenplay documents it names.
 */
export interface ShotFact {
  readonly id: string;
  readonly title: string;
  /** Seconds, when the shot declares them. Absent means the shot is left out of animatic totals. */
  readonly durationSec?: number;
  /** The shot's `dialogue[]` entries, in the order the shot stores them. */
  readonly coverage: readonly DialogueCoverage[];
}

export interface ManuscriptSnapshot {
  readonly scanned: readonly ScannedScene[];
  readonly folders: readonly ManuscriptFolder[];
  /** Every storyboard shot in the project, in tree order. Shots are read wherever they sit, since they are not documents. */
  readonly shots: readonly ShotFact[];
  /**
   * Every comic book in the project, in tree order, with its pages in binder order (comics.md §2). Books are read
   * wherever they sit, like shots: a page is structure, not a document, so no scope narrows it.
   */
  readonly comics: readonly ComicBookFact[];
  /** Manuscript documents with no text. Named in run reports, never scanned. */
  readonly emptyDocIds: readonly string[];
  /** Documents the exclusion rule removed from scanning. */
  readonly excludedDocIds: readonly string[];
}

/**
 * A comic book as the comic checks read it (comics.md §2): the `comic` folder with its settings loaded tolerantly,
 * and its `comic-page` children in binder order, the page number derived from that order (the shotNumber precedent).
 * Read from the tree, not from a document, because a page has no body: its panels and balloons are structure.
 */
export interface ComicBookFact {
  readonly id: string;
  readonly title: string;
  readonly settings: ComicBookSettings;
  readonly pages: readonly ComicPageInput[];
  /**
   * The book's linked script (comics.md §2) as `balloon-coverage` reads it: its body now. Absent when the book has no link, and
   * also when the link is broken (the document is gone or is not a comic script), because a link is never re-matched by title; the
   * check says which of the two it found.
   */
  readonly script?: ComicScriptFact;
}

export interface ComicScriptFact {
  readonly docId: string;
  readonly title: string;
  readonly body: string;
  readonly revision: number;
}

export interface SnapshotOptions {
  /** Research documents named by an explicit scope. Ignored for everything else. */
  readonly includeDocIds?: ReadonlySet<string>;
  /** Overrides the exclusion rule. The default is {@link isArchived}. */
  readonly isExcluded?: (node: TreeNode) => boolean;
}

/** The stand-in for §5.1's "archived/excluded docs": a document whose status is `archived`. */
export function isArchived(node: TreeNode): boolean {
  return node.status === 'archived';
}

const MANUSCRIPT_ROOT = 'manuscript';

/**
 * Walks the binder in order and returns what a run may read. Pure: nothing is
 * written, and the same state and file always yield the same snapshot.
 */
export function snapshotManuscript(
  state: ProjectState,
  file: CoherenceFile,
  options: SnapshotOptions = {},
): ManuscriptSnapshot {
  const isExcluded = options.isExcluded ?? isArchived;
  const include = options.includeDocIds ?? new Set<string>();
  const children = new Map<string, TreeNode[]>();
  for (const node of state.manifest.tree) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const parts = effectiveStoryParts(state.manifest.tree, file.sceneMeta);
  const scanned: ScannedScene[] = [];
  const folders: ManuscriptFolder[] = [];
  const emptyDocIds: string[] = [];
  const excludedDocIds: string[] = [];
  let binderIndex = 0;

  // One recursive walk from every top-level node. The root is a container that is
  // not a folder, so it passes its ancestors through unchanged.
  const visit = (node: TreeNode, ancestors: readonly string[], inManuscript: boolean): void => {
    if (node.type === 'document') {
      binderIndex += 1;
      const member = inManuscript || include.has(node.id);
      if (!member) return;
      if (isExcluded(node)) {
        excludedDocIds.push(node.id);
        return;
      }
      const body = getBody(state, node.id);
      if (body.trim() === '') {
        emptyDocIds.push(node.id);
        return;
      }
      const kind = kindOf(node);
      scanned.push({
        docId: node.id,
        title: node.title || node.id,
        parentId: node.parentId,
        binderIndex,
        ancestorIds: [...ancestors],
        body,
        revision: getRevision(state, node.id),
        meta: { ...(file.sceneMeta[node.id] ?? {}) },
        part: parts.get(node.id) ?? 'main',
        ...(kind !== undefined ? { kind } : {}),
      });
      return;
    }
    const member = inManuscript || node.id === MANUSCRIPT_ROOT;
    if (node.type === 'folder' && member) {
      folders.push({
        id: node.id,
        title: node.title,
        parentId: node.parentId,
        meta: { ...(file.sceneMeta[node.id] ?? {}) },
      });
    }
    const inner = node.type === 'folder' ? [...ancestors, node.id] : ancestors;
    for (const child of children.get(node.id) ?? []) visit(child, inner, member);
  };

  for (const top of state.manifest.tree) {
    if (top.parentId === null) visit(top, [], false);
  }

  return { scanned, folders, shots: shotsOf(state), comics: comicsOf(state, children), emptyDocIds, excludedDocIds };
}

/** The `kind` marker a node declares, when it declares one. The store does not type it, so it is read as an unknown field. */
function kindOf(node: TreeNode): string | undefined {
  const kind = (node as { readonly kind?: unknown }).kind;
  return typeof kind === 'string' && kind !== '' ? kind : undefined;
}

/**
 * The storyboard shots of the tree, read through the storyboard's own codec (storyboard.md §2.2), so a shot's
 * coverage and duration mean what the storyboard means by them. A shot with malformed metadata contributes what
 * the codec kept; the codec's notices are the storyboard's to show, not the check's.
 */
function shotsOf(state: ProjectState): ShotFact[] {
  const shots: ShotFact[] = [];
  for (const node of state.manifest.tree) {
    if (node.type !== SHOT_NODE_TYPE) continue;
    const { meta } = readShotMeta(shotFieldOf(node));
    shots.push({
      id: node.id,
      title: node.title || node.id,
      ...(meta.durationSec !== undefined ? { durationSec: meta.durationSec } : {}),
      coverage: meta.dialogue ?? [],
    });
  }
  return shots;
}

/**
 * The comic books of the tree, read through the comic codec's tolerant loaders (comics.md §2), so a page whose stored
 * value the loader cannot fully render still contributes what it kept; the codec's notices are the comic module's to
 * show, not the check's. `children` is the snapshot's sorted sibling map, so a page's number is its binder position.
 */
function comicsOf(state: ProjectState, children: ReadonlyMap<string, TreeNode[]>): ComicBookFact[] {
  const books: ComicBookFact[] = [];
  for (const node of state.manifest.tree) {
    if (kindOf(node) !== 'comic') continue;
    const stored = node as unknown as Record<string, unknown>;
    const settings = loadComicBook(stored['comic']).value;
    const pages = (children.get(node.id) ?? [])
      .filter((child) => child.type === 'comic-page')
      .map((pageNode, index) => {
        const storedPage = pageNode as unknown as Record<string, unknown>;
        return { id: pageNode.id, number: index + 1, page: loadComicPage(storedPage['comicPage']).value };
      });
    const linked = settings.scriptDocId === undefined ? undefined : state.manifest.tree.find((candidate) => candidate.id === settings.scriptDocId);
    const script: ComicScriptFact | undefined =
      linked !== undefined && linked.type === 'document' && kindOf(linked) === 'comic-script'
        ? { docId: linked.id, title: linked.title || linked.id, body: getBody(state, linked.id), revision: getRevision(state, linked.id) }
        : undefined;
    books.push({ id: node.id, title: node.title || node.id, settings, pages, ...(script !== undefined ? { script } : {}) });
  }
  return books;
}

/**
 * Turns a scope into the documents it names. A `doc` scope that names a document
 * the run cannot read is refused with the reason, rather than silently producing
 * no findings.
 */
export function resolveScope(
  snapshot: ManuscriptSnapshot,
  file: CoherenceFile,
  scope: ScopeSpec,
): ScannedScene[] {
  if (scope.mode === 'full') return [...snapshot.scanned];
  if (scope.mode === 'changed') {
    return snapshot.scanned.filter((scene) => file.reviewState[scene.docId]?.lastReviewedRevision !== scene.revision);
  }
  if (scope.docIds.length !== 1) {
    throw new ScopeError('A document scope names exactly one document.');
  }
  const docId = scope.docIds[0] ?? '';
  const scene = snapshot.scanned.find((candidate) => candidate.docId === docId);
  if (scene !== undefined) return [scene];
  if (snapshot.emptyDocIds.includes(docId)) {
    throw new ScopeError(`The document "${docId}" is empty, so there is no text to check.`);
  }
  if (snapshot.excludedDocIds.includes(docId)) {
    throw new ScopeError(`The document "${docId}" is excluded from checks.`);
  }
  throw new ScopeError(`"${docId}" is not a document this scope can read. Research documents must be named explicitly.`);
}

/**
 * The opening of a scene as evidence. Deterministic findings quote the scene's
 * own text, and the spec gives no other passage for them. The quote is a
 * verbatim slice at offsets into the body projection, which is the one
 * coordinate system Evidence may use.
 */
export function headEvidence(scene: ScannedScene): Evidence {
  const quote = codePointPrefix(scene.body, EVIDENCE_QUOTE_LIMIT);
  return { docId: scene.docId, quote, from: 0, to: quote.length };
}

/** Codex entries from the manifest, or none. `codex[]` is optional in format v1 (codex.md §3). */
export function entriesOf(state: ProjectState): readonly CodexEntry[] {
  return state.manifest.codex ?? [];
}
