/**
 * The reads an MCP resource serves — extensibility.md §9.
 *
 * `doc.read`, `notes.read` and `codex.read` return a model-facing value under a token cap. A resource is something the writer
 * attached on purpose, so it carries the whole body, and the host's own limits apply. These functions are the lookups those
 * tools make (the same node resolution, so the same refusal wording), without the cap. None of them dispatches a command
 * or touches the log's source; a caller that logs a read does it itself.
 */

import { ok, type CommandError, type Result } from '@caotang/bus';
import { codexRead, sortCodex } from '@caotang/codex';
import type { CodexEntry, ProjectState, TreeNode } from '@caotang/store';

import { failure, notFound } from './errors.js';
import { resolveNode } from './resolve.js';
import { bodyOf, wordsOfDocument } from './tools/common.js';

/** A node that has a body file: a document, or a dialogue container, whose body is Ink (dialogue-narrative.md §2.2). */
const BODY_NODE = (node: TreeNode): boolean => node.type === 'document' || node.type === 'dialogue';

export interface BodyRead {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  /** The media-track marker (`screenplay`, `branching`), or undefined on a plain document. */
  readonly kind: string | undefined;
  /** The whole body, as `doc.read` returns it when it fits its cap. */
  readonly text: string;
  readonly words: number;
}

/** A document's whole body. A folder, the root or an unknown reference is refused as `doc.read` refuses it. */
export function readBody(state: ProjectState, ref: string): Result<BodyRead, CommandError> {
  const node = resolveNode(state, ref, BODY_NODE, 'document', 'params.doc');
  if (!node.ok) return failure(node.error);
  const { id, title, type, kind } = node.value;
  return ok({ id, title, type, kind, text: bodyOf(state, id), words: wordsOfDocument(state, id) });
}

export interface NotesRead {
  readonly id: string;
  readonly title: string;
  readonly synopsis: string;
  readonly notes: string;
  readonly keywords: readonly string[];
}

/** A node's inspector fields, whole. `notes.read` cuts the notes to its cap; this does not. */
export function readNotes(state: ProjectState, ref: string): Result<NotesRead, CommandError> {
  const node = resolveNode(state, ref, (candidate) => candidate.type !== 'root', 'node', 'params.doc');
  if (!node.ok) return failure(node.error);
  const { id, title, synopsis, notes, keywords } = node.value;
  return ok({ id, title, synopsis, notes, keywords: [...keywords] });
}

/** A codex entry by id, with its whole description. An unknown id is refused in `codex.read`'s words. */
export function readCodexEntry(state: ProjectState, id: string): Result<CodexEntry, CommandError> {
  const entries = state.manifest.codex ?? [];
  const found = entries.find((entry) => entry.id === id);
  if (found !== undefined) return ok(found);
  const asked = codexRead({ id }, { entries });
  return failure(notFound(asked.note ?? `no codex entry with id "${id}"`, 'use the codex resource to list the entries, then pass one of its ids', 'id'));
}

/** The codex in its deterministic order (codex.md §6), which is the order `codex.read` lists it in. */
export function codexInOrder(state: ProjectState): CodexEntry[] {
  return sortCodex(state.manifest.codex ?? []);
}
