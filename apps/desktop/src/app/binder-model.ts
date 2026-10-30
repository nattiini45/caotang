/**
 * The binder's view model — pure functions over the project state and the view
 * state, with no React and no DOM, so the rules are checkable headless.
 *
 * ui-modules §2 is the contract. Three rules live here and nowhere else:
 *
 *   - which rows are visible, and at what depth (§2.1);
 *   - the pre-dispatch drop check (§2.3) — a *subset* of `binder.move`'s own
 *     validation, never a second copy of it: anything this module refuses is also
 *     refused by the command, and anything the command refuses is still refused
 *     there if the UI lets it through;
 *   - the index a drop lands at, which is the sibling position **excluding the
 *     moving node** — the same meaning `binder.move`'s `index` carries.
 */

import { CHAPTERLESS_DOCUMENT_REFUSAL } from '@caotang/bus';
import type { ProjectState, TreeNode } from '@caotang/store';

/** The two fixed roots the binder renders as section headers (project-format §2). */
export const SECTION_IDS = ['manuscript', 'research'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export function isSectionId(id: string): id is SectionId {
  return (SECTION_IDS as readonly string[]).includes(id);
}

/** §2.1: "synopsis tooltip on hover (first 120 chars)". */
export const SYNOPSIS_PREVIEW_CHARS = 120;

export interface SectionRow {
  readonly kind: 'section';
  readonly node: TreeNode;
  readonly depth: -1;
}

export interface NodeRow {
  readonly kind: 'node';
  readonly node: TreeNode;
  /** 0 for a child of a section, and one more for each level below that. */
  readonly depth: number;
  /** Folders, and any unknown container-like type, can hold children. */
  readonly container: boolean;
  readonly expanded: boolean;
  readonly hasChildren: boolean;
}

export type BinderRow = SectionRow | NodeRow;

/** A node the binder can hold children in: a section or a folder. Documents never are. */
export function isContainer(node: TreeNode): boolean {
  return node.type === 'root' || node.type === 'folder';
}

/** A node the binder may move, rename or delete: anything that is not a fixed root. */
export function isMovable(node: TreeNode): boolean {
  return !(SECTION_IDS as readonly string[]).includes(node.id) && node.id !== 'root';
}

export function nodeById(state: ProjectState, id: string): TreeNode | undefined {
  return state.manifest.tree.find((node) => node.id === id);
}

/** Children of one parent, in sibling order. Ties break on id so the order is total. */
export function childrenOf(state: ProjectState, parentId: string | null): TreeNode[] {
  return state.manifest.tree
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The folders a node sits in, nearest first: its parent folder, that folder's parent folder, and so on up to the manuscript or
 * research. A Fountain section is a binder folder (screenplay.md §2.2), so a screenplay scene's section is the first of these. The
 * manuscript and research are the binder's own sections, not Fountain ones, so they are never listed: a node directly under one has none.
 */
export function enclosingFolders(state: ProjectState, nodeId: string): TreeNode[] {
  const folders: TreeNode[] = [];
  const seen = new Set<string>([nodeId]);
  let parentId = nodeById(state, nodeId)?.parentId ?? null;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = nodeById(state, parentId);
    if (parent === undefined || parent.type !== 'folder' || isSectionId(parent.id)) break;
    folders.push(parent);
    parentId = parent.parentId;
  }
  return folders;
}

/**
 * The binder's default expansion (ui-modules §2.1: "expanded one level"): a folder
 * directly under a section is open, and anything deeper starts closed. An explicit
 * `view.setExpanded` override always wins over this default.
 */
export function defaultExpanded(depth: number): boolean {
  return depth === 0;
}

/**
 * The rows the binder shows, top to bottom. Sections are always present; a node's
 * children appear only while its row is expanded, so a collapsed chapter hides its
 * scenes rather than rendering them off-screen.
 */
export function visibleRows(state: ProjectState, expanded: Readonly<Record<string, boolean>>): BinderRow[] {
  const rows: BinderRow[] = [];
  for (const sectionId of SECTION_IDS) {
    const section = nodeById(state, sectionId);
    if (!section) continue;
    rows.push({ kind: 'section', node: section, depth: -1 });
    walk(state, section.id, 0, expanded, rows);
  }
  return rows;
}

function walk(
  state: ProjectState,
  parentId: string,
  depth: number,
  expanded: Readonly<Record<string, boolean>>,
  out: BinderRow[],
): void {
  for (const node of childrenOf(state, parentId)) {
    const container = isContainer(node);
    const isOpen = container && (expanded[node.id] ?? defaultExpanded(depth));
    const children = childrenOf(state, node.id);
    out.push({
      kind: 'node',
      node,
      depth,
      container,
      expanded: isOpen,
      hasChildren: children.length > 0,
    });
    if (isOpen) walk(state, node.id, depth + 1, expanded, out);
  }
}

/** The node itself and every node beneath it. Fixed-point, like `removeNode`, so a deep subtree is complete. */
export function subtreeIds(state: ProjectState, rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of state.manifest.tree) {
      if (!ids.has(node.id) && node.parentId !== null && ids.has(node.parentId)) {
        ids.add(node.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * What a delete will remove, for the confirm dialog (ui-modules §2.2: "Dialog states
 * what is deleted: node + descendants + their docs"). Counts exclude the node itself
 * from `descendants`, and `words` sums only the documents the subtree owns.
 */
export interface SubtreeSummary {
  readonly title: string;
  readonly descendants: number;
  readonly documents: number;
  readonly words: number;
}

export function summarizeSubtree(state: ProjectState, nodeId: string): SubtreeSummary | undefined {
  const root = nodeById(state, nodeId);
  if (!root) return undefined;
  const ids = subtreeIds(state, nodeId);
  let documents = 0;
  let words = 0;
  for (const node of state.manifest.tree) {
    if (!ids.has(node.id) || node.type !== 'document') continue;
    documents += 1;
    words += wordCountOf(state, node.id);
  }
  return { title: root.title, descendants: ids.size - 1, documents, words };
}

/** §2.1's word count, from `derived.wordCounts` — allowed stale, so a missing entry is zero, not an error. */
export function wordCountOf(state: ProjectState, id: string): number {
  return state.manifest.derived.wordCounts[id] ?? 0;
}

/** The first 120 characters of a synopsis, for the row tooltip (§2.1). Empty text yields `undefined`. */
export function synopsisPreview(synopsis: string): string | undefined {
  const trimmed = synopsis.trim();
  if (trimmed.length === 0) return undefined;
  const chars = [...trimmed];
  return chars.length > SYNOPSIS_PREVIEW_CHARS ? `${chars.slice(0, SYNOPSIS_PREVIEW_CHARS).join('')}…` : trimmed;
}

/* ------------------------------------------------------------------ *
 * Drops (ui-modules §2.3)
 * ------------------------------------------------------------------ */

/**
 * Where a drag is hovering, relative to a row. `before` and `after` place the dragged
 * node as a sibling of the target; `into` places it at the end of a container target.
 * Dropping onto a document row is always `after` (§2.3: "document nodes cannot become
 * parents"), which is why `resolveZone` never returns `into` for a document.
 */
export type DropZone = 'before' | 'after' | 'into';

export type DropPlan =
  | { readonly ok: true; readonly newParentId: string; readonly index: number }
  | { readonly ok: false; readonly reason: DropRefusal };

/** Why a drop is not allowed. `same-place` is not an error: the node is already there. */
export type DropRefusal =
  | 'fixed-root'
  | 'no-target'
  | 'not-a-container'
  | 'section-edge'
  | 'cycle'
  | 'same-place'
  | 'chapterless'
  | 'folder-in-folder';

/**
 * Turn a pointer position into a zone. The top and bottom quarters of a row are
 * `before`/`after`; the middle half is `into` for a container and `after` otherwise.
 * A section header accepts only `into`: a sibling of a section would sit directly
 * under the project root, which the three-tier binder never does.
 */
export function resolveZone(node: TreeNode, fraction: number): DropZone {
  if (!isMovable(node)) return 'into';
  if (fraction < 0.25) return 'before';
  if (fraction > 0.75) return 'after';
  return isContainer(node) ? 'into' : 'after';
}

/**
 * The tree's shape rules for a move (ui-modules §2.4, project-format §2): a manuscript child is a chapter, so a document never
 * lands directly under the manuscript, and a folder never lands inside another folder, since the UI makes three tiers only.
 * Research takes its documents directly, as its board does. The drop and keyboard checks run this after their cycle checks.
 */
function shapeRefusal(moving: TreeNode, parent: TreeNode): DropRefusal | undefined {
  // The two sections are stored as folders, so a section is told apart by its id, and a chapter is a folder that is not one.
  if (parent.id === 'manuscript') return moving.type === 'document' ? 'chapterless' : undefined;
  if (isSectionId(parent.id)) return undefined;
  if (parent.type === 'folder' && moving.type === 'folder') return 'folder-in-folder';
  return undefined;
}

/**
 * The pre-dispatch check, and the index a drop lands at.
 *
 * `index` counts siblings **excluding the moving node**, because `binder.move` (and
 * `siblingOrderAt`) place a node among the others. So dropping `after` the third of
 * [A, B, C] while moving A lands at index 2, and the resulting order is B, C, A.
 */
export function planDrop(
  state: ProjectState,
  movingId: string,
  target: { readonly nodeId: string; readonly zone: DropZone } | null,
): DropPlan {
  const moving = nodeById(state, movingId);
  if (!moving || !isMovable(moving)) return { ok: false, reason: 'fixed-root' };
  if (target === null) return { ok: false, reason: 'no-target' };
  const targetNode = nodeById(state, target.nodeId);
  if (!targetNode) return { ok: false, reason: 'no-target' };

  if (target.zone === 'into') {
    if (!isContainer(targetNode)) return { ok: false, reason: 'not-a-container' };
    if (subtreeIds(state, movingId).has(targetNode.id)) return { ok: false, reason: 'cycle' };
    const shape = shapeRefusal(moving, targetNode);
    if (shape !== undefined) return { ok: false, reason: shape };
    const siblings = childrenOf(state, targetNode.id).filter((node) => node.id !== movingId);
    return placeAt(state, moving, targetNode.id, siblings.length);
  }

  // A section is a fixed root: nothing is ever placed beside one (see `resolveZone`).
  if (!isMovable(targetNode)) return { ok: false, reason: 'section-edge' };

  // `before` and `after` are siblings of the target, so the parent is the target's.
  const parentId = targetNode.parentId;
  if (parentId === null) return { ok: false, reason: 'no-target' };
  const parent = nodeById(state, parentId);
  if (!parent || !isContainer(parent)) return { ok: false, reason: 'not-a-container' };
  if (subtreeIds(state, movingId).has(parentId)) return { ok: false, reason: 'cycle' };
  if (targetNode.id === movingId) return { ok: false, reason: 'same-place' };
  const shape = shapeRefusal(moving, parent);
  if (shape !== undefined) return { ok: false, reason: shape };

  const siblings = childrenOf(state, parentId).filter((node) => node.id !== movingId);
  const position = siblings.findIndex((node) => node.id === targetNode.id);
  if (position === -1) return { ok: false, reason: 'no-target' };
  return placeAt(state, moving, parentId, target.zone === 'before' ? position : position + 1);
}

/**
 * Refuses a drop that would leave the node exactly where it already is.
 *
 * The node's current position is its index in the full sibling list, which is also
 * the number of siblings before it — the same count `index` uses, since the node
 * itself is never one of the siblings `index` is taken against.
 */
function placeAt(state: ProjectState, moving: TreeNode, parentId: string, index: number): DropPlan {
  const currentIndex = childrenOf(state, moving.parentId).findIndex((node) => node.id === moving.id);
  if (moving.parentId === parentId && currentIndex === index) {
    return { ok: false, reason: 'same-place' };
  }
  return { ok: true, newParentId: parentId, index };
}

/**
 * Where a new item goes when the user asks for one with a selection: inside a selected
 * folder or section, and beside a selected document (ui-modules §2.2, "selection's
 * parent"). With nothing selected it goes into the manuscript.
 */
export function newItemParent(state: ProjectState, selectedId: string | null): string {
  const node = selectedId === null ? undefined : nodeById(state, selectedId);
  if (!node) return 'manuscript';
  if (isContainer(node)) return node.id;
  return node.parentId ?? 'manuscript';
}

/**
 * What New document says, instead of making one, when its parent is the manuscript. A document there is the
 * chapterless case `shapeRefusal` refuses for a drop, so the button, Ctrl+N and the context menu give the same reason. The
 * bus refuses it too, in the same words, and a stopped tab's kept words
 * go back into a chapter (UnsentWords).
 */
export function newDocumentRefusalText(parentId: string): string | undefined {
  if (parentId !== 'manuscript') return undefined;
  return `${dropRefusalText('chapterless')} Select a chapter first, or make one with New folder.`;
}

/**
 * Where a new folder goes. A folder never sits inside another folder: the UI creates the
 * three tiers only (ARCHITECTURE §2.2, project-format §2), so a folder goes straight into a
 * section. From a selection that is the section the selection sits in: the selected section
 * itself, or the first section found going up from a folder or a document. With nothing
 * selected, it is the manuscript.
 */
export function newFolderParent(state: ProjectState, selectedId: string | null): SectionId {
  const seen = new Set<string>();
  let cursor = selectedId === null ? undefined : nodeById(state, selectedId);
  while (cursor && !seen.has(cursor.id)) {
    const id = cursor.id;
    if (isSectionId(id)) return id;
    seen.add(id);
    cursor = cursor.parentId === null ? undefined : nodeById(state, cursor.parentId);
  }
  return 'manuscript';
}

/** The refusal text the drop cursor and the row's status line show. */
export function dropRefusalText(reason: DropRefusal): string {
  switch (reason) {
    case 'fixed-root':
      return 'Sections cannot be moved.';
    case 'no-target':
      return 'Drop onto a row in the binder.';
    case 'not-a-container':
      return 'A document cannot hold other items.';
    case 'section-edge':
      return 'Drop it inside a section, not beside it.';
    case 'cycle':
      return 'An item cannot be moved into itself.';
    case 'same-place':
      return 'That is already where it is.';
    case 'chapterless':
      // The bus's own sentence for the same rule, so a drop, New document and a refused create say the same words.
      return CHAPTERLESS_DOCUMENT_REFUSAL;
    case 'folder-in-folder':
      return 'A folder cannot go inside another folder.';
  }
}

/** One keyboard move (ui-modules §2.5, §3.2): a place up or down among the siblings, out of the folder, or into the folder before. */
export type KeyboardStep = 'up' | 'down' | 'out' | 'in';

/**
 * The keyboard's move, planned the way a drop is: the same index convention as `planDrop` (an index counts the siblings that
 * are not moving), and the same refusals. `up` and `down` swap a node with its neighbour; `out` puts it after its folder, and
 * `in` puts it at the end of the folder before it. A node that is already at the edge it would move past is `same-place`.
 * The shape rules of `shapeRefusal` apply: a scene leaves a chapter for nowhere but another chapter, and a folder never goes
 * into a folder, so `out` of a chapter's scene and `in` for a folder are refused.
 */
export function planKeyboardMove(state: ProjectState, nodeId: string, step: KeyboardStep): DropPlan {
  const node = nodeById(state, nodeId);
  if (!node || !isMovable(node) || node.parentId === null) return { ok: false, reason: 'fixed-root' };
  const parentId = node.parentId;

  if (step === 'up' || step === 'down') {
    const siblings = childrenOf(state, parentId);
    const position = siblings.findIndex((sibling) => sibling.id === node.id);
    const next = step === 'up' ? position - 1 : position + 1;
    if (next < 0 || next >= siblings.length) return { ok: false, reason: 'same-place' };
    // Past the neighbour: up lands before it, at its index; down lands after it, one further on.
    return placeAt(state, node, parentId, step === 'up' ? position - 1 : position + 1);
  }

  if (step === 'in') {
    const siblings = childrenOf(state, parentId);
    const position = siblings.findIndex((sibling) => sibling.id === node.id);
    const previous = position > 0 ? siblings[position - 1] : undefined;
    if (previous === undefined) return { ok: false, reason: 'no-target' };
    if (!isContainer(previous)) return { ok: false, reason: 'not-a-container' };
    if (subtreeIds(state, node.id).has(previous.id)) return { ok: false, reason: 'cycle' };
    const shape = shapeRefusal(node, previous);
    if (shape !== undefined) return { ok: false, reason: shape };
    const inside = childrenOf(state, previous.id).filter((child) => child.id !== node.id);
    return placeAt(state, node, previous.id, inside.length);
  }

  // `out`: the folder the node is in must be a movable container, or the node would land directly under a section or the project.
  const parent = nodeById(state, parentId);
  if (!parent || !isMovable(parent) || parent.parentId === null) return { ok: false, reason: 'section-edge' };
  const grandparentId = parent.parentId;
  const grandparent = nodeById(state, grandparentId);
  if (grandparent === undefined) return { ok: false, reason: 'no-target' };
  const shape = shapeRefusal(node, grandparent);
  if (shape !== undefined) return { ok: false, reason: shape };
  const uncles = childrenOf(state, grandparentId);
  const parentPosition = uncles.findIndex((uncle) => uncle.id === parent.id);
  if (parentPosition === -1) return { ok: false, reason: 'no-target' };
  return placeAt(state, node, grandparentId, parentPosition + 1);
}
