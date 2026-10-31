/**
 * The writer's agent rules as the binder menu and Settings show them (agent-harness §4, Rules; ui-modules §2.2, §5.1) — pure.
 *
 * The binder menu offers three states for a folder or a document, and each is one project rule: **may read and change** is no rule,
 * **may read only** is a write-deny on the node's subtree, and **may not read** is a read-deny on it (which also locks it, since a
 * read-deny implies a write-deny). The rule is `tool: '*'`, so it covers every tool, and it is keyed by the node's id, so a rename
 * does not move it. Settings lists every rule with where it comes from and a way to remove it.
 */

import type { PermissionRule, ProjectState, TreeNode } from '@caotang/store';

export type AgentAccess = 'full' | 'read-only' | 'none';

export const ACCESS_LABELS: Readonly<Record<AgentAccess, string>> = Object.freeze({
  full: 'Agent: may read and change',
  'read-only': 'Agent: may read only',
  none: 'Agent: may not read',
});

/** The short words a binder row carries beside its lock icon. */
export const ACCESS_MARKERS: Readonly<Record<Exclude<AgentAccess, 'full'>, string>> = Object.freeze({
  'read-only': 'Agent: read only',
  none: 'Agent: hidden',
});

/** Whether a rule is the one the menu writes for `nodeId`: every tool, this subtree, a deny. */
function isMenuRule(rule: PermissionRule, nodeId: string): boolean {
  return rule.effect === 'deny' && rule.tool === '*' && rule.scope !== undefined && 'subtree' in rule.scope && rule.scope.subtree === nodeId;
}

/** What the project's own rules say about one node, not counting the folders above it. */
export function accessOf(rules: readonly PermissionRule[], nodeId: string): AgentAccess {
  let access: AgentAccess = 'full';
  for (const rule of rules) {
    if (!isMenuRule(rule, nodeId)) continue;
    if ((rule.access ?? 'any') === 'write') access = access === 'none' ? 'none' : 'read-only';
    else access = 'none';
  }
  return access;
}

/** The rules with this node's access set: its menu rule is replaced, and any other rule is kept as it is. */
export function withAccess(rules: readonly PermissionRule[], nodeId: string, access: AgentAccess): PermissionRule[] {
  const kept = rules.filter((rule) => !isMenuRule(rule, nodeId));
  if (access === 'full') return kept;
  return [...kept, { effect: 'deny', tool: '*', scope: { subtree: nodeId }, access: access === 'none' ? 'read' : 'write' }];
}

export interface EffectiveAccess {
  readonly access: AgentAccess;
  /** The node the rule is set on, when it is not the node asked about: the folder that holds it. */
  readonly inheritedFrom?: TreeNode;
}

/** What binds a node: its own access, or the stricter access of a folder above it. */
export function effectiveAccess(rules: readonly PermissionRule[], state: Pick<ProjectState, 'manifest'>, nodeId: string): EffectiveAccess {
  const byId = new Map(state.manifest.tree.map((node) => [node.id, node]));
  let result: EffectiveAccess = { access: 'full' };
  let guard = 0;
  for (let at = byId.get(nodeId); at !== undefined && guard <= byId.size; at = at.parentId === null ? undefined : byId.get(at.parentId), guard += 1) {
    const access = accessOf(rules, at.id);
    if (access === 'full') continue;
    const stricter = result.access === 'full' || (result.access === 'read-only' && access === 'none');
    if (stricter) result = at.id === nodeId ? { access } : { access, inheritedFrom: at };
  }
  return result;
}

const EFFECT_WORDS: Readonly<Record<PermissionRule['effect'], string>> = { deny: 'Never', ask: 'Always asks' };

/** One rule in the writer's words, for the Settings list. `inert` is a rule that names a folder or document this project no longer has. */
export function describeRule(rule: PermissionRule, state: Pick<ProjectState, 'manifest'> | null): { readonly text: string; readonly inert: boolean } {
  const access = rule.access ?? 'any';
  if (rule.scope === undefined) {
    const tool = rule.tool === '*' ? 'any tool' : rule.tool;
    return { text: rule.effect === 'deny' ? `Never lets the agent use ${tool}` : `Asks you before the agent uses ${tool}`, inert: false };
  }
  if ('path' in rule.scope) {
    return { text: `${rule.effect === 'deny' ? 'Keeps the agent out of' : 'Asks before the agent touches'} the path ${rule.scope.path} (${rule.tool})`, inert: false };
  }
  const node = state?.manifest.tree.find((candidate) => candidate.id === (rule.scope as { subtree: string }).subtree);
  if (node === undefined) return { text: `${EFFECT_WORDS[rule.effect]} a folder or document this project no longer has (${rule.tool})`, inert: true };
  const tools = rule.tool === '*' ? '' : ` with ${rule.tool}`;
  if (rule.effect === 'ask') return { text: `Asks you before the agent ${access === 'read' ? 'reads' : access === 'write' ? 'changes' : 'reads or changes'} “${node.title}”${tools}`, inert: false };
  if (access === 'write') return { text: `“${node.title}” is read only for the agent${tools}`, inert: false };
  return { text: `“${node.title}” is hidden from the agent${tools}`, inert: false };
}
