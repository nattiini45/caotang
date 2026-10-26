/**
 * The built-in slash commands (agent-harness.md §2, "Slash commands"): a closed set, each mapped onto something the harness already does.
 * A command that builds a plan builds the plan a planner would, from the arguments as typed: the same tool, the same params, so the card
 * is the planner's card and the same checks, rules and mode decide it. Nothing here skips a card; a command is a way to ask, not an approval.
 *
 * A document argument is resolved before any model call, by the unique-prefix rule `doc.read` uses (resolve.ts), through the resolver the app
 * gives. An argument that names nothing, or names several, is answered with an `ask` that lists the candidates.
 */

import { EXPORT_FORMATS } from '@caotang/bus';

import type { PlanStep } from '../plan.js';
import { SYNOPSIS_MAX_DOCS } from '../tools/ports.js';
import type { BuiltinCommand, BuiltinCommandName, DocLookup, ParsedSlash, SlashArgument, SlashContext, SlashResolution } from './slash.js';

const arg = (name: string, hint: string, kind: SlashArgument['kind'], required: boolean, values?: readonly string[]): SlashArgument => ({
  name,
  hint,
  kind,
  required,
  ...(values === undefined ? {} : { values }),
});

const DRAFT_MODES = ['draft', 'continue'] as const;
const SOURCES = ['text', 'notes', 'both'] as const;

export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  { kind: 'builtin', name: 'help', description: 'List the commands, or show one', args: [arg('command', '[command]', 'text', false)] },
  { kind: 'builtin', name: 'plan', description: 'Ask for a request as a plan card, even for one small change', args: [arg('request', '<request>', 'text', true)] },
  {
    kind: 'builtin',
    name: 'draft',
    description: 'Draft or continue a scene',
    args: [arg('doc', '<doc>', 'doc', true), arg('mode', '[draft|continue]', 'enum', false, DRAFT_MODES), arg('words', '[words]', 'number', false), arg('brief', '[-- brief]', 'text', false)],
  },
  {
    kind: 'builtin',
    name: 'synopses',
    description: 'Fill the synopses of some documents',
    args: [arg('docs', '<docs…>', 'docs', true), arg('source', '[text|notes|both]', 'enum', false, SOURCES)],
  },
  { kind: 'builtin', name: 'scan', description: 'Check the manuscript for coherence problems, with no model', args: [arg('scope', '[doc|changed|full]', 'doc', false)] },
  { kind: 'builtin', name: 'review', description: 'Review for continuity with a model, after you approve its cost', args: [arg('scope', '[doc|changed|full]', 'doc', false)] },
  {
    kind: 'builtin',
    name: 'compile',
    description: 'Compile the manuscript, or a part, after you approve it',
    args: [arg('recipe', '<recipe|format>', 'recipe', true), arg('root', '[root]', 'node', false)],
  },
  { kind: 'builtin', name: 'restore', description: 'Restore to before a turn, after you confirm', args: [arg('turn', '[last|turn]', 'turn', false)] },
  { kind: 'builtin', name: 'context', description: 'Show what the next request would send, with no model call', args: [] },
];

const quote = (title: string): string => `“${title}”`;
const named = (list: readonly string[]): string => list.map(quote).join(', ');

function ask(command: BuiltinCommandName, missing: SlashArgument, message: string, candidates?: readonly string[]): SlashResolution {
  return { kind: 'ask', command, missing, message: `/${command}: ${message}`, ...(candidates === undefined ? {} : { candidates }) };
}

const argOf = (command: BuiltinCommand, name: string): SlashArgument => command.args.find((candidate) => candidate.name === name) ?? (command.args[0] as SlashArgument);

/** The asking for a document that was not found, or several were. */
function askDoc(command: BuiltinCommand, argName: string, query: string, found: Exclude<DocLookup, { id: string }>, spaced: boolean): SlashResolution {
  const missing = argOf(command, argName);
  if (found === undefined) {
    const quoted = spaced ? ' A title with spaces goes in quotes: /draft "Chapter 3" continue.' : '';
    return ask(command.name, missing, `no document is titled or starts with ${quote(query)}.${quoted}`);
  }
  return ask(command.name, missing, `${quote(query)} matches ${found.candidates.length} documents. Type more of the title, or put the whole title in quotes.`, found.candidates);
}

const isWholeNumber = (word: string): boolean => word.length > 0 && word.length <= 6 && [...word].every((ch) => ch >= '0' && ch <= '9');

function step(tool: string, params: PlanStep['params'], expect: string): PlanStep {
  return { tool, params, expect };
}

function planOf(command: BuiltinCommandName, intent: string, planStep: PlanStep): SlashResolution {
  return { kind: 'plan', command, intent, plan: { steps: [planStep] } };
}

function draft(command: BuiltinCommand, parsed: ParsedSlash, context: SlashContext): SlashResolution {
  const [query, ...rest] = parsed.head;
  if (query === undefined) return ask('draft', argOf(command, 'doc'), 'name the document to draft, as in /draft "Chapter 3" continue 800.');
  const found = context.resolve(query, 'document');
  if (found === undefined || !('id' in found)) return askDoc(command, 'doc', query, found, parsed.head.length > 1);
  let mode: (typeof DRAFT_MODES)[number] | undefined;
  let words: number | undefined;
  for (const word of rest) {
    const lower = word.toLowerCase();
    if (lower === 'draft' || lower === 'continue') mode = lower;
    else if (isWholeNumber(word) && Number(word) >= 1) words = Number(word);
    else if (lower === 'rewrite') {
      return ask('draft', argOf(command, 'mode'), 'a rewrite needs a passage selected in the editor, which a command line cannot carry. Ask for it in words instead.');
    } else {
      return ask('draft', argOf(command, 'mode'), `${quote(word)} is not draft, continue or a number of words. Put the brief after --.`);
    }
  }
  const instruction = parsed.brief ?? (mode === 'continue' ? 'Continue the scene from where it stops.' : 'Draft the scene from its synopsis and notes.');
  const params = { doc: found.id, instruction, ...(mode === undefined ? {} : { mode }), ...(words === undefined ? {} : { target_words: words }) };
  const about = words === undefined ? '' : ` (about ${words} words)`;
  const intent = `${mode === 'continue' ? 'Continue' : 'Draft'} ${quote(found.title)}${about}`;
  return planOf('draft', intent, step('scene.draft', params, mode === 'continue' ? `${quote(found.title)} continues with new text` : `${quote(found.title)} holds a new draft`));
}

function synopses(command: BuiltinCommand, parsed: ParsedSlash, context: SlashContext): SlashResolution {
  const words = [...parsed.head];
  const last = words.at(-1)?.toLowerCase();
  const source = words.length > 1 && last !== undefined && (SOURCES as readonly string[]).includes(last) ? (last as (typeof SOURCES)[number]) : undefined;
  if (source !== undefined) words.pop();
  if (words.length === 0) return ask('synopses', argOf(command, 'docs'), 'name the documents to fill, as in /synopses "Chapter 1" "Chapter 2" notes.');
  if (words.length > SYNOPSIS_MAX_DOCS) return ask('synopses', argOf(command, 'docs'), `at most ${SYNOPSIS_MAX_DOCS} documents at a time.`);
  const docs: { id: string; title: string }[] = [];
  for (const query of words) {
    const found = context.resolve(query, 'document');
    if (found === undefined || !('id' in found)) return askDoc(command, 'docs', query, found, false);
    if (!docs.some((doc) => doc.id === found.id)) docs.push(found);
  }
  const titles = docs.map((doc) => doc.title);
  return planOf(
    'synopses',
    `Fill the ${docs.length === 1 ? 'synopsis' : 'synopses'} of ${named(titles)}`,
    step('synopsis.fill', { docs: docs.map((doc) => doc.id), ...(source === undefined ? {} : { source }) }, `${named(titles)} ${docs.length === 1 ? 'has a synopsis' : 'have synopses'}`),
  );
}

/** `/scan` and `/review` share a scope: one document, the documents changed since their last review, or the manuscript. */
function scopeOf(command: BuiltinCommand, parsed: ParsedSlash, context: SlashContext, fallback: 'full' | 'changed'): { scope: { mode: string; docIds?: string[] }; label: string } | SlashResolution {
  if (parsed.head.length > 1) return ask(command.name, argOf(command, 'scope'), 'one document at a time, or changed, or full for the manuscript.');
  const [query] = parsed.head;
  const keyword = query?.toLowerCase();
  if (query === undefined || keyword === 'changed' || keyword === 'full') {
    const mode = keyword === 'changed' || keyword === 'full' ? keyword : fallback;
    return { scope: { mode }, label: mode === 'full' ? 'the manuscript' : 'the documents changed since their last review' };
  }
  const found = context.resolve(query, 'document');
  if (found === undefined || !('id' in found)) return askDoc(command, 'scope', query, found, false);
  return { scope: { mode: 'doc', docIds: [found.id] }, label: quote(found.title) };
}

function coherence(command: BuiltinCommand, parsed: ParsedSlash, context: SlashContext): SlashResolution {
  const scan = command.name === 'scan';
  const picked = scopeOf(command, parsed, context, scan ? 'full' : 'changed');
  if ('kind' in picked) return picked;
  return planOf(
    command.name,
    scan ? `Scan ${picked.label} for coherence problems` : `Review ${picked.label} for continuity`,
    scan ? step('coherence.scan', { scope: picked.scope }, `findings for ${picked.label}`) : step('coherence.review', { scope: picked.scope }, `a continuity review of ${picked.label}`),
  );
}

function compile(command: BuiltinCommand, parsed: ParsedSlash, context: SlashContext): SlashResolution {
  const [what, where] = parsed.head;
  const formats = EXPORT_FORMATS as readonly string[];
  const hint = `name a saved recipe${context.recipes.length === 0 ? '' : ` (${named(context.recipes.map((recipe) => recipe.name))})`} or a format (${formats.join(', ')}).`;
  if (what === undefined) return ask('compile', argOf(command, 'recipe'), hint);
  if (parsed.head.length > 2) return ask('compile', argOf(command, 'root'), 'one recipe or format, and at most one part to compile.');
  const wanted = what.trim().toLowerCase();
  const recipe = context.recipes.find((candidate) => candidate.name.trim().toLowerCase() === wanted);
  if (recipe === undefined && !formats.includes(wanted)) return ask('compile', argOf(command, 'recipe'), `${quote(what)} is neither a saved recipe nor a format; ${hint}`);
  let root: { id: string; title: string } | undefined;
  if (where !== undefined) {
    const found = context.resolve(where, 'any');
    if (found === undefined || !('id' in found)) return askDoc(command, 'root', where, found, false);
    root = found;
  }
  const part = root === undefined ? 'the manuscript' : quote(root.title);
  if (recipe !== undefined) {
    const params = { format: recipe.format, recipeName: recipe.name, ...(root === undefined ? {} : { selection: { root: root.id } }) };
    return planOf('compile', `Compile ${part} with the recipe ${quote(recipe.name)}`, step('export.compile', params, `${part} compiled with the recipe ${quote(recipe.name)}`));
  }
  return planOf(
    'compile',
    `Compile ${part} as ${wanted}`,
    step('export.compile', { format: wanted, selection: { root: root?.id ?? 'manuscript' } }, `${part} compiled as ${wanted}`),
  );
}

export function resolveBuiltin(command: BuiltinCommand, parsed: ParsedSlash, context: SlashContext): SlashResolution {
  switch (command.name) {
    case 'help': {
      const word = parsed.head[0];
      const topic = word?.startsWith('/') === true ? word.slice(1) : word;
      return { kind: 'session', action: 'help', command: 'help', ...(topic === undefined || topic === '' ? {} : { arg: topic.toLowerCase() }) };
    }
    case 'plan':
      return parsed.raw === ''
        ? ask('plan', argOf(command, 'request'), 'say what to plan, as in /plan tighten the opening of chapter 2.')
        : { kind: 'intent', intent: parsed.raw, command: 'plan', forcePlan: true };
    case 'draft':
      return draft(command, parsed, context);
    case 'synopses':
      return synopses(command, parsed, context);
    case 'scan':
    case 'review':
      return coherence(command, parsed, context);
    case 'compile':
      return compile(command, parsed, context);
    case 'restore':
      return { kind: 'session', action: 'restore', command: 'restore', ...(parsed.head[0] === undefined ? {} : { arg: parsed.head[0].toLowerCase() }) };
    case 'context':
      return { kind: 'session', action: 'context', command: 'context' };
  }
}
