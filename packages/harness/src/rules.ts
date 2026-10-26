/**
 * Agent rules — [agent-harness.md §4](../../../docs/architecture/agent-harness.md), "Rules".
 *
 * A rule narrows the agent: `deny` refuses a call, `ask` forces a card for it. The harness evaluates them before the bus, in the
 * order deny, then ask, and the first rule that matches in that order decides, across every source and never by how specific it is.
 * There is no `allow`: a rule can only restrict, so a project file can never grant the agent power. The bus gate (`checkPermission`)
 * is not touched and stays pure; a rule needs the tree, which the gate does not have.
 *
 * Everything here is pure. The shape and the tolerant read are the store's (`agent-rules.ts`), since a manifest carries rules.
 *
 * A **deny with read access** also withholds its scope: the nodes never enter a prompt (`withheldNodes`), and it implies a write-deny
 * on the same scope, so the agent cannot edit what it cannot see.
 */

import { refusal, type CommandError } from '@caotang/bus';
import type { PermissionRule, ProjectState, RuleScope, TreeNode } from '@caotang/store';

export type { PermissionRule, RuleAccess, RuleEffect, RuleScope } from '@caotang/store';

export type RuleSource = 'app' | 'project' | 'session';

export interface SourcedRule extends PermissionRule {
  readonly source: RuleSource;
}

export interface RuleSet {
  readonly rules: readonly SourcedRule[];
  /**
   * The rules could not be read (a host that holds them elsewhere failed to). Every call that changes the project is then refused,
   * since a rule that cannot be read cannot be shown to allow it.
   */
  readonly unreadable?: boolean;
}

export const NO_RULES: RuleSet = Object.freeze({ rules: [] });

/** Where a rule set is read from, at each call, so a change in Settings applies to the next one. */
export type RulesProvider = () => RuleSet;

/** The binder nodes a call reads and writes. `opOf` names the operation of a compound call that touches a node first. */
export interface CallTargets {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly opOf?: Readonly<Record<string, number>>;
}

/** What a rule needs to know about a call beyond its targets. */
export interface CallFacts {
  /** The tool's registry name, or an external tool's qualified name. */
  readonly tool: string;
  /** A loaded external tool: its nodes are unknown. */
  readonly external: boolean;
  /** The call changes the project or the world (any write risk). */
  readonly writes: boolean;
}

export type RuleVerdict =
  | { readonly effect: 'deny'; readonly rule: SourcedRule; readonly target: string; readonly access: 'read' | 'write' }
  | { readonly effect: 'ask'; readonly rule: SourcedRule }
  | { readonly effect: 'none' };

export const NO_VERDICT: RuleVerdict = Object.freeze({ effect: 'none' });

/** The id a deny names when the call's nodes could not be worked out. */
export const UNKNOWN_TARGET = '(unknown)';

const UNREADABLE_RULE: SourcedRule = Object.freeze({
  effect: 'deny',
  tool: '*',
  access: 'write',
  note: 'the rules could not be read',
  source: 'project',
});

/** `*` matches any run of characters, including none. Linear in the text per star, and no regular expression. */
export function globMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      resume = t;
      p += 1;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

function childrenIndex(tree: readonly TreeNode[]): ReadonlyMap<string, readonly TreeNode[]> {
  const out = new Map<string, TreeNode[]>();
  for (const node of tree) {
    if (node.parentId === null) continue;
    const list = out.get(node.parentId);
    if (list === undefined) out.set(node.parentId, [node]);
    else list.push(node);
  }
  return out;
}

/** The title path of a node from the first level under the root: `Manuscript/Act 1/Scene`. The root itself has no path. */
function titlePaths(tree: readonly TreeNode[]): ReadonlyMap<string, readonly string[]> {
  const byId = new Map(tree.map((node) => [node.id, node]));
  const paths = new Map<string, readonly string[]>();
  const pathOf = (node: TreeNode, depth: number): readonly string[] => {
    const known = paths.get(node.id);
    if (known !== undefined) return known;
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    const above = parent === undefined || parent.type === 'root' || depth > tree.length ? [] : pathOf(parent, depth + 1);
    const own = node.type === 'root' ? [] : [...above, node.title];
    paths.set(node.id, own);
    return own;
  };
  for (const node of tree) pathOf(node, 0);
  return paths;
}

/** Path segments against a pattern whose `**` spans any run of segments. Memoized per (pattern, path) position, so it is O(pattern x path). */
function segmentsMatch(pattern: readonly string[], path: readonly string[]): boolean {
  const parts = pattern.filter((part, index) => part !== '**' || pattern[index - 1] !== '**');
  const seen = new Map<number, boolean>();
  const at = (p: number, s: number): boolean => {
    if (p === parts.length) return s === path.length;
    const key = p * (path.length + 1) + s;
    const known = seen.get(key);
    if (known !== undefined) return known;
    let hit = false;
    if (parts[p] === '**') {
      for (let skip = s; skip <= path.length && !hit; skip += 1) hit = at(p + 1, skip);
    } else {
      hit = s < path.length && globMatches(parts[p] as string, path[s] as string) && at(p + 1, s + 1);
    }
    seen.set(key, hit);
    return hit;
  };
  return at(0, 0);
}

/**
 * The nodes a scope covers (itself and everything under it), or undefined when it covers nothing that exists: a subtree whose node
 * was deleted. Such a rule is inert and says so (`ruleWarnings`); it never blocks anything.
 */
export function scopeNodes(scope: RuleScope, tree: readonly TreeNode[]): ReadonlySet<string> | undefined {
  if ('subtree' in scope) {
    if (!tree.some((node) => node.id === scope.subtree)) return undefined;
    const children = childrenIndex(tree);
    const out = new Set<string>([scope.subtree]);
    const queue = [scope.subtree];
    for (let at = 0; at < queue.length; at += 1) {
      for (const child of children.get(queue[at] as string) ?? []) {
        if (out.has(child.id)) continue;
        out.add(child.id);
        queue.push(child.id);
      }
    }
    return out;
  }
  const pattern = scope.path.split('/').map((part) => part.trim()).filter((part) => part !== '');
  const paths = titlePaths(tree);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const covers = (node: TreeNode, depth: number): boolean => {
    const path = paths.get(node.id) ?? [];
    if (path.length > 0 && segmentsMatch(pattern, path)) return true;
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    return parent !== undefined && depth <= tree.length && covers(parent, depth + 1);
  };
  const out = new Set<string>();
  for (const node of tree) if (covers(node, 0)) out.add(node.id);
  return out.size === 0 ? undefined : out;
}

interface Hit {
  readonly target: string;
  readonly access: 'read' | 'write';
}

function intersect(ids: readonly string[], nodes: ReadonlySet<string>): string | undefined {
  return ids.find((id) => nodes.has(id));
}

function hitOf(rule: SourcedRule, call: CallFacts, targets: CallTargets | undefined, tree: readonly TreeNode[]): Hit | undefined {
  const access = rule.access ?? 'any';
  if (rule.scope === undefined) {
    if (access === 'write' && !call.writes) return undefined;
    return { target: '', access: call.writes ? 'write' : 'read' };
  }
  const nodes = scopeNodes(rule.scope, tree);
  if (nodes === undefined) return undefined;
  // A call whose nodes cannot be worked out is refused under a scoped deny and asked about under a scoped ask: a rule that cannot be
  // checked is not taken to allow the call.
  if (targets === undefined) return access === 'write' && !call.writes ? undefined : { target: UNKNOWN_TARGET, access: call.writes ? 'write' : 'read' };
  // A read-deny implies a write-deny on the same scope, so for a deny `read` and `any` cover both. An ask is exactly what it names.
  const reads = access !== 'write';
  const writes = rule.effect === 'deny' ? true : access !== 'read';
  const written = writes ? intersect(targets.writes, nodes) : undefined;
  if (written !== undefined) return { target: written, access: 'write' };
  const read = reads ? intersect(targets.reads, nodes) : undefined;
  return read === undefined ? undefined : { target: read, access: 'read' };
}

/**
 * The verdict for one call. Pure: the same rules, call, targets and tree give the same verdict. Order: every `deny`, then every
 * `ask`, each in the order the rules are listed, and the first match wins whatever its source. `targets` is undefined when the call's
 * nodes could not be worked out.
 */
export function evaluateRules(set: RuleSet, call: CallFacts, targets: CallTargets | undefined, state: Pick<ProjectState, 'manifest'>): RuleVerdict {
  if (set.unreadable === true && call.writes) return { effect: 'deny', rule: UNREADABLE_RULE, target: '', access: 'write' };
  const tree = state.manifest.tree;
  for (const effect of ['deny', 'ask'] as const) {
    for (const rule of set.rules) {
      if (rule.effect !== effect || !globMatches(rule.tool, call.tool)) continue;
      const hit = hitOf(rule, call, targets, tree);
      if (hit === undefined) continue;
      return effect === 'deny' ? { effect: 'deny', rule, target: hit.target, access: hit.access } : { effect: 'ask', rule };
    }
  }
  return NO_VERDICT;
}

/**
 * The nodes a read-deny keeps out of what `tool` reads: the scope of every deny rule with read (or any) access that applies to the
 * tool. A rule with no scope is tool-level and withholds nothing by itself; it refuses the tool.
 */
export function withheldNodes(set: RuleSet, state: Pick<ProjectState, 'manifest'>, tool: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const rule of set.rules) {
    if (rule.effect !== 'deny' || rule.scope === undefined || (rule.access ?? 'any') === 'write' || !globMatches(rule.tool, tool)) continue;
    for (const id of scopeNodes(rule.scope, state.manifest.tree) ?? []) out.add(id);
  }
  return out;
}

/**
 * The nodes any read-deny keeps from some tool, whatever the tool. A conversation already held was filtered by this much at least, so a
 * resume compares it with what it was when the run's last prompt was built.
 */
export function withheldAnywhere(set: RuleSet, state: Pick<ProjectState, 'manifest'>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const rule of set.rules) {
    if (rule.effect !== 'deny' || rule.scope === undefined || (rule.access ?? 'any') === 'write') continue;
    for (const id of scopeNodes(rule.scope, state.manifest.tree) ?? []) out.add(id);
  }
  return out;
}

const SOURCE_WORDS: Readonly<Record<RuleSource, string>> = { app: 'your app settings', project: 'this project’s file', session: 'this session' };

const noteOf = (rule: SourcedRule): string => (rule.note === undefined ? '' : ` (${rule.note})`);

const WRITER_HINT =
  'do not retry it, and do not look for another tool that would do the same: tell the writer what you wanted to do, and leave the rule to them (Settings › Agent, or the folder’s Agent menu in the binder)';

/**
 * The refusal for a deny: code `permission-denied` (the writer can remove a rule; a hard-deny cannot be approved), naming the rule's
 * source and note. A target the writer may not have the agent read is not named by title, so a refusal never carries what a read-deny
 * withholds. `index` is the operation of a compound call that touched it.
 */
export function ruleRefusal(verdict: Extract<RuleVerdict, { effect: 'deny' }>, tool: string, state?: Pick<ProjectState, 'manifest'>, index?: number): CommandError {
  const { rule } = verdict;
  const title = verdict.target === '' || verdict.target === UNKNOWN_TARGET ? undefined : state?.manifest.tree.find((node) => node.id === verdict.target)?.title;
  const where =
    index !== undefined
      ? `operation ${index} touches a part of the project that a rule in ${SOURCE_WORDS[rule.source]} keeps from the agent`
      : verdict.target === UNKNOWN_TARGET
        ? `it could not be worked out which part of the project this call touches, and a rule in ${SOURCE_WORDS[rule.source]} keeps parts of it from the agent`
        : verdict.target === ''
          ? `a rule in ${SOURCE_WORDS[rule.source]} refuses it`
          : rule.access === 'write' && title !== undefined
            ? `"${title}" is locked against changes by a rule in ${SOURCE_WORDS[rule.source]}`
            : `a part of the project is off limits to the agent by a rule in ${SOURCE_WORDS[rule.source]}`;
  return refusal('permission-denied', `"${tool}" was refused: ${where}${noteOf(rule)}. Nothing was run.`, {
    target: index === undefined ? tool : `params.ops[${index}]`,
    correctiveHint: WRITER_HINT,
    details: { rule: { effect: rule.effect, tool: rule.tool, source: rule.source, ...(rule.note === undefined ? {} : { note: rule.note }) } },
  });
}

/** The refusal for an ask the caller cannot answer: no confirmation reached the call. */
export function askRefusal(verdict: Extract<RuleVerdict, { effect: 'ask' }>, tool: string): CommandError {
  const { rule } = verdict;
  return refusal('permission-denied', `"${tool}" needs the writer’s confirmation because of a rule in ${SOURCE_WORDS[rule.source]}${noteOf(rule)}, and none reached this call. Nothing was run.`, {
    target: tool,
    correctiveHint: 'put it in a plan and wait for the writer to approve the card, or send it alone once the writer has confirmed it',
    risk: 'write-confirm',
    details: { rule: { effect: rule.effect, tool: rule.tool, source: rule.source, ...(rule.note === undefined ? {} : { note: rule.note }) } },
  });
}

/** One sentence for the Settings list and the load notice: the rule that has no effect, and why. */
export function ruleWarnings(set: RuleSet, state: Pick<ProjectState, 'manifest'>, toolNames: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const rule of set.rules) {
    const label = `${SOURCE_WORDS[rule.source]}: ${rule.effect} ${rule.tool}`;
    if (rule.tool !== '*' && !rule.tool.startsWith('mcp__') && !toolNames.some((name) => globMatches(rule.tool, name))) {
      out.push(`${label} matches no tool, so it has no effect. Check the spelling`);
    }
    if (rule.scope === undefined) continue;
    if ('path' in rule.scope) out.push(`${label} uses the title path ${rule.scope.path}, which stops matching when a folder is renamed`);
    if (scopeNodes(rule.scope, state.manifest.tree) === undefined) {
      out.push(`${label} names ${'subtree' in rule.scope ? 'a binder node that no longer exists' : 'a path that matches nothing'}, so it has no effect`);
    }
  }
  return out;
}
