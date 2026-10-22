/**
 * The pending journal — the words typed in the moment before a page goes away, kept where a synchronous write reaches them.
 *
 * Typing is saved about 800 ms after the last keystroke, and getting it to the store takes two more asynchronous hops (autosave to the
 * session's state, then the persistence pass to IndexedDB). A page torn down in that time may never finish them. `localStorage` is
 * synchronous, so a write there inside `visibilitychange`, `pagehide` and `beforeunload` is done before the handler returns. The journal
 * holds, per document, the body the session has and the store does not, with the store revision it is based on:
 * `caotang.pending.<projectId>` = `PendingEntry[]`.
 *
 * It is written once per debounce window while the writer types (so a tab that is killed or discarded, with no event at all, loses at most a
 * window), and synchronously on the three lifecycle events. An entry leaves it when the store holds that body. A stopped session
 * (persistence.ts) keeps the unsent copy instead, so the journal is not written for it and its key is cleared once the copy landed.
 *
 * On open the journal is read before the editor mounts (`recoverPending`). It is per-viewer, like the unsent copy: the store, the agent
 * and the bundle never read it. Every read and write tolerates a browser with no storage, a full quota and a value this build did not write.
 */

import { getRevision, type ProjectState } from '@caotang/store';

import type { ProjectSession } from './session.js';
import {
  addUnsentEntry,
  browserStorage,
  newStopId,
  type UnsentDocument,
  type UnsentEntry,
  type UnsentStorage,
} from './unsent-copy.js';

/** The storage key prefix. The key is the prefix and the project id. */
export const PENDING_KEY_PREFIX = 'caotang.pending.';

/**
 * The most the journal writes, in characters of its JSON. Bodies are per scene, so the journal stays small; past this the write is skipped and
 * the writer is told, and the app behaves as it did before the journal (autosave and the leave prompt).
 */
export const PENDING_CAP_CHARS = 2 * 1024 * 1024;

/** One document's words that the store does not hold, and the store revision they are based on. */
export interface PendingEntry {
  readonly docId: string;
  readonly body: string;
  /** The revision the store held for the document when this body was typed. */
  readonly baseRevision: number;
  readonly at: string;
}

export function pendingKey(projectId: string): string {
  return `${PENDING_KEY_PREFIX}${projectId}`;
}

/** The entries kept for a project. `[]` when there are none, the browser keeps no storage, or the value is not one this build wrote. */
export function readPending(storage: UnsentStorage | undefined, projectId: string): PendingEntry[] {
  if (storage === undefined) return [];
  try {
    const raw = storage.getItem(pendingKey(projectId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as unknown[]).filter(isPendingEntry) : [];
  } catch {
    return [];
  }
}

/** Removes a project's journal. Returns `false` when the browser refused, in which case the entries stay and are offered again. */
export function clearPending(storage: UnsentStorage | undefined, projectId: string): boolean {
  if (storage === undefined) return false;
  try {
    storage.removeItem(pendingKey(projectId));
    return true;
  } catch {
    return false;
  }
}

function isPendingEntry(value: unknown): value is PendingEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as { docId?: unknown; body?: unknown; baseRevision?: unknown; at?: unknown };
  return (
    typeof entry.docId === 'string' &&
    typeof entry.body === 'string' &&
    typeof entry.baseRevision === 'number' &&
    Number.isInteger(entry.baseRevision) &&
    typeof entry.at === 'string'
  );
}

/** What the journal reads from the session. A seam so the journal is tested without one. */
export interface PendingSource {
  /** Every document the session holds. */
  docIds(): Iterable<string>;
  /** The body the session holds for a document, or `undefined` when it holds none. */
  bodyOf(docId: string): string | undefined;
  /** What the store holds for a document, or `undefined` when this session has not stored it. */
  stored(docId: string): { readonly body: string; readonly revision: number } | undefined;
  /** The autosave's unsaved body for a document, produced now (`Autosave.pendingBodyOf`), or `null`. */
  pendingBodyOf(docId: string): string | null;
  /** The documents the autosave holds unsaved work for. */
  dirtyDocIds(): readonly string[];
  /** Whether a stale write has stopped the session; the unsent copy keeps its words then. */
  stopped(): boolean;
}

/** Why the journal could not keep the words, in a sentence for the status line. `null` while it can. */
export type PendingFailure = 'too-large' | 'refused';

/**
 * The journal of one open project. `keep` snapshots what the session holds that the store does not and writes it; `prune` takes out the
 * entries the store now holds, and writes without asking the autosave for any body (so it costs no rendering while the writer types).
 */
export class PendingJournal {
  private readonly held = new Map<string, PendingEntry>();
  /** The JSON last written (or found absent), so an unchanged journal writes nothing. */
  private written = '[]';
  private failureNow: PendingFailure | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: UnsentStorage | undefined,
    private readonly projectId: string,
    private readonly source: PendingSource,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Why the last write was skipped, or `null`. */
  failure(): PendingFailure | null {
    return this.failureNow;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshots the unsaved words and writes the journal. Synchronous: this is what the lifecycle events call. */
  keep(): void {
    if (this.source.stopped()) return;
    this.snapshot();
    this.write();
  }

  /** Takes out the entries the store now holds, and writes. */
  prune(): void {
    if (this.source.stopped()) return;
    for (const [docId, entry] of this.held) {
      const stored = this.source.stored(docId);
      if (stored !== undefined && stored.body === entry.body) this.held.delete(docId);
    }
    this.write();
  }

  private snapshot(): void {
    const dirty = new Set(this.source.dirtyDocIds());
    const seen = new Set<string>();
    for (const docId of this.source.docIds()) {
      seen.add(docId);
      const stored = this.source.stored(docId);
      // A document the store has not got has no revision to base words on, and the persistence pass writes it whole.
      if (stored === undefined) continue;
      const pending = this.source.pendingBodyOf(docId);
      const body = pending ?? this.source.bodyOf(docId);
      if (body === undefined) continue;
      // A body the autosave holds but could not read is not in the session yet, so what is held for it stays.
      if (pending === null && dirty.has(docId) && body === stored.body) continue;
      if (body === stored.body) {
        this.held.delete(docId);
        continue;
      }
      const before = this.held.get(docId);
      if (before?.body === body && before.baseRevision === stored.revision) continue;
      this.held.set(docId, { docId, body, baseRevision: stored.revision, at: this.now() });
    }
    for (const docId of this.held.keys()) if (!seen.has(docId)) this.held.delete(docId);
  }

  private write(): void {
    const entries = [...this.held.values()];
    const text = JSON.stringify(entries);
    if (text === this.written) return;
    if (this.storage === undefined) {
      this.fail('refused');
      return;
    }
    if (text.length > PENDING_CAP_CHARS) {
      this.fail('too-large');
      return;
    }
    try {
      if (entries.length === 0) this.storage.removeItem(pendingKey(this.projectId));
      else this.storage.setItem(pendingKey(this.projectId), text);
    } catch {
      this.fail('refused');
      return;
    }
    this.written = text;
    if (this.failureNow !== null) {
      this.failureNow = null;
      this.notify();
    }
  }

  private fail(reason: PendingFailure): void {
    if (this.failureNow === reason) return;
    this.failureNow = reason;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * A stopped session keeps its words in the unsent copy (persistence.ts), so the journal's key is cleared once that copy landed. Until then
   * it stays: it is the only copy there is.
   */
  clearForStop(copyLanded: boolean): void {
    if (!copyLanded) return;
    this.held.clear();
    if (clearPending(this.storage, this.projectId)) this.written = '[]';
  }
}

/** What reading the journal at open decided for each entry. */
export interface RecoveryPlan {
  /** The store never got these words and still holds the text they were based on: they are written, as the writer's own edit. */
  readonly save: readonly PendingEntry[];
  /** The store moved past the revision the words were based on: they are offered, never written over it. */
  readonly offer: readonly PendingEntry[];
  /** The store already holds these words. */
  readonly drop: readonly PendingEntry[];
}

/**
 * Decides each entry against the project as it opened. Equal to the stored body is dropped. The same revision with a different body is the
 * write that never landed. Anything else (the revision moved on, or the document is gone) is offered.
 */
export function planRecovery(entries: readonly PendingEntry[], state: ProjectState): RecoveryPlan {
  const save: PendingEntry[] = [];
  const offer: PendingEntry[] = [];
  const drop: PendingEntry[] = [];
  for (const entry of entries) {
    const record = state.documents.get(entry.docId);
    if (record !== undefined && record.body === entry.body) drop.push(entry);
    else if (record !== undefined && getRevision(state, entry.docId) === entry.baseRevision) save.push(entry);
    else offer.push(entry);
  }
  return { save, offer, drop };
}

/** What recovery did, for the notice. */
export interface RecoveryOutcome {
  readonly saved: number;
  readonly offered: number;
}

/**
 * Reads the journal once, when the project opens and before the editor mounts. Entries that never landed are applied as the writer's own
 * `doc.write` (so each is an undo group of its own, attributed to "You") and saved; entries the store has moved past are written to the unsent
 * copy to be offered (UnsentWords); entries the store holds are dropped. The journal's key is cleared only once every entry is accounted
 * for and the store holds what was written, so a failure leaves it to be read again.
 */
export async function recoverPending(session: ProjectSession, storage: UnsentStorage | undefined = browserStorage()): Promise<RecoveryOutcome> {
  const none: RecoveryOutcome = { saved: 0, offered: 0 };
  const entries = readPending(storage, session.projectId);
  if (entries.length === 0) return none;
  const plan = planRecovery(entries, session.state);
  let complete = true;

  let offered = 0;
  if (plan.offer.length > 0) {
    const documents: UnsentDocument[] = plan.offer.map((entry) => offerOf(session.state, entry));
    const entry: UnsentEntry = { stopId: newStopId(), savedAt: new Date().toISOString(), documents, origin: 'reload' };
    if (addUnsentEntry(storage, session.projectId, entry)) offered = documents.length;
    else complete = false;
  }

  let saved = 0;
  for (const entry of plan.save) {
    const written = session.dispatch('doc.write', { docId: entry.docId, body: entry.body, expectedRevision: entry.baseRevision });
    if (written.ok) saved += 1;
    else complete = false;
  }
  if (plan.save.length > 0) {
    try {
      await session.settle();
    } catch {
      complete = false;
    }
    if (session.saveState() !== 'saved') complete = false;
  }
  if (complete) clearPending(storage, session.projectId);
  return { saved, offered };
}

function offerOf(state: ProjectState, entry: PendingEntry): UnsentDocument {
  const node = state.manifest.tree.find((candidate) => candidate.id === entry.docId);
  const parentId = node?.parentId ?? undefined;
  return { docId: entry.docId, title: node?.title ?? 'Untitled', body: entry.body, ...(parentId === undefined ? {} : { parentId }) };
}

/** The sentence an open says about what recovery did, or `null` when it did nothing. */
export function recoveryNotice(outcome: RecoveryOutcome): string | null {
  const parts: string[] = [];
  if (outcome.saved > 0) {
    const one = outcome.saved === 1;
    parts.push(`Caotang kept ${outcome.saved} unsaved ${one ? 'change' : 'changes'} from before the reload and saved ${one ? 'it' : 'them'}.`);
  }
  if (outcome.offered > 0) {
    parts.push('Words from before the reload that newer text now covers are kept in the binder footer, to put back as new documents or discard.');
  }
  return parts.length === 0 ? null : parts.join(' ');
}
