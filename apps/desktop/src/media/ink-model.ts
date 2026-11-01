/**
 * The Ink source editor's rules, as plain functions (dialogue-narrative.md §2.2, §3, §6). The view calls them on the
 * save cadence and the idle cadence, and the unit spec calls them without a browser: nothing here touches the store,
 * the session or the DOM.
 *
 * Two rules live here. A save mints a line id for each line that has none, but only when the container's `autoLineIds`
 * is on: the spec makes it opt-in per container (§2.2). And the "Add line ids" action mints the same ids on demand, and
 * the view asks the writer to confirm it first, because it changes the text they can see.
 */

import { isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { AUTOSAVE_DEBOUNCE_MS } from '@caotang/store';

import { ensureLineIds, missingLineIds, type ImportIdResult, type MintOptions, type UnplaceableLine } from './engines.js';


/* lingui-set comment="Sentences about Ink line ids. Interpolated values: title and titles are container titles the writer wrote; line, minted and the other counts are numbers; lines, where, first and shown are lists of line positions or ids; room is the reason a line could not take an id; rest counts the ids not shown." */
/**
 * How long the writer must stop typing before the findings are read again. It is the autosave's own window (editor-engine
 * §9), so the graph and the save move on the same beat, and a change to the window moves this with it.
 */
export const INK_IDLE_MS = AUTOSAVE_DEBOUNCE_MS;

export interface InkMintResult {
  /** The text to keep. Equal to the input when nothing was minted. */
  readonly text: string;
  /** How many ids this call wrote into the text. */
  readonly minted: number;
  /** Lines that need an id and cannot take one without changing what they say. The writer moves the divert (§2.2). */
  readonly unplaceable: readonly UnplaceableLine[];
}

/** The number of lines in the text that carry no id yet. Reads the parse, and mints nothing, so a render may call it. */
export function linesMissingIds(text: string): number {
  return missingLineIds(text).length;
}

/**
 * The text a save writes. With `autoLineIds` off it is the writer's text, unchanged. With it on, every line that can
 * take an id gets one, and the ids already in the text are kept (ids are stable per line, §2.2).
 */
export function textOnSave(text: string, autoLineIds: boolean, options: MintOptions = {}): InkMintResult {
  if (!autoLineIds) return { text, minted: 0, unplaceable: [] };
  const result = ensureLineIds(text, options);
  return { text: result.body, minted: result.minted.length, unplaceable: result.unplaceable };
}

/**
 * The confirmed "Add line ids" action: the same minting as a save, for a container that is not opted in. The result is
 * the new text, and the sentence the writer reads after it, which names any line that could not take an id.
 */
export function addLineIds(text: string, options: MintOptions = {}): InkMintResult {
  const result = ensureLineIds(text, options);
  return { text: result.body, minted: result.minted.length, unplaceable: result.unplaceable };
}

const IDS_SHOWN = 3;

function roomForId(): string {
  return t`move the choice or jump so the line has room for its id.`;
}

function lineNumber(line: number): string {
  return t`line ${line}`;
}

function titledLine(title: string, line: number): string {
  return t`${{ title: isolate(title) }} line ${line}`;
}

/** The sentence the writer reads after the action. It says what was written, and which lines still need the writer. */
export function addLineIdsSentence(result: InkMintResult): string {
  const minted = result.minted;
  const written = minted === 0 ? t`No line needed an id.` : plural(minted, { one: 'Added # line id to the Ink text.', other: 'Added # line ids to the Ink text.' });
  if (result.unplaceable.length === 0) return written;
  const unplaceable = result.unplaceable.length;
  const lines = result.unplaceable.map((line) => lineNumber(line.line)).join(', ');
  const room = roomForId();
  const could = plural(unplaceable, {
    one: `# line (${lines}) could not take one: ${room}`,
    other: `# lines (${lines}) could not take one: ${room}`,
  });
  return `${written} ${could}`;
}

/**
 * The sentence the writer reads after an import that minted ids (§4). It says the mint was once, that the container's
 * "Add line ids on save" setting was not touched, which lines could not take an id and in which container, and which ids
 * the source already used twice (kept, never renamed).
 */
export function importLineIdsSentence(result: ImportIdResult): string {
  const minted = result.minted;
  const parts = [
    minted === 0
      ? t`No line needed an id.`
      : plural(minted, {
          one: 'Added # line id to the imported containers, once. "Add line ids on save" was left as it was.',
          other: 'Added # line ids to the imported containers, once. "Add line ids on save" was left as it was.',
        }),
  ];
  if (result.unplaceable.length > 0) {
    const unplaceable = result.unplaceable.length;
    const where = result.unplaceable.map((line) => titledLine(line.title, line.line)).join(', ');
    const room = roomForId();
    parts.push(
      plural(unplaceable, {
        one: `# line (${where}) could not take one: ${room}`,
        other: `# lines (${where}) could not take one: ${room}`,
      }),
    );
  }
  if (result.kept.length > 0) {
    const titles = result.kept.map((title) => `"${isolate(title)}"`).join(', ');
    parts.push(t`${titles} kept the Ink as written, because the ids would have stopped it compiling.`);
  }
  if (result.duplicatesInSource.length > 0) {
    const duplicates = result.duplicatesInSource.length;
    const rest = duplicates - IDS_SHOWN;
    const first = result.duplicatesInSource.slice(0, IDS_SHOWN).join(', ');
    const shown = duplicates > IDS_SHOWN ? t`${first} and ${rest} more` : first;
    parts.push(
      plural(duplicates, {
        one: `# id (${shown}) already appear more than once in the source and were kept as written: the export refuses duplicates, so change them in the Ink.`,
        other: `# ids (${shown}) already appear more than once in the source and were kept as written: the export refuses duplicates, so change them in the Ink.`,
      }),
    );
  }
  return parts.join(' ');
}

/**
 * The sentence the confirm step shows before the ids are written. It says what the write does and to how many lines, and
 * the verb agrees with the count: one line has none, three lines have none.
 */
export function confirmLineIdsSentence(missing: number): string {
  return plural(missing, {
    one: 'This writes an id tag into # line that has none. The ids stay with their lines when the text around them changes.',
    other: 'This writes an id tag into # lines that have none. The ids stay with their lines when the text around them changes.',
  });
}

/** "Add 3 line ids" and "Add 1 line id", for the confirm button. */
export function addLineIdsLabel(count: number): string {
  return plural(count, { one: 'Add # line id', other: 'Add # line ids' });
}
