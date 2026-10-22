/**
 * The executor for `planPersistence` — one job at a time, against the runtime store.
 *
 * ## Why one job at a time
 *
 * Every store write is its own transaction, and a plan may be several of them. Two
 * plans running at once could interleave, and a body write guarded by a revision the
 * other plan has already moved would fail for a reason that is no one's fault. So the
 * queue runs one plan to completion, then re-plans against what the *last* plan left
 * the shadow at, and a change that arrives mid-write is picked up by the next pass
 * rather than racing the current one.
 *
 * ## Failure is a state, not a retry loop
 *
 * A failed plan drops the shadow to `null`, which makes the next plan a full write:
 * the whole project is restated from the in-memory state, which is what repairs a
 * store that is partly behind. Nothing re-runs on its own — the next edit or
 * structural command schedules the next pass, so a store that is failing for a
 * reason a loop cannot fix (a full disk) does not spin. The status line reports it.
 *
 * ## A stale write is a stop, not a failure
 *
 * The store refuses a write whose `expectedRevision` no longer holds, or a create
 * whose row exists, when another writer has moved that row. The shadow is then
 * the wrong thing to repair from: the store holds text this session never saw, and
 * a full restatement would overwrite it with this session's older text (the
 * two-tab defect). So a stale write stops the session. The shadow is kept, nothing
 * is written from this session again, and the text stays in memory for the shell
 * to say so and offer a backup.
 *
 * ## What a stopped tab keeps, and where (unsent-copy.ts)
 *
 * A stopped session's words are in memory only, and a reload would take them. So the
 * words it holds that the store does not are written to this browser's storage when
 * the session stops, and again after each change while it stays stopped. The store is
 * never written from that copy; the writer puts it back as new documents (UnsentWords).
 */

import {
  DocumentExistsError,
  RevisionConflictError,
  RuntimeStoreStaleError,
  commitProject,
  writeDocumentBody,
  writeProjectSkills,
  writeProjectState,
  type ProjectState,
  type RuntimeStore,
} from '@caotang/store';

import { planPersistence, type DocumentShadow, type PersistPlan, type Shadow } from './persistence-plan.js';
import { noteStopCause } from './integrity-model.js';
import {
  browserStorage,
  newStopId,
  noteStop,
  noteStopKept,
  unsentDocuments,
  writeUnsentEntry,
  type UnsentStorage,
} from './unsent-copy.js';

export type PersistenceStatus = 'idle' | 'writing' | 'failed' | 'conflict';

/**
 * Whether a store refusal means another writer has moved a row this session holds (see the note above). A store another tab has upgraded
 * is one too: this build cannot write its schema, so nothing this session writes can land, and the words are kept as a stopped tab's are
 * until the tab is reloaded (`RuntimeStoreStaleError`).
 */
export function isStaleWrite(error: unknown): boolean {
  return error instanceof RevisionConflictError || error instanceof DocumentExistsError || error instanceof RuntimeStoreStaleError;
}

export class Persistence {
  private shadow: Shadow | null;
  /**
   * The bodies and revisions the store holds, as the last pass that landed left them. Unlike the shadow it survives a failed pass (which drops the
   * shadow so the next pass restates everything), because the store still holds what it held: the pending journal reads it (pending-journal.ts).
   */
  private stored: ReadonlyMap<string, DocumentShadow> | null;
  private status: PersistenceStatus = 'idle';
  private lastError: unknown = null;
  private again = false;
  /**
   * Set by a stale write. Nothing is written from this session after it: not the store (see the note above), and not the
   * findings file either (session.ts `queueCoherenceSave`).
   */
  private stopped = false;
  private current: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  /** The browser's storage for the unsent copy (unsent-copy.ts), or `undefined` where there is none. */
  private readonly storage: UnsentStorage | undefined = browserStorage();
  /** This session's entry in the unsent copy (unsent-copy.ts). Only a stopped session writes it, and no other stop's entry is touched. */
  private readonly stopId: string = newStopId();
  /** The entry as last written, so a stopped session that makes no change writes nothing. */
  private keptText = '';

  constructor(
    private readonly store: RuntimeStore,
    private readonly projectId: string,
    private readonly read: () => ProjectState,
    shadow: Shadow | null,
  ) {
    this.shadow = shadow;
    this.stored = shadow?.docs ?? null;
  }

  /** What the store holds for a document, as far as this session knows, or `undefined` for a document it has not stored. */
  storedDocument(docId: string): DocumentShadow | undefined {
    return this.stored?.get(docId);
  }

  /** Ask for the store to be brought up to date. Coalesces: at most one pass is ever queued behind a running one. */
  schedule(): void {
    if (this.stopped) {
      // A stopped session writes nothing to the store, but its words are still changing: they are kept here (unsent-copy.ts).
      this.keepUnsent();
      return;
    }
    if (this.current !== null) {
      this.again = true;
      return;
    }
    this.current = this.drain().finally(() => {
      this.current = null;
    });
  }

  /** Resolves once every change made so far is in the store, or the last attempt has failed. */
  async settle(): Promise<void> {
    this.schedule();
    while (this.current !== null) await this.current;
  }

  getStatus(): PersistenceStatus {
    return this.status;
  }

  getError(): unknown {
    return this.lastError;
  }

  /** Whether a stale write has stopped this session, after which nothing is written from it (see the note above). */
  isStopped(): boolean {
    return this.stopped;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async drain(): Promise<void> {
    do {
      this.again = false;
      await this.step();
    } while (this.again);
  }

  private async step(): Promise<void> {
    if (this.stopped) return;
    const plan = planPersistence(this.shadow, this.read());
    if (plan.kind === 'none') {
      this.setStatus('idle', null);
      return;
    }
    this.setStatus('writing', null);
    try {
      await this.execute(plan);
      this.shadow = plan.next;
      this.stored = plan.next.docs;
      this.setStatus('idle', null);
    } catch (error) {
      if (isStaleWrite(error)) {
        // Another writer moved a row this session holds. Restating would overwrite its text, so this session stops, and the
        // words it holds are kept in this browser so a reload does not take them. An upgraded store is said as that cause.
        this.stopped = true;
        noteStopCause(error instanceof RuntimeStoreStaleError ? 'updated' : 'newer-text');
        noteStop(this.projectId, this.stopId);
        this.keepUnsent();
        this.setStatus('conflict', error);
        return;
      }
      // The shadow no longer describes the store, so the next pass restates everything.
      this.shadow = null;
      this.setStatus('failed', error);
    }
  }

  private async execute(plan: PersistPlan): Promise<void> {
    if (plan.kind === 'full') {
      await writeProjectState(this.store, plan.state);
      return;
    }
    if (plan.kind !== 'incremental') return;
    // Bodies first. Each one is guarded by the revision it replaces, so a stale body stops the pass before the
    // manifest is written: a stale tab's structure never lands on top of a newer one when its text was already stale.
    for (const write of plan.bodies) {
      const result = await writeDocumentBody(this.store, {
        projectId: this.projectId,
        docId: write.docId,
        body: write.body,
        expectedRevision: write.expectedRevision,
      });
      // The store's revision and the plan's must agree; a disagreement is a bug, and
      // throwing turns it into a full restatement instead of a silent divergence.
      if (result.revision !== write.expectedRevision + 1) {
        throw new Error(
          `the store holds "${write.docId}" at revision ${result.revision}, but the write expected ${write.expectedRevision + 1}`,
        );
      }
    }
    if (plan.skills !== null) await writeProjectSkills(this.store, this.projectId, plan.skills);
    if (plan.manifest !== null) {
      await commitProject(this.store, {
        projectId: this.projectId,
        manifest: plan.manifest,
        createDocuments: plan.createDocuments.map((doc) => ({ id: doc.id, body: doc.body })),
        removeDocumentIds: plan.removeDocumentIds,
      });
    }
  }

  /**
   * Keeps the words a stopped session holds in this browser (unsent-copy.ts). It writes only when the words changed since the
   * last write, so the many changes that carry no text (a selection, a view) cost nothing here. Whether the latest write landed
   * is reported to the stopped-tab notice, which reads it on every render, so a refused write is never shown as kept.
   */
  private keepUnsent(): void {
    const documents = unsentDocuments(this.shadow, this.read());
    const text = JSON.stringify(documents);
    if (text === this.keptText) return;
    const landed = writeUnsentEntry(this.storage, this.projectId, this.stopId, documents);
    if (landed) this.keptText = text;
    noteStopKept(this.stopId, landed);
  }

  private setStatus(status: PersistenceStatus, error: unknown): void {
    this.status = status;
    this.lastError = error;
    for (const listener of this.listeners) listener();
  }
}
