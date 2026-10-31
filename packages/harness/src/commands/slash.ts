/**
 * Slash commands (agent-harness.md §2, "Slash commands"): the composer's `/name args` line, read and resolved without a model.
 *
 * Everything here is pure. `parseSlash` splits the line, `expandTemplate` fills a template's placeholders, and `resolveSlash` says what the
 * composer does with the line: send it as an intent, run a plan the app built (`AgentSession.submitPlan`), do a session action (restore,
 * context, help), or ask for an argument. A line never reaches the planner as slash syntax: a command becomes the plan it names or the
 * sentence it expands to, and a line that names no command is sent as it was typed.
 */

import { err, ok, type Result } from '@caotang/bus';

import type { Plan } from '../plan.js';
import { BUILTIN_COMMANDS, resolveBuiltin } from './builtins.js';

export const BUILTIN_COMMAND_NAMES = ['help', 'plan', 'draft', 'synopses', 'scan', 'review', 'compile', 'restore', 'context'] as const;
export type BuiltinCommandName = (typeof BUILTIN_COMMAND_NAMES)[number];

export interface SlashArgument {
  readonly name: string;
  /** Shown in the menu: `<doc>`, `[words]`. */
  readonly hint: string;
  readonly required: boolean;
  readonly kind: 'doc' | 'docs' | 'enum' | 'number' | 'text' | 'turn' | 'recipe' | 'node';
  readonly values?: readonly string[];
}

export interface BuiltinCommand {
  readonly kind: 'builtin';
  readonly name: BuiltinCommandName;
  readonly description: string;
  readonly args: readonly SlashArgument[];
}

export interface ParsedSlash {
  /** The command name, lower-cased. */
  readonly name: string;
  /** The text after the name, trimmed: `$ARGUMENTS`. */
  readonly raw: string;
  /** Every word after the name, quotes respected: `$1`..`$9`. */
  readonly positional: readonly string[];
  /** The `key=value` words, by key. They stay in `positional` too. */
  readonly named: Readonly<Record<string, string>>;
  /** The words before a bare `--`; all of them when there is none. */
  readonly head: readonly string[];
  /** The text after a bare `--`, trimmed. Absent when there is no `--` or nothing follows it. */
  readonly brief?: string;
}

export type DocLookup = { readonly id: string; readonly title: string } | { readonly candidates: readonly string[] } | undefined;

/** What the app answers for a title the writer typed: the harness's unique-prefix rule, with whatever a read rule withholds left out. */
export type DocResolver = (query: string, scope: 'document' | 'any') => DocLookup;

export interface SlashContext {
  readonly resolve: DocResolver;
  /** The project's saved export recipes, with the format each compiles to. */
  readonly recipes: readonly { readonly name: string; readonly format: string }[];
}

/** What the composer does with the text. */
export type SlashResolution =
  /** Not a command, the `//` escape, or a command that only changes how the turn runs (`/plan`). */
  | { readonly kind: 'intent'; readonly intent: string; readonly note?: string; readonly command?: BuiltinCommandName; readonly forcePlan?: true }
  /** A plan the app built: `AgentSession.submitPlan`, with no planner call. */
  | { readonly kind: 'plan'; readonly intent: string; readonly plan: Plan; readonly command: BuiltinCommandName }
  | { readonly kind: 'session'; readonly action: 'restore' | 'context' | 'help'; readonly arg?: string; readonly command: BuiltinCommandName }
  /** Answered in the panel, with no model call. `candidates` lists the titles an ambiguous argument could mean. */
  | { readonly kind: 'ask'; readonly command: BuiltinCommandName; readonly missing: SlashArgument; readonly message: string; readonly candidates?: readonly string[] };

const COMMAND_NAME_MAX = 32;

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ' || ch === '　';
const isAsciiLetter = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isIdentStart = (ch: string): boolean => isAsciiLetter(ch) || ch === '_';
const isIdentPart = (ch: string): boolean => isIdentStart(ch) || isDigit(ch);

/** Whether `name` is a command name the log may carry: lower-case letters, digits and hyphens, starting with a letter. */
export function isCommandName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > COMMAND_NAME_MAX) return false;
  const lower = (ch: string): boolean => ch >= 'a' && ch <= 'z';
  if (!lower(name[0] as string)) return false;
  for (const ch of name) if (!(lower(ch) || isDigit(ch) || ch === '-')) return false;
  return true;
}

const CLOSERS: Readonly<Record<string, string>> = { '"': '"', "'": "'", '“': '”', '‘': '’' };

interface Token {
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly quoted: boolean;
}

/** Splits like a shell: a word that opens with a quote runs to the matching one, so `"Chapter 3 / Arrival"` is one word. A quote inside a word is text. */
function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < raw.length) {
    if (isSpace(raw[at] as string)) {
      at += 1;
      continue;
    }
    const start = at;
    let value = '';
    let quoted = false;
    const closer = CLOSERS[raw[at] as string];
    if (closer !== undefined) {
      quoted = true;
      at += 1;
      while (at < raw.length && raw[at] !== closer) {
        // Inside straight double quotes a backslash escapes the quote and itself.
        if (raw[at] === '\\' && closer === '"' && (raw[at + 1] === '"' || raw[at + 1] === '\\')) at += 1;
        value += raw[at];
        at += 1;
      }
      at += 1;
    }
    while (at < raw.length && !isSpace(raw[at] as string)) {
      value += raw[at];
      at += 1;
    }
    tokens.push({ value, start, end: Math.min(at, raw.length), quoted });
  }
  return tokens;
}

/** The `key` of a `key=value` word, or undefined. */
function keyOf(word: string): string | undefined {
  if (word.length === 0 || !isIdentStart(word[0] as string)) return undefined;
  let at = 1;
  while (at < word.length && isIdentPart(word[at] as string)) at += 1;
  return word[at] === '=' ? word.slice(0, at) : undefined;
}

/**
 * Reads a composer line that starts with `/name`. Undefined for text that is not a command line: no leading `/`, the `//` escape, a
 * full-width `／`, or a slash that begins a path (`/usr/bin`) rather than a name.
 */
export function parseSlash(text: string): ParsedSlash | undefined {
  if (text[0] !== '/' || text[1] === '/') return undefined;
  let end = 1;
  while (end < text.length && (isIdentPart(text[end] as string) || text[end] === '-')) end += 1;
  if (end < text.length && !isSpace(text[end] as string)) return undefined;
  const raw = text.slice(end).trim();
  const tokens = tokenize(raw);
  const named: Record<string, string> = {};
  for (const token of tokens) {
    const key = token.quoted ? undefined : keyOf(token.value);
    if (key !== undefined) named[key] = token.value.slice(key.length + 1);
  }
  const dash = tokens.findIndex((token) => !token.quoted && token.value === '--');
  const brief = dash === -1 ? '' : raw.slice((tokens[dash] as Token).end).trim();
  return {
    name: text.slice(1, end).toLowerCase(),
    raw,
    positional: tokens.map((token) => token.value),
    named,
    head: (dash === -1 ? tokens : tokens.slice(0, dash)).map((token) => token.value),
    ...(brief === '' ? {} : { brief }),
  };
}

export interface TemplatePlaceholders {
  readonly SELECTION?: string;
  readonly DOC?: string;
}

/**
 * Fills a template body: `$ARGUMENTS` (the whole tail), `$1`..`$9`, `$name` for a named argument, `$SELECTION`, `$DOC`, and `$$` for a literal
 * `$`. One pass left to right, so a value that contains `$1` is not expanded again. A placeholder with nothing to fill it is a `missing`
 * error naming it, never an empty string; a `$word` that is none of these stays as written. `names` are the arguments a template declares:
 * a declared name the line did not give is missing.
 */
export function expandTemplate(
  body: string,
  parsed: ParsedSlash,
  placeholders: TemplatePlaceholders = {},
  names: readonly string[] = [],
): Result<string, { readonly missing: string }> {
  const missing = names.find((name) => parsed.named[name] === undefined);
  if (missing !== undefined) return err({ missing: `$${missing}` });
  let out = '';
  let at = 0;
  while (at < body.length) {
    const ch = body[at] as string;
    if (ch !== '$') {
      out += ch;
      at += 1;
      continue;
    }
    const next = body[at + 1] ?? '';
    if (next === '$') {
      out += '$';
      at += 2;
    } else if (next >= '1' && next <= '9') {
      const value = parsed.positional[Number(next) - 1];
      if (value === undefined) return err({ missing: `$${next}` });
      out += value;
      at += 2;
    } else if (isIdentStart(next)) {
      let end = at + 2;
      while (end < body.length && isIdentPart(body[end] as string)) end += 1;
      const word = body.slice(at + 1, end);
      const value = word === 'ARGUMENTS' ? parsed.raw : word === 'SELECTION' || word === 'DOC' ? placeholders[word] : parsed.named[word];
      if (value !== undefined) out += value;
      else if (word === 'SELECTION' || word === 'DOC') return err({ missing: `$${word}` });
      else out += `$${word}`;
      at = end;
    } else {
      out += '$';
      at += 1;
    }
  }
  return ok(out);
}

/** The partial command name the menu filters by, or undefined when the text is not one being typed: `/dr` gives `dr`. */
export function menuQuery(text: string): string | undefined {
  if (text[0] !== '/' || text[1] === '/') return undefined;
  for (let at = 1; at < text.length; at += 1) if (!(isIdentPart(text[at] as string) || text[at] === '-')) return undefined;
  return text.slice(1).toLowerCase();
}

/** The commands the menu lists for `query`: those whose name starts with it, in the closed set's order. */
export function matchCommands(query: string): readonly BuiltinCommand[] {
  return BUILTIN_COMMANDS.filter((command) => command.name.startsWith(query));
}

/** `/draft <doc> [draft|continue] [words] [-- brief]`: the command with its arguments' hints. */
export function usageOf(command: BuiltinCommand): string {
  return ['/' + command.name, ...command.args.map((arg) => arg.hint)].join(' ');
}

/** What the composer does with `text` (the line as typed, trimmed by the caller). */
export function resolveSlash(text: string, context: SlashContext): SlashResolution {
  if (text.startsWith('//')) return { kind: 'intent', intent: text.slice(1) };
  if (text.trimEnd() === '/') return { kind: 'session', action: 'help', command: 'help' };
  const parsed = parseSlash(text);
  if (parsed === undefined) return { kind: 'intent', intent: text };
  const command = BUILTIN_COMMANDS.find((candidate) => candidate.name === parsed.name);
  if (command === undefined) {
    return { kind: 'intent', intent: text, note: `No command /${parsed.name}; sent as a request. Type // to start a request with a slash.` };
  }
  return resolveBuiltin(command, parsed, context);
}
