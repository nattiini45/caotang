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
  | `caotang://doc/${string}`
  | `caotang://notes/${string}`
  | `caotang://codex/${string}`;

export const PROJECT_URI = 'caotang://project';
export const BINDER_URI = 'caotang://binder';
export const CODEX_URI = 'caotang://codex';

export const DOC_TEMPLATE = 'caotang://doc/{id}';
export const NOTES_TEMPLATE = 'caotang://notes/{id}';
export const CODEX_ENTRY_TEMPLATE = 'caotang://codex/{id}';

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
  'script.setShowMeta',
  'script.setEpisodeMeta',
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

/** The commands that change nothing a resource shows: the view's state, exports, the coherence file, external tools, skills. */
function leavesResourcesAlone(command: string): boolean {
  return /^(view|export|coherence|mcp|skill|recipe)\./u.test(command);
}

/**
 * The resources a batch of log rows changed, from the rows' commands and the nodes they name. A command that names a node changes
 * that node's body or notes, and any command that is not a view or export change moves the project and the binder, which are built
 * from the whole tree. A codex command refreshes the index and every entry, because the log does not say which entry it touched.
 */
export function changeOf(state: ProjectState, rows: readonly ActivityEntry[]): ProjectChange {
  const updated = new Set<string>();
  let listChanged = false;
  const byId = new Map(state.manifest.tree.map((node) => [node.id, node]));
  for (const row of rows) {
    if (row.defect !== undefined || leavesResourcesAlone(row.command)) continue;
    updated.add(PROJECT_URI);
    updated.add(BINDER_URI);
    if (LISTING.has(row.command)) listChanged = true;
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
