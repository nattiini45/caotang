/**
 * L5 — the focus text — [context-assembly.md §2 and §3](../../../../docs/architecture/context-assembly.md).
 *
 * The part of the focus document the model may build on, by mode:
 *
 * - `draft` (an empty document, or a draft that has no body): no body text. The synopsis
 *   and notes stand in.
 * - `continue`: the tail, the last `continuationChars` characters (3,000 by default).
 * - `rewrite_selection`: the selection, and the immediate antecedent before it, the last
 *   `ANTECEDENT_CHARS` characters (1,500) of the text before it.
 * - `full` (synopsis.fill): the whole document, up to the layer's cap, cut from the bottom.
 *
 * Both sizes are the spec's, and they hold by default. The budget the layers above pass up
 * (context-assembly §3) lengthens the tail and the antecedent only when the config opts in
 * (`focusFlowUp`): then each unused token adds four characters, up to the layer's cap. Left
 * off, the flowed-in budget still raises the layer's cap, but the text does not grow into it.
 *
 * Every mode ends with the boundary marker, so a continuation starts at a known place.
 * The text is one layer item, and a budget shortens it rather than dropping it. The
 * selection is never cut, because the rewrite is about it. When it is over budget, it is
 * sent whole, and the layer's notes say so.
 *
 * continuity.scan has no single focus. Its L5 is a block of document tails, one per scope
 * document, and those are whole entries under the rank rule.
 */

import { getBody, getRevision, type ProjectState, type TreeNode } from '@caotang/store';
import type { DetectionDoc, IndexedDoc } from '@caotang/codex';

import { newBlock, type Block, type BlockItem } from '../block.js';
import { ContextError } from '../errors.js';
import { dropRecord } from '../drops.js';
import {
  ANTECEDENT_CHARS,
  PREVIEW_CHARS,
  SCOPE_DOCUMENT_LIMIT,
  SCOPE_TAIL_CHARS,
} from '../profiles.js';
import { formatCount, headOf, tailOf } from '../text.js';
import { CHARS_PER_TOKEN, charsFor } from '../tokens.js';
import {
  LAYER_NAMES,
  type DraftMode,
  type DropRecord,
  type FocusReport,
  type SelectionSpan,
} from '../types.js';

/** The boundary every focus text ends with (§2 L5). */
export const FOCUS_MARKER = '<<< current text ends here >>>';

const HEADING = `# ${LAYER_NAMES.L5}`;

export interface FocusInput {
  readonly node: TreeNode;
  /** The document's body projection, as the store holds it. */
  readonly body: string;
  readonly mode: DraftMode | 'full';
  readonly selection: SelectionSpan | undefined;
  /** The layer's effective budget in tokens, flow-up included. */
  readonly budgetTokens: number;
  /** Tokens of unused budget that flowed up from L4 (or L3). They lengthen the tail when `flowUp` is set. */
  readonly carryTokens: number;
  /** Whether the text takes the flowed-in budget (`ContextConfig.focusFlowUp`). Off by default. */
  readonly flowUp: boolean;
  readonly continuationChars: number;
}

export interface FocusPlan {
  readonly text: string;
  readonly notes: readonly string[];
  readonly report: FocusReport;
  /** The text the focus contributes to codex detection (codex.md §4, rule 6). */
  readonly surfaces: readonly DetectionDoc[];
  /** The one entry the layer reports as kept. */
  readonly item: { readonly label: string; readonly reason: string };
}

export function focusText(input: FocusInput): FocusPlan {
  const cap = charsFor(input.budgetTokens);
  switch (input.mode) {
    case 'draft':
      return standIn(input, cap);
    case 'continue':
      return input.body === '' ? standIn(input, cap) : continueText(input, cap);
    case 'rewrite_selection':
      return rewriteText(input, cap);
    case 'full':
      return fullText(input, cap);
  }
}

function sentReport(node: TreeNode, mode: FocusReport['mode'], sent: string, documentChars: number): FocusReport {
  return {
    doc: node.id,
    title: node.title,
    mode,
    chars: sent.length,
    head: headOf(sent, PREVIEW_CHARS),
    documentChars,
  };
}

/** draft: the synopsis and notes, cut from the notes first if the budget is tight. */
function standIn(input: FocusInput, cap: number): FocusPlan {
  const { node, body } = input;
  const synopsis = node.synopsis.trim() === '' ? '(none)' : node.synopsis.trim();
  const fullNotes = node.notes.trim();
  const intro =
    body === ''
      ? `Document: ${node.title} (draft; the document is empty, so its synopsis and notes stand in for the text)`
      : `Document: ${node.title} (draft; the document holds ${formatCount(body.length)} characters, which are not sent, so its synopsis and notes stand in)`;
  const frame = (notes: string): string =>
    [HEADING, intro, `Synopsis: ${synopsis}`, `Notes: ${notes === '' ? '(none)' : notes}`, FOCUS_MARKER].join('\n\n');

  const notes: string[] = [];
  let shown = fullNotes;
  let text = frame(shown);
  if (text.length > cap) {
    shown = headOf(fullNotes, Math.max(0, fullNotes.length - (text.length - cap)));
    text = frame(shown);
    notes.push(
      `The notes are cut to fit the focus budget (${formatCount(shown.length)} of ${formatCount(fullNotes.length)} characters).`,
    );
  }
  return {
    text,
    notes,
    report: sentReport(node, 'draft', '', body.length),
    surfaces: [],
    item: { label: node.title, reason: 'draft stand-in: synopsis and notes' },
  };
}

/** The characters the flowed-in budget adds to a focus size: none unless the config opts in. */
function flowedInChars(input: FocusInput): number {
  return input.flowUp ? CHARS_PER_TOKEN * input.carryTokens : 0;
}

/** continue: the tail. Its nominal length is `continuationChars`, plus the flowed-in budget when opted in. */
function continueText(input: FocusInput, cap: number): FocusPlan {
  const { node, body } = input;
  const frame = (tail: string): string =>
    [
      HEADING,
      `Document: ${node.title} (continue; ${
        tail.length === body.length
          ? `all ${formatCount(body.length)} characters`
          : `the last ${formatCount(tail.length)} of ${formatCount(body.length)} characters`
      } of the current text)`,
      tail,
      FOCUS_MARKER,
    ].join('\n\n');

  const wanted = Math.min(body.length, input.continuationChars + flowedInChars(input));
  let take = wanted;
  let tail = tailOf(body, take);
  let text = frame(tail);
  while (text.length > cap && take > 0) {
    take = Math.max(0, take - (text.length - cap));
    tail = tailOf(body, take);
    text = frame(tail);
  }
  const notes: string[] = [];
  if (take < wanted) {
    notes.push(`The tail is cut to fit the focus budget (${formatCount(tail.length)} of ${formatCount(wanted)} characters).`);
  }
  return {
    text,
    notes,
    report: sentReport(node, 'continue', tail, body.length),
    surfaces: [{ id: 'tail', text: tail }],
    item: { label: node.title, reason: `last ${formatCount(tail.length)} characters of the current text` },
  };
}

/** rewrite_selection: the selection, with as much of the text before it as the budget allows. */
function rewriteText(input: FocusInput, cap: number): FocusPlan {
  const { node, body, selection } = input;
  if (selection === undefined || selection.exact === '') {
    throw new ContextError('missing-selection', 'rewrite_selection needs a selection with text (agent-harness.md §3, row 8)');
  }
  const notes: string[] = [];
  const valid =
    selection.from >= 0 &&
    selection.from <= selection.to &&
    selection.to <= body.length &&
    body.slice(selection.from, selection.to) === selection.exact;
  if (!valid) {
    notes.push('The selection no longer matches the document, so the text before it is not sent.');
  }
  const before = valid ? body.slice(0, selection.from) : '';
  const frame = (antecedent: string): string =>
    [
      HEADING,
      `Document: ${node.title} (rewrite selection; ${formatCount(antecedent.length)} characters of preceding text, then the selection of ${formatCount(selection.exact.length)} characters)`,
      `Preceding text:\n${antecedent === '' ? '(none)' : antecedent}`,
      `Selection to rewrite:\n${selection.exact}`,
      FOCUS_MARKER,
    ].join('\n\n');

  let take = Math.min(before.length, ANTECEDENT_CHARS + flowedInChars(input));
  let antecedent = tailOf(before, take);
  let text = frame(antecedent);
  while (text.length > cap && antecedent.length > 0) {
    take = Math.max(0, antecedent.length - (text.length - cap));
    antecedent = tailOf(before, take);
    text = frame(antecedent);
  }
  if (text.length > cap) {
    notes.push(
      `The selection is ${formatCount(selection.exact.length)} characters, over the focus budget, so it is sent whole.`,
    );
  }
  return {
    text,
    notes,
    report: sentReport(node, 'rewrite_selection', antecedent + selection.exact, body.length),
    surfaces: [
      { id: 'selection', text: selection.exact },
      { id: 'tail', text: antecedent },
    ],
    item: {
      label: node.title,
      reason: `rewrite selection, ${formatCount(selection.exact.length)} characters with ${formatCount(antecedent.length)} before it`,
    },
  };
}

/** synopsis.fill: the whole document, cut from the bottom to the layer's cap. */
function fullText(input: FocusInput, cap: number): FocusPlan {
  const { node, body } = input;
  const frame = (shown: string): string =>
    [
      HEADING,
      `Document: ${node.title} (full text; ${formatCount(shown.length)} of ${formatCount(body.length)} characters${
        shown.length < body.length ? ', the rest is over the focus budget' : ''
      })`,
      shown === '' ? '(the document is empty)' : shown,
      FOCUS_MARKER,
    ].join('\n\n');

  let shown = body;
  let text = frame(shown);
  while (text.length > cap && shown.length > 0) {
    // Every pass must shorten the text, or this loop never ends. headOf keeps at most the count it
    // is given, so the first cut is shorter already. The fallback cuts the text already shown, which
    // is a prefix of the body and always shorter, so it does not depend on headOf at all.
    const next = headOf(body, Math.max(0, shown.length - (text.length - cap)));
    shown = next.length < shown.length ? next : headOf(shown, shown.length - 1);
    text = frame(shown);
  }
  const notes: string[] = [];
  if (shown.length < body.length) {
    notes.push(`The document is cut at ${formatCount(shown.length)} of ${formatCount(body.length)} characters.`);
  }
  return {
    text,
    notes,
    report: sentReport(node, 'full', shown, body.length),
    surfaces: [{ id: 'focus', text: shown }],
    item: { label: node.title, reason: `full text, ${formatCount(shown.length)} of ${formatCount(body.length)} characters` },
  };
}

export interface ScopePlan {
  readonly block: Block;
  readonly drops: readonly DropRecord[];
  /** The documents whose text is sent, as detection sees them. */
  readonly sent: readonly IndexedDoc[];
  readonly notes: readonly string[];
}

/**
 * continuity.scan's L5: the tail of each scope document, in scope order, at most
 * `SCOPE_DOCUMENT_LIMIT` of them. A document beyond the limit is named in the drops.
 */
export function scopeBlock(state: ProjectState, scope: readonly TreeNode[]): ScopePlan {
  const sent = scope.slice(0, SCOPE_DOCUMENT_LIMIT);
  const drops: DropRecord[] = scope
    .slice(SCOPE_DOCUMENT_LIMIT)
    .map((node) => dropRecord(node.title, { kind: 'scope-limit', limit: SCOPE_DOCUMENT_LIMIT }, 'scope'));

  const items: BlockItem[] = sent.map((node) => {
    const body = getBody(state, node.id);
    const tail = tailOf(body, SCOPE_TAIL_CHARS);
    const extent =
      tail.length === body.length
        ? `all ${formatCount(body.length)} characters`
        : `last ${formatCount(tail.length)} of ${formatCount(body.length)} characters`;
    return {
      ref: { kind: 'doc', id: node.id },
      label: node.title,
      reason: `scope document, ${extent}`,
      body: [`## ${node.title} (${extent})`, tail === '' ? '(the document is empty)' : tail, FOCUS_MARKER].join('\n'),
      protected: false,
      group: 'scope',
    };
  });

  // A truncated scope says so in the prompt itself, not only in the report: the model is told
  // which documents it was not sent (§7, and the preview's trust mechanic in §5).
  const header =
    scope.length > SCOPE_DOCUMENT_LIMIT
      ? `${HEADING}\n\nScope: first ${SCOPE_DOCUMENT_LIMIT} of ${scope.length} documents sent; the rest are not. Each sent document is its last ${formatCount(SCOPE_TAIL_CHARS)} characters, in manuscript order.`
      : `${HEADING}\n\nScope: documents in manuscript order; the last ${formatCount(SCOPE_TAIL_CHARS)} characters of each.`;
  const block = newBlock({
    id: 'L5',
    header,
    empty: '(no documents in scope)',
    cut: '(documents not sent)',
    items,
    display: items.map((_, index) => index),
  });
  const notes =
    scope.length > SCOPE_DOCUMENT_LIMIT
      ? [`The scope holds ${scope.length} documents; the first ${SCOPE_DOCUMENT_LIMIT} are sent. Split the scope to cover the rest.`]
      : [];
  return {
    block,
    drops,
    sent: sent.map((node) => ({
      id: node.id,
      revision: getRevision(state, node.id),
      body: getBody(state, node.id),
    })),
    notes,
  };
}
