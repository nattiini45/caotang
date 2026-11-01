/**
 * The words and the choices of the picture board's storage actions (pictures.md §6.3, §6.4 step 3, §6.6.1): which selected pictures
 * a bulk *Store working copies* is offered for, what a sweep says before and after it runs, and the re-link the board offers when a
 * picture's file was renamed outside the app.
 *
 * Pure and renderer-free, so every sentence and every count is tested without a browser. Nothing here dispatches: the view runs the
 * command, and a refusal is said in the command's own words, unchanged.
 */

import type { CommandError, ExecutionOutcome, Result } from '@caotang/bus';
import { plural, t } from '@lingui/core/macro';
import type { ProjectState, RelinkPair, SweepCandidate } from '@caotang/store';

import { explain } from '../components/actions.js';

import { pictureLabelOf, type PictureEntry } from './picture-board-model.js';

/* lingui-set comment="The picture board's storage actions. count, removed and remaining are numbers; name and title are a picture's caption or a file name; reason and detail are a sentence a command or a browser wrote." */

/** The long edge a working copy is scaled to (pictures.md §6.4 step 3). */
export const WORKING_COPY_LONG_EDGE = 4096;

export interface WorkingCopyChoice {
  /** The selected pictures a working copy would change. */
  readonly ids: readonly string[];
  /** Why the rest of the selection is left out, as one sentence, or `null` when none is. */
  readonly leftOut: string | null;
}

/**
 * The selected pictures *Store working copies* is offered for: a picture whose longest side is over 4096 px, that is not itself a
 * working copy, and whose file is held. The command would copy a smaller picture too, which only makes a second file, so the board
 * does not offer it.
 */
export function workingCopyChoiceOf(entries: readonly PictureEntry[], chosen: ReadonlySet<string>): WorkingCopyChoice {
  const ids: string[] = [];
  let tooSmall = 0;
  let already = 0;
  let missing = 0;
  for (const entry of entries) {
    if (!chosen.has(entry.id)) continue;
    const { width, height, workingCopy } = entry.record;
    if (workingCopy !== undefined) already += 1;
    else if (entry.missing) missing += 1;
    else if (width === undefined || height === undefined || Math.max(width, height) <= WORKING_COPY_LONG_EDGE) tooSmall += 1;
    else ids.push(entry.id);
  }
  const reasons: string[] = [];
  if (tooSmall > 0) reasons.push(t`${plural(tooSmall, { one: '# is not larger than 4096 px.', other: '# are not larger than 4096 px.' })}`);
  if (already > 0) reasons.push(t`${plural(already, { one: '# is already a working copy.', other: '# are already working copies.' })}`);
  if (missing > 0) reasons.push(t`${plural(missing, { one: '# has no file to copy.', other: '# have no file to copy.' })}`);
  return { ids, leftOut: reasons.length === 0 ? null : reasons.join(' ') };
}

/** The action's label with the number of pictures it would change, as the board's other batch actions count. */
export function workingCopyLabel(count: number): string {
  return t({ message: `Store working copies (${{ count }})`, comment: 'The button that stores 4096 px working copies of the selected pictures; the value is how many it would change.' });
}

/** What the confirmation says. The originals stay: the command keeps them for the undo, and only a delete and a sweep remove them. */
export function workingCopyTitle(count: number): string {
  return t`${plural(count, { one: 'Store a 4096 px working copy of this picture?', other: 'Store 4096 px working copies of these # pictures?' })}`;
}

/** The refusal or the success of the bulk working copies, as the board's status line says it. */
export function workingCopyReport(result: Result<ExecutionOutcome, CommandError>, count: number): { readonly text: string; readonly tone: 'info' | 'error' } {
  if (!result.ok) return { text: explain(result.error), tone: 'error' };
  return { text: t`${plural(count, { one: 'Stored # working copy. Undo puts the original back.', other: 'Stored # working copies. Undo puts the originals back.' })}`, tone: 'info' };
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

/** What a sweep's preview comes to, before the writer is asked. */
export type SweepOffer =
  | { readonly kind: 'ready'; readonly candidates: readonly SweepCandidate[] }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'refused'; readonly text: string };

export function sweepOfferOf(preview: { readonly ok: true; readonly candidates: readonly SweepCandidate[] } | { readonly ok: false; readonly reason: string }): SweepOffer {
  if (!preview.ok) {
    return { kind: 'refused', text: t`Unused files cannot be listed safely, so none was removed: ${{ reason: preview.reason }}` };
  }
  return preview.candidates.length === 0 ? { kind: 'nothing' } : { kind: 'ready', candidates: preview.candidates };
}

export function sweepNothingText(): string {
  return t`No unused picture file was found. Every file in the project belongs to a picture or is named by something the project keeps.`;
}

export function sweepTitle(count: number): string {
  return t`${plural(count, { one: 'Remove # unused file?', other: 'Remove # unused files?' })}`;
}

export function exportSweepTitle(count: number): string {
  return t`${plural(count, { one: 'Remove # unused file before exporting?', other: 'Remove # unused files before exporting?' })}`;
}

/** What `asset.sweep` returns: the files it removed and the ones it left. */
export interface SweepResult {
  readonly candidates: number;
  readonly removed: readonly string[];
  readonly remaining: readonly string[];
  readonly interrupted?: string;
}

function sweepResultOf(outcome: ExecutionOutcome): SweepResult {
  const raw = (outcome.result ?? {}) as Partial<SweepResult>;
  return {
    candidates: typeof raw.candidates === 'number' ? raw.candidates : 0,
    removed: Array.isArray(raw.removed) ? raw.removed : [],
    remaining: Array.isArray(raw.remaining) ? raw.remaining : [],
    ...(typeof raw.interrupted === 'string' ? { interrupted: raw.interrupted } : {}),
  };
}

/**
 * What the sweep did, said honestly. A refused sweep removed nothing and is said in the command's own sentence, which names the root
 * that could not be read. A sweep that stopped part-way says how many files are gone and how many are still there.
 */
export function sweepReport(result: Result<ExecutionOutcome, CommandError>): { readonly text: string; readonly tone: 'info' | 'error' } {
  if (!result.ok) return { text: explain(result.error), tone: 'error' };
  const done = sweepResultOf(result.value);
  const removed = done.removed.length;
  const remaining = done.remaining.length;
  if (done.interrupted !== undefined) {
    const detail = done.interrupted;
    return {
      text: t`The sweep stopped early (${{ detail }}). ${plural(removed, { one: '# file was removed', other: '# files were removed' })}, and ${plural(remaining, { one: '# file is still there', other: '# files are still there' })}.`,
      tone: 'error',
    };
  }
  if (removed === 0 && remaining === 0) return { text: sweepNothingText(), tone: 'info' };
  if (remaining > 0) {
    return {
      text: t`${plural(removed, { one: '# unused file was removed', other: '# unused files were removed' })}, and ${plural(remaining, { one: '# file could not be removed and is still there', other: '# files could not be removed and are still there' })}.`,
      tone: 'error',
    };
  }
  return { text: t`${plural(removed, { one: 'Removed # unused file.', other: 'Removed # unused files.' })}`, tone: 'info' };
}

/* ------------------------------------------------------------------ *
 * Re-link
 * ------------------------------------------------------------------ */

export interface RelinkLine {
  readonly key: string;
  /** The picture, by the name the board gives it. */
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

/** One line per renamed picture: what the board calls it, the file it recorded, and the file its bytes were found under. */
export function relinkLinesOf(state: Pick<ProjectState, 'manifest'>, pairs: readonly RelinkPair[]): RelinkLine[] {
  const records = state.manifest.assets ?? [];
  return pairs.map((pair) => {
    const record = records.find((candidate) => candidate.id === pair.assetId);
    return { key: pair.assetId, name: record === undefined ? pair.assetId : pictureLabelOf(record), from: record?.file ?? pair.assetId, to: pair.file };
  });
}

export function relinkLabel(count: number): string {
  return t`${plural(count, { one: 'Re-link # renamed picture', other: 'Re-link # renamed pictures' })}`;
}

export function relinkNotice(count: number): string {
  return t`${plural(count, {
    one: 'A file that belongs to a picture was renamed outside Caotang. Its bytes match a file that no picture uses.',
    other: '# files that belong to pictures were renamed outside Caotang. Their bytes match files that no picture uses.',
  })}`;
}

export function relinkReport(result: Result<ExecutionOutcome, CommandError>): { readonly text: string; readonly tone: 'info' | 'error' } {
  if (!result.ok) return { text: explain(result.error), tone: 'error' };
  const raw = (result.value.result ?? {}) as { pairs?: unknown };
  const count = Array.isArray(raw.pairs) ? raw.pairs.length : 0;
  return { text: t`${plural(count, { one: 'Re-linked # renamed picture. Undo points it back at the old name.', other: 'Re-linked # renamed pictures. Undo points them back at the old names.' })}`, tone: 'info' };
}
