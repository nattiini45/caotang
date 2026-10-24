/**
 * The unsent copy of a stopped tab (persistence.ts): the words a stopped session holds that the store does not, kept in this browser so a
 * reload does not take them. A stopped session keeps its text only in memory, and a reload would lose it, so when a stale write stops the
 * session the changed bodies are written here, and again after each later change while the session stays stopped.
 *
 * One entry per stop. A stop writes its own entry under the project's key and leaves every other stop's entry alone, so a second stop of
 * the same project (after a reload) never overwrites the words a first stop kept. An entry leaves the copy only when the writer puts it back
 * (UnsentWords.tsx) or discards it, and a put-back removes it only once the store has saved what it made.
 *
 * It is a per-viewer convenience, the kind the browser's storage is for, and never project state: the store, the agent and the bundle do not
 * read it. Putting the words back adds them as new documents, which overwrites nothing. Every read and write here tolerates a browser that
 * keeps no storage, a full quota or a value this build did not write.
 */

import { dateFormat } from '@caotang/i18n';
import type { ProjectState } from '@caotang/store';

import { formatterLocale } from '../i18n/format-locale.js';
import type { Shadow } from './persistence-plan.js';

/** The storage key prefix. The key is the prefix and the project id, so two projects never share a copy. */
export const UNSENT_KEY_PREFIX = 'caotang.unsent.';

/** The part of the browser's storage the copy uses. `undefined` where the browser keeps none (a private window, a blocked site). */
export type UnsentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/**
 * One document's words that the store does not hold: the document, its title when the copy was made, and its whole body. `restoredAs` is
 * the id of the document a put-back made from it, once one was made, so a retry repeats only the step that did not land (restoreStep).
 */
export interface UnsentDocument {
  readonly docId: string;
  readonly title: string;
  readonly body: string;
  /**
   * The chapter (or, for a note, the Research folder) the document was in when the copy was made (docs/decisions.md, "Chapterless
   * documents"), so a put-back restores it there (`restoreParentOf`). An entry an older build wrote has none, and goes into the kept chapter.
   */
  readonly parentId?: string;
  readonly restoredAs?: string;
}

/** The chapter a put-back makes, once per put-back, at the end of the manuscript, for the documents whose own chapter is gone. */
export const KEPT_CHAPTER_TITLE = 'Kept from a stopped tab';

/** The same, for words kept through a reload (`UnsentEntry.origin`). */
export const RELOAD_CHAPTER_TITLE = 'Kept from before a reload';

/** The Research root's id (store create.ts): the documents under it are notes, not the manuscript. */
const RESEARCH_ROOT = 'research';

/**
 * Where one kept document goes back: the chapter it recorded, when that still exists and is a chapter (a folder directly under the
 * manuscript, and not a storyboard, which holds only shots). A Research document goes back to the Research folder it recorded, or to the
 * Research root when that is what it recorded, while that parent still exists: notes do not belong in the manuscript. Otherwise `null`:
 * the document goes into the kept chapter, since a document goes inside a chapter and never directly under the manuscript. An entry with no
 * recorded parent (an older build's) is `null` too.
 */
export function restoreParentOf(state: ProjectState, parentId: string | undefined): string | null {
  if (parentId === undefined) return null;
  const parent = state.manifest.tree.find((node) => node.id === parentId);
  if (parent === undefined || parent.type !== 'folder') return null;
  if (parent.kind === 'storyboard') return null;
  if (parent.parentId === 'manuscript') return parent.id;
  return isInResearch(state, parent.id) ? parent.id : null;
}

/** Whether a node is the Research root or sits somewhere under it. The walk is bounded by the tree's size, so a damaged cycle ends. */
function isInResearch(state: ProjectState, nodeId: string): boolean {
  const byId = new Map(state.manifest.tree.map((node) => [node.id, node] as const));
  let current: string | null = nodeId;
  for (let steps = 0; current !== null && steps <= byId.size; steps += 1) {
    if (current === RESEARCH_ROOT) return true;
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

/** What one stop kept: the stop that wrote it, when it was last written, and the documents it holds. */
export interface UnsentEntry {
  readonly stopId: string;
  readonly savedAt: string;
  readonly documents: readonly UnsentDocument[];
  /**
   * Where the words came from. Absent for a stopped tab's. `'reload'` marks words the pending journal kept through a reload that the store has
   * since moved past (pending-journal.ts), offered the same way, with their own wording (UnsentWords).
   */
  readonly origin?: 'reload';
}

/** The browser's local storage, or `undefined` when the browser does not offer it. Reading it can throw in some privacy modes. */
export function browserStorage(): UnsentStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** The key one project's copy is kept under. */
export function unsentKey(projectId: string): string {
  return `${UNSENT_KEY_PREFIX}${projectId}`;
}

/**
 * The documents whose words this session holds and the store does not, as far as the session knows: a body that differs from the
 * shadow, or a new document with words in it. A blank body has no words, so it is not here; a document the session removed is not
 * here either, because nothing was typed in it. With no shadow to compare with, every document with words is here.
 */
export function unsentDocuments(shadow: Shadow | null, state: ProjectState): UnsentDocument[] {
  const out: UnsentDocument[] = [];
  for (const [docId, record] of state.documents) {
    if (record.body.trim() === '') continue;
    if (shadow !== null && shadow.docs.get(docId)?.body === record.body) continue;
    const parentId = parentOf(state, docId);
    out.push({ docId, title: titleOf(state, docId), body: record.body, ...(parentId === undefined ? {} : { parentId }) });
  }
  return out;
}

function titleOf(state: ProjectState, docId: string): string {
  return state.manifest.tree.find((node) => node.id === docId)?.title ?? 'Untitled';
}

function parentOf(state: ProjectState, docId: string): string | undefined {
  return state.manifest.tree.find((node) => node.id === docId)?.parentId ?? undefined;
}

/** A stop's identifier: eight random bytes in hex. It only has to differ between the stops of one project. */
export function newStopId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `stop-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The stop this tab's session made, if any (persistence.ts records it when the session stops). A session stops once and stays stopped until
 * the tab reloads, so one record is enough for the stopped-tab notice (StaleTabNotice.tsx) to read. `keptLatest` is whether the latest write
 * of this stop's entry landed, so the notice can say what the browser holds now rather than what it held once.
 */
interface StopRecord {
  readonly projectId: string;
  readonly stopId: string;
  readonly keptLatest: boolean;
}

let stop: StopRecord | null = null;
const stopListeners = new Set<() => void>();

function notifyStop(): void {
  for (const listener of stopListeners) listener();
}

/** Records that this tab's session has stopped on a project, before its entry is written. */
export function noteStop(projectId: string, stopId: string): void {
  stop = { projectId, stopId, keptLatest: false };
  notifyStop();
}

/** Records whether the latest write of a stop's entry landed. A write for any other stop is not this tab's stop, so it is ignored. */
export function noteStopKept(stopId: string, landed: boolean): void {
  if (stop === null || stop.stopId !== stopId) return;
  stop = { ...stop, keptLatest: landed };
  notifyStop();
}

/**
 * Whether the words this tab's stopped session holds are kept in this browser: the latest write of its entry landed, and the entry is still
 * there. Another stop's entry never counts, so a copy from an earlier stop does not make the notice say these words are kept.
 */
export function stopKeptInBrowser(storage: UnsentStorage | undefined): boolean {
  const current = stop;
  if (current === null || !current.keptLatest) return false;
  return readUnsentEntries(storage, current.projectId).some((entry) => entry.stopId === current.stopId);
}

/** Subscribes to changes of the stop record, for the notice's useSyncExternalStore. Returns the unsubscribe. */
export function subscribeStop(listener: () => void): () => void {
  stopListeners.add(listener);
  return () => {
    stopListeners.delete(listener);
  };
}

/** Every stop's entry for a project, in the order they were first written. `[]` when there is none, or the storage is unavailable. */
export function readUnsentEntries(storage: UnsentStorage | undefined, projectId: string): readonly UnsentEntry[] {
  return (storage === undefined ? null : storedEntries(storage, projectId)) ?? [];
}

/**
 * The entries stored for a project. `null` when the browser would not give the value up, so a write must not replace it: it may hold other
 * stops' words. An absent value, or one this build did not write, reads as none, and an entry that is not a copy is dropped, not the rest.
 */
function storedEntries(storage: UnsentStorage, projectId: string): UnsentEntry[] | null {
  let raw: string | null;
  try {
    raw = storage.getItem(unsentKey(projectId));
  } catch {
    return null;
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as unknown[]).filter(isUnsentEntry) : [];
  } catch {
    return [];
  }
}

/**
 * Writes one stop's entry: the documents it now holds, which replace the ones it held. Every other stop's entry stays as it is. No documents
 * removes this stop's entry. Returns `false` when the browser refused the write (no storage, or a full quota): the session carries on, and the
 * words stay on screen.
 */
export function writeUnsentEntry(
  storage: UnsentStorage | undefined,
  projectId: string,
  stopId: string,
  documents: readonly UnsentDocument[],
): boolean {
  if (storage === undefined) return false;
  const current = storedEntries(storage, projectId);
  if (current === null) return false;
  const index = current.findIndex((entry) => entry.stopId === stopId);
  let next: readonly UnsentEntry[];
  if (documents.length === 0) {
    next = current.filter((entry) => entry.stopId !== stopId);
  } else {
    const entry: UnsentEntry = { stopId, savedAt: new Date().toISOString(), documents };
    next = index < 0 ? [...current, entry] : current.map((existing, position) => (position === index ? entry : existing));
  }
  return storeEntries(storage, projectId, next);
}

/**
 * Adds an entry another part of the app made (the pending journal's offer, see `UnsentEntry.origin`). Every entry already there stays. Returns
 * `false` when the browser refused the write or would not give the value up, in which case nothing changed.
 */
export function addUnsentEntry(storage: UnsentStorage | undefined, projectId: string, entry: UnsentEntry): boolean {
  if (storage === undefined) return false;
  const current = storedEntries(storage, projectId);
  if (current === null) return false;
  return storeEntries(storage, projectId, [...current.filter((existing) => existing.stopId !== entry.stopId), entry]);
}

/** Removes one stop's entry, once its words are put back and saved, or discarded. A browser that refuses the removal keeps it: nothing is lost. */
export function removeUnsentEntry(storage: UnsentStorage | undefined, projectId: string, stopId: string): boolean {
  return writeUnsentEntry(storage, projectId, stopId, []);
}

/** Removes every entry a project has. Used when the project leaves this browser. A browser that refuses the removal keeps them. */
export function clearUnsentCopy(storage: UnsentStorage | undefined, projectId: string): void {
  try {
    storage?.removeItem(unsentKey(projectId));
  } catch {
    // Kept on purpose: an entry that cannot be removed is offered again, so nothing is lost.
  }
}

function storeEntries(storage: UnsentStorage, projectId: string, entries: readonly UnsentEntry[]): boolean {
  try {
    if (entries.length === 0) storage.removeItem(unsentKey(projectId));
    else storage.setItem(unsentKey(projectId), JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

/**
 * The put-backs this tab has made, by stop and document. They hold even where the browser refuses the copy's own writes, so a retry in this
 * tab never makes a document twice; the copy's marks (`restoredAs`) carry the same record across a reload where the browser accepts them.
 */
const restoredHere = new Map<string, string>();

/**
 * Puts one stop's documents back, one at a time, through `put`. `put` makes or writes one document and returns why it could not, or `null`.
 * It is given the document with the id of any document an earlier try made from it, and a `recordCreated` callback: calling it keeps the new
 * document's id on the copy at once, so a retry that finds the document repeats only the body write and never a second create.
 *
 * The entry is not removed here. The caller removes it (`removeUnsentEntry`) once the store has saved the put-back, so a save that fails
 * leaves the words kept. Returns the failure at the first document that did not go in, or `null` when every document is back in memory.
 */
export function putBackDocuments(
  storage: UnsentStorage | undefined,
  projectId: string,
  stopId: string,
  put: (doc: UnsentDocument, recordCreated: (docId: string) => void) => string | null,
): string | null {
  const entry = readUnsentEntries(storage, projectId).find((candidate) => candidate.stopId === stopId);
  for (const kept of entry?.documents ?? []) {
    const key = `${stopId}/${kept.docId}`;
    const doc: UnsentDocument = { ...kept, restoredAs: restoredHere.get(key) ?? kept.restoredAs };
    const failure = put(doc, (restoredAs) => {
      restoredHere.set(key, restoredAs);
      markRestored(storage, projectId, stopId, kept.docId, restoredAs);
    });
    if (failure !== null) return failure;
  }
  return null;
}

/** Keeps on a stop's entry the id of the document a put-back made from one of its documents. Best effort: the tab's own record holds regardless. */
function markRestored(storage: UnsentStorage | undefined, projectId: string, stopId: string, docId: string, restoredAs: string): void {
  if (storage === undefined) return;
  const current = storedEntries(storage, projectId);
  if (current === null || !current.some((entry) => entry.stopId === stopId)) return;
  const next = current.map((entry) =>
    entry.stopId !== stopId
      ? entry
      : { ...entry, documents: entry.documents.map((doc) => (doc.docId === docId ? { ...doc, restoredAs } : doc)) },
  );
  storeEntries(storage, projectId, next);
}

/** What putting one kept document back still has to do: make the document, write the body of one an earlier try made, or nothing. */
export type RestoreStep = { readonly kind: 'create' } | { readonly kind: 'write'; readonly docId: string } | { readonly kind: 'done' };

/**
 * What putting one kept document back still has to do, given the document an earlier try made from it (`existing`, as the session holds it
 * now, or `undefined` when there is none). `create` makes the document. `write` repeats only the body, because the document exists and is
 * still empty, so its body write was the step that did not land. `done` leaves a document that already holds words as the writer left it.
 */
export function restoreStep(doc: UnsentDocument, existing: { readonly body: string } | undefined): RestoreStep {
  if (doc.restoredAs === undefined || existing === undefined) return { kind: 'create' };
  return existing.body.trim() === '' ? { kind: 'write', docId: doc.restoredAs } : { kind: 'done' };
}

function isUnsentEntry(value: unknown): value is UnsentEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as { stopId?: unknown; savedAt?: unknown; documents?: unknown; origin?: unknown };
  if (typeof entry.stopId !== 'string' || typeof entry.savedAt !== 'string' || !Array.isArray(entry.documents)) return false;
  if (entry.origin !== undefined && entry.origin !== 'reload') return false;
  return entry.documents.every(isUnsentDocument);
}

/**
 * The time a kept-words entry shows, in the formatter locale (i18n.md §4.1, D3), and `''` when the stored stamp does not parse.
 * The decision lives here so a model test can pin what a British, American or German interface reads.
 */
export function unsentStamp(savedAt: string, locale: string = formatterLocale()): string {
  if (Number.isNaN(Date.parse(savedAt))) return '';
  return dateFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(savedAt));
}

function isUnsentDocument(value: unknown): value is UnsentDocument {
  if (typeof value !== 'object' || value === null) return false;
  const doc = value as { docId?: unknown; title?: unknown; body?: unknown; parentId?: unknown; restoredAs?: unknown };
  return (
    typeof doc.docId === 'string' &&
    typeof doc.title === 'string' &&
    typeof doc.body === 'string' &&
    (doc.parentId === undefined || typeof doc.parentId === 'string') &&
    (doc.restoredAs === undefined || typeof doc.restoredAs === 'string')
  );
}
