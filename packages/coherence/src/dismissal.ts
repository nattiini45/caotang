/**
 * The dismissal picker, as data — [coherence.md §6.3 and §11 D11](../../../docs/architecture/coherence.md).
 *
 * Dismissal is a writer judgment (D5), so the agent cannot reach it. The picker
 * has five reasons and one free-text note. The reasons split into two kinds:
 *
 *  - **technique** (`flashback`, `in-world-lie`, `unreliable-narrator`) declares
 *    a storytelling device. Its dialog cross-links to the scene-mode picker, so a
 *    writer can declare the device as data instead of dismissing it again.
 *  - **judgment** (`intentional`, `false-positive`) means "do not raise this again".
 *
 * The tooltip rule is the spec's: one line each for `in-world-lie` and
 * `unreliable-narrator`, which the dialog shows, and no others. This file holds
 * the copy. The dialog that renders it is the UI's work and is not here.
 */

import { noteLengthProblem } from './text.js';

export const DISMISSAL_REASONS = [
  {
    id: 'flashback',
    label: 'Flashback',
    kind: 'technique',
    modeCrossLink: true,
    /** The one reason with a timeline mode of its own (§5.2.1). */
    declaresMode: 'flashback',
  },
  {
    id: 'in-world-lie',
    label: 'In-world lie',
    kind: 'technique',
    modeCrossLink: true,
    tooltip: 'In-story deception between characters.',
  },
  {
    id: 'unreliable-narrator',
    label: 'Unreliable narrator',
    kind: 'technique',
    modeCrossLink: true,
    tooltip: 'Narration-level deception.',
  },
  { id: 'intentional', label: 'Intentional', kind: 'judgment', modeCrossLink: false },
  { id: 'false-positive', label: 'False positive', kind: 'judgment', modeCrossLink: false },
] as const;

export type DismissalReasonId = (typeof DISMISSAL_REASONS)[number]['id'];

/** The line the dialog shows when a technique reason is picked. Spec wording, quoted from §6.3. */
export const MODE_CROSS_LINK_COPY = 'Declare this as a scene mode instead.';

/** The line a `timeline.gap` finding's dialog adds under any reason: the mode that silences it is a time skip (§5.2.1). */
export const GAP_CROSS_LINK_COPY = 'Declare a time skip on one of these scenes instead.';

/** The check-specific line the dismissal dialog shows for a finding of this check, or `undefined` where there is none. */
export function checkCrossLinkFor(checkId: string): string | undefined {
  return checkId === 'timeline.gap' ? GAP_CROSS_LINK_COPY : undefined;
}

export function isDismissalReason(value: unknown): value is DismissalReasonId {
  return DISMISSAL_REASONS.some((reason) => reason.id === value);
}

export type DismissalCheck = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * A dismissal is valid when its reason is on the picker and its note fits the
 * limit. A free-text reason is refused: the picker is closed so that a dismissal
 * can be counted and explained later.
 */
export function validateDismissal(reason: unknown, note: string | undefined): DismissalCheck {
  if (!isDismissalReason(reason)) {
    const valid = DISMISSAL_REASONS.map((r) => r.id).join(', ');
    return { ok: false, error: `dismissal reason "${String(reason)}" is not on the picker; valid reasons are ${valid}` };
  }
  const problem = noteLengthProblem(note);
  if (problem !== undefined) return { ok: false, error: `the dismissal note is ${problem}` };
  return { ok: true };
}

/** The dialog's tooltip for a reason, or `undefined` where the spec gives none. */
export function tooltipFor(reason: DismissalReasonId): string | undefined {
  const entry = DISMISSAL_REASONS.find((candidate) => candidate.id === reason);
  return entry !== undefined && 'tooltip' in entry ? entry.tooltip : undefined;
}
