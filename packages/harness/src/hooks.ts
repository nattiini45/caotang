/**
 * Hooks — [hooks.md](../../../docs/architecture/hooks.md). A hook is a writer-authored check the harness runs at a point of the agent's
 * call: `tool.before` (at the plan's preflight and again as the call runs) and `tool.after`. This build runs the pure `check` kind only,
 * and every check is a synchronous function over the project, scoped to the nodes the call touches.
 *
 * What a hook can do is narrower than what the gate can: it can allow, warn, block (before a call), or add a labelled note for the model
 * (after one). It never approves a call, rewrites its params or writes the project. A hook runs after the gate has answered (the rules,
 * the grant, the port's state check), so an `allow` is no more than "nothing to say".
 *
 * A hook that throws is a warning, "the step was not checked", and never a silent pass; it blocks only when the writer set `failClosed`.
 */

import { HOOKS_MAX, HOOK_PATTERNS_MAX, HOOK_TEXT_MAX, type HookCheck, type HookEvent, type ProjectHook } from '@caotang/bus';
import { DETERMINISTIC_CHECK_IDS, SCAN_DOC_GUARD, scanTool, type DeterministicCheckId } from '@caotang/coherence';
import { countBody, getBody, nodeById, type ProjectState, type TreeNode } from '@caotang/store';

import { TOOL_NAMES, metadataFor } from './metadata.js';
import { globMatches } from './rules.js';
import { countIn, excludedBy, heldFile } from './tools/coherence.js';
import type { CallParams } from './types.js';
import { isRecord } from './util.js';

export type { HookCheck, HookEvent, HookMatcher } from '@caotang/bus';
/** A hook as the project stores it (`agent.hooks`). */
export type HookSpec = ProjectHook;

/** A check that takes longer than this is reported, since a synchronous check cannot be pre-empted (hooks.md §3). */
export const HOOK_SLOW_MS = 2000;
/** The most text one check reads. A longer text is not checked, and the hook warns that it was not. */
export const HOOK_TEXT_CAP = 2_000_000;

export type HookDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'warn'; readonly reason: string }
  | { readonly action: 'block'; readonly reason: string }
  /** `tool.after` only: text for the model, shown to it inside an untrusted envelope. */
  | { readonly action: 'context'; readonly text: string };

/** One hook's run on one call. */
export interface HookRun {
  readonly hookId: string;
  readonly name: string;
  readonly event: HookEvent;
  readonly tool: string;
  readonly callId?: string;
  readonly decision: HookDecision;
  /** How long the check took, in milliseconds on the runner's clock. */
  readonly ms: number;
  /** The check threw: the decision is then a warning (or a block under `failClosed`), and this says why. */
  readonly failed?: string;
}

/** What a hook sees: the call's name and params, the text it would write, and the nodes it touches. Never a key or a token. */
export interface HookInput {
  readonly event: 'tool.before' | 'tool.after';
  readonly turnId?: string;
  readonly tool: string;
  readonly callId?: string;
  readonly params: CallParams;
  /** What the agent loop staged for a model-backed call: the draft the call would write. */
  readonly proposal?: unknown;
  /** The binder nodes the call touches: its targets before it runs, the nodes it changed after. */
  readonly affected: readonly string[];
  /** Set by a caller that knows whether the call writes, as it does for an external tool (its server's risk). Otherwise the tool's metadata says. */
  readonly write?: boolean;
}

export interface HookDeps {
  readonly state: ProjectState;
  /** The clock `ms` is read from. Default: `performance.now`. */
  readonly now?: () => number;
  /** The binder nodes a read-deny keeps from `tool`: a check reads no text of theirs. */
  readonly withheld?: (tool: string) => ReadonlySet<string>;
}

export interface HookRunner {
  /** The `tool.before` hooks for a call that has not run, with no effect and no wait: the plan card's check (hooks.md §3). */
  preflight(input: HookInput & { readonly event: 'tool.before' }): readonly HookRun[];
  /** The hooks for `input.event`, at the moment the call runs or has run. Synchronous in this build: every handler is. */
  run(input: HookInput): readonly HookRun[];
}

/** The hooks, as a list or as a function read at each call so a change applies to the next one. */
export type HookSource = readonly HookSpec[] | (() => readonly HookSpec[] | undefined);

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

/** The top-level params whose value is prose, for a tool `WRITTEN_TEXT` has no row for (a read, which writes nothing). */
const PROSE_PARAMS: readonly string[] = ['text', 'body', 'notes', 'synopsis', 'ink'];
const LEAVES_MAX = 500;
const DEPTH_MAX = 6;

/**
 * Where the text a native write tool puts in the project sits in its params, and which of its other strings a hook does not read. A
 * path is a param name, `.` into an object and `[]` through a list (`entries[].aliases[]`). `read` is prose the call writes: a canon
 * entry's name, aliases and description are canon text, and a document's title is the writer's. `skip` is every other free string: a
 * reference to a node, a title used to find one, the brief a model drafts from (the draft itself is read from the staged proposal), a
 * short label or a search term. A string in neither list is text the hook cannot read (`unreadText`), and `test/hooks.test.ts` holds
 * that every free string of every write tool is in one of the two.
 */
interface WrittenText {
  readonly read: readonly string[];
  readonly skip: readonly string[];
}

export const WRITTEN_TEXT: Readonly<Record<string, WrittenText>> = {
  'meta.set': { read: [], skip: ['targets[]', 'status', 'label', 'keywords_add[]', 'keywords_remove[]'] },
  'notes.append': { read: ['text'], skip: ['doc'] },
  'synopsis.fill': { read: [], skip: ['docs[]'] },
  'scene.draft': { read: [], skip: ['doc', 'instruction', 'selection.exact', 'selection.prefix', 'selection.suffix'] },
  'binder.restructure': { read: ['ops[].title'], skip: ['ops[].parent', 'ops[].node', 'ops[].newParent'] },
  'export.compile': { read: [], skip: ['selection.root', 'template', 'recipeName'] },
  'codex.write': {
    read: ['entries[].name', 'entries[].aliases[]', 'entries[].description'],
    skip: ['entries[].id', 'entries[].exclude[]', 'entries[].attachTo[]', 'entries[].detachFrom[]', 'entries[].visualRefs[]'],
  },
  'doc.import': { read: ['title', 'body', 'synopsis'], skip: ['parent', 'keywords[]', 'status', 'label'] },
  'codex.import': { read: ['entries[].name', 'entries[].aliases[]', 'entries[].description'], skip: ['entries[].exclude[]', 'entries[].attachTo[]'] },
  'coherence.review': { read: [], skip: ['scope.docIds[]'] },
  'coherence.setFindingStatus': { read: ['note'], skip: ['findingId'] },
  'shots.derive': { read: [], skip: ['doc', 'styleNote'] },
  'shots.annotate': { read: ['action'], skip: ['shots[]', 'image.assetId', 'spec.lens'] },
  'prompt.draft': { read: [], skip: ['shots[]', 'vendor', 'instruction'] },
  'dialogue.draft': { read: [], skip: ['doc', 'instruction', 'fromBeats[]'] },
  'scene.apply': { read: ['text'], skip: ['doc', 'selection.exact', 'selection.prefix', 'selection.suffix', 'briefId'] },
  'dialogue.apply': { read: ['ink'], skip: ['doc', 'fromBeats[]', 'briefId'] },
  'notes.replace': { read: ['notes'], skip: ['doc'] },
  'synopsis.set': { read: ['synopsis'], skip: ['doc'] },
  'vocabulary.upsert': { read: [], skip: ['id', 'name', 'color'] },
  'filter.save': { read: [], skip: ['id', 'name', 'criteria.text', 'criteria.statusId', 'criteria.labelId', 'criteria.keywordsAll[]', 'criteria.keywordsAny[]'] },
  'goal.save': { read: [], skip: ['id', 'node', 'deadline'] },
  'memory.write': { read: ['title', 'body'], skip: ['slug', 'expectedDigest'] },
  'instructions.propose': { read: ['text'], skip: ['expectedDigest'] },
};

/**
 * Every string of an external tool's arguments. A walk that stops short would let a hook pass text it never read, so a limit throws
 * (the runner turns that into "the hook could not run"). A number, a flag, and an empty list or object carry no prose and are not counted.
 */
function leavesOf(value: unknown, out: string[], depth = 0): void {
  const items: readonly unknown[] | undefined = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : undefined;
  const carries = typeof value === 'string' || (items !== undefined && items.length > 0);
  if (depth > DEPTH_MAX) {
    if (carries) throw new Error(`the arguments are nested over ${DEPTH_MAX} levels deep`);
    return;
  }
  if (typeof value === 'string') {
    if (out.length >= LEAVES_MAX) throw new Error(`the arguments hold over ${LEAVES_MAX} strings`);
    out.push(value);
  } else if (items !== undefined) {
    for (const item of items) leavesOf(item, out, depth + 1);
  }
}

/** The strings at `path` (see `WrittenText`), whatever lists lie on the way. */
function valuesAt(value: unknown, path: readonly string[], out: string[]): void {
  const [head, ...rest] = path;
  if (head === undefined) {
    if (typeof value === 'string') out.push(value);
    return;
  }
  const many = head.endsWith('[]');
  const child = isRecord(value) ? value[many ? head.slice(0, -2) : head] : undefined;
  if (!many) valuesAt(child, rest, out);
  else if (Array.isArray(child)) for (const item of child) valuesAt(item, rest, out);
}

/** A write tool the hooks have no account of, called with text: nothing says which of its strings are prose, so the hook cannot say it read them. */
function unreadText(tool: string, params: CallParams): void {
  if (!(metadataFor(tool)?.risk ?? '').startsWith('write')) return;
  const strings: string[] = [];
  leavesOf(params, strings);
  if (strings.some((text) => text.trim() !== '')) throw new Error(`the hook cannot read the text ${tool} writes`);
}

/**
 * The tools a model drafts the text of, and the part of the staged proposal that holds it: a string (`text`, `ink`) or a list (`items`,
 * `shots`). A proposal of one of these tools without that part is a shape the hook has no reader for (`proseOf`).
 */
export const STAGED_PROSE: Readonly<Record<string, { readonly key: string; readonly list: boolean }>> = {
  'scene.draft': { key: 'text', list: false },
  'dialogue.draft': { key: 'ink', list: false },
  'synopsis.fill': { key: 'items', list: true },
  'shots.derive': { key: 'shots', list: true },
  'prompt.draft': { key: 'items', list: true },
};

/** The prose of a drafted video prompt (`ref`): the words of its prompt and its audio cues, its negative prompt and its notes. Never the vendor or the mode. */
function promptProseOf(ref: unknown, out: string[]): void {
  if (!isRecord(ref)) return;
  leavesOf(ref['prompt'], out);
  leavesOf(ref['audio'], out);
  for (const key of ['negativePrompt', 'notes']) if (typeof ref[key] === 'string') out.push(ref[key]);
}

/**
 * The prose a call would write: the prose a native tool writes (`WRITTEN_TEXT`), every string of an external tool's arguments, and the
 * draft the loop staged (a scene's text, a dialogue's Ink, each synopsis, a derived shot's action and quotes, a drafted video prompt).
 * The brief behind a draft is not prose the call writes, so it is not read. It throws when it cannot read all of it: an external
 * tool's arguments past the walk's limits, a write tool it has no account of, or a staged draft of a shape it has no reader for.
 */
export function proseOf(tool: string, params: CallParams, proposal?: unknown): string {
  const parts: string[] = [];
  if (tool.startsWith('mcp__')) leavesOf(params, parts);
  else if (Object.hasOwn(WRITTEN_TEXT, tool)) for (const path of (WRITTEN_TEXT[tool] as WrittenText).read) valuesAt(params, path.split('.'), parts);
  else {
    unreadText(tool, params);
    for (const key of PROSE_PARAMS) if (typeof params[key] === 'string') parts.push(params[key]);
  }
  const staged = Object.hasOwn(STAGED_PROSE, tool) ? (STAGED_PROSE[tool] as { readonly key: string; readonly list: boolean }) : undefined;
  if (staged !== undefined && proposal !== undefined && typeof proposal !== 'string') {
    const held = isRecord(proposal) ? proposal[staged.key] : undefined;
    if (staged.list ? !Array.isArray(held) : typeof held !== 'string') throw new Error(`the hook cannot read the text ${tool} writes`);
  }
  if (typeof proposal === 'string') parts.push(proposal);
  else if (isRecord(proposal)) {
    if (typeof proposal['text'] === 'string') parts.push(proposal['text']);
    if (typeof proposal['ink'] === 'string') parts.push(proposal['ink']);
    if (Array.isArray(proposal['items'])) {
      for (const item of proposal['items']) {
        if (!isRecord(item)) continue;
        if (typeof item['synopsis'] === 'string') parts.push(item['synopsis']);
        if (tool === 'prompt.draft') promptProseOf(item['ref'], parts);
      }
    }
    if (tool === 'shots.derive' && Array.isArray(proposal['shots'])) {
      for (const shot of proposal['shots']) {
        if (!isRecord(shot)) continue;
        if (typeof shot['action'] === 'string') parts.push(shot['action']);
        if (Array.isArray(shot['dialogueQuotes'])) for (const quote of shot['dialogueQuotes']) if (typeof quote === 'string') parts.push(quote);
      }
    }
  }
  return parts.join('\n');
}

const WORD_CHAR = /^[\p{L}\p{N}\p{M}_]$/u;
/** Scripts written without spaces: a word in them has no boundary to look for. */
const UNSEGMENTED = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]$/u;

const isWordChar = (point: number): boolean => WORD_CHAR.test(String.fromCodePoint(point));
const isUnsegmented = (point: number): boolean => UNSEGMENTED.test(String.fromCodePoint(point));

/** NFC and case-folded, so "É" typed as one code point or two, and in either case, is one word. */
export function foldText(text: string): string {
  return text.normalize('NFC').toLowerCase().normalize('NFC');
}

const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;
const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** The code point that ends just before `at`, or undefined at the start. */
function pointBefore(text: string, at: number): number | undefined {
  if (at <= 0) return undefined;
  const unit = text.charCodeAt(at - 1);
  if (isLow(unit) && at >= 2 && isHigh(text.charCodeAt(at - 2))) return text.codePointAt(at - 2);
  return unit;
}

/** Whether a match of `needle` at `at` is a whole word: its edges sit on a boundary, or in a script written without spaces. */
function wholeWord(text: string, at: number, needle: string): boolean {
  // A match must start and end on a code point, never inside a surrogate pair.
  if (isLow(text.charCodeAt(at)) && at > 0 && isHigh(text.charCodeAt(at - 1))) return false;
  const end = at + needle.length;
  if (end < text.length && isLow(text.charCodeAt(end)) && isHigh(text.charCodeAt(end - 1))) return false;
  const first = needle.codePointAt(0) as number;
  const last = pointBefore(needle, needle.length) as number;
  const before = pointBefore(text, at);
  const after = end < text.length ? (text.codePointAt(end) as number) : undefined;
  // A word edge is open when nothing word-like sits beside it, or when either side is a script written without spaces (Latin beside Han is two words).
  const open = (inside: number, outside: number | undefined): boolean =>
    outside === undefined || !isWordChar(outside) || !isWordChar(inside) || isUnsegmented(outside) || isUnsegmented(inside);
  return open(first, before) && open(last, after);
}

/** How many times `needle` occurs in `text` as a whole word. Both are folded here. Literal: there is no pattern syntax to run. */
export function countWholeWord(text: string, needle: string): number {
  const haystack = foldText(text);
  const target = foldText(needle);
  if (target === '') return 0;
  let count = 0;
  for (let at = haystack.indexOf(target); at !== -1; at = haystack.indexOf(target, at + target.length)) {
    if (wholeWord(haystack, at, target)) count += 1;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

/** A failed check: `reason` is safe to show anywhere (the writer's words, counts, titles); `detail` can quote the project. */
interface Failure {
  readonly reason: string;
  readonly detail?: string;
}

const clip = (text: string): string => [...text].slice(0, HOOK_TEXT_MAX).join('');

function quote(text: string): string {
  return `“${text}”`;
}

function titlesOf(state: ProjectState, ids: readonly string[]): string {
  const named = ids.slice(0, 3).map((id) => quote(nodeById(state, id)?.title ?? id));
  return named.join(', ') + (ids.length > 3 ? `, and ${ids.length - 3} more` : '');
}

/** The affected nodes that are documents the check may read: not withheld by a read rule. */
function readable(state: ProjectState, input: HookInput, deps: HookDeps): TreeNode[] {
  const hidden = deps.withheld?.(input.tool);
  const out: TreeNode[] = [];
  for (const id of new Set(input.affected)) {
    const node = nodeById(state, id);
    if (node !== undefined && node.type === 'document' && hidden?.has(id) !== true) out.push(node);
  }
  return out;
}

function patternCheck(check: Extract<HookCheck, { kind: 'pattern' }>, input: HookInput): Failure | undefined {
  const text = proseOf(input.tool, input.params, input.proposal);
  if (text === '') return undefined;
  if (text.length > HOOK_TEXT_CAP) throw new Error(`the text is over ${HOOK_TEXT_CAP} characters`);
  const hits: string[] = [];
  for (const pattern of check.patterns.slice(0, HOOK_PATTERNS_MAX)) {
    const count = countWholeWord(text, clip(pattern.match));
    if (count > 0) hits.push(`${quote(clip(pattern.match))} appears${count > 1 ? ` ${count} times` : ''}: ${clip(pattern.message)}`);
  }
  return hits.length === 0 ? undefined : { reason: hits.join(' ') };
}

function statusCheck(check: Extract<HookCheck, { kind: 'status' }>, input: HookInput, deps: HookDeps): Failure | undefined {
  const { state } = deps;
  const hidden = deps.withheld?.(input.tool);
  const names = new Map(state.manifest.vocabulary.statuses.map((term) => [term.id, term.name]));
  const allowed = new Set(check.allowed.map((status) => foldText(status)));
  const wrong: string[] = [];
  for (const id of new Set(input.affected)) {
    const node = nodeById(state, id);
    if (node === undefined || hidden?.has(id) === true) continue;
    const status = node.status ?? '';
    const named = names.get(status) ?? status;
    if (!allowed.has(foldText(status)) && !allowed.has(foldText(named))) wrong.push(id);
  }
  if (wrong.length === 0) return undefined;
  return { reason: `${titlesOf(state, wrong)} ${wrong.length === 1 ? 'is' : 'are'} not marked ${check.allowed.map((status) => quote(clip(status))).join(' or ')}.` };
}

function wordsCheck(check: Extract<HookCheck, { kind: 'words' }>, input: HookInput, deps: HookDeps): Failure | undefined {
  const { state } = deps;
  const bounds = (words: number): string | undefined => {
    if (check.max !== undefined && words > check.max) return `is ${words} words, over the ${check.max} this hook allows`;
    if (check.min !== undefined && words < check.min) return `is ${words} words, under the ${check.min} this hook asks for`;
    return undefined;
  };
  if (input.event === 'tool.before') {
    const text = proseOf(input.tool, input.params, input.proposal);
    if (text === '') return undefined;
    if (text.length > HOOK_TEXT_CAP) throw new Error(`the text is over ${HOOK_TEXT_CAP} characters`);
    const problem = bounds(countBody(text).words);
    return problem === undefined ? undefined : { reason: `The text ${problem}.` };
  }
  const problems: string[] = [];
  for (const node of readable(state, input, deps)) {
    const problem = bounds(countBody(getBody(state, node.id)).words);
    if (problem !== undefined) problems.push(`${quote(node.title)} ${problem}`);
  }
  return problems.length === 0 ? undefined : { reason: `${problems.slice(0, 3).join('; ')}.` };
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { info: 0, warning: 1, error: 2 };

function coherenceCheck(check: Extract<HookCheck, { kind: 'coherence' }>, input: HookInput, deps: HookDeps): Failure | undefined {
  const { state } = deps;
  const docs = readable(state, input, deps);
  if (docs.length === 0) return undefined;
  if (docs.length > SCAN_DOC_GUARD) throw new Error(`the call touches ${docs.length} documents, over the ${SCAN_DOC_GUARD}-document scan guard`);
  const known = DETERMINISTIC_CHECK_IDS as readonly string[];
  const unknown = check.checks.find((id) => !known.includes(id));
  if (unknown !== undefined) throw new Error(`${quote(unknown)} is not a coherence check in this build`);
  const excluded = excludedBy(deps.withheld?.(input.tool));
  const outcome = scanTool(
    { scope: { mode: 'doc', docIds: docs.map((node) => node.id) }, checks: [...check.checks] as DeterministicCheckId[] },
    { state, file: heldFile(state), now: new Date(0), detector: countIn, ...(excluded === undefined ? {} : { isExcluded: excluded }) },
  );
  if (!outcome.ok) throw new Error(outcome.message);
  const run = outcome.file?.runs.find((candidate) => candidate.id === outcome.data.runId);
  // The dialogue checks run on a full scan with the app's dialogue facts, which a hook has not got: a check that did not run is no pass.
  const skipped = check.checks.filter((id) => !(run?.checkIds ?? []).includes(id));
  if (skipped.length > 0) throw new Error(`${skipped.map(quote).join(', ')} did not run on the touched documents (some checks need a full scan)`);
  const upserted = new Set(run?.findingsUpserted ?? []);
  const floor = SEVERITY_RANK[check.severityAtLeast ?? 'info'] ?? 0;
  const found = (outcome.file?.findings ?? []).filter((finding) => upserted.has(finding.id) && finding.status === 'open' && (SEVERITY_RANK[finding.severity] ?? 0) >= floor);
  if (found.length === 0) return undefined;
  const ids = [...new Set(found.map((finding) => finding.checkId))];
  const count = found.length === 1 ? '1 finding' : `${found.length} findings`;
  return {
    reason: `${count} from ${ids.join(', ')} in ${titlesOf(state, docs.map((node) => node.id))}.`,
    detail: found.slice(0, 5).map((finding) => `- ${finding.message}`).join('\n'),
  };
}

function runCheck(check: HookCheck, input: HookInput, deps: HookDeps): Failure | undefined {
  switch (check.kind) {
    case 'pattern':
      return patternCheck(check, input);
    case 'status':
      return statusCheck(check, input, deps);
    case 'words':
      return wordsCheck(check, input, deps);
    case 'coherence':
      return coherenceCheck(check, input, deps);
  }
}

/* ------------------------------------------------------------------ *
 * The runner
 * ------------------------------------------------------------------ */

const AFTER_NOTE = ' The step has already run; the writer can undo it.';

/** Whether a matcher name can stand for a tool of this build. `*` and the external tools (`mcp__…`, which come and go) are never flagged. */
function namesATool(entry: string, toolNames: readonly string[]): boolean {
  return entry === '*' || entry.startsWith('mcp__') || toolNames.some((name) => globMatches(entry, name));
}

/** The names in a hook's matcher that stand for no tool, when none of them does: the hook can never fire. Empty for any other hook. */
function deadNames(spec: HookSpec, toolNames: readonly string[] = TOOL_NAMES): readonly string[] {
  const tools = spec.matcher?.tools;
  if (tools === undefined || tools.some((entry) => namesATool(entry, toolNames))) return [];
  return tools;
}

/**
 * One sentence for each name in an enabled hook's matcher that matches no tool, so the hook never fires: a misspelt name, or a glob
 * that is not one a rule would take. `*` and the external tools are not flagged.
 */
export function hookWarnings(hooks: readonly HookSpec[], toolNames: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const hook of hooks) {
    if (!hook.enabled) continue;
    for (const entry of hook.matcher?.tools ?? []) {
      if (!namesATool(entry, toolNames)) out.push(`Hook ${quote(hookLabel(hook.name))}: ${quote(entry)} matches no tool, so it never fires. Check the spelling`);
    }
  }
  return out;
}

function isWriteCall(input: HookInput): boolean {
  if (input.write !== undefined) return input.write;
  // An external tool whose caller did not say counts as a write: it is not in the tool table, and a hook must not pass what it cannot place.
  if (input.tool.startsWith('mcp__')) return true;
  return (metadataFor(input.tool)?.risk ?? '').startsWith('write');
}

function matches(spec: HookSpec, input: HookInput): boolean {
  if (!spec.enabled || spec.event !== input.event) return false;
  // Every call the harness runs is the agent's. `user` is for the events a later build fires on the writer's own gestures.
  if (spec.matcher?.issuedBy === 'user') return false;
  const tools = spec.matcher?.tools;
  if (tools === undefined) return true;
  // A hook whose names match no tool never fires on its own account. Before a call it speaks on every write instead, so it is not
  // taken for a hook that found nothing to object to (see `evaluate`).
  if (deadNames(spec).length > 0) return input.event === 'tool.before' && isWriteCall(input);
  if (tools.some((name) => globMatches(name, input.tool))) return true;
  // A row that stands for an in-app tool is held by the hooks written for that tool, as it is by its rules (metadata `mirrors`).
  const mirrored = metadataFor(input.tool)?.mirrors;
  return mirrored !== undefined && tools.some((name) => globMatches(name, mirrored));
}

function decisionOf(spec: HookSpec, input: HookInput, failure: Failure): HookDecision {
  if (input.event === 'tool.after') {
    const note = failure.detail === undefined ? failure.reason : `${failure.reason}\n${failure.detail}`;
    return { action: 'context', text: spec.onBlock === 'block' ? `${note}${AFTER_NOTE}` : note };
  }
  return spec.onBlock === 'block' ? { action: 'block', reason: failure.reason } : { action: 'warn', reason: failure.reason };
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/** Runs the hooks that match an input, in declaration order. The first block ends the run: the hooks after it are not asked. */
export function createHookRunner(source: HookSource, deps: HookDeps): HookRunner {
  const clock = deps.now ?? now;
  const specsNow = (): readonly HookSpec[] => (typeof source === 'function' ? (source() ?? []) : source).slice(0, HOOKS_MAX);

  const evaluate = (input: HookInput): readonly HookRun[] => {
    const runs: HookRun[] = [];
    for (const spec of specsNow()) {
      if (!matches(spec, input)) continue;
      const started = clock();
      let decision: HookDecision;
      let failed: string | undefined;
      try {
        const dead = deadNames(spec);
        if (dead.length > 0) {
          // A hook the writer meant to stop steps that can never fire is a hook that could not run, not a clean pass.
          if (spec.failClosed === true && spec.onBlock === 'block') throw new Error(`no tool is named ${dead.map(quote).join(', ')}`);
          decision = { action: 'warn', reason: `No tool is named ${dead.map(quote).join(', ')}, so this hook never fires. Check the spelling.` };
        } else {
          const failure = runCheck(spec.handler.check, input, deps);
          decision = failure === undefined ? { action: 'allow' } : decisionOf(spec, input, failure);
        }
      } catch (thrown) {
        failed = thrown instanceof Error ? thrown.message : String(thrown);
        const reason = `The hook could not run (${failed}), so the step was not checked.`;
        decision = spec.failClosed === true && input.event === 'tool.before' ? { action: 'block', reason } : { action: 'warn', reason };
      }
      const ms = Math.max(0, clock() - started);
      if (ms > HOOK_SLOW_MS && decision.action === 'allow') {
        decision = { action: 'warn', reason: `The hook took ${(ms / 1000).toFixed(1)} seconds, over the ${HOOK_SLOW_MS / 1000} a check should take. Narrow its scope or turn it off.` };
      }
      runs.push({
        hookId: spec.id,
        name: spec.name,
        event: input.event,
        tool: input.tool,
        ...(input.callId === undefined ? {} : { callId: input.callId }),
        decision,
        ms,
        ...(failed === undefined ? {} : { failed }),
      });
      if (decision.action === 'block') break;
    }
    return runs;
  };

  return { preflight: evaluate, run: evaluate };
}

/* ------------------------------------------------------------------ *
 * What a run becomes
 * ------------------------------------------------------------------ */

/** A hook's name as it may sit on a line of its own in a prompt: one line, no marker characters, clipped. */
export function hookLabel(name: string): string {
  let out = '';
  for (const char of name) {
    const code = char.codePointAt(0) as number;
    out += code < 0x20 || code === 0x7f || char === '"' || char === '<' || char === '>' || char === '\\' ? ' ' : char;
  }
  return out.trim().slice(0, 60);
}

/** The first block among the runs, if any. */
export function blockOf(runs: readonly HookRun[]): (HookRun & { readonly decision: { readonly action: 'block'; readonly reason: string } }) | undefined {
  for (const run of runs) if (run.decision.action === 'block') return run as HookRun & { readonly decision: { readonly action: 'block'; readonly reason: string } };
  return undefined;
}

/** The words of a block, as the card and the model read them. */
export function blockWords(run: HookRun & { readonly decision: { readonly action: 'block'; readonly reason: string } }, tool: string): string {
  return `The hook ${quote(hookLabel(run.name))} stopped ${tool}: ${run.decision.reason}`;
}
