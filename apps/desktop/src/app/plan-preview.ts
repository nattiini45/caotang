/**
 * What a plan card shows of a step's preview, as data (agent-harness §3 rows 7, 9 and 13). The harness puts a preview on each
 * step: a synopsis batch's rows, a codex write's entry diffs, and a restructure's tree. This module reads those values into the
 * view the card draws, so the writer sees what the step will write before the approval covers it (agent-harness §2). It also
 * formats the cost estimate and the window warning that the prompt preview carries (context-assembly §5, §7). Nothing here
 * touches the DOM, and every id in the preview is named by its title, never shown raw.
 */

import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';
import { costLineRef, refusalSentence } from '@caotang/harness';
import type { MessageRef } from '@caotang/i18n';

import { renderRef } from '../i18n/render-ref.js';
import { nodeById, type ProjectState } from '@caotang/store';

/* lingui-set comment="Interpolated values: parent, title" */

/** One synopsis a batch writes: the document, whether the synopsis is new or replaces one, the text and its word count. */
export interface SynopsisPreviewRow {
  readonly doc: string;
  readonly action: 'create' | 'replace';
  readonly synopsis: string;
  readonly words: number;
}

/** One field a codex update changes, with the value it had and the value it gets, both as the preview states them. */
export interface CodexPreviewChange {
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

/** One codex entry a write changes: a new entry, or an update with its changed fields, the documents it joins or leaves, and its flags. */
export interface CodexPreviewEntry {
  readonly name: string;
  readonly action: 'create' | 'update';
  readonly changes: readonly CodexPreviewChange[];
  readonly attached: readonly string[];
  readonly detached: readonly string[];
  readonly flags: readonly string[];
}

/** One node a restructure creates, moves or renames: where it was, and where it lands. */
export interface TreePreviewRow {
  readonly title: string;
  readonly change: string;
  readonly from: string;
  readonly to: string;
}

/** One shot a derive creates: its number in the proposed list, its card title and its spec row (storyboard.md §4). */
export interface ShotPreviewRow {
  readonly number: number;
  readonly title: string;
  /** The camera spec in one line (shot size, angle, movement and duration), or empty when the shot has none. */
  readonly spec: string;
}

/** The shot list a derive proposes, and the storyboard folder it creates: each shot's row, the tree diff lines, and the plan's notes. */
export interface ShotsPreviewView {
  readonly kind: 'shots';
  readonly folder: string;
  readonly shots: readonly ShotPreviewRow[];
  readonly lines: readonly string[];
  readonly notes: readonly string[];
}

/** A run of a notes rewrite's text: kept as it is, added, or taken out. */
export interface NotesDiffSegment {
  readonly kind: 'same' | 'added' | 'removed';
  readonly text: string;
}

/** What `notes.replace` does to a document's notes, word by word, old to new (agent-harness §3). */
export interface NotesPreviewView {
  readonly kind: 'notes';
  readonly doc: string;
  readonly segments: readonly NotesDiffSegment[];
  readonly wordsBefore: number;
  readonly wordsAfter: number;
}

/** A step's preview in the words the card draws. */
export type StepPreviewView =
  | NotesPreviewView
  | { readonly kind: 'synopses'; readonly rows: readonly SynopsisPreviewRow[] }
  | { readonly kind: 'codex'; readonly entries: readonly CodexPreviewEntry[] }
  | { readonly kind: 'tree'; readonly lines: readonly string[]; readonly rows: readonly TreePreviewRow[] }
  | ReviewPreviewView
  | InkPreviewView
  | ShotsPreviewView;

/** The Ink a dialogue step writes to its container, and what the dialogue module says about it (dialogue-narrative.md §7). */
export interface InkPreviewView {
  readonly kind: 'ink';
  readonly container: string;
  readonly ink: string;
  readonly newBeats: readonly string[];
  readonly warnings: readonly string[];
}

/** One document a coherence review reads, as its plan states it: its token estimate, and what the budget left out of its prompt. */
export interface ReviewPreviewDocument {
  readonly title: string;
  readonly tokens: number;
  readonly truncated: boolean;
  /** Codex entries and story-so-far blocks the budget left out, by name. */
  readonly left: readonly string[];
}

/** A coherence review's plan (coherence.md §7 tool 16): what it reads, its cost bound by stage, and the first prompt. */
export interface ReviewPreviewView {
  readonly kind: 'review';
  readonly documents: readonly ReviewPreviewDocument[];
  readonly extractCalls: number;
  readonly verifyCallsAtMost: number;
  readonly totalTokensAtMost: number;
  readonly maxFindings: number;
  readonly overGuard: boolean;
  readonly prompt: string;
}

/** The name a node takes when the project no longer holds it, so a preview never shows an id. */
const MISSING_NODE: MessageDescriptor = msg`a document that is no longer in the project`;

/**
 * The `from` a create's field carries (codex.md §7, "create = full proposed content"). It marks a field that has no earlier
 * value and is never rendered: the card shows a create's fields as "label: value", so the marker is data, not copy.
 */
export const NEW_ENTRY_FROM = 'new-entry';

/** The writer's word for each codex field a write can name (codex.md §2). The preview's field names are internal, so they are mapped here. */
const FIELD_LABELS: Readonly<Record<string, MessageDescriptor>> = {
  name: msg`Name`,
  type: msg`Type`,
  description: msg`Description`,
  aliases: msg`Also known as`,
  includePolicy: msg`Included in drafting`,
  caseSensitive: msg`Match case`,
  exclude: msg`Ignore matches in`,
  visualRefs: msg`Visual references`,
};

/** A field's writer-facing label, or the internal name for one with no label. */
function fieldLabel(field: string): string {
  const label = FIELD_LABELS[field];
  return label === undefined ? field : i18n._(label);
}

/** The fields a create carries whole, in the order the card lists them. */
const CREATE_FIELDS = ['type', 'description', 'aliases', 'includePolicy', 'caseSensitive', 'exclude', 'visualRefs'] as const;

/** The name a picture takes when the project no longer holds its file, so the card names it rather than showing its id. */
const MISSING_PICTURE: MessageDescriptor = msg`a picture that is no longer in the project`;

/** The writer's words for each include policy (codex.md §2): when the entry is put into a drafting call. */
const POLICY_WORDS: Readonly<Record<string, MessageDescriptor>> = {
  always: msg`Always, in every drafting call`,
  detected: msg`When its name or an alias appears in the text`,
  manual: msg`Only when attached to the scene`,
  never: msg`Never`,
};

/**
 * The flag the codex diff carries for an always-include entry (`ALWAYS_INCLUDE_FLAG` in the harness) — its data token, never
 * translated; the harness is free to extend the sentence after `always-include`.
 */
function isAlwaysFlag(flag: string): boolean {
  return flag.startsWith('always-include');
}

const CHANGE_WORDS: Readonly<Record<string, MessageDescriptor>> = {
  created: msg`Created`,
  moved: msg`Moved`,
  renamed: msg`Renamed`,
  both: msg`Moved and renamed`,
};

/** A restructure change in the writer's words: a move and a rename together are one change of their own. */
function changeWordsOf(change: string): string {
  const key = change.startsWith('moved') && change.includes('renamed') ? 'both' : change;
  const word = CHANGE_WORDS[key];
  return word === undefined ? change : i18n._(word);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function titleOf(state: ProjectState, id: string): string {
  return nodeById(state, id)?.title ?? i18n._(MISSING_NODE);
}

/** A place in the tree as the restructure preview names it: the node's title, and the title of the node it sits in. */
function placeOf(slot: Record<string, unknown>): string {
  const title = typeof slot['title'] === 'string' ? slot['title'] : '';
  const parent = typeof slot['parentTitle'] === 'string' ? slot['parentTitle'] : null;
  return parent === null ? title : t`${{ title: isolate(title) }}, in ${{ parent: isolate(parent) }}`;
}

function flagWords(flag: string): string {
  return isAlwaysFlag(flag) ? t`Always included: this entry goes into every drafting call` : flag;
}

/** A codex value in the words the card shows: yes or no, the list joined, the policy named in words, and "(none)" for nothing. */
function plainOf(field: string, value: unknown): string {
  if (field === 'includePolicy' && typeof value === 'string') {
    const policy = POLICY_WORDS[value];
    return policy === undefined ? value : i18n._(policy);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.map((item) => String(item)).join(', ');
  if (value === null || value === undefined || value === '') return '(none)';
  return String(value);
}

/** The value a preview carries as JSON text (an update's `from` and `to`), read back to the value it stands for. */
function valueOfJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * A codex value for one field, in the writer's words. A picture list names its pictures by file name, from the project's own
 * pictures (`names`, by asset id), and says "(none)" for an empty list; every other field reads as `plainOf` reads it.
 */
function wordsOf(field: string, value: unknown, names: ReadonlyMap<string, string>): string {
  if (field !== 'visualRefs') return plainOf(field, value);
  const ids = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return ids.length === 0 ? '(none)' : ids.map((id) => names.get(id) ?? i18n._(MISSING_PICTURE)).join(', ');
}

/**
 * The changes of a create: every field the new entry holds, from "(new entry)" to its value, under the writer's label. The picture
 * references are always listed on a create, so a create with none says "(none)" rather than leaving the writer to wonder.
 */
function createChangesOf(entry: Record<string, unknown>, names: ReadonlyMap<string, string>): CodexPreviewChange[] {
  return CREATE_FIELDS.filter((field) => entry[field] !== undefined || field === 'visualRefs').map((field) => ({
    field: fieldLabel(field),
    from: NEW_ENTRY_FROM,
    to: wordsOf(field, entry[field], names),
  }));
}

/** The changes of an update: each field that moves, from its old value to its new one, under the writer's label. */
function updateChangesOf(changes: unknown, names: ReadonlyMap<string, string>): CodexPreviewChange[] {
  if (!Array.isArray(changes)) return [];
  return changes.filter(isRecord).map((change) => {
    const field = String(change['field'] ?? '');
    return {
      field: fieldLabel(field),
      from: wordsOf(field, valueOfJson(String(change['from'] ?? 'null')), names),
      to: wordsOf(field, valueOfJson(String(change['to'] ?? 'null')), names),
    };
  });
}

function isSpace(char: string): boolean {
  return char.trim() === '';
}

/** The text as words and the whitespace between them, so a diff of the tokens joins back to the text. */
function wordTokens(text: string): string[] {
  const tokens: string[] = [];
  let start = 0;
  for (let at = 1; at <= text.length; at += 1) {
    if (at === text.length || isSpace(text.charAt(at)) !== isSpace(text.charAt(at - 1))) {
      tokens.push(text.slice(start, at));
      start = at;
    }
  }
  return text.length === 0 ? [] : tokens;
}

/** The product of two token counts above which the longest-common-subsequence table is not built (about 4 million cells). */
const DIFF_CELLS_MAX = 4_000_000;

/**
 * The difference between two texts, word by word. The words both texts share at the start and the end are kept, and the middle is
 * matched by a longest common subsequence. A middle too large to match shows as the old words taken out and the new words added,
 * which is true and only less fine.
 */
export function wordDiff(before: string, after: string): NotesDiffSegment[] {
  const a = wordTokens(before);
  const b = wordTokens(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);

  const out: NotesDiffSegment[] = [];
  const push = (kind: NotesDiffSegment['kind'], text: string): void => {
    if (text === '') return;
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === kind) out[out.length - 1] = { kind, text: last.text + text };
    else out.push({ kind, text });
  };

  push('same', a.slice(0, head).join(''));
  if (middleA.length * middleB.length > DIFF_CELLS_MAX) {
    push('removed', middleA.join(''));
    push('added', middleB.join(''));
  } else {
    // lengths[i][j] is the longest common run of middleA from i and middleB from j.
    const lengths: Uint32Array[] = Array.from({ length: middleA.length + 1 }, () => new Uint32Array(middleB.length + 1));
    for (let i = middleA.length - 1; i >= 0; i -= 1) {
      for (let j = middleB.length - 1; j >= 0; j -= 1) {
        const row = lengths[i] as Uint32Array;
        row[j] = middleA[i] === middleB[j] ? ((lengths[i + 1] as Uint32Array)[j + 1] as number) + 1 : Math.max((lengths[i + 1] as Uint32Array)[j] as number, row[j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < middleA.length || j < middleB.length) {
      if (i < middleA.length && j < middleB.length && middleA[i] === middleB[j]) {
        push('same', middleA[i] as string);
        i += 1;
        j += 1;
      } else if (i < middleA.length && (j === middleB.length || ((lengths[i + 1] as Uint32Array)[j] as number) >= ((lengths[i] as Uint32Array)[j + 1] as number))) {
        // The old words come out before the new ones go in, so a replaced run reads old, then new.
        push('removed', middleA[i] as string);
        i += 1;
      } else {
        push('added', middleB[j] as string);
        j += 1;
      }
    }
  }
  push('same', a.slice(a.length - tail).join(''));
  return out;
}

function wordCount(text: string): number {
  return wordTokens(text).filter((token) => !isSpace(token.charAt(0))).length;
}

/**
 * The card's view of one step's preview, by tool. Undefined for a step whose preview the card does not draw (a read, or a
 * tool with nothing to show beyond its params), so the card shows its params as it always has. `pictureNames` maps each
 * picture's asset id to its file name, for a codex entry's visual references; a picture not in it is named as missing.
 */
export function stepPreviewOf(
  tool: string,
  preview: unknown,
  state: ProjectState,
  pictureNames: ReadonlyMap<string, string> = new Map(),
): StepPreviewView | undefined {
  if (!isRecord(preview)) return undefined;
  if (tool === 'notes.replace' && typeof preview['before'] === 'string' && typeof preview['after'] === 'string') {
    return {
      kind: 'notes',
      doc: typeof preview['doc'] === 'string' ? preview['doc'] : '',
      segments: wordDiff(preview['before'], preview['after']),
      wordsBefore: wordCount(preview['before']),
      wordsAfter: wordCount(preview['after']),
    };
  }
  if (tool === 'synopsis.fill' && Array.isArray(preview['rows'])) {
    const rows = preview['rows'].filter(isRecord).map(
      (row): SynopsisPreviewRow => ({
        doc: typeof row['doc'] === 'string' ? row['doc'] : '',
        action: row['action'] === 'create' ? 'create' : 'replace',
        synopsis: typeof row['synopsis'] === 'string' ? row['synopsis'] : '',
        words: typeof row['words'] === 'number' ? row['words'] : 0,
      }),
    );
    return { kind: 'synopses', rows };
  }
  if (tool === 'codex.write' && Array.isArray(preview['entries'])) {
    const entries = preview['entries'].filter(isRecord).map(
      (entry): CodexPreviewEntry => ({
        name: typeof entry['name'] === 'string' ? entry['name'] : '',
        action: entry['action'] === 'update' ? 'update' : 'create',
        // A create's fields sit beside its name, not in `changes`, so they are read off the entry (codex-write.ts createDiff).
        changes: entry['action'] === 'update' ? updateChangesOf(entry['changes'], pictureNames) : createChangesOf(entry, pictureNames),
        attached: textsOf(entry['attach']).map((id) => titleOf(state, id)),
        detached: textsOf(entry['detach']).map((id) => titleOf(state, id)),
        flags: textsOf(entry['flags']).map(flagWords),
      }),
    );
    return { kind: 'codex', entries };
  }
  if (tool === 'dialogue.draft' && typeof preview['ink'] === 'string') {
    return {
      kind: 'ink',
      container: typeof preview['container'] === 'string' ? preview['container'] : '',
      ink: preview['ink'],
      newBeats: textsOf(preview['newBeats']),
      warnings: textsOf(preview['warnings']),
    };
  }
  if (tool === 'coherence.review' && Array.isArray(preview['documents']) && isRecord(preview['estimate'])) {
    const estimate = preview['estimate'];
    const documents = preview['documents'].filter(isRecord).map(
      (doc): ReviewPreviewDocument => ({
        title: typeof doc['title'] === 'string' ? doc['title'] : '',
        tokens: typeof doc['tokens'] === 'number' ? doc['tokens'] : 0,
        truncated: doc['truncated'] === true,
        left: [...textsOf(doc['codexDropped']), ...textsOf(doc['storyDropped'])],
      }),
    );
    return {
      kind: 'review',
      documents,
      extractCalls: typeof estimate['extractCalls'] === 'number' ? estimate['extractCalls'] : 0,
      verifyCallsAtMost: typeof estimate['verifyCallsAtMost'] === 'number' ? estimate['verifyCallsAtMost'] : 0,
      totalTokensAtMost: typeof estimate['totalTokensAtMost'] === 'number' ? estimate['totalTokensAtMost'] : 0,
      maxFindings: typeof preview['maxFindings'] === 'number' ? preview['maxFindings'] : 0,
      overGuard: preview['overGuard'] === true,
      prompt: typeof preview['promptPreview'] === 'string' ? preview['promptPreview'] : '',
    };
  }
  if (tool === 'shots.derive' && typeof preview['folder'] === 'string' && Array.isArray(preview['shots'])) {
    const shots = preview['shots'].filter(isRecord).map(
      (shot): ShotPreviewRow => ({
        number: typeof shot['number'] === 'number' ? shot['number'] : 0,
        title: typeof shot['title'] === 'string' ? shot['title'] : '',
        spec: typeof shot['spec'] === 'string' ? shot['spec'] : '',
      }),
    );
    return { kind: 'shots', folder: preview['folder'], shots, lines: textsOf(preview['lines']), notes: textsOf(preview['notes']) };
  }
  if (tool === 'binder.restructure' && Array.isArray(preview['tree'])) {
    const rows = preview['tree'].filter(isRecord).map((node): TreePreviewRow => {
      const after = isRecord(node['after']) ? node['after'] : {};
      const before = isRecord(node['before']) ? node['before'] : undefined;
      const change = typeof node['change'] === 'string' ? node['change'] : '';
      return {
        title: typeof after['title'] === 'string' ? after['title'] : '',
        change: changeWordsOf(change),
        from: before === undefined ? t`Not in the project yet` : placeOf(before),
        to: placeOf(after),
      };
    });
    return { kind: 'tree', lines: textsOf(preview['lines']), rows };
  }
  return undefined;
}

/**
 * Why Approve is off because a step was refused, in the words the preflight gave (the first refused step's message and its hint, as
 * two sentences), or undefined when no step was refused. The card shows it beside the disabled Approve, as well as on the step's own
 * row, since the writer looks at Approve to see what is stopping the plan.
 */
export function refusalReasonOf(
  steps: readonly {
    readonly status: string;
    readonly error?: {
      readonly message: string;
      readonly messageRef?: MessageRef;
      readonly correctiveHint?: string;
      readonly correctiveHintRef?: MessageRef;
    };
  }[],
): string | undefined {
  const refused = steps.find((step) => step.status === 'refused' && step.error !== undefined)?.error;
  if (refused === undefined) return undefined;
  // I7: a bus refusal carries the same sentence as a ref; the English is the fallback for an old or
  // untranslated id, never a raw ICU template.
  const message = refused.messageRef === undefined ? refused.message : renderRef(refused.messageRef);
  const hint = refused.correctiveHintRef === undefined ? refused.correctiveHint : renderRef(refused.correctiveHintRef);
  return refusalSentence(message, hint);
}

/**
 * A dollar amount for the card: four decimals under a dollar, where a single step's cost sits, two above it, and a floor word
 * for an amount too small to show.
 */
export function formatUsd(value: number): string {
  if (value < 0.0001) return t`under $0.0001`;
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** The cost estimate of one step, as the card's line, or undefined when the profile has no price (provider-gateway §6). */
export function costLineOf(
  cost: { readonly promptUsd: number; readonly completionUsd: number; readonly totalUsd: number; readonly includesThinking?: true } | undefined,
): string | undefined {
  // I7: the line is the harness ref, rendered through the active catalogue or compiled English. Its
  // English is byte-identical to the sentence this function wrote before the ref existed.
  const ref = costLineRef(cost);
  return ref === undefined ? undefined : renderRef(ref);
}

/**
 * What a turn's tokens cost at the profile it ran on: prompt tokens at the prompt price and reply tokens at the reply price, per
 * 1,000 tokens (provider-gateway §2). Undefined when the profile has no price, so an unpriced turn shows no cost.
 */
export function turnCostOf(
  tokens: { readonly promptTokens: number; readonly completionTokens: number },
  price: { readonly prompt: number; readonly completion: number } | null,
): number | undefined {
  if (price === null) return undefined;
  return (tokens.promptTokens * price.prompt + tokens.completionTokens * price.completion) / 1000;
}

/** The whole plan's estimate: the sum of the steps that carry a price, or undefined when none of them does. */
export function planCostOf(costs: readonly (number | undefined)[]): number | undefined {
  const priced = costs.filter((value): value is number => value !== undefined);
  return priced.length === 0 ? undefined : priced.reduce((sum, value) => sum + value, 0);
}
