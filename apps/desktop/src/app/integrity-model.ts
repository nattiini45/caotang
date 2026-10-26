/**
 * The decisions the data-safety paths make, as pure functions of what they are told. The editor, the folder save and the
 * demo run call these, and the model tests read them without a browser, so each rule is pinned where it is decided.
 */
/* lingui-set comment="Interpolated values: fieldCount, fields, name, times, unsaid" */

import { plural, t } from '@lingui/core/macro';
import { isolate, listFormat, type MessageRef } from '@caotang/i18n';

import { formatterLocale } from '../i18n/format-locale.js';
import { renderRef, titleValues } from '../i18n/render-ref.js';
import type { SaveState, WrittenBody } from './session.js';

/**
 * Why this tab's session stopped saving (persistence.ts): another tab stored newer text for the project (`newer-text`), or another tab
 * upgraded Caotang's browser storage, which this tab must reload to use again (`updated`). The stopped-tab notice (StaleTabNotice.tsx)
 * and the save indicator (`saveStateWords`) say which, and the cause is read from here, so neither needs the session.
 *
 * It is page state, as the browser's storage is: one page holds one tab, so one stop is current at a time. It is the one piece of state
 * in this module, kept beside the words that read it.
 */
export type StopCause = 'newer-text' | 'updated';

let cause: StopCause = 'newer-text';
const causeListeners = new Set<() => void>();

/** Records why the session stopped. Listeners are told only when the cause changes. */
export function noteStopCause(next: StopCause): void {
  if (next === cause) return;
  cause = next;
  for (const listener of causeListeners) listener();
}

/** The cause the current stop has, or `newer-text` when nothing has stopped. */
export function stopCause(): StopCause {
  return cause;
}

/** Calls `listener` when the cause changes, for a component that reads it with `useSyncExternalStore`. */
export function subscribeStopCause(listener: () => void): () => void {
  causeListeners.add(listener);
  return () => {
    causeListeners.delete(listener);
  };
}

/**
 * The save indicator's words for each save state (ui-modules §5.3, rule 4). A failure says what is safe right now and the one thing
 * to do about it: the words are in this tab and are written again on the next change, and a backup is the copy that does not depend
 * on the browser. `offersBackup` says whether the indicator carries the Export a backup button. A stop says why (`cause`, `StopCause`):
 * a newer text in another tab, or an upgrade of the browser storage that this tab must reload to use.
 */
export function saveStateWords(
  state: SaveState,
  cause: StopCause = stopCause(),
): { readonly text: string; readonly offersBackup: boolean } {
  if (state === 'saved') return { text: t`All changes saved in this browser`, offersBackup: false };
  if (state === 'saving') return { text: t`Saving…`, offersBackup: false };
  if (state === 'conflict' && cause === 'updated') {
    return { text: t`Caotang was updated in another tab, so this tab cannot save. Export a backup, then reload this tab.`, offersBackup: false };
  }
  if (state === 'conflict') return { text: t`Another tab has newer text`, offersBackup: false };
  return {
    text: t`Not saved to browser storage yet. Your words are safe in this tab and are written again on the next change.`,
    offersBackup: true,
  };
}

/**
 * Whether a store change to a document is this session's own last write, so the editor only needs to learn the revision.
 *
 * Both the revision and the body must match. A revision alone is not enough: a later change (an agent apply) can arrive at
 * the revision of an earlier own write over different text if the revision is ever reused, and matching on the revision
 * alone would leave the editor showing the text an undo removed. The store's revision only rises (an undo is a write too),
 * so this check is a second guard, not the first.
 */
export function isOwnWrite(own: WrittenBody | null, stored: string, revision: number): boolean {
  return own !== null && own.revision === revision && own.body === stored;
}

/** The lock file the Caotang MCP server holds in a project folder while it runs (packages/mcp-server/src/lock.ts). */
export const MCP_LOCK_FILE = '.caotang-mcp.lock';

/** What a save to a project folder should do, given what the folder holds now (project-format §4, mcp-server README). */
export type FolderSaveVerdict =
  /** Nothing stands in the way: write the folder. */
  | 'write'
  /** The MCP server holds the folder, and the writer has not said to save while it does. */
  | 'locked'
  /** The folder's `caotang.json` is not the text this session last loaded or saved: another program changed it, or removed it. */
  | 'changed'
  /** The folder holds a project this session never loaded or saved, and the writer has not said to replace it. */
  | 'unknown'
  /**
   * The folder holds an earlier save of this same project (its `caotang.json` names this project's id), and this browser has no record of
   * what the folder held then, so it cannot tell which files changed since: the writer is asked before this tab's version is written over it.
   */
  | 'earlier'
  /** A document or codex file in the folder changed, was removed or was added since this session last loaded or saved it. */
  | 'files';

export interface FolderSaveFacts {
  /** The folder's `caotang.json` text now, or `null` when the folder has none. */
  readonly onDisk: string | null;
  /** The `caotang.json` text this session last loaded from, or saved to, the folder; `null` when it never has. */
  readonly baseline: string | null;
  /** Whether `.caotang-mcp.lock` is in the folder. */
  readonly locked: boolean;
  /** The writer has said to save although the folder is locked. */
  readonly lockConfirmed: boolean;
  /** The writer has said to replace a manifest that changed, or that this session never saw, or a document another program changed. */
  readonly overwriteConfirmed: boolean;
  /** Whether a document or codex file of the folder differs from what this session last held (lifecycle `folderChanges` and `saveFolder`). */
  readonly filesChanged: boolean;
  /** Whether the folder's `caotang.json` names this session's own project (`folderProjectRoute` `own`). A folder that does is never "another project". */
  readonly sameProject?: boolean;
}

/**
 * The verdict for one save. The lock is checked first, because a locked folder is a different question from a changed one.
 * A folder with no manifest is written only when this session never held one there: a manifest this session did hold, and that another
 * program removed since, is a change (`changed`), so it is asked about rather than recreated. Otherwise the folder must hold the
 * text this session last saw, and then the document and codex files it held, or the writer must have said to replace them. The replaced
 * manifest is kept as a backup by the writer (write.ts rotates it), and a replaced document or codex file is copied to `.caotang-backup` first
 * (folder-guard.ts), so a confirmed replacement is recoverable; the question asked about one says where the copy is (lifecycle `folderChanges`).
 */
export function folderSaveVerdict(facts: FolderSaveFacts): FolderSaveVerdict {
  if (facts.locked && !facts.lockConfirmed) return 'locked';
  if (facts.overwriteConfirmed) return 'write';
  if (facts.onDisk === null) {
    if (facts.baseline !== null) return 'changed';
    return facts.filesChanged ? 'files' : 'write';
  }
  if (facts.baseline === null) return facts.sameProject === true ? 'earlier' : 'unknown';
  if (facts.onDisk !== facts.baseline) return 'changed';
  if (facts.filesChanged) return 'files';
  return 'write';
}

/**
 * Whose project a folder holds, as a save into it sees it:
 * - `none`: the folder has no `caotang.json`, or one that names no project id;
 * - `own`: its `caotang.json` names this session's project, so it holds this project's own earlier save, however the session came to it;
 * - `original`: this session is a separate copy made from the book the folder holds (the copy took a fresh id, and `copiedFrom` is the
 *   folder's id), so the save is refused: writing the copy there would turn the folder's book into the copy;
 * - `other`: any other project, which the writer is asked about before it is replaced (the `unknown` question).
 */
export type FolderProjectRoute = 'none' | 'own' | 'original' | 'other';

export function folderProjectRoute(facts: {
  /** The project id the folder's `caotang.json` names, or `undefined` when it has none or names none. */
  readonly folderId: string | undefined;
  /** This session's project id. */
  readonly ownId: string;
  /** The id of the project this session's project was copied from, when it is a separate copy (lifecycle `adopt`), else `null`. */
  readonly copiedFrom: string | null;
}): FolderProjectRoute {
  if (facts.folderId === undefined) return 'none';
  if (facts.folderId === facts.ownId) return 'own';
  return facts.copiedFrom !== null && facts.folderId === facts.copiedFrom ? 'original' : 'other';
}

/**
 * How a folder opens, given what this browser keeps:
 * - `own`: this browser keeps the folder's project and it is the same book, so the folder opens as that project's own session;
 * - `ask`: this browser keeps the folder's project but the two differ, so the writer is asked which version to keep (`FolderDiffersAnswer`);
 * - `new`: this browser does not keep it, so the folder opens as a new project under its own id.
 */
export type FolderOpenRoute = 'own' | 'ask' | 'new';

export function folderOpenRoute(facts: { readonly storedHasId: boolean; readonly sameBook: boolean }): FolderOpenRoute {
  if (!facts.storedHasId) return 'new';
  return facts.sameBook ? 'own' : 'ask';
}

/**
 * The writer's answer when a folder's version of a project differs from this browser's:
 * - `use-folder`: the folder's version replaces this browser's copy, under the same id, and the folder is the project's own;
 * - `keep-browser`: this browser's copy opens, and is saved to the folder, which asks first about any document it would write over;
 * - `separate-copy`: the folder opens as a second project with its own id, which cannot be saved into the folder (today's copy).
 */
export type FolderDiffersAnswer = 'use-folder' | 'keep-browser' | 'separate-copy';

/**
 * The digests a "keep this browser's version" save is checked against (lifecycle `answerFolderDiffers`), so its question names exactly the
 * documents and codex entries it would write over: for each file both hold, this browser's digest, and for a file only the folder holds, the
 * folder's own. A file only this browser holds is left out, since saving adds it and replaces nothing. The save then sees the folder's
 * differing files as changed (`driftOf`), and asks with the changed-documents question before it writes.
 */
export function keepBrowserDigests(browser: ReadonlyMap<string, string>, folder: ReadonlyMap<string, string>): Map<string, string> {
  const held = new Map<string, string>();
  for (const [path, digest] of folder) held.set(path, browser.get(path) ?? digest);
  return held;
}

/**
 * The sample project a demo run should open: the first sample the settings name that still exists in this browser, or `null`
 * when none does (the run then makes one). Reusing it keeps one sample per writer, rather than one more on every demo click.
 */
export function sampleToReuse(knownSampleIds: readonly string[], presentProjectIds: readonly string[]): string | null {
  const present = new Set(presentProjectIds);
  return knownSampleIds.find((id) => present.has(id)) ?? null;
}

/**
 * A reason as a sentence of its own: its first letter capitalised and a full stop at its end, so a reason an error carries reads as a
 * sentence when it follows another. Empty text stays empty.
 */
export function sentenceOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** What an open's notices say to the writer: each one's own sentence, when it has one. */
export interface OpenNotice {
  /** The notice as a whole sentence in the writer's words (`LoadNotice.say`), or none when it cannot be put that way. */
  readonly say?: string;
  /** I7: the same sentence as a reference. A notice without one reads its `say` exactly as written. */
  readonly messageRef?: MessageRef;
}

/**
 * The lines an open shows for its notices: each notice that has a writer's sentence, once, in the order the load raised them,
 * and one line counting the rest. A notice with no sentence names a path, an id or a spec section, so it is counted rather than quoted.
 */
export function openNoticeLines(notices: readonly OpenNotice[]): string[] {
  const lines: string[] = [];
  let unsaid = 0;
  for (const notice of notices) {
    const sentence =
      notice.messageRef === undefined
        ? notice.say
        : renderRef(notice.messageRef, { userValues: titleValues(notice.messageRef) });
    if (sentence === undefined) unsaid += 1;
    else if (!lines.includes(sentence)) lines.push(sentence);
  }
  if (unsaid > 0) {
    lines.push(
      t`Caotang also noted ${plural(unsaid, { one: '# smaller thing', other: '# smaller things' })} in the project’s files as it opened them.`,
    );
  }
  return lines;
}

/**
 * The open's sentence for the fields a save drops, or `null` when there are none. A name the file carries on several items is
 * said once, with how many times it occurs, so the line neither repeats a name nor loses the count.
 */
export function droppedFieldsSentence(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const fieldCount = names.length;
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const words = [...counts].map(([name, times]) =>
    times === 1
      ? t`“${{ name: isolate(name) }}”`
      : t`“${{ name: isolate(name) }}” ${plural(times, { one: '# time', other: '# times' })}`,
  );
  const listed = listFormat(formatterLocale()).format(words);
  return names.length === 1
    ? t`The file has a field Caotang keeps but does not use: ${{ fields: listed }}. It is dropped on the next save.`
    : t`The file has ${plural(fieldCount, { one: '# field', other: '# fields' })} Caotang keeps but does not use: ${{ fields: listed }}. They are dropped on the next save.`;
}
