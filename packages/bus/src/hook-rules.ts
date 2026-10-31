/**
 * Hooks: the shape and the structural rules both the bus and the store state — [command-bus.md §9](../../../docs/architecture/command-bus.md),
 * [project-format.md §2](../../../docs/architecture/project-format.md), [hooks.md](../../../docs/architecture/hooks.md).
 *
 * A hook is a writer-authored check the harness runs at a point of the agent's turn. It is data, never code: the only handler a project
 * file may carry is the pure `check` kind, so a hook read from a shared folder can at worst warn, block or add a labelled note, and never
 * runs anything. The bus owns this module because `hook.save` has to refuse a malformed hook before any effect, and the store (which
 * depends on the bus) reads the same checks when it loads `agent.hooks`. The checks that need the coherence module (that a check id
 * exists) and the project (that a status is in the vocabulary) are the harness's, at the time the hook runs.
 */

import { invalidError, isRecord } from './params.js';
import { err, ok, type CommandError, type Result } from './result.js';

/** Hooks in one project. */
export const HOOKS_MAX = 20;
export const HOOK_NAME_MAX = 60;
/** Patterns in one `pattern` check. */
export const HOOK_PATTERNS_MAX = 50;
/** One pattern and one message, in characters. */
export const HOOK_TEXT_MAX = 300;
export const HOOK_LIST_MAX = 30;
export const HOOK_TOOLS_MAX = 50;
export const HOOK_TOOL_NAME_MAX = 200;
export const HOOK_STATUS_MAX = 60;
export const HOOK_WORDS_MAX = 1_000_000;

/** Every event a hook may name. The harness runs the first two; the rest are specified (hooks.md §2) and load, but nothing fires them yet. */
export const HOOK_EVENTS = ['tool.before', 'tool.after', 'export.before', 'export.after', 'project.save', 'turn.submit', 'turn.end'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The events this build runs. */
export const HOOK_EVENTS_RUN: readonly HookEvent[] = ['tool.before', 'tool.after'];

export const HOOK_ISSUERS = ['agent', 'user', 'any'] as const;
export const HOOK_SEVERITIES = ['error', 'warning', 'info'] as const;

export interface HookMatcher {
  /** Registry or qualified external tool names, or globs with `*` as a rule's tool takes (`notes.*`). Absent means every call. */
  readonly tools?: readonly string[];
  /** Absent means `agent` for a tool event. */
  readonly issuedBy?: (typeof HOOK_ISSUERS)[number];
}

/** The four pure checks. A pattern is a literal, whole-word text: no regular expression is stored or run. */
export type HookCheck =
  | { readonly kind: 'coherence'; readonly checks: readonly string[]; readonly severityAtLeast?: (typeof HOOK_SEVERITIES)[number] }
  | { readonly kind: 'pattern'; readonly patterns: readonly { readonly match: string; readonly message: string }[] }
  | { readonly kind: 'status'; readonly allowed: readonly string[] }
  | { readonly kind: 'words'; readonly min?: number; readonly max?: number };

export interface ProjectHook {
  /** "h_" + 10 Crockford base32, minted once. */
  readonly id: string;
  /** Shown on cards and in reports: `No “suddenly”`. */
  readonly name: string;
  readonly event: HookEvent;
  readonly matcher?: HookMatcher;
  /** The only handler kind a project file may hold. */
  readonly handler: { readonly kind: 'check'; readonly check: HookCheck };
  /** What a failed check does at `tool.before`: `block` refuses the step, `warn` (the default) only says so. */
  readonly onBlock?: 'block' | 'warn';
  /** A hook that errors warns by default; with this it blocks. */
  readonly failClosed?: boolean;
  readonly enabled: boolean;
}

/** A hook as `hook.save` takes it: the store mints the id when there is none. */
export type HookDraft = Omit<ProjectHook, 'id'> & { readonly id?: string };

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const HOOK_KEYS = ['id', 'name', 'event', 'matcher', 'handler', 'onBlock', 'failClosed', 'enabled'] as const;
const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** Whether `value` is a hook id: `h_` and ten Crockford characters. Scanned, not matched by a pattern. */
export function isHookId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 12 || !value.startsWith('h_')) return false;
  for (let i = 2; i < value.length; i += 1) if (!CROCKFORD.includes(value.charAt(i))) return false;
  return true;
}

/** A check id (`pov.coverage`): lower-case words joined by dots and hyphens. Whether the coherence module has it is the harness's check. */
export function isHookCheckId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 60) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const allowed = (code >= 97 && code <= 122) || code === 46 || code === 45;
    if (!allowed) return false;
  }
  return true;
}

const codePoints = (text: string): number => [...text].length;

function invalid(message: string, hint: string, target: string): Result<never, CommandError> {
  return err(invalidError(message, hint, target));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A closed key set: the first key outside `allowed` is the refusal. */
function unknownKey(value: Record<string, unknown>, allowed: readonly string[], at: string): Result<never, CommandError> | undefined {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.includes(key)) return invalid(`${at} has a "${key}" key, which a hook never holds`, `remove the "${key}" key`, `${at}.${key}`);
    if (!allowed.includes(key)) {
      const hint = key === 'regex' ? 'a pattern is a literal word or phrase; regular expressions are not supported' : `${at} carries only: ${allowed.join(', ')}`;
      return invalid(`${at}.${key} is not a hook field`, hint, `${at}.${key}`);
    }
  }
  return undefined;
}

function textField(value: unknown, at: string, max: number, what: string): Result<string, CommandError> {
  if (typeof value !== 'string' || value.trim() === '') return invalid(`${at} must be non-blank text`, `give the hook ${what}`, at);
  if (codePoints(value) > max) return invalid(`${at} is over ${max} characters`, `shorten it to ${max} characters or fewer`, at);
  return ok(value);
}

function stringList(value: unknown, at: string, max: number, itemMax: number, valid: (item: string) => boolean, what: string): Result<string[], CommandError> {
  if (!Array.isArray(value) || value.length === 0) return invalid(`${at} must be a list with at least one ${what}`, `name at least one ${what}`, at);
  if (value.length > max) return invalid(`${at} lists more than ${max} items`, `keep it to ${max} or fewer`, at);
  const out: string[] = [];
  for (const [index, item] of (value as unknown[]).entries()) {
    if (typeof item !== 'string' || item.trim() === '' || codePoints(item) > itemMax || !valid(item)) {
      return invalid(`${at}[${index}] is not a valid ${what}`, `each ${what} is non-blank text of at most ${itemMax} characters`, `${at}[${index}]`);
    }
    out.push(item);
  }
  return ok(out);
}

function readMatcher(raw: unknown): Result<HookMatcher, CommandError> {
  if (!isPlainObject(raw)) return invalid('hook.matcher must be an object', 'give { "tools": [...] } or leave the matcher out', 'matcher');
  const stray = unknownKey(raw, ['tools', 'issuedBy'], 'matcher');
  if (stray !== undefined) return stray;
  const out: { tools?: string[]; issuedBy?: (typeof HOOK_ISSUERS)[number] } = {};
  if (raw['tools'] !== undefined) {
    const tools = stringList(raw['tools'], 'matcher.tools', HOOK_TOOLS_MAX, HOOK_TOOL_NAME_MAX, () => true, 'tool name');
    if (!tools.ok) return tools;
    out.tools = tools.value;
  }
  if (raw['issuedBy'] !== undefined) {
    if (!(HOOK_ISSUERS as readonly unknown[]).includes(raw['issuedBy'])) return invalid('matcher.issuedBy must be agent, user or any', 'use one of agent, user, any', 'matcher.issuedBy');
    out.issuedBy = raw['issuedBy'] as (typeof HOOK_ISSUERS)[number];
  }
  return ok(out);
}

function readWords(raw: Record<string, unknown>): Result<HookCheck, CommandError> {
  const bound = (key: 'min' | 'max'): Result<number | undefined, CommandError> => {
    const value = raw[key];
    if (value === undefined) return ok(undefined);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > HOOK_WORDS_MAX) {
      return invalid(`check.${key} must be a whole number from 0 to ${HOOK_WORDS_MAX}`, 'give a word count', `check.${key}`);
    }
    return ok(value);
  };
  const min = bound('min');
  if (!min.ok) return min;
  const max = bound('max');
  if (!max.ok) return max;
  if (min.value === undefined && max.value === undefined) return invalid('a words check needs a min or a max', 'give min, max or both', 'check');
  if (min.value !== undefined && max.value !== undefined && min.value > max.value) return invalid('check.min is above check.max', 'swap them, or lower min', 'check.min');
  return ok({ kind: 'words', ...(min.value === undefined ? {} : { min: min.value }), ...(max.value === undefined ? {} : { max: max.value }) });
}

function readCheck(raw: unknown): Result<HookCheck, CommandError> {
  if (!isPlainObject(raw)) return invalid('handler.check must be an object', 'give { "kind": "pattern" | "coherence" | "status" | "words", ... }', 'check');
  switch (raw['kind']) {
    case 'coherence': {
      const stray = unknownKey(raw, ['kind', 'checks', 'severityAtLeast'], 'check');
      if (stray !== undefined) return stray;
      const checks = stringList(raw['checks'], 'check.checks', HOOK_LIST_MAX, 60, isHookCheckId, 'check id');
      if (!checks.ok) return checks;
      if (raw['severityAtLeast'] !== undefined && !(HOOK_SEVERITIES as readonly unknown[]).includes(raw['severityAtLeast'])) {
        return invalid('check.severityAtLeast must be error, warning or info', 'use one of error, warning, info', 'check.severityAtLeast');
      }
      return ok({ kind: 'coherence', checks: checks.value, ...(raw['severityAtLeast'] === undefined ? {} : { severityAtLeast: raw['severityAtLeast'] as (typeof HOOK_SEVERITIES)[number] }) });
    }
    case 'pattern': {
      const stray = unknownKey(raw, ['kind', 'patterns'], 'check');
      if (stray !== undefined) return stray;
      const list = raw['patterns'];
      if (!Array.isArray(list) || list.length === 0) return invalid('check.patterns must list at least one pattern', 'give { "match": "word", "message": "why" }', 'check.patterns');
      if (list.length > HOOK_PATTERNS_MAX) return invalid(`check.patterns lists more than ${HOOK_PATTERNS_MAX} patterns`, `keep it to ${HOOK_PATTERNS_MAX} or fewer`, 'check.patterns');
      const patterns: { match: string; message: string }[] = [];
      for (const [index, item] of (list as unknown[]).entries()) {
        const at = `check.patterns[${index}]`;
        if (!isPlainObject(item)) return invalid(`${at} must be an object`, 'give { "match": "word", "message": "why" }', at);
        const bad = unknownKey(item, ['match', 'message'], at);
        if (bad !== undefined) return bad;
        const match = textField(item['match'], `${at}.match`, HOOK_TEXT_MAX, 'the word or phrase to look for');
        if (!match.ok) return match;
        const message = textField(item['message'], `${at}.message`, HOOK_TEXT_MAX, 'a message that says why');
        if (!message.ok) return message;
        patterns.push({ match: match.value, message: message.value });
      }
      return ok({ kind: 'pattern', patterns });
    }
    case 'status': {
      const stray = unknownKey(raw, ['kind', 'allowed'], 'check');
      if (stray !== undefined) return stray;
      const allowed = stringList(raw['allowed'], 'check.allowed', HOOK_LIST_MAX, HOOK_STATUS_MAX, () => true, 'status');
      return allowed.ok ? ok({ kind: 'status', allowed: allowed.value }) : allowed;
    }
    case 'words': {
      const stray = unknownKey(raw, ['kind', 'min', 'max'], 'check');
      return stray ?? readWords(raw);
    }
    default:
      return invalid(`check.kind ${typeof raw['kind'] === 'string' ? `"${raw['kind']}"` : 'is missing, and'} is not a check this build has`, 'use coherence, pattern, status or words', 'check.kind');
  }
}

/**
 * Reads one hook, as the bus and the store's load both read it. `requireId` is the load's: a stored hook has its id, while a draft
 * may leave it for the store to mint. The result is a new object holding only the fields a hook has, so no extra key is carried along.
 */
export function readHook(raw: unknown, requireId: boolean): Result<HookDraft, CommandError> {
  if (!isPlainObject(raw)) return invalid('hook must be an object', 'give { name, event, handler, enabled }', 'hook');
  const stray = unknownKey(raw, HOOK_KEYS, 'hook');
  if (stray !== undefined) return stray;
  if (raw['id'] === undefined ? requireId : !isHookId(raw['id'])) {
    return invalid('hook.id must be h_ followed by 10 base32 characters', requireId ? 'a stored hook has an id' : 'leave the id out of a new hook; it is minted', 'hook.id');
  }
  const name = textField(raw['name'], 'hook.name', HOOK_NAME_MAX, 'a name');
  if (!name.ok) return name;
  if (!(HOOK_EVENTS as readonly unknown[]).includes(raw['event'])) {
    return invalid(`hook.event ${typeof raw['event'] === 'string' ? `"${raw['event']}"` : 'is missing, and'} is not a hook event`, `use one of: ${HOOK_EVENTS.join(', ')}`, 'hook.event');
  }
  const handler = raw['handler'];
  if (!isPlainObject(handler)) return invalid('hook.handler must be an object', 'give { "kind": "check", "check": { ... } }', 'hook.handler');
  if (handler['kind'] !== 'check') {
    return invalid(
      `hook.handler.kind ${typeof handler['kind'] === 'string' ? `"${handler['kind']}"` : 'is missing, and'} is not allowed in a project file`,
      'a project file holds only "check" hooks; anything that runs code or calls a model stays out of a folder that others can open',
      'hook.handler.kind',
    );
  }
  const bad = unknownKey(handler, ['kind', 'check'], 'handler');
  if (bad !== undefined) return bad;
  const check = readCheck(handler['check']);
  if (!check.ok) return check;
  const matcher = raw['matcher'] === undefined ? undefined : readMatcher(raw['matcher']);
  if (matcher !== undefined && !matcher.ok) return matcher;
  if (raw['onBlock'] !== undefined && raw['onBlock'] !== 'block' && raw['onBlock'] !== 'warn') return invalid('hook.onBlock must be block or warn', 'use block or warn', 'hook.onBlock');
  if (raw['failClosed'] !== undefined && typeof raw['failClosed'] !== 'boolean') return invalid('hook.failClosed must be true or false', 'use true or false', 'hook.failClosed');
  if (raw['enabled'] !== undefined && typeof raw['enabled'] !== 'boolean') return invalid('hook.enabled must be true or false', 'use true or false', 'hook.enabled');
  return ok({
    ...(raw['id'] === undefined ? {} : { id: raw['id'] as string }),
    name: name.value,
    event: raw['event'] as HookEvent,
    ...(matcher === undefined ? {} : { matcher: matcher.value }),
    handler: { kind: 'check', check: check.value },
    ...(raw['onBlock'] === undefined ? {} : { onBlock: raw['onBlock'] as 'block' | 'warn' }),
    ...(raw['failClosed'] === undefined ? {} : { failClosed: raw['failClosed'] as boolean }),
    enabled: raw['enabled'] !== false,
  });
}
