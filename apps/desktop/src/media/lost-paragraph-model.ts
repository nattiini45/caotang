/**
 * The pictures that lost their paragraph (pictures.md §2.3, §5): a placement whose paragraph was deleted keeps its `orphaned` mark, is
 * listed, and is never dropped. *Make document-level* is the writer's way to keep such a picture on its document without the
 * paragraph: it becomes an ordinary placement on the binder item.
 *
 * Pure and renderer-free. Nothing here dispatches: the view runs the commands, and a refusal is said in the command's own words.
 */

import type { AssetLink, ReadAssetLink } from '@caotang/pictures';
import { t } from '@lingui/core/macro';

/* lingui-set comment="Lost paragraph placements. name is a picture's caption or file name, the writer's own text." */

type AnyLink = AssetLink | ReadAssetLink;

type ParagraphTarget = { readonly kind?: unknown; readonly nodeId?: unknown; readonly orphaned?: unknown; readonly anchor?: { readonly exact?: unknown } };

function paragraphOf(link: AnyLink): ParagraphTarget | null {
  const target = link.target as ParagraphTarget;
  return target.kind === 'paragraph' && typeof target.nodeId === 'string' ? target : null;
}

export interface LostParagraph {
  readonly linkId: string;
  readonly assetId: string;
  readonly nodeId: string;
  /** The words of the paragraph as they were captured, or `null` when the capture holds none. */
  readonly quote: string | null;
  readonly note: string | null;
}

/** The placements on one binder item whose paragraph is gone, in the order the project keeps them. */
export function lostParagraphsOf(links: readonly AnyLink[], nodeId: string): LostParagraph[] {
  const lost: LostParagraph[] = [];
  for (const link of links) {
    const target = paragraphOf(link);
    if (target === null || target.nodeId !== nodeId || target.orphaned !== true) continue;
    const exact = target.anchor?.exact;
    lost.push({
      linkId: link.id,
      assetId: link.assetId,
      nodeId,
      quote: typeof exact === 'string' && exact !== '' ? exact : null,
      note: typeof link.note === 'string' && link.note !== '' ? link.note : null,
    });
  }
  return lost;
}

export type DocumentLevelPlan =
  /** Place the picture on the binder item with the same role and note, then take the lost paragraph placement off. */
  | { readonly kind: 'move'; readonly assetId: string; readonly nodeId: string; readonly role: 'reference' | 'source'; readonly note: string | null }
  /** The item already holds this picture as a placement of its own, so the lost one only has to go. */
  | { readonly kind: 'merge'; readonly assetId: string; readonly nodeId: string }
  | { readonly kind: 'refused'; readonly text: string };

/**
 * What *Make document-level* does for one placement. Only a placement that has lost its paragraph is offered it: a placement whose
 * paragraph is still there is the writer's to keep, move or take off, and a `moved` placement waits for its confirmation.
 */
export function documentLevelPlanOf(links: readonly AnyLink[], linkId: string): DocumentLevelPlan {
  const link = links.find((candidate) => candidate.id === linkId);
  if (link === undefined) return { kind: 'refused', text: t`That placement is no longer in the project, so nothing was changed.` };
  const target = paragraphOf(link);
  if (target === null || target.orphaned !== true) {
    return { kind: 'refused', text: t`That picture has not lost its paragraph, so nothing was changed.` };
  }
  const nodeId = target.nodeId as string;
  const twin = links.find((candidate) => candidate.id !== link.id && candidate.assetId === link.assetId && candidate.target.kind === 'node' && (candidate.target as { nodeId?: unknown }).nodeId === nodeId);
  if (twin !== undefined) return { kind: 'merge', assetId: link.assetId, nodeId };
  // A paragraph placement is a plain reference or the page a transcription was read from; a card belongs to a binder item, so it is neither.
  const role = link.role === 'source' ? 'source' : 'reference';
  return { kind: 'move', assetId: link.assetId, nodeId, role, note: typeof link.note === 'string' && link.note !== '' ? link.note : null };
}

/** The selection the editor published (editor-selection.ts), as *Re-pin* and *Attach to this paragraph* read it. */
export interface RepinCaret {
  readonly docId: string;
  readonly from: number;
  readonly to: number;
  readonly dirty: boolean;
}

/**
 * Why a re-pin cannot use the editor's selection right now, in the words the Inspector shows beside the button, or `null` when it can.
 * The rules are *Attach to this paragraph*'s (`canAttachToParagraph`): the editor shows this document, a range is selected rather than
 * a bare caret, and the store holds the text the selection is in, because the anchor is captured against the stored body.
 */
export function repinBlockedText(caret: RepinCaret | null, node: { readonly id: string; readonly type: string }): string | null {
  if (caret !== null && caret.docId === node.id && node.type === 'document' && caret.from !== caret.to && !caret.dirty) return null;
  if (caret !== null && caret.docId === node.id && caret.dirty) return t`Re-pinning waits for the text to be saved.`;
  return t`Select text in the paragraph you want, in this document, to re-pin a picture to it.`;
}

export type RepinPlan =
  | { readonly kind: 'repin'; readonly linkId: string; readonly selection: { readonly from: number; readonly to: number } }
  | { readonly kind: 'refused'; readonly text: string };

/**
 * What *Re-pin* does for one placement: the `asset.repin` the selection makes, or the sentence that says why not. Nothing is
 * changed in either case; the command is the only thing that clears `orphaned` and `moved`.
 */
export function repinPlanOf(links: readonly AnyLink[], linkId: string, caret: RepinCaret | null, node: { readonly id: string; readonly type: string }): RepinPlan {
  const link = links.find((candidate) => candidate.id === linkId);
  if (link === undefined) return { kind: 'refused', text: t`That placement is no longer in the project, so nothing was changed.` };
  const target = paragraphOf(link);
  if (target === null || (target.orphaned !== true && (target as { moved?: unknown }).moved !== true)) {
    return { kind: 'refused', text: t`That picture has not lost its paragraph, so nothing was changed.` };
  }
  if (target.nodeId !== node.id) return { kind: 'refused', text: t`That placement belongs to another document, so nothing was changed.` };
  const blocked = repinBlockedText(caret, node);
  if (blocked !== null || caret === null) return { kind: 'refused', text: blocked ?? '' };
  return { kind: 'repin', linkId, selection: { from: caret.from, to: caret.to } };
}

export function repinDone(name: string): string {
  return t`${{ name }} is now pinned to the paragraph you selected. Undo puts it back as it was.`;
}

/** What the writer is told when the single compound command has landed. */
export function documentLevelDone(plan: DocumentLevelPlan, name: string): string {
  if (plan.kind === 'merge') return t`${{ name }} was already placed on this item, so its lost paragraph placement was taken off. Undo puts it back.`;
  return t`${{ name }} is now placed on the whole item. Undo puts it back under its paragraph.`;
}
