/**
 * Agent rules as data — [agent-harness.md §4](../../../docs/architecture/agent-harness.md), stored under `agent.rules` in
 * `caotang.json` ([project-format.md §2](../../../docs/architecture/project-format.md)) and in the app's settings.
 *
 * A rule narrows what the agent may do: `deny` refuses a call, `ask` forces a card for it. There is no `allow` in this build, so
 * a project file can only restrict the agent and never grant it power. The evaluation is the harness's (`rules.ts`); this module
 * owns the shape and the tolerant read, so the manifest loader and the app's settings read one definition.
 */

export const RULE_EFFECTS = ['deny', 'ask'] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

export const RULE_ACCESSES = ['read', 'write', 'any'] as const;
export type RuleAccess = (typeof RULE_ACCESSES)[number];

/** A binder node and everything under it (the stored form, stable across renames), or a title path for a hand-edited file. */
export type RuleScope = { readonly subtree: string } | { readonly path: string };

export interface PermissionRule {
  readonly effect: RuleEffect;
  /** A registry name or a qualified external name; `*` matches any run of characters (`codex.*`, `mcp__notion__*`, `*`). */
  readonly tool: string;
  /** Absent means the whole project. */
  readonly scope?: RuleScope;
  /** Absent means `any`. */
  readonly access?: RuleAccess;
  /** Shown on refusals and in Settings. */
  readonly note?: string;
}

export const RULES_MAX = 200;
export const RULE_TOOL_MAX = 200;
export const RULE_NOTE_MAX = 200;
export const RULE_SCOPE_MAX = 400;

export interface ParsedRules {
  readonly rules: readonly PermissionRule[];
  /** One sentence per rule or field that was dropped, naming where, for the load notice and the Settings list. */
  readonly warnings: readonly string[];
  /**
   * How many rules were dropped that would have restricted the agent: everything dropped except an `allow` (which has no effect by
   * design). A host that cannot show the writer a warning treats a list with any lost rule as unreadable and fails closed.
   */
  readonly lost: number;
}

export interface ParseRulesOptions {
  /** Where the list sits, for the warnings: `agent.rules` in the manifest. */
  readonly at?: string;
  /** Tool-level rules only (the app's settings): a rule with a scope is dropped, since a node id means nothing across projects. */
  readonly toolOnly?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scopeOf(raw: unknown): RuleScope | undefined {
  if (!isRecord(raw)) return undefined;
  const { subtree, path } = raw;
  if (typeof subtree === 'string' && subtree.trim() !== '' && subtree.length <= RULE_SCOPE_MAX && path === undefined) return { subtree: subtree.trim() };
  if (typeof path === 'string' && path.trim() !== '' && path.length <= RULE_SCOPE_MAX && subtree === undefined) return { path: path.trim() };
  return undefined;
}

/**
 * Reads a list of rules, tolerantly: a rule that cannot be read is dropped with a warning and never blocks a load. A dropped
 * rule is a restriction lost, so each warning says which rule it was. An `allow` rule is dropped too, since this build has none.
 */
export function parseRules(raw: unknown, options: ParseRulesOptions = {}): ParsedRules {
  const at = options.at ?? 'rules';
  const warnings: string[] = [];
  if (raw === undefined) return { rules: [], warnings, lost: 0 };
  if (!Array.isArray(raw)) return { rules: [], warnings: [`${at}: expected a list of rules; dropped`], lost: 1 };
  const rules: PermissionRule[] = [];
  let lost = 0;
  for (const [index, item] of raw.entries()) {
    const where = `${at}[${index}]`;
    if (rules.length >= RULES_MAX) {
      warnings.push(`${where}: more than ${RULES_MAX} rules; the rest are dropped`);
      lost += raw.length - index;
      break;
    }
    if (!isRecord(item)) {
      warnings.push(`${where}: not a rule; dropped`);
      lost += 1;
      continue;
    }
    const effect = item['effect'];
    if (effect === 'allow') {
      warnings.push(`${where}: allow rules are not supported in this build, so this one has no effect; dropped`);
      continue;
    }
    if (typeof effect !== 'string' || !(RULE_EFFECTS as readonly string[]).includes(effect)) {
      warnings.push(`${where}: expected an effect of deny or ask; dropped`);
      lost += 1;
      continue;
    }
    const tool = item['tool'];
    if (typeof tool !== 'string' || tool.trim() === '' || tool.length > RULE_TOOL_MAX) {
      warnings.push(`${where}: expected a tool name or pattern; dropped`);
      lost += 1;
      continue;
    }
    const access = item['access'];
    if (access !== undefined && !(typeof access === 'string' && (RULE_ACCESSES as readonly string[]).includes(access))) {
      warnings.push(`${where}: expected an access of read, write or any; dropped`);
      lost += 1;
      continue;
    }
    let scope: RuleScope | undefined;
    if (item['scope'] !== undefined) {
      scope = scopeOf(item['scope']);
      if (scope === undefined) {
        warnings.push(`${where}: expected a scope of one subtree id or one title path; dropped`);
        lost += 1;
        continue;
      }
      if (options.toolOnly === true) {
        warnings.push(`${where}: rules in the app's settings apply to tools only, since a binder id belongs to one project; dropped. Use the binder menu to restrict a folder`);
        lost += 1;
        continue;
      }
    }
    const note = item['note'];
    const kept = typeof note === 'string' && note.trim() !== '' ? note.trim().slice(0, RULE_NOTE_MAX) : undefined;
    if (note !== undefined && typeof note !== 'string') warnings.push(`${where}.note: expected text; dropped, and the rule is kept`);
    rules.push({
      effect: effect as RuleEffect,
      tool: tool.trim(),
      ...(scope === undefined ? {} : { scope }),
      ...(access === undefined ? {} : { access: access as RuleAccess }),
      ...(kept === undefined ? {} : { note: kept }),
    });
  }
  return { rules, warnings, lost };
}

/** Whether two rules say the same thing, so a UI does not write a rule twice. */
export function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  const scopeKey = (rule: PermissionRule): string =>
    rule.scope === undefined ? '' : 'subtree' in rule.scope ? `s:${rule.scope.subtree}` : `p:${rule.scope.path}`;
  return a.effect === b.effect && a.tool === b.tool && scopeKey(a) === scopeKey(b) && (a.access ?? 'any') === (b.access ?? 'any');
}
