/**
 * Placing and gating a drafted Ink block — [dialogue-narrative.md §7, tool 22](../../../docs/architecture/dialogue-narrative.md).
 *
 * The model drafts Ink text (the loop's job); this module decides where that text goes in the
 * container and whether the result may be shown for approval. A new beat (a knot or a stitch) goes
 * after the whole section of the beat it follows, or at the end of the body. Text that declares no
 * beat has no place of its own: it can be placed only in an empty container, where it is the
 * story's opening flow. After a beat it would sit inside that beat's flow, where a playthrough does
 * not reliably reach it, so it is refused. The candidate body is compile-checked before the card
 * exists: a compile error blocks it outright, and a warning the base body did not already have is
 * shown and must be approved explicitly.
 */

import { compileInk, type InkMessage } from './compile.js';
import { beatIds, findNode, parseInk } from './ink-parse.js';

export type DraftMode = 'empty' | 'after-beat' | 'append';

export interface DraftPlan {
  /** The candidate body, the one the card shows and the one a write would store. */
  readonly body: string;
  readonly mode: DraftMode;
  /** The offset the draft was inserted at, in the base body. */
  readonly insertedAt: number;
  /** The beat the draft continues from, when there was one. */
  readonly anchor: string | null;
  /** The knot and stitch ids the draft itself declares. */
  readonly newBeats: readonly string[];
}

export type PlanResult =
  | { readonly ok: true; readonly plan: DraftPlan }
  | {
      readonly ok: false;
      readonly code: 'unknown-beats' | 'no-beat';
      /** What is wrong, in one sentence. */
      readonly message: string;
      /** The next step the model should take. */
      readonly correctiveHint: string;
      readonly beats: readonly string[];
    };

/** Places the draft. Pure: no compile, no write. Unknown beat ids are refused with the list that exists. */
export function planDraft(body: string, ink: string, fromBeats: readonly string[] = []): PlanResult {
  const parsed = parseInk(body);
  const beats = beatIds(parsed.graph);
  const unknown = fromBeats.filter((id) => !beats.includes(id));
  if (unknown.length > 0) {
    const known = beats.length > 0 ? beats.join(', ') : 'none: the container has no knots yet';
    return {
      ok: false,
      code: 'unknown-beats',
      message: `no beat is called ${unknown.map((id) => `"${id}"`).join(', ')}.`,
      correctiveHint: `the knots and stitches in this container are: ${known}. Name one of them in fromBeats, or omit fromBeats to append.`,
      beats,
    };
  }
  const draft = `${ink.trim()}\n`;
  const newBeats = beatIds(parseInk(draft).graph);
  const anchor = fromBeats[fromBeats.length - 1];

  if (body.trim() === '') {
    return { ok: true, plan: { body: draft, mode: 'empty', insertedAt: 0, anchor: null, newBeats } };
  }

  if (newBeats.length === 0) {
    const sitting = anchor === undefined ? 'at the end of the body, inside the flow of its last beat' : `inside the flow of "${anchor}"`;
    return {
      ok: false,
      code: 'no-beat',
      message: `the draft declares no knot or stitch, so its text would sit ${sitting}, where a playthrough does not reliably reach it.`,
      correctiveHint: `declare the new text as a knot (=== name ===) and divert to it from a beat that plays. A knot draft goes ${anchor === undefined ? 'at the end of the body' : `after "${anchor}" when you name it in fromBeats`}.`,
      beats,
    };
  }

  if (anchor !== undefined) {
    const node = findNode(parsed.graph, anchor);
    if (node !== undefined) {
      // A new beat goes after the whole section of the anchor's top-level knot. A header inserted
      // inside that section would take the stitches that follow it under the new beat, and a stitch
      // header placed at the section's end becomes one more stitch of the same knot.
      const knot = node.kind === 'knot' ? node : parsed.graph.nodes.find((n) => n.kind === 'knot' && n.id === node.knot);
      const at = knot?.subtreeTo ?? node.to;
      const before = body.slice(0, at);
      const after = body.slice(at);
      const left = before.endsWith('\n') ? before : `${before}\n`;
      const gap = left.endsWith('\n\n') ? '' : '\n';
      const tail = after.length > 0 ? `\n${after}` : '';
      return { ok: true, plan: { body: `${left}${gap}${draft}${tail}`, mode: 'after-beat', insertedAt: at, anchor, newBeats } };
    }
  }

  const at = body.trimEnd().length;
  return { ok: true, plan: { body: `${body.slice(0, at)}\n\n${draft}`, mode: 'append', insertedAt: at, anchor: null, newBeats } };
}

export interface DraftCheck {
  /** True only when the base and the candidate both compile. Warnings never make it false. */
  readonly ok: boolean;
  /** The candidate's compile errors, verbatim. Any one blocks the card. */
  readonly errors: readonly InkMessage[];
  /** The base body's compile errors, verbatim. When present the draft is not charged with them: it is refused for a broken base. */
  readonly baseErrors: readonly InkMessage[];
  /** Warnings in the candidate that the base body did not have: shown, and approved explicitly. */
  readonly newWarnings: readonly string[];
  /** Warnings that were already in the base body. Shown for context, never blocking. */
  readonly existingWarnings: readonly string[];
}

/**
 * Compile-checks a planned candidate against its base. The base is compiled too, so a
 * container that already fails is reported as such, and the draft is not blamed for it.
 */
export function checkDraft(base: string, candidate: string): DraftCheck {
  const before = compileInk(base);
  const after = compileInk(candidate);
  const baseWarnings = new Set(before.warnings.map((w) => w.text));
  return {
    ok: before.ok && after.ok,
    errors: after.errors,
    baseErrors: before.errors,
    newWarnings: after.warnings.filter((w) => !baseWarnings.has(w.text)).map((w) => w.text),
    existingWarnings: after.warnings.filter((w) => baseWarnings.has(w.text)).map((w) => w.text),
  };
}
