/**
 * The dialogue coverage picker's model (storyboard.md §3.2): which script a shot covers, captured as a `TextAnchor` from text the
 * writer selected in that script, and the `shot.setMeta` that records it. Nothing here applies anything.
 *
 * The anchor is captured fresh, against the stored body as it stands when the writer covers the text (edit-anchors.md §2), and
 * never stored as the raw offsets of a view. A selection the body cannot place exactly is refused, rather than guessed at.
 */

import { t } from '@lingui/core/macro';
import { getBody, getRevision, nodeById, type ProjectState, type TreeNode } from '@caotang/store';

import {
  captureTextAnchor,
  isShotNode,
  locateQuote,
  readShotMeta,
  shotFieldOf,
  storedValueOf,
  type DialogueCoverage,
  type ShotCommand,
  type StoryboardResult,
  type TextAnchor,
} from './engines.js';


/* lingui-set comment="Shot coverage refusals. Interpolated values: shotId is a shot's id; places is a count." */
/** A document the picker can cover text in: a screenplay scene, or a prose document. */
export interface ScriptChoice {
  readonly id: string;
  readonly title: string;
  readonly kind: 'screenplay' | 'prose';
}

/** The documents a shot can cover, in the binder's tree order. A dialogue container is not a script the picker offers. */
export function scriptChoicesOf(state: ProjectState): ScriptChoice[] {
  return state.manifest.tree.flatMap((node: TreeNode): ScriptChoice[] => {
    if (node.type !== 'document') return [];
    if (node.kind === 'screenplay') return [{ id: node.id, title: node.title, kind: 'screenplay' }];
    if (node.kind === undefined) return [{ id: node.id, title: node.title, kind: 'prose' }];
    return [];
  });
}

/** The text the writer selected in the picker, with where it sits in the text the picker shows. */
export interface SelectedText {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

type Captured = { readonly ok: true; readonly anchor: TextAnchor } | { readonly ok: false; readonly message: string };

/**
 * The anchor for the writer's selection in one document, captured against the stored body now. The selected words are located
 * in the stored text whatever its line endings, and only a single place is accepted: a passage that appears twice is refused,
 * with how many places, since no one range is the one meant. A text area holds line feeds only, so the search runs with every
 * line ending on both sides read as one line feed, and the range found is mapped back to the stored body, which is what the
 * anchor addresses (a stored CRLF inside the passage stays in the anchor's `exact`).
 */
export function captureSelection(state: ProjectState, docId: string, selected: SelectedText): Captured {
  const node = nodeById(state, docId);
  if (node === undefined || node.type !== 'document') return { ok: false, message: t`that document is no longer in the project` };
  if (selected.text.trim() === '') return { ok: false, message: t`select the words the shot covers in the text above, then cover them` };
  const body = getBody(state, docId);
  const revision = getRevision(state, docId);
  const lines = lineFeedsOf(body);
  const located = locateQuote(lines.text, selected.text.replace(/\r\n?/g, '\n'));
  if (located.status === 'many') {
    const places = located.count;
    return { ok: false, message: t`that text appears more than once in the document (${places} places); select a longer passage` };
  }
  if (located.status === 'none') return { ok: false, message: t`the selected text could not be found in the stored text, so select it again` };
  return anchorOf(body, lines.starts[located.from] ?? body.length, lines.ends[located.to - 1] ?? body.length, revision);
}

/** The body with each CRLF and lone CR read as one LF, and where each character of that text begins and ends in the body. */
function lineFeedsOf(body: string): { readonly text: string; readonly starts: readonly number[]; readonly ends: readonly number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  let text = '';
  for (let at = 0; at < body.length; ) {
    const char = body.charAt(at);
    const width = char === '\r' && body.charAt(at + 1) === '\n' ? 2 : 1;
    text += char === '\r' ? '\n' : char;
    starts.push(at);
    ends.push(at + width);
    at += width;
  }
  return { text, starts, ends };
}

function anchorOf(body: string, from: number, to: number, revision: number): Captured {
  const anchor = captureTextAnchor(body, from, to, revision);
  if (anchor === undefined) return { ok: false, message: t`the selection is longer than the 2000 characters a coverage can hold, so cover a shorter passage` };
  return { ok: true, anchor };
}

/** The coverage a shot holds, read back into the words the picker lists: the document, the covered text, and its index. */
export interface CoverageRow {
  readonly index: number;
  readonly docId: string;
  readonly title: string;
  readonly text: string;
}

export function coverageRowsOf(state: ProjectState, shotId: string): CoverageRow[] {
  const node = nodeById(state, shotId);
  if (node === undefined || !isShotNode(node)) return [];
  const entries = readShotMeta(shotFieldOf(node)).meta.dialogue ?? [];
  return entries.map((entry: DialogueCoverage, index) => ({
    index,
    docId: entry.docId,
    title: nodeById(state, entry.docId)?.title ?? t`A document that is no longer in the project`,
    text: entry.anchor.exact,
  }));
}

/** The `shot.setMeta` that adds one coverage to a shot, after the coverage it already holds. */
export function coverCommand(state: ProjectState, shotId: string, docId: string, anchor: TextAnchor): StoryboardResult<ShotCommand> {
  return rewriteCoverage(state, shotId, (current) => [...current, { kind: 'fountain-element', docId, anchor }]);
}

/** The `shot.setMeta` that removes one coverage from a shot, by its position in the list. */
export function uncoverCommand(state: ProjectState, shotId: string, index: number): StoryboardResult<ShotCommand> {
  return rewriteCoverage(state, shotId, (current) => current.filter((_, at) => at !== index));
}

function rewriteCoverage(
  state: ProjectState,
  shotId: string,
  next: (current: readonly DialogueCoverage[]) => readonly DialogueCoverage[],
): StoryboardResult<ShotCommand> {
  const node = nodeById(state, shotId);
  if (node === undefined || !isShotNode(node)) return { ok: false, refusal: { code: 'not-a-shot', message: t`no shot "${shotId}" to cover` } };
  const raw = shotFieldOf(node);
  const base: Record<string, unknown> = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const current = readShotMeta(raw).meta.dialogue ?? [];
  base.dialogue = next(current);
  const stored = storedValueOf(readShotMeta(base));
  const empty = stored === null || typeof stored !== 'object' || Object.keys(stored).length === 0;
  return {
    ok: true,
    value: {
      name: 'shot.setMeta',
      params: { nodeId: shotId, stored: empty ? null : (stored as Readonly<Record<string, unknown>>), expect: raw === undefined ? null : raw },
    },
  };
}
