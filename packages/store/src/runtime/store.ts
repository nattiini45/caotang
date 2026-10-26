/**
 * The IndexedDB runtime store — [project-format.md §4](docs/architecture/project-format.md)
 * and [§8](docs/architecture/project-format.md).
 *
 * §4, quoted: "**Browser working store (v0.1):** every mutation is one IndexedDB
 * transaction (atomic by construction). … Every mutation bumps a per-document
 * `revision` counter (used by agent tools for optimistic concurrency, see
 * [agent-harness.md](docs/architecture/agent-harness.md) §3)."
 *
 * §8, quoted: "**Runtime truth (v0.1):** IndexedDB … All commands read/write the
 * runtime store", and the hard acceptance test: "lossless round-trip to this
 * artifact is the acceptance test for any runtime store."
 *
 * Two sentences in that paragraph do the real work for this file, and both are
 * about *where a line of code is allowed to sit*.
 *
 * **One transaction per mutation** is why the two document-writing paths are
 * separate and why nothing in this file uses `Promise.all`. IndexedDB gives
 * atomicity only for what a single transaction covers, so a mutation that
 * touched two object stores in two transactions would be two mutations wearing
 * one name — and the gap between them is precisely the torn-write class §4 says
 * cannot occur here. The test suite proves this by failing a transaction
 * part-way and asserting that none of it survived.
 *
 * There are now three write entry points, and the third is a different kind of
 * thing rather than a third way to write a body: `appendSession` writes a
 * `sessions.jsonl` line (§4's append-only stats tier), which touches no document
 * and no revision. It lives here because it is a mutation of the same store
 * under the same one-transaction rule, not because it belongs to the document
 * half.
 *
 * **The `expectedRevision` guard lives inside the write transaction**, on
 * purpose. Comparing a revision in JavaScript before opening the transaction
 * is a check-then-act race: a second tab can commit in the gap, and the write
 * then lands on a row nobody looked at. IndexedDB transactions read their own
 * writes, so the read, the comparison and the write belong in one transaction —
 * and the second tab's transaction serializes behind it rather than through it.
 *
 * **Revisions are persisted here and never in the manifest.** `state.ts` calls
 * the counter "in-memory only", and for the artifact that is exactly right: it
 * is concurrency state, not content, and putting it in `caotang.json` would make
 * every save produce a diff. The runtime store is not the manifest, though — it
 * is the place a reload goes to. A revision that restarted at 0 on reopen would
 * make an `expectedRevision` captured before a reload silently match a document
 * that had moved on, which is the one failure the counter exists to prevent.
 *
 * ## Why callback style
 *
 * An IndexedDB transaction is closed to new requests the moment the current task
 * ends, so a transaction body may not `await` anything that resolves on a later
 * task. The store is therefore written in callbacks, and `transact` below
 * settles on the transaction's terminal event rather than on a request — which
 * is what makes `await writeDocumentBody(…)` mean *committed*, not *issued*.
 */

import type { Manifest } from '../manifest.js';
import { createProjectState, rebuildDerived, type DocumentRecord, type ProjectState } from '../state.js';
import { assertSessionRecord, type SessionRecord } from '../sessions.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const RUNTIME_DB_NAME = 'caotang';
/**
 * 4: the `runs` and `runEvents` object stores joined (agent-harness §5.1, the run log). The upgrade is additive: it creates them and
 * leaves every other store and row as it was.
 *
 * 3: the `snapshots` object store joined `projects`, `documents` and
 * `sessions`.
 *
 * There is no migration to write. The store is a *runtime cache* that only ever
 * holds what this build put in it, and no build has shipped, so there is no
 * database an older version created that this one has to read. The same
 * no-wild-artifacts argument §2 uses for adding `codex[]` to format v1.
 */
export const RUNTIME_DB_VERSION = 4;

/** The manifest — structural truth, vocabulary, codex (§2). */
export const PROJECT_STORE = 'projects';
/** One row per document: the body (§4's irreplaceable content) plus its revision. */
export const DOCUMENT_STORE = 'documents';
/** Index for "every document of project P", so enumeration needs no key range. */
export const DOCUMENT_PROJECT_INDEX = 'byProject';
/**
 * One row per `sessions.jsonl` line — the writing-session log.
 *
 * §4 ranks it with the disposable tier ("stats = `sessions.jsonl`") but with one
 * difference that the row shape encodes: it is **append-only**, so its key is
 * `[projectId, index]` and nothing in this file ever puts a row at an index that
 * is already taken. §1's tier list calls the file "append-only, keep" in the same
 * breath as "survives everything except full folder loss"; the two together are
 * why a session line is the one artifact record this store never rewrites.
 */
export const SESSION_STORE = 'sessions';
/** Index for "every session line of project P". */
export const SESSION_PROJECT_INDEX = 'byProject';

/**
 * One row per §5.1 checkpoint body snapshot.
 *
 * **Not the artifact's `.bak` ladder.** `paths.ts` already has `snapshotFile(n)`
 * and `SNAPSHOT_COUNT` for the manifest backup files, and the two are unrelated:
 * those are §5.3's *recovery* ladder on disk, these are §5.1's *undo* snapshots
 * in IndexedDB. The name collision is real and this comment is the only thing
 * standing between the next reader and a diff that moves the wrong tier.
 *
 * The key is `[projectId, docId, revision]` rather than a per-project ordinal,
 * because §5.1 rule 4 says a body unchanged since the last snapshot is not
 * re-stored — the checkpoint *references the existing snapshot*. Keying on the
 * revision a body was captured at makes that dedupe a property of the key: the
 * same revision cannot be written twice, so "re-stored" is impossible rather
 * than merely avoided. `retention.ts` owns the eviction ladder that walks these rows.
 */
export const SNAPSHOT_STORE = 'snapshots';
/** Index for "every snapshot of project P", so the retention sweep needs no key range. */
export const SNAPSHOT_PROJECT_INDEX = 'byProject';

/**
 * One row per agent run (agent-harness §5.1): its record, keyed by `runId`. The log of what the run did is the `runEvents` rows, one
 * per event, keyed `[runId, seq]` so a run's events are one contiguous range in the order they were appended. Neither store carries a
 * key, a header or a request body: the events hold the chat messages the harness built, which are the writer's own text.
 */
export const RUN_STORE = 'runs';
/** Index for "every run of project P". */
export const RUN_PROJECT_INDEX = 'byProject';
export const RUN_EVENT_STORE = 'runEvents';
/** Index for "every event of run R", read without a key range. */
export const RUN_EVENT_RUN_INDEX = 'byRun';

export interface ProjectRow {
  id: string;
  manifest: Manifest;
  storedAt: string;
  /**
   * `ProjectState.declinedCodexFiles`, flattened for storage: the `codex/*.md`
   * files the load that produced this row read and could not import.
   *
   * It lives here because this store rehydrates a `ProjectState` between
   * sessions, and a prune that ran against a rehydrated state which had
   * forgotten the load's reading would delete those files all over again — the
   * fix would hold for one session and quietly stop holding after a restart,
   * which is the same defect wearing a shorter fuse. Optional, because a row
   * written before this field existed reads back without it, and absent means
   * "this row's load declined nothing", not "prune anything".
   */
  declinedCodexFiles?: string[];
  /**
   * `ProjectState.declinedDocFiles`, flattened for storage — the same contract as
   * {@link declinedCodexFiles}, for `docs/*.md` files the load named for a node
   * that is not a document. Optional for the same reason: absent is "declined
   * nothing", and a row written before this field existed reads back without it.
   */
  declinedDocFiles?: string[];
  /**
   * `ProjectState.declinedText`, flattened: the path → text of every file the load
   * declined. The sets above say which files to keep; this is what they held, so an
   * export from a rehydrated state still carries them. Optional, and absent
   * means "declined nothing".
   */
  declinedText?: Record<string, string>;
  /**
   * The project's coherence artifact set (coherence.md §3), by its project-relative path: `coherence.json`, its
   * `.bak.N` snapshots and any kept `.corrupt-<ts>` copy. It is the store's home for the file, the way the rows above
   * are for the load's declines: the coherence module reads and writes it through `ArtifactFs`, and the app mirrors that
   * set here. Optional, and absent means "no file yet", which is what a project that never ran a check has.
   *
   * It is not part of the manifest, so a manifest write leaves it alone (`commitProject` and `writeProjectState` carry it
   * across), and the only writer is {@link writeCoherenceFiles}.
   */
  coherenceFiles?: Record<string, string>;
  /**
   * `ProjectState.skills`, flattened: every skill file by its path inside `.agents/skills/` (`<folder>/<path>`), as bytes. The
   * store is a view over the state, so a rehydrated state holds the skills the project had. Optional, and absent means no skills,
   * which is what a row written before skills existed has. A structural commit carries it across, as it does `declinedText`.
   */
  skillFiles?: Record<string, Uint8Array>;
}

export interface DocumentRow {
  projectId: string;
  id: string;
  body: string;
  revision: number;
}

/**
 * One `sessions.jsonl` line. The A5 record travels whole and unflattened: the
 * line *is* the record, so a reader of the store and a reader of the file see the
 * same four fields rather than a storage shape and a file shape that have to be
 * translated. `index` is the line number, and it is the append-only guarantee.
 */
export interface SessionRow {
  projectId: string;
  index: number;
  record: SessionRecord;
}

/**
 * One §5.1 checkpoint snapshot: the body a document held **before** a
 * compensable text mutation replaced it.
 *
 * `revision` is the document revision the captured body was at. It is the key's
 * part that keeps one body from being captured twice at the same revision. The
 * restore does not put it back: the undo is a write, so the document's revision
 * moves up past it.
 */
export interface SnapshotRow {
  projectId: string;
  docId: string;
  revision: number;
  /** The full pre-mutation body. §5.1 rule 1: full snapshots, not deltas. */
  body: string;
  /** Epoch ms of the capture — display and retention ordering only (§5.1 rule 3). */
  capturedAt: number;
  /** The command that captured it, so a restore can name what it is undoing. */
  command: string;
}

export interface RuntimeStore {
  readonly db: IDBDatabase;
  readonly name: string;
  close(): void;
}

function documentKey(projectId: string, docId: string): IDBValidKey {
  return [projectId, docId];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A document-writing command carried an `expectedRevision` that no longer
 * holds. [command-bus.md](docs/architecture/command-bus.md) §6 turns this into
 * `CommandError('conflict', 'doc was modified since plan (rev N → M)')`; the
 * store throws the fact and lets the bus own the envelope, because the bus is
 * where the undo group and the callId dedupe live.
 */
export class RevisionConflictError extends Error {
  constructor(
    readonly docId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `doc was modified since the write was planned (rev ${expected} → ${actual}): ${docId}`,
    );
    this.name = 'RevisionConflictError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`no project "${projectId}" in the runtime store`);
    this.name = 'ProjectNotFoundError';
  }
}

/**
 * This tab's connection to the runtime store was closed because another tab opened the database at a newer version.
 *
 * A newer build of Caotang has upgraded the store, and this build does not know that schema, so it cannot write to it. The browser
 * refuses to reopen at this build's version for the same reason, so the way forward is a reload of this tab, which opens the store
 * at the newer version. Every use of the closed connection is refused with this error, rather than the browser's `InvalidStateError`,
 * so the writer's save state names the cause.
 */
export class RuntimeStoreStaleError extends Error {
  constructor() {
    super(
      'Caotang was updated in another tab, so this tab can no longer save to browser storage. Reload this tab to keep working. Export a backup first to keep the words typed here.',
    );
    this.name = 'RuntimeStoreStaleError';
  }
}

/** The connections another tab's version change closed (see `openRuntimeStore`), so each later use can say why it is closed. */
const upgradedConnections = new WeakSet<IDBDatabase>();

/**
 * The store another tab upgraded, and this build is older than: the browser refuses this build's open of it (`VersionError`). A reload
 * of this tab is the way to the newer build, so the message says that, rather than the browser's own text.
 */
export class RuntimeStoreNewerError extends Error {
  constructor() {
    super(
      'Caotang was updated in another tab, and this tab is still the older version, so it cannot open your projects. Reload this tab to get the updated version. If this message stays, close the other Caotang tabs and reload this one.',
    );
    this.name = 'RuntimeStoreNewerError';
  }
}

/**
 * Throws {@link RuntimeStoreStaleError} when another tab upgraded the store and closed this connection. A caller that reads or writes the
 * store outside this file's own transactions calls it first, so its refusal names the cause rather than the browser's `InvalidStateError`.
 */
export function requireLiveConnection(store: RuntimeStore): void {
  if (upgradedConnections.has(store.db)) throw new RuntimeStoreStaleError();
}

/**
 * A `commitProject` named a document row that already exists.
 *
 * `createDocuments` means *create*. An id that is already in the store is a
 * command replayed against a tree that has moved, or a command built from a
 * stale one — and writing the row would replace a body the author has, so the
 * commit is refused whole rather than half-applied.
 *
 * The store raises the refusal either way: this class exists so the refusal
 * **names the document**, which `ConstraintError` does not. One structural
 * commit creates several rows in one transaction, and a caller that cannot say
 * which id collided cannot write a message anyone can act on — see
 * `RevisionConflictError` for the same trade, and command-bus.md §6, which owns
 * the `CommandError` envelope this fact is turned into.
 */
export class DocumentExistsError extends Error {
  constructor(
    readonly projectId: string,
    readonly docId: string,
  ) {
    super(`cannot create "${docId}": that row already exists in project "${projectId}"`);
    this.name = 'DocumentExistsError';
  }
}

/**
 * A snapshot was captured for a revision that already has one.
 *
 * §5.1 rule 4's dedupe is expressed by the key, so this refusal is what a
 * duplicate capture *looks like* rather than a silent overwrite. The caller
 * (`restore` in the compensable applies) treats it as the success it is — a
 * second snapshot of an unchanged body is the same snapshot — and a caller that
 * meant to replace a body at a revision it has already snapshotted has a real
 * bug worth naming. Same trade as `DocumentExistsError`, for the same reason.
 */
export class SnapshotExistsError extends Error {
  constructor(
    readonly projectId: string,
    readonly docId: string,
    readonly revision: number,
  ) {
    super(
      `cannot capture "${docId}" at revision ${revision}: project "${projectId}" already has that snapshot`,
    );
    this.name = 'SnapshotExistsError';
  }
}

// ---------------------------------------------------------------------------
// The transaction primitive
// ---------------------------------------------------------------------------

/**
 * Run `body` in one transaction and settle on the transaction's own outcome.
 *
 * The promise resolves on `complete` and rejects on `abort`, so a caller that
 * awaits a write is waiting for the commit rather than for the request that
 * proposed it. `body` is called synchronously with the transaction still
 * active, and may issue further requests from inside a request callback — that
 * is the only window IndexedDB gives, and it is why there is no `await` in any
 * transaction body in this file.
 */
export function transact<T>(
  db: IDBDatabase,
  storeNames: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction, done: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T | undefined;
    // The first real cause of the failure, which is what the promise rejects with. An echo of the abort is not a cause (see
    // `isAbortEcho`): a request still queued when the transaction aborts errors with `AbortError`, and that must not replace the
    // refusal that aborted it.
    let cause: unknown;
    let caused = false;

    if (upgradedConnections.has(db)) {
      reject(new RuntimeStoreStaleError());
      return;
    }
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (error) {
      reject(upgradedConnections.has(db) ? new RuntimeStoreStaleError() : error);
      return;
    }

    const done = (value: T): void => {
      result = value;
    };
    const fail = (error: unknown): void => {
      if (!caused && !isAbortEcho(error)) {
        caused = true;
        cause = error;
      }
      try {
        tx.abort();
      } catch {
        // Already finished — the abort event below still settles the promise.
      }
    };

    tx.oncomplete = () => {
      if (caused) reject(cause);
      else resolve(result as T);
    };
    // With no cause of ours, the promise rejects with the transaction's own error: the browser's reason for the abort.
    tx.onabort = () => {
      if (caused) reject(cause);
      else reject(tx.error ?? new Error('the transaction was aborted'));
    };

    try {
      body(tx, done, fail);
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * The errors that say a transaction has already ended, rather than what went wrong inside it. A request issued on a transaction
 * that has finished throws `TransactionInactiveError` (`InvalidStateError` from `objectStore`), and a request still queued when the
 * transaction aborts errors with `AbortError`. Each is a consequence of the transaction's ending, so the abort reports it.
 */
export function isAbortEcho(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'TransactionInactiveError' || name === 'InvalidStateError' || name === 'AbortError';
}

/**
 * Wraps a request callback, so an exception it throws is a failure of its transaction rather than an unhandled error out of the
 * event loop. A callback runs while its transaction is active, but the requests it issues can find the transaction already aborted
 * by an earlier failure in the same transaction. The thrown error is then an echo of that abort, and the abort settles the promise.
 */
export function guarded(fail: (error: unknown) => void, callback: () => void): () => void {
  return () => {
    try {
      callback();
    } catch (error) {
      fail(error);
    }
  };
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Open (and if necessary create) the runtime store.
 *
 * The factory is a parameter rather than a global so the browser binding and
 * the in-memory binding are interchangeable — that is the seam the plan
 * reserves for an OPFS fallback, and it means the store's tests run headless
 * with no new dependency.
 */
export function openRuntimeStore(
  factory: IDBFactory,
  name: string = RUNTIME_DB_NAME,
): Promise<RuntimeStore> {
  return new Promise<RuntimeStore>((resolve, reject) => {
    const request = factory.open(name, RUNTIME_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(DOCUMENT_STORE)) {
        // A compound key so one project is one contiguous key range and the
        // rows stay separable without a second store per project.
        const documents = db.createObjectStore(DOCUMENT_STORE, {
          keyPath: ['projectId', 'id'],
        });
        documents.createIndex(DOCUMENT_PROJECT_INDEX, 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        // Same compound key as documents, so a project's lines are one
        // contiguous range and the key order *is* the log order. The second
        // component is the line number, which is why the binding compares
        // compound keys component-wise — `["p",10]` is after `["p",2]`, and a
        // string comparison of the whole key would say otherwise.
        const sessions = db.createObjectStore(SESSION_STORE, {
          keyPath: ['projectId', 'index'],
        });
        sessions.createIndex(SESSION_PROJECT_INDEX, 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        // `[projectId, docId, revision]` — see `SnapshotRow`'s own comment. The
        // revision is the last key component, so a project's snapshots are one
        // contiguous range and **the same body cannot be captured twice at the
        // same revision**, which is §5.1 rule 4 as a constraint the runtime
        // enforces rather than a check a caller might forget.
        const snapshots = db.createObjectStore(SNAPSHOT_STORE, {
          keyPath: ['projectId', 'docId', 'revision'],
        });
        snapshots.createIndex(SNAPSHOT_PROJECT_INDEX, 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains(RUN_STORE)) {
        const runs = db.createObjectStore(RUN_STORE, { keyPath: 'runId' });
        runs.createIndex(RUN_PROJECT_INDEX, 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains(RUN_EVENT_STORE)) {
        const events = db.createObjectStore(RUN_EVENT_STORE, { keyPath: ['runId', 'seq'] });
        events.createIndex(RUN_EVENT_RUN_INDEX, 'runId', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab asking for a newer version must not be blocked by this
      // connection holding the old one open forever, so the cooperative half of
      // the version-change handshake lives here. The connection is marked first, so
      // a later write says it was closed by an upgrade (RuntimeStoreStaleError).
      db.onversionchange = () => {
        upgradedConnections.add(db);
        db.close();
      };
      resolve({ db, name, close: () => db.close() });
    };
    request.onerror = () => {
      if (request.error?.name === 'VersionError') reject(new RuntimeStoreNewerError());
      else reject(request.error ?? new Error(`could not open the runtime store "${name}"`));
    };
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every project id in the runtime store, sorted. */
export function listProjectIds(store: RuntimeStore): Promise<string[]> {
  return transact<string[]>(store.db, [PROJECT_STORE], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore(PROJECT_STORE).getAll();
    request.onsuccess = guarded(fail, () => {
      const rows = request.result as ProjectRow[];
      done(rows.map((row) => row.id).sort());
    });
  });
}

/**
 * Rebuild the in-memory project state from the runtime store.
 *
 * Revisions come back as stored, not as zero: see the module header on why a
 * reload must not restart the counter.
 */
export function readProjectState(
  store: RuntimeStore,
  projectId: string,
): Promise<ProjectState> {
  return transact<ProjectState>(
    store.db,
    [PROJECT_STORE, DOCUMENT_STORE],
    'readonly',
    (tx, done, fail) => {
      const documents = tx.objectStore(DOCUMENT_STORE);
      const projectRequest = tx.objectStore(PROJECT_STORE).get(projectId);

      projectRequest.onsuccess = guarded(fail, () => {
        const row = projectRequest.result as ProjectRow | undefined;
        if (!row) {
          fail(new ProjectNotFoundError(projectId));
          return;
        }
        // A `const` local keeps the narrowing; the manifest is the one value
        // the second request depends on.
        const manifest = row.manifest;
        const documentsRequest = documents.index(DOCUMENT_PROJECT_INDEX).getAll(projectId);
        documentsRequest.onsuccess = guarded(fail, () => {
          const rows = documentsRequest.result as DocumentRow[];
          const state = createProjectState(manifest);
          for (const name of row.declinedCodexFiles ?? []) {
            state.declinedCodexFiles.add(name);
          }
          for (const name of row.declinedDocFiles ?? []) {
            state.declinedDocFiles.add(name);
          }
          for (const [path, text] of Object.entries(row.declinedText ?? {})) {
            state.declinedText.set(path, text);
          }
          for (const [path, bytes] of Object.entries(row.skillFiles ?? {})) {
            const slash = path.indexOf('/');
            const folder = path.slice(0, slash);
            const files = state.skills.get(folder) ?? [];
            files.push({ path: path.slice(slash + 1), bytes: bytes.slice() });
            state.skills.set(folder, files);
          }
          for (const files of state.skills.values()) files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
          for (const document of rows) {
            state.documents.set(document.id, {
              id: document.id,
              body: document.body,
              revision: document.revision,
            });
          }
          // §2's "loader recomputes on open if absent", and this is the *other*
          // loader. Added, and it is not a duplicate of `readProject`'s
          // call for a measured reason: a project row written by a build before
          // the counts had a producer carries `"wordCounts": {}`, so rehydrating
          // it reproduces exactly the state the artifact loader has to repair —
          // and this one was reachable without any filesystem involved at all.
          // Runs after the rows are in, for the same reason `readProject` does:
          // the documents are the input.
          //
          // In-memory only, like every rebuild here — the durable row is written
          // by the next `commitProject`, and §2 makes the field a cache.
          rebuildDerived(state);
          done(state);
        });
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface ProjectCommit {
  projectId: string;
  manifest: Manifest;
  /**
   * Documents this change **creates**. An entry naming a row that already exists
   * is refused — the whole commit, with `DocumentExistsError` — so no body and
   * no revision is overwritten by a call that meant to add a node.
   *
   * `writeDocumentBody` is the only writer on the **ordinary** path, and the only
   * one that *bumps* a revision; that is what makes §4's "every mutation bumps a
   * per-document revision" true where it is load-bearing — the autosave and
   * agent writes that carry an `expectedRevision`. It is **not** true of the
   * whole store, and the exception is deliberate rather than overlooked:
   * `writeProjectState` writes bodies too and *assigns* the revisions its state
   * carries, so an import moves a counter (measured: an import over a document
   * at revision 3 lands it at 1). That path's own comment carries the reason —
   * an artifact has no revision, and nothing outside this store holds a
   * captured one — so §4's sentence is exactly true of `writeDocumentBody` and
   * approximately true of the store. Do not read a rewind through the wholesale
   * path as the failure this interface is about.
   *
   * "Refused" rather than "skipped" is load-bearing, and it was chosen over the
   * quieter alternative: an entry that already exists is not a harmless repeat,
   * it is a caller that believes it is adding a document and is not. Skipping it
   * would let the commit succeed with the addition silently missing, which is
   * the failure class this store's `add`-not-`put` discipline exists to remove.
   */
  createDocuments?: readonly { id: string; body?: string }[];
  /** Document ids whose node left the tree. Their rows go with them. */
  removeDocumentIds?: readonly string[];
  now?: Date;
}

/**
 * Commit a structural change — manifest plus the document rows it creates and
 * removes — in **one** transaction over both object stores.
 *
 * A command that both moves a node and rewrites a body must still be one
 * transaction; it cannot use this function, because the body's revision is
 * `writeDocumentBody`'s to bump. That case is the reason the two entry points
 * are separate rather than one general-purpose commit.
 *
 * **`createDocuments` is `add`, so a name that is taken refuses the whole
 * commit** rather than overwriting a body. The alternative — a read that leaves
 * an existing row alone — was the other half of the finding and was rejected:
 * it needs a read per document to reach a conclusion the store already has, and
 * its answer for a duplicate is a *silent* success in which the document the
 * caller meant to add is simply not there.
 *
 * `writeProjectState` keeps its `put`, on purpose and not by oversight: it is
 * the wholesale-replace path (import and export), where the state handed in
 * **is** the truth about what exists, so overwriting a row is the job rather
 * than an accident. Only the two functions that *decide* what a commit means
 * refuse to overwrite a row somebody else wrote.
 */
/** The state's skills as a row stores them: `<folder>/<path>` to bytes, copied. */
function skillFilesOf(state: ProjectState): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [folder, list] of state.skills) for (const file of list) files[`${folder}/${file.path}`] = file.bytes.slice();
  return files;
}

export function commitProject(store: RuntimeStore, commit: ProjectCommit): Promise<void> {
  const storedAt = (commit.now ?? new Date()).toISOString();
  return transact<void>(
    store.db,
    [PROJECT_STORE, DOCUMENT_STORE],
    'readwrite',
    (tx, _done, fail) => {
      const projects = tx.objectStore(PROJECT_STORE);
      const documents = tx.objectStore(DOCUMENT_STORE);
      // The row is read before it is written for one reason: `declinedCodexFiles`
      // belongs to the *load*, not to this commit. A structural commit carries a
      // manifest and nothing else, so a blind `put` would clear the record of
      // which `codex/*.md` files the loader could not read — and the next
      // artifact write would prune them, which is the exact data loss
      // `ProjectRow.declinedCodexFiles` exists to prevent. Read and write stay in
      // one transaction, so there is no window between them.
      const existingRequest = projects.get(commit.projectId);
      existingRequest.onsuccess = guarded(fail, () => {
        const previous = existingRequest.result as ProjectRow | undefined;
        const row: ProjectRow = { id: commit.projectId, manifest: commit.manifest, storedAt };
        if (previous?.declinedCodexFiles !== undefined) {
          row.declinedCodexFiles = [...previous.declinedCodexFiles];
        }
        if (previous?.declinedDocFiles !== undefined) {
          row.declinedDocFiles = [...previous.declinedDocFiles];
        }
        if (previous?.declinedText !== undefined) {
          row.declinedText = { ...previous.declinedText };
        }
        if (previous?.skillFiles !== undefined) {
          row.skillFiles = { ...previous.skillFiles };
        }
        // The coherence set is not the manifest's, so a structural commit keeps it (ProjectRow.coherenceFiles).
        if (previous?.coherenceFiles !== undefined) {
          row.coherenceFiles = { ...previous.coherenceFiles };
        }
        projects.put(row);
        for (const doc of commit.createDocuments ?? []) {
          // `add`, not `put`. A `put` at a key that is taken overwrites the row, so a
          // `createDocuments` entry naming a document that already exists would
          // replace its body and restart its revision at 0 — the one failure
          // the counter exists to prevent, and the exact opposite of what this
          // interface's own comment promises its callers.
          //
          // `sessions.jsonl` makes the same move, where a `put` would have
          // rewritten a line in a file that is append-only by definition. The point in
          // both cases is that the rule becomes **a constraint the runtime
          // enforces** rather than a check this function might forget or
          // reorder — the same reason the permission gate puts hard-deny ahead of the
          // inheritance branch instead of inside it.
          //
          // The refusal aborts the transaction, so the manifest swap staged
          // above, the other rows this commit creates and every id it removes go
          // with it. That is §4's "one transaction (atomic by construction)"
          // doing the work: a refused create cannot leave a new manifest
          // attached to a half-created document.
          const create = documents.add({
            projectId: commit.projectId,
            id: doc.id,
            body: doc.body ?? '',
            revision: 0,
          } satisfies DocumentRow);
          create.onerror = () => {
            // `ConstraintError` is the refusal; the id is the fact the caller
            // needs. Anything else is passed through rather than relabelled,
            // because a handler that maps every failure onto one diagnosis
            // hides the next fault behind this one.
            fail(
              create.error?.name === 'ConstraintError'
                ? new DocumentExistsError(commit.projectId, doc.id)
                : (create.error ?? new Error(`could not create "${doc.id}"`)),
            );
          };
        }
        for (const id of commit.removeDocumentIds ?? []) {
          documents.delete(documentKey(commit.projectId, id));
        }
      });
    },
  );
}

export interface WriteDocumentOptions {
  projectId: string;
  docId: string;
  body: string;
  /**
   * [command-bus.md](docs/architecture/command-bus.md) §6's optional optimistic
   * concurrency check. Omitted means "no opinion" — a write that is not guarding
   * against a concurrent change.
   *
   * The user typing path does **not** omit it, despite this looking like a
   * single-writer app where a guard has nothing to catch:
   * [editor-engine.md](docs/architecture/editor-engine.md) §9 is explicit that
   * "autosave flushes carry the revision they were based on", so the autosave
   * scheduler always supplies one. Omitting it there would make the counter
   * inert for the only writer that runs while the user is not looking, which is
   * exactly the window a second tab gets. See `runtime/autosave.ts`.
   */
  expectedRevision?: number;
}

export interface WriteDocumentResult {
  /** The revision after the write: `expected + 1`, or unchanged for a no-op. */
  revision: number;
  /** False when the body was already exactly this, so no revision was burned. */
  changed: boolean;
}

/**
 * Write a document body and bump its revision — one transaction, one row.
 *
 * The read that the `expectedRevision` guard needs happens *inside* this
 * transaction. That is the whole reason this function exists separately from
 * `commitProject`: the check and the write it guards must not be separated by a
 * task boundary, or a second tab can slip a write between them and the check
 * protects nothing.
 */
export function writeDocumentBody(
  store: RuntimeStore,
  options: WriteDocumentOptions,
): Promise<WriteDocumentResult> {
  return transact<WriteDocumentResult>(
    store.db,
    [DOCUMENT_STORE],
    'readwrite',
    (tx, done, fail) => {
      const documents = tx.objectStore(DOCUMENT_STORE);
      const key = documentKey(options.projectId, options.docId);
      const read = documents.get(key);
      read.onsuccess = guarded(fail, () => {
        const row = read.result as DocumentRow | undefined;
        if (!row) {
          fail(
            new ProjectNotFoundError(
              `${options.projectId}/${options.docId} — no document row to write`,
            ),
          );
          return;
        }
        if (
          options.expectedRevision !== undefined &&
          row.revision !== options.expectedRevision
        ) {
          fail(
            new RevisionConflictError(options.docId, options.expectedRevision, row.revision),
          );
          return;
        }
        if (row.body === options.body) {
          // An identical write is not a mutation, so it does not bump (§4).
          done({ revision: row.revision, changed: false });
          return;
        }
        const next: DocumentRow = {
          ...row,
          body: options.body,
          revision: row.revision + 1,
        };
        documents.put(next);
        done({ revision: next.revision, changed: true });
      });
    },
  );
}

export interface WriteProjectStateResult {
  /** Rows dropped because their document is no longer in the state. */
  removedDocumentIds: string[];
}

/**
 * Replace a project's stored state wholesale — the ingest and export path.
 *
 * This is the one function that writes bodies outside `writeDocumentBody`, and
 * it is the *state* that says what the revisions are: an artifact carries no
 * revision, so an import starts every document at 0, which is correct because
 * nothing outside this store can hold a captured revision.
 *
 * The reconcile is exact — a row whose document is absent is removed, and
 * reported. Anything else would resurrect a document the author deleted the
 * next time the project was exported.
 */
export function writeProjectState(
  store: RuntimeStore,
  state: ProjectState,
  options: { now?: Date } = {},
): Promise<WriteProjectStateResult> {
  const projectId = state.manifest.project.id;
  const storedAt = (options.now ?? new Date()).toISOString();
  return transact<WriteProjectStateResult>(
    store.db,
    [PROJECT_STORE, DOCUMENT_STORE],
    'readwrite',
    (tx, done, fail) => {
      const projects = tx.objectStore(PROJECT_STORE);
      const documents = tx.objectStore(DOCUMENT_STORE);
      const index = documents.index(DOCUMENT_PROJECT_INDEX);
      const project: ProjectRow = {
        id: projectId,
        manifest: state.manifest,
        storedAt,
        declinedCodexFiles: [...state.declinedCodexFiles],
        declinedDocFiles: [...state.declinedDocFiles],
        declinedText: Object.fromEntries(state.declinedText),
        ...(state.skills.size === 0 ? {} : { skillFiles: skillFilesOf(state) }),
      };
      // The coherence set is not in the state, so the row keeps the one it held (ProjectRow.coherenceFiles). The read
      // comes first in this transaction, so the put that follows it sees the row as it was.
      const previousRequest = projects.get(projectId);
      previousRequest.onsuccess = guarded(fail, () => {
        const previous = previousRequest.result as ProjectRow | undefined;
        if (previous?.coherenceFiles !== undefined) project.coherenceFiles = { ...previous.coherenceFiles };
        projects.put(project);
      });

      const records: DocumentRecord[] = [...state.documents.values()];
      for (const record of records) {
        documents.put({
          projectId,
          id: record.id,
          body: record.body,
          revision: record.revision,
        } satisfies DocumentRow);
      }

      const existingRequest = index.getAll(projectId);
      existingRequest.onsuccess = guarded(fail, () => {
        const existing = existingRequest.result as DocumentRow[];
        const wanted = new Set(records.map((r) => r.id));
        const removed: string[] = [];
        for (const row of existing) {
          if (wanted.has(row.id)) continue;
          removed.push(row.id);
          documents.delete(documentKey(projectId, row.id));
        }
        done({ removedDocumentIds: removed.sort() });
      });
    },
  );
}

/**
 * The project's coherence artifact set, by path (ProjectRow.coherenceFiles). A project with no set reads as none, which is
 * the empty file the coherence module starts from; a project that is not in the store at all is an error, since there is
 * nothing to attach a set to.
 */
export function readCoherenceFiles(store: RuntimeStore, projectId: string): Promise<Record<string, string>> {
  return transact<Record<string, string>>(store.db, [PROJECT_STORE], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore(PROJECT_STORE).get(projectId);
    request.onsuccess = guarded(fail, () => {
      const row = request.result as ProjectRow | undefined;
      if (!row) {
        fail(new ProjectNotFoundError(projectId));
        return;
      }
      done({ ...(row.coherenceFiles ?? {}) });
    });
  });
}

/**
 * Replaces the project's coherence artifact set with `files` (ProjectRow.coherenceFiles). It rewrites the whole set, because
 * the module's own save rotates snapshots, so a partial write would tear the set it is meant to protect. The manifest and
 * the bodies are not touched: this is one `put` of the project row, read and written in one transaction.
 */
export function writeCoherenceFiles(store: RuntimeStore, projectId: string, files: Readonly<Record<string, string>>): Promise<void> {
  return transact<void>(store.db, [PROJECT_STORE], 'readwrite', (tx, done, fail) => {
    const projects = tx.objectStore(PROJECT_STORE);
    const request = projects.get(projectId);
    request.onsuccess = guarded(fail, () => {
      const row = request.result as ProjectRow | undefined;
      if (!row) {
        fail(new ProjectNotFoundError(projectId));
        return;
      }
      projects.put({ ...row, coherenceFiles: { ...files } });
      done(undefined);
    });
  });
}

/**
 * Replaces the project's skills with `skills` (ProjectRow.skillFiles): one `put` of the project row, read and written in one
 * transaction. The manifest and the bodies are not touched, so a change to a skill does not restate the manuscript.
 */
export function writeProjectSkills(
  store: RuntimeStore,
  projectId: string,
  skills: ReadonlyMap<string, readonly { readonly path: string; readonly bytes: Uint8Array }[]>,
): Promise<void> {
  return transact<void>(store.db, [PROJECT_STORE], 'readwrite', (tx, done, fail) => {
    const projects = tx.objectStore(PROJECT_STORE);
    const request = projects.get(projectId);
    request.onsuccess = guarded(fail, () => {
      const row = request.result as ProjectRow | undefined;
      if (!row) {
        fail(new ProjectNotFoundError(projectId));
        return;
      }
      const next: ProjectRow = { ...row };
      delete next.skillFiles;
      const files: Record<string, Uint8Array> = {};
      for (const [folder, list] of skills) for (const file of list) files[`${folder}/${file.path}`] = file.bytes.slice();
      if (Object.keys(files).length > 0) next.skillFiles = files;
      projects.put(next);
      done(undefined);
    });
  });
}

/**
 * Append one line to a project's session log — one transaction, one `add`.
 *
 * §4: "`sessions.jsonl` — append-only, never rewritten, survives everything
 * except full folder loss." Two parts of that sentence are load-bearing here and
 * neither is about timing.
 *
 * **The line number is read inside this transaction.** Choosing the index in
 * JavaScript and then opening a transaction is the check-then-act race with a
 * different payload: two sessions ended in the same tick would both compute
 * "next is 4", and the second would either overwrite the first's line or fail.
 * The read and the write belong together, and the directional readwrite
 * serialization already in the binding is what makes the second one wait rather
 * than race.
 *
 * **`add`, not `put`.** A put at a taken index overwrites a line, which is the
 * one thing the format forbids, and it would do it silently. `add` refuses the
 * duplicate key, so "never rewritten" is a property of the store call rather than
 * a promise in a comment — the class of bug this log exists to avoid, turned
 * into a constraint the runtime enforces.
 *
 * The record is validated *before* the transaction opens: a line no reader
 * accepts is worse than a refused write, because it would be skipped silently by
 * every future read of this project's history.
 */
export async function appendSession(
  store: RuntimeStore,
  request: { projectId: string; record: SessionRecord },
): Promise<void> {
  // `async` so a refused record *rejects* rather than throwing out of the call:
  // every other failure of a store write arrives as a rejection, and a caller
  // that chains `.catch` (or `Promise.all` over several appends) must not have to
  // know that this one validation happens before the promise exists.
  assertSessionRecord(request.record, 'appendSession');
  return transact<void>(store.db, [SESSION_STORE], 'readwrite', (tx, done, fail) => {
    const sessions = tx.objectStore(SESSION_STORE);
    const existing = sessions.index(SESSION_PROJECT_INDEX).getAll(request.projectId);
    existing.onsuccess = guarded(fail, () => {
      const rows = existing.result as SessionRow[];
      // Highest index plus one, not the row count: a log with a gap in it (an
      // import that seeded some lines, a hand-repaired file) must not have its
      // remaining lines overwritten by a line numbered from zero.
      const next = rows.reduce((max, row) => (row.index > max ? row.index : max), -1) + 1;
      sessions.add({
        projectId: request.projectId,
        index: next,
        record: request.record,
      } satisfies SessionRow);
      done();
    });
  });
}

/**
 * Every session line of a project, in the order they were appended.
 *
 * Order is the log: §4's `endedAt`-per-line consumers ([goals-progress.md
 * §2.1](docs/architecture/goals-progress.md)) sum a day, and
 * [goals-progress.md §9](docs/architecture/goals-progress.md) reconstructs a
 * history from these lines, so an out-of-order read is a wrong number rather
 * than a cosmetic one. The index `getAll` returns rows in primary-key order, and
 * the primary key is `[projectId, index]`.
 */
export function readSessions(store: RuntimeStore, projectId: string): Promise<SessionRecord[]> {
  return transact<SessionRecord[]>(store.db, [SESSION_STORE], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore(SESSION_STORE).index(SESSION_PROJECT_INDEX).getAll(projectId);
    request.onsuccess = guarded(fail, () => {
      const rows = request.result as SessionRow[];
      done(rows.map((row) => row.record));
    });
  });
}

/**
 * Capture one §5.1 checkpoint snapshot — one transaction, one `add`.
 *
 * **Two mechanisms hold rule 4's dedupe, and no test can tell which one did.**
 * The key carries the revision, so a `put` at a taken key would silently replace
 * a body a checkpoint is relying on; the in-transaction `get` below refuses it
 * first, and `add` would refuse it too. **Measured both ways, and
 * the asymmetry is the point:** reverting `add` to `put` leaves all 27 tests in
 * `compensable.test.ts` green, and neutralising the `get` leaves exactly one
 * failing — the same test. Either mechanism alone is sufficient, so each masks
 * the other and neither is load-bearing on its own. Keep both; do not cite one of
 * them as the guard.
 *
 * The *named* refusal (`SnapshotExistsError`) is the `get`'s, not `add`'s — `add`
 * would abort the transaction with a raw `ConstraintError`. That is why both are
 * here: the `get` names the row, `add` refuses it whatever the read says.
 *
 * **What this refuses, exactly: a second capture at a revision already held.**
 * The body is validated for nothing else — no size limit (rule 1 is "full bodies,
 * not deltas"), and **no check that the document has a row**. Measured: a
 * capture for a `docId` with no row is accepted and persisted, because the
 * transaction spans `[SNAPSHOT_STORE]` alone. The bus path cannot reach that
 * (commands.ts's `requireDocument` throws first), but this function is exported
 * from the package, so a retention or recovery caller can. Whether a snapshot
 * naming no document is a refusal worth having is a separate decision; the
 * guarantee here is only the dedupe, and only that is tested.
 */
export async function writeBodySnapshot(
  store: RuntimeStore,
  snapshot: Omit<SnapshotRow, 'projectId'> & { projectId: string },
): Promise<void> {
  return transact<void>(store.db, [SNAPSHOT_STORE], 'readwrite', (tx, done, fail) => {
    const snapshots = tx.objectStore(SNAPSHOT_STORE);
    const existing = snapshots.get([
      snapshot.projectId,
      snapshot.docId,
      snapshot.revision,
    ]);
    existing.onsuccess = guarded(fail, () => {
      if (existing.result !== undefined) {
        fail(
          new SnapshotExistsError(snapshot.projectId, snapshot.docId, snapshot.revision),
        );
        return;
      }
      snapshots.add(snapshot satisfies SnapshotRow);
      done();
    });
  });
}

/**
 * Every snapshot of one project, in primary-key order — `[projectId, docId,
 * revision]`, so grouped by document and ascending by revision within it.
 *
 * That order is what the retention sweep needs, and it is the order the *key*
 * already has: no sort is performed here, because a sort the caller cannot see
 * is a second definition of the same ordering.
 */
export function readBodySnapshots(store: RuntimeStore, projectId: string): Promise<SnapshotRow[]> {
  return transact<SnapshotRow[]>(store.db, [SNAPSHOT_STORE], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore(SNAPSHOT_STORE).index(SNAPSHOT_PROJECT_INDEX).getAll(projectId);
    request.onsuccess = guarded(fail, () => {
      done(request.result as SnapshotRow[]);
    });
  });
}

/** Drop a project and all of its documents, session lines, snapshots, runs and run events — one transaction, six stores. */
export function deleteProject(store: RuntimeStore, projectId: string): Promise<boolean> {
  return transact<boolean>(
    store.db,
    [PROJECT_STORE, DOCUMENT_STORE, SESSION_STORE, SNAPSHOT_STORE, RUN_STORE, RUN_EVENT_STORE],
    'readwrite',
    (tx, done, fail) => {
      const projects = tx.objectStore(PROJECT_STORE);
      const documents = tx.objectStore(DOCUMENT_STORE);
      const sessions = tx.objectStore(SESSION_STORE);
      const snapshots = tx.objectStore(SNAPSHOT_STORE);
      const existing = projects.get(projectId);
      existing.onsuccess = guarded(fail, () => {
        const existed = existing.result !== undefined;
        projects.delete(projectId);
        const rowsRequest = documents.index(DOCUMENT_PROJECT_INDEX).getAll(projectId);
        const sessionsRequest = sessions.index(SESSION_PROJECT_INDEX).getAll(projectId);
        const snapshotsRequest = snapshots.index(SNAPSHOT_PROJECT_INDEX).getAll(projectId);
        rowsRequest.onsuccess = guarded(fail, () => {
          for (const row of rowsRequest.result as DocumentRow[]) {
            documents.delete(documentKey(projectId, row.id));
          }
          sessionsRequest.onsuccess = guarded(fail, () => {
            for (const row of sessionsRequest.result as SessionRow[]) {
              sessions.delete([projectId, row.index]);
            }
            snapshotsRequest.onsuccess = guarded(fail, () => {
              // Snapshots go with the project in the *same* transaction, and
              // that is §5.1 rule 6 rather than a nicety: a surviving snapshot
              // is a full copy of a body the author deleted, which is the
              // unbounded-growth class the rule exists to prevent — reached here
              // by deleting a project rather than by evicting a checkpoint.
              for (const row of snapshotsRequest.result as SnapshotRow[]) {
                snapshots.delete([projectId, row.docId, row.revision]);
              }
              // The project's agent runs and their events go with it (agent-harness §5.1): a run log holds the writer's own text.
              const runs = tx.objectStore(RUN_STORE);
              const runEvents = tx.objectStore(RUN_EVENT_STORE);
              const runsRequest = runs.index(RUN_PROJECT_INDEX).getAll(projectId);
              runsRequest.onsuccess = guarded(fail, () => {
                const ids = (runsRequest.result as { runId: string }[]).map((row) => row.runId);
                for (const id of ids) runs.delete(id);
                let left = ids.length;
                if (left === 0) {
                  done(existed);
                  return;
                }
                for (const id of ids) {
                  const eventsRequest = runEvents.index(RUN_EVENT_RUN_INDEX).getAll(id);
                  eventsRequest.onsuccess = guarded(fail, () => {
                    for (const event of eventsRequest.result as { runId: string; seq: number }[]) runEvents.delete([event.runId, event.seq]);
                    left -= 1;
                    if (left === 0) done(existed);
                  });
                }
              });
            });
          });
        });
      });
    },
  );
}
