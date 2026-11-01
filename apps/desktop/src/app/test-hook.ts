/**
 * `window.__caotang` — read-only views of the open session, for the Playwright suite.
 *
 * Installed only in development builds (`import.meta.env.DEV`), so a production bundle
 * carries neither the hook nor the code behind it. It exposes what the spec says the
 * tests should read: the activity log rows, which are the command trace (ui-modules §6),
 * and the project's tree and bodies, which are the final state the trace should produce.
 *
 * Nothing here writes. A test drives the app through its gestures and reads the result.
 */

import type { ProjectSession } from './session.js';

export interface TraceRow {
  readonly command: string;
  readonly issuedBy: 'user' | 'agent';
  readonly summary: string;
  readonly affected: readonly { readonly nodeId: string; readonly title: string }[];
  readonly undoGroupId: string | null;
}

/** A dispatch the bus turned away. It has no activity row, so this is how a test sees one. */
export interface RejectedRow {
  readonly command: string;
  readonly issuedBy: 'user' | 'agent';
  readonly code: string;
}

export interface TreeRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly title: string;
  readonly order: number;
  readonly status: string | null;
  readonly label: string | null;
  readonly synopsis: string;
}

/** The body-projection range an editor has selected, and the document it is in. */
export interface SelectionRow {
  readonly docId: string;
  readonly from: number;
  readonly to: number;
}

/** How one mounted editor reports its selection: its body offsets, or `null` when nothing is selected or it is not shown. */
export type SelectionReader = () => { readonly from: number; readonly to: number } | null;

const selectionReaders = new Map<string, SelectionReader>();

/**
 * An editor pane registers how to read its selection while it is mounted, under its document. The hook reads them; nothing
 * else does. The returned function removes the registration when the pane unmounts or changes its document.
 */
export function registerSelectionReader(docId: string, read: SelectionReader): () => void {
  selectionReaders.set(docId, read);
  return () => {
    if (selectionReaders.get(docId) === read) selectionReaders.delete(docId);
  };
}

export interface CaotangTestHook {
  /** The activity log, oldest first. View commands are included; they are marked by their name. */
  activity(): TraceRow[];
  /** The text the shown editor has selected, as body offsets in its document, or `null` when nothing is selected. */
  selection(): SelectionRow | null;
  /** The dispatches the bus turned away, oldest first. A refused dispatch is not in `activity()`. */
  rejected(): RejectedRow[];
  /** The open project's tree, in the order the manifest holds it. */
  tree(): TreeRow[];
  /** A document's body, or `null` when there is no such document. */
  body(docId: string): string | null;
  /** The persistence status the save indicator shows. */
  saveState(): string | null;
  /** How many undo groups the session holds. */
  undoGroups(): number;
  /** The project id of the open session, or `null` on the projects screen. */
  projectId(): string | null;
  /** The picture registry as the manifest holds it: the records and the placements, in order. */
  pictures(): PicturesRow;
}

export interface PicturesRow {
  readonly records: readonly {
    readonly id: string;
    readonly file: string;
    readonly bytes: number;
    readonly width: number | null;
    readonly height: number | null;
    readonly caption: string | null;
    readonly alt: string | null;
    readonly tags: readonly string[];
    readonly decorative: boolean;
    readonly workingCopy: boolean;
  }[];
  readonly links: readonly { readonly id: string; readonly assetId: string; readonly role: string; readonly kind: string; readonly nodeId: string | null; readonly note: string | null }[];
}

declare global {
  interface Window {
    __caotang?: CaotangTestHook;
  }
}

export function installTestHook(current: () => ProjectSession | null): void {
  if (!import.meta.env.DEV) return;
  window.__caotang = {
    activity: () => {
      const session = current();
      if (!session) return [];
      return session.log.entries().map((entry) => ({
        command: entry.command,
        issuedBy: entry.issuedBy,
        summary: entry.summary,
        affected: entry.affected.map((node) => ({ nodeId: node.nodeId, title: node.title })),
        undoGroupId: entry.undoGroupId ?? null,
      }));
    },
    selection: () => {
      for (const [docId, read] of selectionReaders) {
        const range = read();
        if (range !== null) return { docId, from: range.from, to: range.to };
      }
      return null;
    },
    rejected: () => {
      const session = current();
      if (!session) return [];
      return session.rejected().map((row) => ({ command: row.command, issuedBy: row.issuedBy, code: row.code }));
    },
    tree: () => {
      const session = current();
      if (!session) return [];
      return session.state.manifest.tree.map((node) => ({
        id: node.id,
        parentId: node.parentId,
        type: node.type,
        title: node.title,
        order: node.order,
        status: node.status,
        label: node.label,
        synopsis: node.synopsis,
      }));
    },
    body: (docId) => current()?.state.documents.get(docId)?.body ?? null,
    saveState: () => current()?.saveState() ?? null,
    undoGroups: () => current()?.undo.groups().length ?? 0,
    projectId: () => current()?.projectId ?? null,
    pictures: () => {
      const manifest = current()?.state.manifest;
      return {
        records: (manifest?.assets ?? []).map((record) => ({
          id: record.id,
          file: record.file,
          bytes: record.bytes,
          width: record.width ?? null,
          height: record.height ?? null,
          caption: record.caption ?? null,
          alt: record.alt ?? null,
          tags: record.tags ?? [],
          decorative: record.decorative === true,
          workingCopy: record.workingCopy !== undefined,
        })),
        links: (manifest?.assetLinks ?? []).map((link) => ({
          id: link.id,
          assetId: link.assetId,
          role: String(link.role),
          kind: link.target.kind,
          nodeId: typeof (link.target as { nodeId?: unknown }).nodeId === 'string' ? (link.target as { nodeId: string }).nodeId : null,
          note: link.note ?? null,
        })),
      };
    },
  };
}
