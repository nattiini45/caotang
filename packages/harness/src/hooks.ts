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

import { metadataFor } from './metadata.js';
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

/** The params whose value is prose the call would write. */
const PROSE_PARAMS: readonly string[] = ['text', 'body', 'notes', 'synopsis', 'ink'];
const LEAVES_MAX = 500;
const DEPTH_MAX = 6;

function leavesOf(value: unknown, out: string[], depth = 0): void {
  if (out.length >= LEAVES_MAX || depth > DEPTH_MAX) return;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) leavesOf(item, out, depth + 1);
  else if (isRecord(value)) for (const item of Object.values(value)) leavesOf(item, out, depth + 1);
}

/**
 * The prose a call would write: the prose params of a native tool, every string of an external tool's arguments, and the draft the loop
 * staged (its text, its Ink, its synopses). The prompt behind a draft is not prose the call writes, so it is not read.
 */
export function proseOf(tool: string, params: CallParams, proposal?: unknown): string {
  const parts: string[] = [];
  if (tool.startsWith('mcp__')) leavesOf(params, parts);
  else for (const key of PROSE_PARAMS) if (typeof params[key] === 'string') parts.push(params[key]);
  if (typeof proposal === 'string') parts.push(proposal);
  else if (isRecord(proposal)) {
    if (typeof proposal['text'] === 'string') parts.push(proposal['text']);
    if (typeof proposal['ink'] === 'string') parts.push(proposal['ink']);
    if (Array.isArray(proposal['items'])) {
      for (const item of proposal['items']) if (isRecord(item) && typeof item['synopsis'] === 'string') parts.push(item['synopsis']);
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

function matches(spec: HookSpec, input: HookInput): boolean {
  if (!spec.enabled || spec.event !== input.event) return false;
  // Every call the harness runs is the agent's. `user` is for the events a later build fires on the writer's own gestures.
  if (spec.matcher?.issuedBy === 'user') return false;
  const tools = spec.matcher?.tools;
  if (tools === undefined || tools.includes(input.tool)) return true;
  // A row that stands for an in-app tool is held by the hooks written for that tool, as it is by its rules (metadata `mirrors`).
  const mirrored = metadataFor(input.tool)?.mirrors;
  return mirrored !== undefined && tools.includes(mirrored);
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
        const failure = runCheck(spec.handler.check, input, deps);
        decision = failure === undefined ? { action: 'allow' } : decisionOf(spec, input, failure);
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
