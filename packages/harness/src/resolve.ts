/**
 * Node references — how a tool call names a node.
 *
 * **The disambiguation rule, stated once** (agent-harness.md §3, `doc.read`):
 *
 * 1. An exact id wins outright. Ids are unambiguous by construction.
 * 2. Otherwise the reference is matched against titles, case-insensitively and
 *    with surrounding whitespace ignored:
 *    - exactly one title equal to it → that node;
 *    - otherwise exactly one title that *starts with* it → that node;
 *    - more than one candidate at either step → refused, with every candidate
 *      listed and the next corrective tool named;
 *    - none → not found, with the next corrective tool named.
 *
 * The exact-title step is what makes "The Storm" resolve when "The Storm Returns"
 * also exists: the longer title starts with the shorter one, but the shorter one
 * is an exact match, so there is no ambiguity to report.
 *
 * Candidates are restricted by a filter first, so "doc" means a document and a
 * folder title never silently matches a document reference.
 */

import { HINT_READ_TREE, ok, type CommandError, type Result } from '@caotang/bus';
import type { ProjectState, TreeNode } from '@caotang/store';

import { failure, invalidParams, notFound, refusal } from './errors.js';
import { plural } from './util.js';

export type NodeFilter = (node: TreeNode) => boolean;

/** A document node: the only kind that has a body and a notes field to read. */
export const DOCUMENT: NodeFilter = (node) => node.type === 'document';

/** `meta.set`'s targets: "docs/folders" (agent-harness §3). The root is not a target. */
export const TARGET: NodeFilter = (node) => node.type === 'document' || node.type === 'folder';

/** A node that can hold children: the tree root or a folder. */
export const CONTAINER: NodeFilter = (node) => node.type === 'root' || node.type === 'folder';

export const ANY_NODE: NodeFilter = () => true;

function normal(text: string): string {
  return text.trim().toLowerCase();
}

function candidateLine(node: Pick<TreeNode, 'id' | 'title'>): string {
  return `"${node.title}" (${node.id})`;
}

/** The refusal for a reference that names several nodes: every candidate listed, by id too, so a caller can pick one without parsing the sentence. */
export function ambiguity(ref: string, noun: string, target: string, matches: readonly Pick<TreeNode, 'id' | 'title' | 'type'>[]): CommandError {
  return refusal('invalid-params', `"${ref}" matches ${plural(matches.length, noun)}: ${matches.map(candidateLine).join(', ')}. Pass one of their ids.`, {
    correctiveHint: `use binder.read_tree to list the ids, then pass the id of the ${noun} you mean`,
    target,
    details: { ref, noun, candidates: matches.map((node) => ({ id: node.id, title: node.title, type: node.type })) },
  });
}

/**
 * An ambiguity refusal as the agent may see it: the candidates a read rule withholds are dropped, and a reference that matches
 * none of the rest is answered as a name that matches nothing, so no title or id of a withheld node leaves in an error. Any other
 * error is returned as it is.
 */
export function withoutWithheld(error: CommandError, withheld: ReadonlySet<string>): CommandError {
  const details = error.details as { ref?: unknown; noun?: unknown; candidates?: unknown } | undefined;
  if (withheld.size === 0 || details === undefined || !Array.isArray(details.candidates) || typeof details.ref !== 'string' || typeof details.noun !== 'string') return error;
  const candidates = details.candidates as { id: string; title: string; type: TreeNode['type'] }[];
  const visible = candidates.filter((candidate) => !withheld.has(candidate.id));
  if (visible.length === candidates.length) return error;
  const target = error.target ?? 'params.doc';
  if (visible.length === 0) return notFound(`no ${details.noun} is titled or identified by "${details.ref}"`, HINT_READ_TREE, target);
  return ambiguity(details.ref, details.noun, target, visible);
}

export function resolveNode(
  state: ProjectState,
  ref: string,
  filter: NodeFilter,
  noun: string,
  target: string,
): Result<TreeNode, CommandError> {
  if (normal(ref).length === 0) {
    return failure(invalidParams(`${target} must not be blank`, `pass a title or an id naming a ${noun}`, target));
  }

  const candidates = state.manifest.tree.filter(filter);
  const byId = candidates.find((node) => node.id === ref);
  if (byId !== undefined) return ok(byId);

  const elsewhere = state.manifest.tree.find((node) => node.id === ref);
  if (elsewhere !== undefined) {
    return failure(
      invalidParams(
        `"${ref}" is a ${elsewhere.type}, not a ${noun}`,
        `pass a ${noun} here — ${HINT_READ_TREE}`,
        target,
      ),
    );
  }

  const wanted = normal(ref);
  const exact = candidates.filter((node) => normal(node.title) === wanted);
  const matches = exact.length > 0 ? exact : candidates.filter((node) => normal(node.title).startsWith(wanted));

  if (matches.length === 1) return ok(matches[0] as TreeNode);
  if (matches.length > 1) return failure(ambiguity(ref, noun, target, matches));
  return failure(notFound(`no ${noun} is titled or identified by "${ref}"`, HINT_READ_TREE, target));
}

/** An id, and nothing else — `binder.restructure` names existing ids only (agent-harness §3). */
export function resolveId(state: ProjectState, id: string, target: string): Result<TreeNode, CommandError> {
  const node = state.manifest.tree.find((candidate) => candidate.id === id);
  if (node === undefined) {
    return failure(notFound(`no node with id "${id}"`, HINT_READ_TREE, target));
  }
  return ok(node);
}

/* ------------------------------------------------------------------ *
 * Tree shape helpers. Pure reads over the manifest's flat tree.
 * ------------------------------------------------------------------ */

export function childrenOf(state: ProjectState, parentId: string): TreeNode[] {
  return state.manifest.tree
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order);
}

/** Every node under `rootId`, depth-first, in binder order. `rootId` itself is excluded. */
export function descendantsOf(state: ProjectState, rootId: string): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (parentId: string): void => {
    for (const child of childrenOf(state, parentId)) {
      out.push(child);
      visit(child.id);
    }
  };
  visit(rootId);
  return out;
}
