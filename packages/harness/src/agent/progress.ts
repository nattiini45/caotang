/**
 * The task list of a turn (agent-harness §8): what the writer asks while waiting, answered from the events the loop already
 * emits. `reduceTaskList` folds one turn's events into a short checklist, with one item in progress at a time, and
 * `headerLineOf` words the item the agent header shows.
 *
 * The list is derived, not declared: it comes from the plan cards and the status cards, so it costs no model tokens, is a
 * pure function of the event stream (an eval can assert it), and cannot claim work that did not run. It is never sent to the
 * model. Nothing here touches the DOM.
 */

import { isToolName, type ToolName } from '../metadata.js';
import type { CallParams } from '../types.js';
import type { PlanCardView, PlanStepView, StatusCard, StatusState } from './cards.js';
import { DEFAULT_MAX_MODEL_CALLS, type AgentEvent, type TurnPhase } from './events.js';

/* ------------------------------------------------------------------ *
 * Phrases — one per tool, so an item reads as a sentence about its target.
 * ------------------------------------------------------------------ */

/** An item's two lines: the imperative one the list shows, and the present-tense one the header shows while it runs. */
export interface TaskPhrase {
  readonly content: string;
  readonly activeForm: string;
}

export type TaskPhraseFn = (params: CallParams) => TaskPhrase;

const TARGET_CHARS = 40;

/** A document or entry name as an item quotes it, cut so a long title cannot fill the header. */
function quoted(name: string): string {
  const trimmed = name.trim();
  return `“${trimmed.length > TARGET_CHARS ? `${trimmed.slice(0, TARGET_CHARS - 1).trimEnd()}…` : trimmed}”`;
}

function textOf(params: CallParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function listOf(params: CallParams, key: string): readonly unknown[] {
  const value = params[key];
  return Array.isArray(value) ? value : [];
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const phrase = (content: string, activeForm: string): TaskPhrase => ({ content, activeForm });

/** "Draft “X”" / "Drafting “X”", or the bare verb when the call names no target. */
function aboutDoc(verb: string, ing: string, bare: string, bareIng: string): TaskPhraseFn {
  return (params) => {
    const doc = textOf(params, 'doc');
    return doc === undefined ? phrase(bare, bareIng) : phrase(`${verb} ${quoted(doc)}`, `${ing} ${quoted(doc)}`);
  };
}

/**
 * One phrase per registry tool, including the extension rows. Keyed by `ToolName`, so a row added to the registry without
 * a phrase here does not compile, and `test/agent/progress.test.ts` reads `harness.tools()` back to prove it. The text
 * is fixed wording plus the call's own params: a tool's description is never used (descriptions of external tools are untrusted).
 */
export const TASK_PHRASES: Readonly<Record<ToolName, TaskPhraseFn>> = {
  'project.overview': () => phrase('Read the project overview', 'Reading the project overview'),
  'binder.read_tree': () => phrase('Read the binder', 'Reading the binder'),
  'doc.read': aboutDoc('Read', 'Reading', 'Read a document', 'Reading a document'),
  'notes.read': (params) => {
    const doc = textOf(params, 'doc');
    return doc === undefined ? phrase('Read notes', 'Reading notes') : phrase(`Read the notes of ${quoted(doc)}`, `Reading the notes of ${quoted(doc)}`);
  },
  'meta.set': (params) => {
    const targets = listOf(params, 'targets');
    const only = targets.length === 1 && typeof targets[0] === 'string' ? targets[0] : undefined;
    if (only !== undefined) return phrase(`Update ${quoted(only)}`, `Updating ${quoted(only)}`);
    const what = counted(targets.length, 'document', 'documents');
    return targets.length === 0 ? phrase('Update document details', 'Updating document details') : phrase(`Update ${what}`, `Updating ${what}`);
  },
  'notes.append': (params) => {
    const doc = textOf(params, 'doc');
    return doc === undefined
      ? phrase('Add to the notes', 'Adding to the notes')
      : phrase(`Add to the notes of ${quoted(doc)}`, `Adding to the notes of ${quoted(doc)}`);
  },
  'synopsis.fill': (params) => {
    const docs = listOf(params, 'docs');
    const only = docs.length === 1 && typeof docs[0] === 'string' ? docs[0] : undefined;
    if (only !== undefined) return phrase(`Fill the synopsis of ${quoted(only)}`, `Filling the synopsis of ${quoted(only)}`);
    const what = counted(docs.length, 'synopsis', 'synopses');
    return docs.length === 0 ? phrase('Fill synopses', 'Filling synopses') : phrase(`Fill ${what}`, `Filling ${what}`);
  },
  'scene.draft': aboutDoc('Draft', 'Drafting', 'Draft a scene', 'Drafting a scene'),
  'binder.restructure': (params) => {
    const changes = listOf(params, 'ops').length;
    if (changes === 0) return phrase('Restructure the binder', 'Restructuring the binder');
    const what = counted(changes, 'change', 'changes');
    return phrase(`Restructure the binder (${what})`, `Restructuring the binder (${what})`);
  },
  'continuity.scan': () => phrase('Scan for continuity problems', 'Scanning for continuity problems'),
  'export.compile': (params) => {
    const format = textOf(params, 'format');
    return format === undefined ? phrase('Compile an export', 'Compiling an export') : phrase(`Compile a ${format} export`, `Compiling a ${format} export`);
  },
  'codex.read': (params) => {
    const query = textOf(params, 'query');
    return query === undefined ? phrase('Read the codex', 'Reading the codex') : phrase(`Look up ${quoted(query)} in the codex`, `Looking up ${quoted(query)} in the codex`);
  },
  'codex.write': (params) => {
    const entries = listOf(params, 'entries').length;
    if (entries === 0) return phrase('Write codex entries', 'Writing codex entries');
    const what = counted(entries, 'codex entry', 'codex entries');
    return phrase(`Write ${what}`, `Writing ${what}`);
  },
  'agent.plan': () => phrase('Plan', 'Planning'),
  'doc.import': (params) => {
    const title = textOf(params, 'title');
    return title === undefined ? phrase('Import a document', 'Importing a document') : phrase(`Import ${quoted(title)}`, `Importing ${quoted(title)}`);
  },
  'codex.import': (params) => {
    const entries = listOf(params, 'entries').length;
    if (entries === 0) return phrase('Import codex entries', 'Importing codex entries');
    const what = counted(entries, 'codex entry', 'codex entries');
    return phrase(`Import ${what}`, `Importing ${what}`);
  },
  'coherence.scan': () => phrase('Scan for coherence problems', 'Scanning for coherence problems'),
  'coherence.review': () => phrase('Review the story for coherence', 'Reviewing the story for coherence'),
  'coherence.setFindingStatus': () => phrase('Update a finding', 'Updating a finding'),
  'tool.search': () => phrase('Search for tools', 'Searching for tools'),
  'shots.derive': () => phrase('Derive shots', 'Deriving shots'),
  'shots.annotate': () => phrase('Annotate shots', 'Annotating shots'),
  'prompt.draft': () => phrase('Draft video prompts', 'Drafting video prompts'),
  'prompt.variant': () => phrase('Draft a prompt variant', 'Drafting a prompt variant'),
  'dialogue.draft': aboutDoc('Draft dialogue in', 'Drafting dialogue in', 'Draft dialogue', 'Drafting dialogue'),
  'dialogue.table': aboutDoc('Export the dialogue table of', 'Exporting the dialogue table of', 'Export a dialogue table', 'Exporting a dialogue table'),
  'skill.load': (params) => {
    const name = textOf(params, 'name');
    return name === undefined ? phrase('Read a skill', 'Reading a skill') : phrase(`Read the skill ${quoted(name)}`, `Reading the skill ${quoted(name)}`);
  },
  'agent.delegate': (params) => {
    const agent = textOf(params, 'agent');
    return agent === undefined ? phrase('Hand work to a helper agent', 'Handing work to a helper agent') : phrase(`Hand work to the ${agent} agent`, `Handing work to the ${agent} agent`);
  },
  'notes.replace': aboutDoc('Rewrite the notes of', 'Rewriting the notes of', 'Rewrite notes', 'Rewriting notes'),
  'synopsis.set': aboutDoc('Set the synopsis of', 'Setting the synopsis of', 'Set a synopsis', 'Setting a synopsis'),
  'vocabulary.upsert': (params) => {
    const name = textOf(params, 'name');
    const kind = textOf(params, 'kind') ?? 'status';
    return name === undefined
      ? phrase(`Change the ${kind} vocabulary`, `Changing the ${kind} vocabulary`)
      : phrase(`Add or change the ${kind} ${quoted(name)}`, `Adding or changing the ${kind} ${quoted(name)}`);
  },
  'filter.save': (params) => {
    const name = textOf(params, 'name');
    return name === undefined ? phrase('Save a filter', 'Saving a filter') : phrase(`Save the filter ${quoted(name)}`, `Saving the filter ${quoted(name)}`);
  },
  'goal.save': (params) => {
    const node = textOf(params, 'node');
    return node === undefined ? phrase('Set a goal', 'Setting a goal') : phrase(`Set a goal for ${quoted(node)}`, `Setting a goal for ${quoted(node)}`);
  },
};

/** Gives a reference its name for display: a document id its title. The reducer stays pure; the caller supplies the project's titles. */
export type NameOf = (ref: string) => string;

const REF_KEYS = ['doc', 'docs', 'targets'];

/** The params with the document references in them shown by name. */
function named(params: CallParams, nameOf: NameOf): CallParams {
  const shown: Record<string, unknown> = { ...params };
  for (const key of REF_KEYS) {
    const value = params[key];
    if (typeof value === 'string') shown[key] = nameOf(value);
    else if (Array.isArray(value)) shown[key] = value.map((entry) => (typeof entry === 'string' ? nameOf(entry) : entry));
  }
  return shown;
}

/** A line terminator: none can stand in a name the parsers below accept (the `.` of the patterns they replace). */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * `mcp__<server>__<alias>`: the name an external tool is given (extensibility §3.5), split at the first `__` after a server key of at
 * least one character. A scan rather than a pattern, because the name is the server's own text and a backtracking split of it is
 * quadratic.
 */
function externalName(tool: string): { readonly server: string; readonly alias: string } | null {
  if (!tool.startsWith('mcp__') || LINE_BREAK.test(tool)) return null;
  const split = tool.indexOf('__', 6);
  if (split < 0 || split + 2 >= tool.length) return null;
  return { server: tool.slice(5, split), alias: tool.slice(split + 2) };
}

/**
 * The phrase of any tool a card can name. A native tool takes its table row. An external tool takes a generic phrase built from
 * the server key and the alias in its qualified name, never from its description, which is untrusted input (extensibility §4).
 */
export function phraseFor(tool: string, params: CallParams, nameOf?: NameOf): TaskPhrase {
  if (isToolName(tool)) return TASK_PHRASES[tool](nameOf === undefined ? params : named(params, nameOf));
  const external = externalName(tool);
  if (external !== null) {
    const call = `“${external.alias}” on “${external.server}”`;
    return phrase(`Call ${call}`, `Calling ${call}`);
  }
  return phrase(`Run ${tool}`, `Running ${tool}`);
}

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

export type TaskState = 'pending' | 'waiting' | 'in_progress' | 'done' | 'skipped' | 'failed';

export interface TaskItem {
  /** Stable within a turn: `${seq}:${origin}` for a plan step, `reads:${round}` for a round of reads, `plan` for the planner row. */
  readonly key: string;
  /** The imperative line, e.g. "Draft “The Landing”". */
  readonly content: string;
  /** The present-tense line the header shows while the item runs, e.g. "Drafting “The Landing”". */
  readonly activeForm: string;
  readonly state: TaskState;
  readonly tool?: string;
  /** The status card's call id, once the item has run. Links the item to its card. */
  readonly callId?: string;
  /** The first sentence of the refusal, for a failed item. */
  readonly reason?: string;
}

/** What the fold remembers between events. Part of the value so the reducer stays a pure function of the list and the event. */
interface Track {
  /** The groups opened so far: a plan card, a one-step confirm card or a single call each open one. */
  readonly groups: number;
  /** The planner rounds started so far; a round's reads are one item. */
  readonly round: number;
  /** The plan card the turn is deciding or running. A later plan card appends its steps; the same card shown again re-derives them. */
  readonly plan: { readonly seq: number; readonly root: string; readonly approved: boolean } | null;
  /** The cards that appeared waiting for a decision since the last plan event: the ids the next card's steps own. */
  readonly fresh: readonly { readonly id: string; readonly tool: string }[];
  /** Which item each status card belongs to. */
  readonly owner: Readonly<Record<string, string>>;
  readonly calls: Readonly<Record<string, StatusState>>;
  /** The scene whose draft is streaming, before its card is shown. */
  readonly drafting: string | null;
  /** The card waiting for the writer, if any. */
  readonly awaiting: { readonly kind: 'plan' | 'confirm'; readonly steps: number; readonly content: string } | null;
}

export interface TaskList {
  readonly turnId: string;
  readonly items: readonly TaskItem[];
  readonly modelCalls: { readonly used: number; readonly limit: number };
  readonly phase: TurnPhase | 'idle';
  readonly track: Track;
}

export function emptyTaskList(turnId: string, limit: number = DEFAULT_MAX_MODEL_CALLS): TaskList {
  return {
    turnId,
    items: [],
    modelCalls: { used: 0, limit },
    phase: 'idle',
    track: { groups: 0, round: 0, plan: null, fresh: [], owner: {}, calls: {}, drafting: null, awaiting: null },
  };
}

/** The first sentence of a refusal: what the item shows as its reason. */
export function firstSentence(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  const match = /^.*?[.!?](?=\s|$)/.exec(line);
  return (match?.[0] ?? line).trim();
}

const PLAN_KEY = 'plan';
const READ_CALL = /:r\d+(?:\.confirm)?$/;

/**
 * The call id a plan's step ids are built from: the id less its trailing `.<step>` and any `.retry<n>` before it, or undefined when it
 * has no step suffix. Read from the end in one pass, because a pattern with a repeated retry group backtracks quadratically.
 */
export function planCallRoot(id: string): string | undefined {
  const digitsBefore = (end: number): number => {
    let start = end;
    while (start > 0 && id.charCodeAt(start - 1) >= 48 && id.charCodeAt(start - 1) <= 57) start--;
    return start;
  };
  const step = digitsBefore(id.length);
  if (step === id.length || step === 0 || id[step - 1] !== '.') return undefined;
  let end = step - 1;
  for (;;) {
    const digits = digitsBefore(end);
    if (digits === end || digits < 6 || id.slice(digits - 6, digits) !== '.retry') break;
    end = digits - 6;
  }
  const root = id.slice(0, end);
  return LINE_BREAK.test(root) ? undefined : root;
}

function isSettled(phase: TurnPhase | 'idle'): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'cancelled';
}

const stepKey = (seq: number, origin: number): string => `${seq}:${origin}`;
const groupOf = (key: string): string => (key.includes(':') ? key.slice(0, key.indexOf(':')) : key);

/** The step's item: its words from the phrase table, its state from the card it is on. */
function itemOfStep(seq: number, step: PlanStepView, existing: TaskItem | undefined, nameOf?: NameOf): TaskItem {
  const words = phraseFor(step.tool, step.params, nameOf);
  const state: TaskState = step.status === 'done' ? 'done' : step.status === 'refused' ? 'failed' : 'waiting';
  const reason = step.status === 'refused' && step.error !== undefined ? firstSentence(step.error.message) : '';
  return {
    key: stepKey(seq, step.origin),
    ...words,
    state,
    tool: step.tool,
    ...(existing?.callId !== undefined && state === 'done' ? { callId: existing.callId } : {}),
    ...(reason === '' ? {} : { reason }),
  };
}

/** Replaces the items of one group, in place when the group is there and at the end when it is new. */
function withGroup(items: readonly TaskItem[], seq: number, next: readonly TaskItem[]): readonly TaskItem[] {
  const prefix = `${seq}`;
  const at = items.findIndex((item) => groupOf(item.key) === prefix);
  const rest = items.filter((item) => groupOf(item.key) !== prefix);
  if (at === -1) return [...rest, ...next];
  return [...rest.slice(0, at), ...next, ...rest.slice(at)];
}

function replaceItem(items: readonly TaskItem[], key: string, change: (item: TaskItem) => TaskItem): readonly TaskItem[] {
  return items.map((item) => (item.key === key ? change(item) : item));
}

/** The reads item of a round, from the cards that belong to it. */
function readsItem(list: TaskList, key: string, items: readonly TaskItem[]): readonly TaskItem[] {
  const ids = Object.keys(list.track.owner).filter((id) => list.track.owner[id] === key);
  const states = ids.map((id) => list.track.calls[id]);
  const state: TaskState = states.includes('running')
    ? 'in_progress'
    : states.includes('pending-approval')
      ? 'waiting'
      : states.length > 0 && states.every((value) => value === 'failed')
        ? 'failed'
        : states.length > 0 && states.every((value) => value === 'cancelled')
          ? 'skipped'
          : 'done';
  const content = ids.length > 1 ? `Read the project (${ids.length} reads)` : 'Read the project';
  const activeForm = ids.length > 1 ? `Reading the project (${ids.length} reads)` : 'Reading the project';
  const exists = items.some((item) => item.key === key);
  const base: TaskItem = { key, content, activeForm, state };
  return exists ? replaceItem(items, key, (item) => ({ ...item, content, activeForm, state })) : [...items, base];
}

/** What a status card moves its item to. `pending-approval` leaves the item as the plan card put it. */
function cardState(card: StatusCard, item: TaskItem): TaskItem {
  switch (card.status) {
    case 'running':
      return { ...item, state: 'in_progress', callId: card.callId };
    case 'done':
      return { ...item, state: 'done', callId: card.callId };
    case 'failed': {
      const reason = card.error === undefined ? '' : firstSentence(card.error);
      return { ...item, state: 'failed', callId: card.callId, ...(reason === '' ? {} : { reason }) };
    }
    case 'cancelled':
      return { ...item, state: 'skipped', callId: card.callId };
    default:
      return item;
  }
}

function onCard(list: TaskList, card: StatusCard, nameOf?: NameOf): TaskList {
  const calls = { ...list.track.calls, [card.id]: card.status };
  let track: Track = { ...list.track, calls };
  let items = list.items;
  let key = track.owner[card.id];
  if (key === undefined) {
    if (card.status === 'pending-approval') {
      return { ...list, track: { ...track, fresh: [...track.fresh, { id: card.id, tool: card.tool }] } };
    }
    if (READ_CALL.test(card.id)) {
      key = `reads:${track.round}`;
      track = { ...track, owner: { ...track.owner, [card.id]: key } };
    } else {
      // A call with no card before it: a write that needs no approval, or a step refused before any card was shown for it.
      const seq = track.groups + 1;
      key = stepKey(seq, 0);
      track = { ...track, groups: seq, owner: { ...track.owner, [card.id]: key } };
      items = [...items, { key, ...phraseFor(card.tool, card.args, nameOf), state: 'pending', tool: card.tool }];
    }
  }
  const next: TaskList = { ...list, items, track };
  if (key.startsWith('reads:')) return finish({ ...next, items: readsItem(next, key, items) }, card.status === 'running' || card.status === 'done');
  return finish({ ...next, items: replaceItem(items, key, (item) => cardState(card, item)) }, card.status === 'running' || card.status === 'done');
}

function onPlan(list: TaskList, card: PlanCardView, nameOf?: NameOf): TaskList {
  const { track } = list;
  const pending = card.steps.filter((step) => step.status !== 'done');
  const awaiting: Track['awaiting'] = {
    kind: card.kind,
    steps: pending.length,
    content: phraseFor(pending[0]?.tool ?? card.steps[0]?.tool ?? 'agent.plan', pending[0]?.params ?? {}, nameOf).content,
  };

  if (card.kind === 'confirm') {
    const step = card.steps[0];
    if (step === undefined) return list;
    const candidate = [...track.fresh].reverse().find((entry) => entry.tool === step.tool);
    let items = list.items;
    let next: Track = { ...track, fresh: [], awaiting };
    if (candidate !== undefined && READ_CALL.test(candidate.id)) {
      // A read the document guard held back: it waits on its round's reads item.
      const key = `reads:${track.round}`;
      next = { ...next, owner: { ...next.owner, [candidate.id]: key }, calls: { ...next.calls, [candidate.id]: 'pending-approval' } };
      return finish({ ...list, track: next, items: readsItem({ ...list, track: next }, key, items) }, false);
    }
    let key: string | undefined;
    if (candidate !== undefined) {
      const seq = track.groups + 1;
      key = stepKey(seq, step.origin);
      next = { ...next, groups: seq, owner: { ...next.owner, [candidate.id]: key } };
      items = [...items, itemOfStep(seq, step, undefined, nameOf)];
    } else {
      // A step of the plan that is running, asking on a card of its own (an external write).
      key = [...items].reverse().find((item) => item.tool === step.tool && (item.state === 'pending' || item.state === 'waiting'))?.key;
    }
    if (key === undefined) return finish({ ...list, track: next }, false);
    const target = key;
    return finish({ ...list, track: next, items: replaceItem(items, target, (item) => (step.status === 'refused' ? itemOfStep(Number(groupOf(target)), step, item, nameOf) : { ...item, state: 'waiting' })) }, false);
  }

  const root = track.fresh[0] === undefined ? undefined : (planCallRoot(track.fresh[0].id) ?? track.fresh[0].id);
  const current = track.plan;
  const reshown = current !== null && (root === undefined ? !current.approved : root === current.root);
  const seq = reshown ? current.seq : track.groups + 1;
  const owner: Record<string, string> = { ...track.owner };
  for (const entry of track.fresh) {
    const tail = /\.(\d+)$/.exec(entry.id)?.[1];
    const step = tail === undefined ? undefined : card.steps.find((candidate) => candidate.index === Number(tail));
    if (step !== undefined) owner[entry.id] = stepKey(seq, step.origin);
  }
  const before = list.items.filter((item) => groupOf(item.key) === `${seq}`);
  const shown = card.steps.map((step) => itemOfStep(seq, step, before.find((item) => item.key === stepKey(seq, step.origin)), nameOf));
  // A step the card no longer holds was dropped before it ran.
  const dropped = before.filter((item) => !shown.some((entry) => entry.key === item.key)).map((item): TaskItem => (item.state === 'done' ? item : { ...item, state: 'skipped' }));
  const next: Track = {
    ...track,
    groups: reshown ? track.groups : seq,
    plan: { seq, root: root ?? current?.root ?? '', approved: false },
    fresh: [],
    owner,
    drafting: null,
    awaiting,
  };
  return finish({ ...list, track: next, items: withGroup(list.items, seq, [...shown, ...dropped]) }, false);
}

/** The turn is over: whatever has not run will not. */
function settle(list: TaskList): TaskList {
  const items = list.items.map((item): TaskItem => (item.state === 'pending' || item.state === 'waiting' || item.state === 'in_progress' ? { ...item, state: 'skipped' } : item));
  return finish({ ...list, items, track: { ...list.track, awaiting: null, drafting: null } }, false);
}

function onPhase(list: TaskList, phase: TurnPhase): TaskList {
  let next: TaskList = { ...list, phase };
  if (phase === 'planning') next = { ...next, track: { ...next.track, round: next.track.round + 1, drafting: null } };
  if (phase === 'retrying') next = { ...next, track: { ...next.track, drafting: null } };
  if (phase === 'running') {
    // The writer approved: what waited for a decision now waits its turn.
    const items = next.items.map((item): TaskItem => (item.state === 'waiting' ? { ...item, state: 'pending' } : item));
    const plan = next.track.plan === null ? null : { ...next.track.plan, approved: true };
    next = { ...next, items, track: { ...next.track, plan, awaiting: null, drafting: null } };
  }
  if (isSettled(phase)) return settle(next);
  return finish(next, phase === 'running');
}

/**
 * The normalising pass every fold ends in. The planner row is in progress while the model is being asked and nothing else runs;
 * a running turn always has its next pending item in progress; and no list ever holds two items in progress.
 */
function finish(list: TaskList, promote: boolean): TaskList {
  let items = list.items;
  const running = (item: TaskItem): boolean => item.key !== PLAN_KEY && item.state === 'in_progress';
  if (promote && list.phase === 'running' && !items.some(running)) {
    const next = items.findIndex((item) => item.key !== PLAN_KEY && item.state === 'pending');
    if (next !== -1) items = items.map((item, index) => (index === next ? { ...item, state: 'in_progress' } : item));
  }
  const asking = list.phase === 'planning' || list.phase === 'retrying';
  if (asking && !items.some((item) => item.key === PLAN_KEY)) {
    items = [{ key: PLAN_KEY, content: 'Plan', activeForm: 'Planning', state: 'in_progress' }, ...items];
  }
  const busy = items.some(running);
  const activeForm = list.track.drafting !== null ? `Drafting ${quoted(list.track.drafting)}` : list.phase === 'retrying' ? 'Trying again' : 'Planning';
  items = items.map((item) => (item.key === PLAN_KEY ? { ...item, activeForm, state: asking && !busy ? 'in_progress' : 'done' } : item));
  const last = items.map(running).lastIndexOf(true);
  items = items.map((item, index) => (running(item) && index !== last ? { ...item, state: 'pending' } : item));
  return { ...list, items };
}

/**
 * Folds one event into a turn's task list. An event for another turn returns the list unchanged, as `reduceTurn` does, so a
 * caller may pass every event through every list it holds. Events that change nothing the list shows (a streamed delta) return
 * the list itself.
 */
export function reduceTaskList(list: TaskList, event: AgentEvent, nameOf?: NameOf): TaskList {
  if (event.turnId !== list.turnId) return list;
  switch (event.type) {
    case 'turn':
      return onPhase(list, event.phase);
    case 'model.call':
      return list.modelCalls.used === event.used && list.modelCalls.limit === event.limit
        ? list
        : { ...list, modelCalls: { used: event.used, limit: event.limit } };
    case 'draft.delta': {
      // Only the first delta of a draft names a scene: the rest change nothing the header shows.
      const scene = nameOf === undefined ? event.docTitle : nameOf(event.docTitle);
      return event.start === true && list.track.drafting !== scene ? finish({ ...list, track: { ...list.track, drafting: scene } }, false) : list;
    }
    case 'card':
      return onCard(list, event.card, nameOf);
    case 'plan':
      return onPlan(list, event.card, nameOf);
    case 'report':
      return settle({ ...list, phase: isSettled(list.phase) ? list.phase : event.report.status === 'cancelled' ? 'cancelled' : event.report.status === 'failed' ? 'failed' : 'done' });
    default:
      return list;
  }
}

/** Plural of "step", for the header. */
function stepsOf(count: number): string {
  return counted(count, 'step', 'steps');
}

/**
 * The line the agent header shows: "Step 3 of 5 · Drafting “The Landing”" while an item runs (the planner row is one of the
 * items, as the checklist shows it), "Waiting for you · Plan, 3 steps" while a card waits. `null` when the turn is not running, or has nothing to say yet:
 * the header then keeps its own words. It changes when the active step changes and not when text streams.
 */
export function headerLineOf(list: TaskList): string | null {
  if (list.phase === 'idle' || isSettled(list.phase)) return null;
  const { awaiting } = list.track;
  if (list.phase === 'awaiting-approval' && awaiting !== null) {
    return awaiting.kind === 'plan' ? `Waiting for you · Plan, ${stepsOf(awaiting.steps)}` : `Waiting for you · ${awaiting.content}`;
  }
  const active = list.items.find((item) => item.state === 'in_progress');
  if (active === undefined) return null;
  const steps = list.items.filter((item) => item.state !== 'skipped');
  return `Step ${steps.indexOf(active) + 1} of ${steps.length} · ${active.activeForm}`;
}

/** How close a turn is to its model-call bound: `limit` at the bound, `near` one call short of it (the last two calls). */
export function budgetLevelOf(modelCalls: TaskList['modelCalls']): 'ok' | 'near' | 'limit' {
  if (modelCalls.used >= modelCalls.limit) return 'limit';
  return modelCalls.used === modelCalls.limit - 1 && modelCalls.limit > 1 ? 'near' : 'ok';
}
