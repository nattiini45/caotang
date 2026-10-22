/**
 * Gestures, each one a single dispatch — ui-modules §2.2, §3.2, §4.1 mapped onto the
 * bus. Components call these; they do not build commands themselves, so the mapping
 * from a gesture to a command is in one file that can be read against the spec.
 *
 * Every function returns the bus's own result, so a caller can report a refusal in
 * the words the command chose, and a success can read what the apply produced.
 */

import type { CodexUpsertOp, CommandError, CommandParams, ExecutionOutcome, Result, VocabularyKind } from '@caotang/bus';
import type { ProjectState } from '@caotang/store';

import { nodeById, type DropPlan } from '../app/binder-model.js';
import type { ProjectSession } from '../app/session.js';

export type Outcome = Result<ExecutionOutcome, CommandError>;

/** `binder.create`'s apply returns the new node's id; this checks that shape rather than trusting it. */
export function createdNodeId(outcome: Outcome): string | undefined {
  if (!outcome.ok) return undefined;
  const result = outcome.value.result;
  if (typeof result !== 'object' || result === null) return undefined;
  const id = (result as { nodeId?: unknown }).nodeId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Select one node. A document also becomes the active document (§2.5's "open in
 * editor" on a click), and a container becomes the corkboard's scope (§3.1).
 */
export function selectNode(session: ProjectSession, nodeId: string): void {
  session.dispatch('view.setSelection', { nodeIds: [nodeId] });
  const node = nodeById(session.state, nodeId);
  if (!node) return;
  if (node.type === 'document') {
    session.dispatch('view.setActiveDoc', { docId: nodeId });
  } else {
    session.dispatch('view.setCorkboardScope', { nodeId: node.id === 'manuscript' ? null : node.id });
  }
}

export function clearSelection(session: ProjectSession): void {
  session.dispatch('view.setSelection', { nodeIds: [] });
}

export function setExpanded(session: ProjectSession, nodeId: string, expanded: boolean): void {
  session.dispatch('view.setExpanded', { nodeId, expanded });
}

/** A new node. `Untitled` is the spec's default (ui-modules §2.2); the caller may name it when the empty state already knows the name. */
export function createNode(
  session: ProjectSession,
  parentId: string,
  type: 'folder' | 'document',
  title = 'Untitled',
): Outcome {
  return session.dispatch('binder.create', { parentId, type, title });
}

export function renameNode(session: ProjectSession, nodeId: string, title: string): Outcome {
  return session.dispatch('binder.rename', { nodeId, title });
}

export function deleteNode(session: ProjectSession, nodeId: string): Outcome {
  return session.dispatch('project.deleteNode', { nodeId });
}

/** `binder.move` with the plan the binder model computed — the command still validates it. */
export function moveNode(session: ProjectSession, nodeId: string, plan: Extract<DropPlan, { ok: true }>): Outcome {
  return session.dispatch('binder.move', { nodeId, newParentId: plan.newParentId, index: plan.index });
}

export function setStatus(session: ProjectSession, nodeId: string, status: string | null): Outcome {
  return session.dispatch('binder.setMeta', { nodeId, patch: { status } });
}

export function setLabel(session: ProjectSession, nodeId: string, label: string | null): Outcome {
  return session.dispatch('binder.setMeta', { nodeId, patch: { label } });
}

/** The scene's export style (exporter.md §2): a style in `SCENE_STYLES`, or `null` to clear it. */
export function setSceneStyle(session: ProjectSession, nodeId: string, style: string | null): Outcome {
  return session.dispatch('binder.setMeta', { nodeId, patch: { style } });
}

export function addKeyword(session: ProjectSession, nodeId: string, keyword: string): Outcome {
  return session.dispatch('binder.setMeta', { nodeId, patch: { keywords_add: [keyword] } });
}

export function removeKeyword(session: ProjectSession, nodeId: string, keyword: string): Outcome {
  return session.dispatch('binder.setMeta', { nodeId, patch: { keywords_remove: [keyword] } });
}

export function setSynopsis(session: ProjectSession, nodeId: string, synopsis: string): Outcome {
  return session.dispatch('binder.setSynopsis', { nodeId, synopsis });
}

export function setNotes(session: ProjectSession, nodeId: string, notes: string): Outcome {
  return session.dispatch('notes.set', { nodeId, notes });
}

/**
 * `codex.upsert` for one entry (codex.md §7): a create, or an update that names only the fields it changes. The
 * bus validates the whole op, so a refusal (a duplicate name, a limit) comes back as an error for the panel to say.
 */
export function saveEntry(session: ProjectSession, op: CodexUpsertOp): Outcome {
  return session.dispatch('codex.upsert', { entries: [op] });
}

/** `codex.attach` (codex.md §5): both lists are always given, so the change to the attachments is stated in full. */
export function attachEntry(
  session: ProjectSession,
  entryId: string,
  attachTo: readonly string[],
  detachFrom: readonly string[],
): Outcome {
  return session.dispatch('codex.attach', { entryId, attachTo: [...attachTo], detachFrom: [...detachFrom] });
}

/**
 * `export.compile` (exporter.md §5): the whole manuscript, in one of the formats the exporter writes. A recipe, when named,
 * supplies the options the compile reads (the title page, the contents, the author), so the dialog's controls are saved to
 * the recipe first and the compile names it.
 */
export function compileManuscript(session: ProjectSession, format: string, recipeName?: string): Outcome {
  return session.dispatch('export.compile', recipeName === undefined ? { format } : { format, recipeName });
}

/** `project.rename`: the project's title, which the title page and the EPUB's `dc:title` carry. */
export function renameProject(session: ProjectSession, title: string): Outcome {
  return session.dispatch('project.rename', { title });
}

/** `project.setMetadata` (epub-metadata.md): the author, language, ISBN and cover reference. A key left out is left alone. */
export function setProjectDetails(session: ProjectSession, patch: CommandParams['project.setMetadata']['patch']): Outcome {
  return session.dispatch('project.setMetadata', { patch });
}

/** `project.importAsset` for the cover is `session.importCover`, which stages the bytes first (session.ts). */

/**
 * `vocabulary.upsert` (project-format §2): a new term when `id` is absent, or the named term renamed and recoloured.
 * A status or label is the writer's to add, rename and recolour, so this is the only path that writes the vocabulary.
 */
export function saveTerm(
  session: ProjectSession,
  kind: VocabularyKind,
  term: { readonly id?: string; readonly name: string; readonly color: string },
): Outcome {
  return session.dispatch('vocabulary.upsert', { kind, ...term });
}

/** `vocabulary.remove`: drop a term. Nodes that held it lose it, and the undo puts it back where it was. */
export function removeTerm(session: ProjectSession, kind: VocabularyKind, id: string): Outcome {
  return session.dispatch('vocabulary.remove', { kind, id });
}

/** `recipe.save` (exporter.md §2): a named export configuration. Saving a name that exists replaces it. */
export function saveRecipe(session: ProjectSession, recipe: CommandParams['recipe.save']): Outcome {
  return session.dispatch('recipe.save', recipe);
}

/** `recipe.delete`: remove a saved recipe by name. */
export function deleteRecipe(session: ProjectSession, name: string): Outcome {
  return session.dispatch('recipe.delete', { name });
}

/**
 * `export.compileSelection` (exporter.md §5): the nodes named, and nothing inferred from them. A recipe, when named, supplies the
 * options the part compiles with (the title page, the contents, the author and the character limit), as it does for a manuscript.
 */
export function compileSelection(session: ProjectSession, includeRootIds: readonly string[], format: string, recipeName?: string): Outcome {
  return session.dispatch(
    'export.compileSelection',
    recipeName === undefined ? { includeRootIds: [...includeRootIds], format } : { includeRootIds: [...includeRootIds], format, recipeName },
  );
}

/** The first of the selection that still names a node, or `null`: a deleted node may linger in view state (bus view.ts). */
export function liveSelection(state: ProjectState, selection: readonly string[]): string | null {
  for (const id of selection) {
    if (nodeById(state, id)) return id;
  }
  return null;
}

/** A refusal's words, for the status line: what is wrong, then what to do, each as one sentence. */
export function explain(error: CommandError): string {
  const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);
  return error.correctiveHint
    ? `${sentence(error.message)} ${sentence(error.correctiveHint)}`
    : sentence(error.message);
}
