/**
 * The screenplay view's model: pure over the Fountain body, so the view and the tests read the same thing.
 *
 * The body is the source of truth (screenplay.md §3). Everything here is derived from it on each read: the
 * units the formatted view draws, the scene list the navigator jumps through, the page count the paginator
 * gives, and the cue checks the coherence module would raise. Nothing here is stored, and nothing writes the body.
 */

import { t } from '@lingui/core/macro';
import type { AutosaveStatus, FlushReport } from '@caotang/store';

import {
  characterCueNames,
  cueSpellingGroups,
  estimatePageCount,
  estimateRuntimeMinutes,
  parseFountain,
  printedText,
  type CueSpellingGroup,
  type LocatedElement,
  type SceneSpan,
} from './engines.js';

/** One character's block: the cue, then the parentheticals and dialogue under it. */
export interface DialogueBlock {
  readonly cue: LocatedElement;
  readonly lines: readonly LocatedElement[];
}

/** One thing the formatted view draws, in source order. A dual pair is two blocks side by side (screenplay.md §3). */
export type ScreenplayUnit =
  | { readonly kind: 'element'; readonly element: LocatedElement }
  | { readonly kind: 'block'; readonly block: DialogueBlock }
  | { readonly kind: 'dual'; readonly left: DialogueBlock; readonly right: DialogueBlock };

export interface ScreenplayReadout {
  readonly pages: number;
  /** One minute of screen time per page. An estimate, never a timing (paginate.ts). */
  readonly minutes: number;
  readonly scenes: number;
  /** Distinct character names cued in the scene. */
  readonly characters: number;
}

export interface ScreenplayModel {
  readonly units: readonly ScreenplayUnit[];
  readonly scenes: readonly SceneSpan[];
  readonly cues: readonly string[];
  readonly spellingGroups: readonly CueSpellingGroup[];
  readonly titlePage: Readonly<Record<string, string>> | null;
  /** What the lenient reader could not close, in order. Empty for well-formed input. */
  readonly notices: readonly string[];
  readonly readout: ScreenplayReadout;
}

/**
 * Elements that never draw. A note and a boneyard are annotations, which the parser makes transparent: they do not
 * end a block. A synopsis is consumed on import, and a title page is shown above the script, not in it.
 */
const SILENT: ReadonlySet<string> = new Set(['note', 'boneyard', 'synopsis', 'title_page']);

interface PendingBlock {
  readonly cue: LocatedElement;
  readonly lines: LocatedElement[];
}

/** The screenplay model of one Fountain body. Pure: the same source always gives the same model. */
export function screenplayModelOf(source: string): ScreenplayModel {
  const parsed = parseFountain(source);
  const units: ScreenplayUnit[] = [];
  // The block a parenthetical or a line of dialogue joins. Any other element closes it.
  let open: PendingBlock | null = null;

  for (const element of parsed.elements) {
    if (SILENT.has(element.type)) continue;

    if (element.type === 'character') {
      const pending: PendingBlock = { cue: element, lines: [] };
      const last = units[units.length - 1];
      // A dual cue (`NAME ^`) pairs with the block just before it, and both draw side by side.
      if (element.dual === true && open !== null && last !== undefined && last.kind === 'block' && last.block.cue === open.cue) {
        units[units.length - 1] = { kind: 'dual', left: open, right: pending };
      } else {
        units.push({ kind: 'block', block: pending });
      }
      open = pending;
      continue;
    }

    if ((element.type === 'parenthetical' || element.type === 'dialogue') && open !== null) {
      open.lines.push(element);
      continue;
    }

    open = null;
    units.push({ kind: 'element', element });
  }

  const cues = characterCueNames(parsed.elements);
  const pages = estimatePageCount(parsed.elements);
  return {
    units,
    scenes: parsed.scenes,
    cues,
    spellingGroups: cueSpellingGroups(parsed.elements),
    titlePage: parsed.titlePage,
    notices: parsed.notices,
    readout: {
      pages,
      minutes: estimateRuntimeMinutes(pages),
      scenes: parsed.scenes.length,
      characters: cues.length,
    },
  };
}

/**
 * The text an element prints: notes and boneyards removed, the forcing character already stripped by the parser.
 * A page break and a title page carry no text, so they print as nothing.
 */
export function printedOf(element: LocatedElement): string {
  return 'text' in element ? printedText(element.text) : '';
}

/** The offset a scene navigator jumps to: the start of the scene heading, or `null` when there is no such scene. */
export function sceneOffset(model: ScreenplayModel, index: number): number | null {
  return model.scenes[index]?.range.from ?? null;
}

/**
 * The save line the footer shows for one document. It is the prose editor's footer line (EditorPane), word for word, so a
 * scene and a prose document say the same thing about whether their words are stored.
 */
export function saveLineOf(status: AutosaveStatus): string {
  if (status.lastError !== null) return t`Not saved yet. Your words are in this tab; they will be written again on the next change.`;
  return status.dirty ? t`Saving…` : 'Saved';
}

/**
 * The status line's words when a flush the view started on leaving did not write. `null` when every report saved, found
 * nothing to save, or joined a write that was already running.
 */
export function unwrittenFlushOf(reports: readonly FlushReport[]): string | null {
  const unwritten = reports.some((report) => report.outcome === 'failed' || report.outcome === 'conflict');
  return unwritten ? t`The scene did not save when its view closed. Your words are in this tab; they will be written again on the next change.` : null;
}
