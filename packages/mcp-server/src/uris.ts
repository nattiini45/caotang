/**
 * The resource URIs of a project — extensibility.md §9.
 *
 * Every URI names a node or a codex entry by its id and nothing else: a file name (`docs/n_*.md`) never appears in one, and a title
 * does not either, because a title can change and an id cannot. The scheme is `caotang:`, so a URI cannot be taken for a file or a
 * web address.
 */

import type { ActivityEntry } from '@caotang/bus';
import type { ProjectState, TreeNode } from '@caotang/store';

import type { ProjectChange } from './changes.js';

export const RESOURCE_SCHEME = 'caotang' as const;

export type CaotangResourceUri =
  | 'caotang://project'
  | 'caotang://binder'
  | 'caotang://codex'
  | 'caotang://timeline'
  | 'caotang://timeline.csv'
  | 'caotang://assets'
  | `caotang://asset/${string}`
  | `caotang://doc/${string}`
  | `caotang://notes/${string}`
  | `caotang://codex/${string}`;

export const PROJECT_URI = 'caotang://project';
export const BINDER_URI = 'caotang://binder';
export const CODEX_URI = 'caotang://codex';
export const TIMELINE_URI = 'caotang://timeline';
export const TIMELINE_CSV_URI = 'caotang://timeline.csv';
export const ASSETS_URI = 'caotang://assets';

export const ASSET_TEMPLATE = 'caotang://asset/{id}';
export const DOC_TEMPLATE = 'caotang://doc/{id}';
export const NOTES_TEMPLATE = 'caotang://notes/{id}';
export const CODEX_ENTRY_TEMPLATE = 'caotang://codex/{id}';

export const assetUri = (id: string): CaotangResourceUri => `caotang://asset/${id}`;
export const docUri = (id: string): CaotangResourceUri => `caotang://doc/${id}`;
export const notesUri = (id: string): CaotangResourceUri => `caotang://notes/${id}`;
export const codexEntryUri = (id: string): CaotangResourceUri => `caotang://codex/${id}`;

/** A node with a body of its own: a document, or a dialogue container (its body is Ink). */
export function hasBody(node: TreeNode): boolean {
  return node.type === 'document' || node.type === 'dialogue';
}

/** The commands that change a body. */
const BODY: ReadonlySet<string> = new Set(['doc.write', 'editor.insert', 'editor.replaceRange', 'screenplay.import', 'dialogue.importInk']);

/** The commands that change what the notes resource shows: the synopsis, notes, keywords and the title it opens with. */
const INSPECTOR: ReadonlySet<string> = new Set([
  'notes.set',
  'notes.append',
  'binder.setSynopsis',
  'binder.setMeta',
  'binder.rename',
  'dialogue.setMeta',
  'shot.setMeta',
]);

/** The commands after which the resource lists are different: a node is added, moved or renamed, or a codex entry may be added. */
const LISTING: ReadonlySet<string> = new Set([
  'binder.create',
  'binder.move',
  'binder.rename',
  'project.deleteNode',
  'storyboard.create',
  'shot.create',
  'screenplay.import',
  'dialogue.importInk',
  'codex.upsert',
]);

const CODEX: ReadonlySet<string> = new Set(['codex.upsert', 'codex.attach']);

/** The picture commands after which the resource list is different: a picture is added or its record removed. */
const PICTURE_LISTING: ReadonlySet<string> = new Set(['asset.import', 'asset.importBatch', 'asset.delete']);

/**
 * The commands that change the timeline resources though they leave the others alone: they touch only `coherence.json` —
 * a scene declaration, a findings change or a scan's run — and the timeline is built from the whole state and the whole
 * coherence file, so they refresh `caotang://timeline` and `caotang://timeline.csv`. (`timeline.apply` needs no entry
 * here: it is not a `coherence.` command, so it reaches the project resources below and the timeline with them.)
 */
const TIMELINE_ONLY: ReadonlySet<string> = new Set(['coherence.setSceneMeta', 'coherence.scan', 'coherence.setFindingStatus']);

/** The commands that change nothing a resource shows: the view's state, exports, the coherence file, external tools, skills. */
function leavesResourcesAlone(command: string): boolean {
  return /^(view|export|coherence|mcp|skill|recipe)\./u.test(command);
}

/**
 * The resources a batch of log rows changed, from the rows' commands and the nodes they name. A command that names a node changes
 * that node's body or notes, and any command that is not a view or export change moves the project and the binder, which are built
 * from the whole tree. A codex command refreshes the index and every entry, because the log does not say which entry it touched.
 * The timeline resources (`caotang://timeline`, `caotang://timeline.csv`) follow the same rule: the timeline is built from
 * the whole state and the whole coherence file, so every project change refreshes them, and so does any command that
 * changes only `coherence.json` (a scene declaration, a finding, a scan). `caotang://assets` is built from the whole
 * registry and follows it, and a picture command (`asset.*`) also refreshes every `caotang://asset/{id}`, as a codex
 * command refreshes every entry.
 */
export function changeOf(state: ProjectState, rows: readonly ActivityEntry[]): ProjectChange {
  const updated = new Set<string>();
  let listChanged = false;
  const byId = new Map(state.manifest.tree.map((node) => [node.id, node]));
  for (const row of rows) {
    if (row.defect !== undefined) continue;
    if (TIMELINE_ONLY.has(row.command)) {
      updated.add(TIMELINE_URI);
      updated.add(TIMELINE_CSV_URI);
    }
    if (leavesResourcesAlone(row.command)) continue;
    updated.add(PROJECT_URI);
    updated.add(BINDER_URI);
    // The timeline model is a function of the whole state and the coherence file, so any project change refreshes it too.
    updated.add(TIMELINE_URI);
    updated.add(TIMELINE_CSV_URI);
    // The registry's links follow the tree and the bodies (a deleted node takes its links, a body write re-pins its paragraph links),
    // so any project change may have changed `caotang://assets`.
    updated.add(ASSETS_URI);
    if (LISTING.has(row.command) || PICTURE_LISTING.has(row.command)) listChanged = true;
    // A picture command can change any record or file (a relink, a working copy) and the log does not say which one.
    if (row.command.startsWith('asset.')) for (const record of state.manifest.assets ?? []) updated.add(assetUri(record.id));
    if (CODEX.has(row.command)) {
      updated.add(CODEX_URI);
      for (const entry of state.manifest.codex ?? []) updated.add(codexEntryUri(entry.id));
    }
    for (const { nodeId } of row.affected) {
      const node = byId.get(nodeId);
      if (node === undefined || node.type === 'root') continue;
      if (BODY.has(row.command) && hasBody(node)) updated.add(docUri(nodeId));
      if (INSPECTOR.has(row.command)) updated.add(notesUri(nodeId));
    }
  }
  return { updated: [...updated].sort(), listChanged };
}
