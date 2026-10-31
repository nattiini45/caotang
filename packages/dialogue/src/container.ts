/**
 * Dialogue containers in a project state — the store-facing half of the module.
 *
 * The store does not yet know the dialogue node types or their metadata (project-format §2 names
 * them as additive), so these helpers read what is there: the tree, the bodies and the codex. A
 * container is found by id or by title, the way `doc.read` resolves a document, and a node of any
 * other kind is refused with its kind named. A refusal is the bus's `CommandError`, so the tools
 * return one error shape with a closed code and a corrective hint.
 */

import { caseFold, canonical } from '@caotang/codex';
import { refusal, type CommandError } from '@caotang/bus';
import { getBody, type ProjectState, type TreeNode } from '@caotang/store';

import { isDialogueNodeType, type DialogueContainerMeta } from './kinds.js';
import type { DialogueSource } from './table.js';

/** The tree in binder order: each parent's children by `order`, depth first. Orphans are not visited. */
export function binderOrder(state: ProjectState): TreeNode[] {
  const children = new Map<string | null, TreeNode[]>();
  for (const node of state.manifest.tree) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: TreeNode[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null): void => {
    for (const node of children.get(parent) ?? []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push(node);
      walk(node.id);
    }
  };
  walk(null);
  return out;
}

/** Every dialogue container, in binder order, with its body and metadata. */
export function dialogueSourcesIn(state: ProjectState, metaFor?: (id: string) => DialogueContainerMeta | undefined): DialogueSource[] {
  return binderOrder(state)
    .filter((node) => isDialogueNodeType(node.type))
    .map((node) => {
      const meta = metaFor?.(node.id);
      return { id: node.id, title: node.title, body: getBody(state, node.id), ...(meta !== undefined ? { meta } : {}) };
    });
}

export type ContainerResolution =
  | { readonly ok: true; readonly node: TreeNode; readonly body: string }
  | { readonly ok: false; readonly error: CommandError };

function kindOf(node: TreeNode): string {
  if (node.type === 'document') return 'prose document';
  if (node.type === 'folder') return 'folder';
  return `${node.type} node`;
}

function keyOf(text: string): string {
  return caseFold(canonical(text.trim()));
}

function fail(code: CommandError['code'], message: string, correctiveHint: string): ContainerResolution {
  return { ok: false, error: refusal(code, message, { correctiveHint, target: 'params.doc' }) };
}

/** Resolves a container by exact id first, then by title. Ambiguous titles and non-containers are refused by name. */
export function resolveContainer(state: ProjectState, ref: string): ContainerResolution {
  const wanted = ref.trim();
  if (wanted === '') return fail('not-found', 'the container is not named', 'name the container by its title or id. binder.read_tree lists them.');
  const tree = state.manifest.tree;
  const byId = tree.find((node) => node.id === wanted);
  // The root carries the project's name as its title, and it is never a node a writer names: skip it for titles.
  const matches = byId !== undefined ? [byId] : tree.filter((node) => node.type !== 'root' && keyOf(node.title) === keyOf(wanted));
  if (matches.length === 0) {
    return fail('not-found', `no node is called "${wanted}"`, 'binder.read_tree lists the ids and titles.');
  }
  if (matches.length > 1) {
    const titles = matches.map((node) => `"${node.title}" (${node.id})`).join(', ');
    // The candidates travel as data too, so a caller that must not name some of them can leave those out (the harness, under a read rule).
    const candidates = matches.map((node) => ({ id: node.id, title: node.title, type: node.type }));
    return {
      ok: false,
      error: refusal('invalid-params', `"${wanted}" matches ${matches.length} nodes: ${titles}`, {
        correctiveHint: 'name one by its id.',
        target: 'params.doc',
        details: { ref: wanted, noun: 'node', candidates },
      }),
    };
  }
  const node = matches[0];
  if (node === undefined) return fail('not-found', `no node is called "${wanted}"`, 'binder.read_tree lists the ids and titles.');
  if (!isDialogueNodeType(node.type)) {
    return fail(
      'invalid-params',
      `"${node.title}" is a ${kindOf(node)}, not a dialogue container`,
      'The dialogue tools work on dialogue containers only. binder.read_tree lists them.',
    );
  }
  return { ok: true, node, body: getBody(state, node.id) };
}
