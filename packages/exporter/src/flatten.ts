/**
 * Stages 1 and 2 of the pipeline — select and flatten — [exporter.md §2](../../../docs/architecture/exporter.md).
 *
 * Pure: it reads the project state and returns a value. Nothing here touches a
 * port, a clock or a file, which is why `previewFlatten` can run on the same
 * function the compile runs (§4: the user sees the block list the artifact is
 * built from, not a second guess at it).
 *
 * ## What the walk does, in the order the spec states it
 *
 * The tree is walked depth-first in `order` (§2). A node is **included** when it
 * is named in `includeRootIds` or lies under a named node, so the compile follows
 * the binder's order and not the order the caller listed the roots in. The fixed
 * roots (`root`, `manuscript`, `research`) are containers and never headings;
 * every other folder is a chapter.
 *
 * A chapter heading is emitted **lazily**, when its first scene survives: a
 * chapter whose documents are all empty produces no heading, and the empty
 * documents are reported instead. A separator goes between two consecutive scenes of
 * the same chapter, or of the same loose run filed directly under the manuscript, and
 * never before a chapter's first scene, so the output has no stray rule at a chapter
 * boundary.
 */

import { FIXED_ROOT_IDS, countBody, type ProjectState, type TreeNode } from '@caotang/store';
import { SCENE_STYLE_ROWS, sceneStyleOf, type SceneStyleRow } from './scene-style.js';
import type { ExportSelection, FlatBlock } from './types.js';

export interface FlattenOptions {
  /** Whether to lead with the title page (exporter.md §2 `titlepage`, default on). */
  readonly titlePage: boolean;
  /** The scene styles a stored value is read against (exporter.md §2). Absent is the build's own rows. */
  readonly sceneStyles?: readonly SceneStyleRow[];
}

export interface FlattenResult {
  readonly blocks: readonly FlatBlock[];
  /** Labels of the empty documents left out, e.g. `Chapter 3 → The Call`. */
  readonly skippedDocs: readonly string[];
  /** Human-readable notes, one per skip and per selection the tree could not resolve. */
  readonly notes: readonly string[];
  readonly wordCount: number;
  readonly chapterCount: number;
  readonly sceneCount: number;
}

/** A folder the walk is currently inside, and whether its heading has been written. */
interface ChapterContext {
  readonly node: TreeNode;
  readonly level: number;
  emitted: boolean;
  number: number;
  scenes: number;
}

const FIXED = new Set<string>(FIXED_ROOT_IDS);

/** The `label` a skip is reported under: the chapter and the document, when there is one. */
export function documentLabel(chapter: string | undefined, title: string): string {
  return chapter === undefined ? title : `${chapter} → ${title}`;
}

export function flatten(state: ProjectState, selection: ExportSelection, options: FlattenOptions): FlattenResult {
  const tree = state.manifest.tree;
  const byId = new Map(tree.map((node) => [node.id, node] as const));

  const childrenOf = new Map<string, TreeNode[]>();
  for (const node of tree) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId) ?? [];
    siblings.push(node);
    childrenOf.set(node.parentId, siblings);
  }
  for (const siblings of childrenOf.values()) {
    // `order` is gap-encoded (project-format §2), so ties are possible only in a
    // hand-edited file; the id breaks them so the walk is deterministic either way.
    siblings.sort((a, b) => a.order - b.order || compareIds(a.id, b.id));
  }

  const styleRows = options.sceneStyles ?? SCENE_STYLE_ROWS;
  const selected = new Set(selection.includeRootIds);
  const blocks: FlatBlock[] = [];
  const skippedDocs: string[] = [];
  const notes: string[] = [];
  let wordCount = 0;
  let chapterCount = 0;
  let sceneCount = 0;
  let looseScenes = 0;
  /** The chapter the previous emitted scene belonged to — drives the separator. */
  let previousChapter: ChapterContext | undefined;
  let previousEmitted = false;

  for (const id of selection.includeRootIds) {
    if (!byId.has(id)) notes.push(`no node "${id}" in the tree, so it contributed nothing`);
  }

  const scene = (node: TreeNode, chapter: ChapterContext | undefined): void => {
    const label = documentLabel(chapter?.node.title, node.title);
    const body = state.documents.get(node.id)?.body;
    if (body === undefined) {
      skippedDocs.push(label);
      notes.push(`skipped: ${label} (no document record)`);
      return;
    }
    if (selection.docFilter !== undefined && !selection.docFilter({ id: node.id, title: node.title, body })) {
      return;
    }
    if (body.trim() === '') {
      skippedDocs.push(label);
      notes.push(`skipped: ${label} (empty)`);
      return;
    }

    if (chapter !== undefined && !chapter.emitted) {
      chapter.emitted = true;
      chapterCount += 1;
      chapter.number = chapterCount;
      // The folder's synopsis rides along when it has one: the Fountain renderer writes it as the section's `=` line, so a
      // section's synopsis survives a round trip (screenplay.md §2.2). The prose renderers have no use for it and ignore it.
      const synopsis = chapter.node.synopsis;
      blocks.push({
        kind: 'chapter',
        title: chapter.node.title,
        level: chapter.level,
        number: chapter.number,
        ...(synopsis.trim() === '' ? {} : { synopsis }),
      });
    }
    // A separator is for a scene that follows another scene **in the same chapter**. Two loose scenes filed directly
    // under the manuscript share no chapter folder, so both carry `chapter === undefined`; the comparison alone still
    // separates them, and still excludes a chapter boundary, where the two chapters differ.
    if (previousEmitted && previousChapter === chapter) {
      blocks.push({ kind: 'separator' });
    }

    let number: number;
    if (chapter !== undefined) {
      chapter.scenes += 1;
      number = chapter.scenes;
    } else {
      looseScenes += 1;
      number = looseScenes;
    }
    // Read from the manifest, never computed. A style the rows do not name (an unknown stored value) is a normal scene.
    const style = sceneStyleOf(node.style, styleRows);
    blocks.push({ kind: 'scene', docId: node.id, title: node.title, body, number, ...(style === undefined ? {} : { style }) });
    wordCount += countBody(body).words;
    sceneCount += 1;
    previousChapter = chapter;
    previousEmitted = true;
  };

  const visit = (node: TreeNode, inherited: boolean, chapter: ChapterContext | undefined, level: number): void => {
    const include = inherited || selected.has(node.id);

    if (node.type === 'document') {
      if (include) scene(node, chapter);
      return;
    }

    if (node.type === 'root' || node.type === 'folder') {
      let nextChapter = chapter;
      let nextLevel = level;
      // A selected document inside an unselected folder still needs its folder's
      // heading, so the context is made whether or not the folder is included.
      if (node.type === 'folder' && !FIXED.has(node.id)) {
        nextLevel = level + 1;
        nextChapter = { node, level: nextLevel, emitted: false, number: 0, scenes: 0 };
      }
      for (const child of childrenOf.get(node.id) ?? []) visit(child, include, nextChapter, nextLevel);
      return;
    }

    // An unknown node type (a media-track kind, say) is inert in v0.1: it is named
    // when it was asked for, and its subtree is not walked.
    if (include) notes.push(`skipped: "${node.title}" is a ${node.type} node, which this exporter does not compile`);
  };

  for (const root of tree) {
    if (root.parentId === null) visit(root, false, undefined, 0);
  }

  if (options.titlePage) blocks.unshift({ kind: 'frontmatter', fmKind: 'titlepage' });

  return { blocks, skippedDocs, notes, wordCount, chapterCount, sceneCount };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
