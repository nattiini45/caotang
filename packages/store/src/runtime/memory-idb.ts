/**
 * In-memory IndexedDB — the headless binding for the runtime store.
 *
 * [project-format.md §4](docs/architecture/project-format.md) puts the working
 * store in IndexedDB, and §8 makes it the runtime truth: "all commands
 * read/write the runtime store". The store code is therefore browser code, and
 * the honest way to test browser code is to run it against a real
 * implementation of the browser API — not against a bag of arrays that agrees
 * with whatever the store happens to do.
 *
 * So this is a *binding*, in the same sense `MemoryArtifactFs` is the artifact
 * filesystem's binding: the browser's `indexedDB` and this class both satisfy
 * `IDBFactory`, and the store is written against that interface alone. Being
 * typed `implements IDBFactory` is the point — a store that misuses the API
 * fails typecheck here rather than quietly agreeing with a permissive fake.
 *
 * **What it models, and why each part matters.** IndexedDB's guarantees are all
 * consequences of two rules, and a fake that omits either one lets the store
 * pass tests a browser would fail:
 *
 *  1. **A transaction is atomic and isolated.** Writes land in a per-transaction
 *     overlay and reach the shared store only when the transaction commits; an
 *     abort anywhere in it discards *everything* it wrote and no other
 *     connection ever saw any of it. This is the whole of §4's "atomic by
 *     construction", so `abortAfterWrites` exists to make an abort observable
 *     part-way through a transaction.
 *  2. **A transaction is only usable while it is active.** Between tasks —
 *     after an `await`, after any `setTimeout` — it is closed to new requests
 *     and using one throws `TransactionInactiveError`. That is why real IDB code
 *     chains requests in callbacks instead of awaiting them, and this fake
 *     throws rather than pretending otherwise.
 *
 * On top of those: read-your-write inside a transaction, and readwrite
 * transactions touching the same stores running in creation order, which is
 * what makes two tabs editing one document serialize instead of interleave.
 */

type DomExceptionName =
  | 'AbortError'
  | 'ConstraintError'
  | 'DataError'
  | 'InvalidAccessError'
  | 'InvalidStateError'
  | 'NotFoundError'
  | 'NotSupportedError'
  | 'QuotaExceededError'
  | 'TransactionInactiveError'
  | 'UnknownError'
  | 'VersionError';

function domError(name: DomExceptionName, message: string): Error {
  const Ctor = DOMException as unknown as new (m: string, n: string) => Error;
  return new Ctor(message, name);
}

/** For the parts of the API this binding deliberately does not model. */
function notSupported(what: string): Error {
  return domError('NotSupportedError', `${what} is not modelled by MemoryIndexedDb`);
}

/** Stable string form of an IndexedDB key, so compound keys can key a Map. */
function keyId(key: IDBValidKey): string {
  return JSON.stringify(key);
}

/**
 * Compare keys well enough for `IDBFactory.cmp` and record ordering.
 *
 * A compound key is compared **component-wise**, as IndexedDB specifies. That is
 * not a detail: every compound store in this package keys on `[projectId, …]` —
 * `[projectId, index]` for sessions, `[projectId, id]` for documents, and
 * `[projectId, docId, revision]` for the snapshots — and a whole-key string
 * comparison puts `["p",10]` *before* `["p",2]` ("p,10" < "p,2"). A session log
 * with eleven lines would then read back out of order, and a reader would sum a
 * day's words from the wrong sequence. Found by the ordering test rather than
 * by foresight, which is the argument for writing a test that counts past nine.
 *
 * The loop is over `Math.min` of the two lengths and a length difference
 * settles the rest, so a two-part key and a three-part key at the same project
 * compare correctly and arithmetically — which is what the snapshot key needs
 * to sort by revision within a document, with a *string* in the middle.
 */
function compareKeys(a: unknown, b: unknown): number {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      // Real IndexedDB has no ordering between a key and an array key; the
      // binding's only arrays are compound keys, so this cannot arise from the
      // store. Sorted by kind so the comparison stays total.
      return Array.isArray(a) ? 1 : -1;
    }
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      const part = compareKeys(a[i], b[i]);
      if (part !== 0) return part;
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function readPath(value: unknown, path: string[]): unknown {
  let cursor: unknown = value;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function makeStringList(values: string[]): DOMStringList {
  const list: Record<string, unknown> = {
    length: values.length,
    item: (i: number): string | null => values[i] ?? null,
    // `contains` is the member every real caller reaches for first; a
    // DOMStringList without it fails the caller, not the binding.
    contains: (value: string): boolean => values.includes(value),
  };
  values.forEach((value, i) => {
    list[i] = value;
  });
  return list as unknown as DOMStringList;
}

// ---------------------------------------------------------------------------
// Backing storage — owned by the factory, shared by every connection to a name.
// ---------------------------------------------------------------------------

interface StoredRecord {
  key: IDBValidKey;
  value: unknown;
}

class BackingStore {
  readonly records = new Map<string, StoredRecord>();
  /** index name → key-path segments. */
  readonly indexes = new Map<string, string[]>();

  constructor(
    readonly name: string,
    readonly keyPath: string | string[],
    readonly autoIncrement: boolean,
  ) {}

  /** The same key path as segments, for reading a value's key out of it. */
  get keySegments(): string[] {
    return Array.isArray(this.keyPath) ? this.keyPath : [this.keyPath];
  }

  createIndex(name: string, keyPath: string | string[]): void {
    this.indexes.set(name, Array.isArray(keyPath) ? keyPath : [keyPath]);
  }

  put(key: IDBValidKey, value: unknown): void {
    this.records.set(keyId(key), { key, value: structuredClone(value) });
  }

  delete(key: IDBValidKey): void {
    this.records.delete(keyId(key));
  }

  get(key: IDBValidKey): StoredRecord | undefined {
    return this.records.get(keyId(key));
  }

  sorted(): StoredRecord[] {
    return [...this.records.values()].sort((a, b) => compareKeys(a.key, b.key));
  }
}

interface FactoryData {
  version: number;
  stores: Map<string, BackingStore>;
}

function versionChangeEvent(type: string, oldVersion: number, newVersion: number): IDBVersionChangeEvent {
  const event = new Event(type) as IDBVersionChangeEvent;
  Object.defineProperties(event, {
    oldVersion: { value: oldVersion },
    newVersion: { value: newVersion },
  });
  return event;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * What every request kind shares.
 *
 * The event-handler properties are declared on the *concrete* classes using
 * DOM's own indexed types (`IDBRequest<T>['onsuccess']`) rather than restating
 * them. Restating them is how a fake quietly stops being the thing it claims to
 * implement; borrowing the declaration cannot drift.
 */
abstract class FakeRequestBase extends EventTarget {
  error: DOMException | null = null;
  readonly readyState: IDBRequestReadyState = 'pending';

  protected setDone(): void {
    Object.defineProperty(this, 'readyState', { value: 'done', configurable: true });
  }

  protected fire(type: 'success' | 'error'): Event {
    const event = new Event(type);
    this.dispatchEvent(event);
    return event;
  }
}

class StoreRequest<T> extends FakeRequestBase implements IDBRequest<T> {
  result!: T;
  onsuccess: IDBRequest<T>['onsuccess'] = null;
  onerror: IDBRequest<T>['onerror'] = null;
  aborted = false;

  constructor(
    private readonly tx: FakeTransaction,
    readonly source: IDBObjectStore | IDBIndex,
    private readonly run: () => T,
  ) {
    super();
    this.tx.enqueue(this);
  }

  get transaction(): IDBTransaction {
    return this.tx;
  }

  deliver(): void {
    if (this.tx.finished) {
      this.failAborted();
      return;
    }
    this.tx.runActive(() => {
      // Two kinds of throw are told apart. An error out of `run` is the request's own failure, as the spec has it. An error out of the
      // success callback is a bug in that callback: a browser reports it as an uncaught exception, and this binding records it, so a
      // test can see it (`MemoryIndexedDb.handlerErrors`). Both abort the transaction, as they do in a browser.
      let ran = false;
      try {
        this.result = this.run();
        ran = true;
        this.setDone();
        this.onsuccess?.call(this, this.fire('success'));
      } catch (error) {
        if (ran) this.tx.recordHandlerError(error);
        // An unhandled request error aborts its transaction, as in the spec.
        this.setDone();
        this.error = error as DOMException;
        if (this.onerror?.call(this, this.fire('error')) !== true) {
          this.tx.abortWith(error as Error);
        }
      }
    });
  }

  /**
   * The failure of a request whose transaction ended before it ran: IndexedDB's AbortError, fired as an error event on the request. The
   * browser fires these before the transaction's own abort event, and `FakeTransaction.abortWith` queues them in that order.
   */
  failAborted(): void {
    this.aborted = true;
    this.setDone();
    this.error = domError('AbortError', 'the transaction was aborted') as DOMException;
    this.onerror?.call(this, this.fire('error'));
  }
}

class OpenRequestBase extends FakeRequestBase implements IDBOpenDBRequest {
  // `result` and `source` are typed as the interface declares them and are
  // never read by the store: an open request has no object store behind it.
  // A binding that invented values here would be the kind of plausible lie this
  // file exists to avoid.
  result!: IDBDatabase;
  source!: IDBObjectStore | IDBIndex | IDBCursor;
  onsuccess: IDBOpenDBRequest['onsuccess'] = null;
  onerror: IDBOpenDBRequest['onerror'] = null;
  onupgradeneeded: IDBOpenDBRequest['onupgradeneeded'] = null;
  onblocked: IDBOpenDBRequest['onblocked'] = null;
  transaction: IDBOpenDBRequest['transaction'] = null;
}

class OpenRequest extends OpenRequestBase {
  constructor(
    private readonly factory: MemoryIndexedDb,
    private readonly name: string,
    private readonly requested: number | undefined,
  ) {
    super();
    this.factory.queueOpen(this.name, () => this.run());
  }

  private upgrade(): FakeTransaction {
    return this.result.transaction([], 'versionchange') as FakeTransaction;
  }

  private run(connectionsClosed = false): void {
    const existing = this.factory.dataFor(this.name);
    const current = existing?.version ?? 0;
    const target = this.requested ?? (current === 0 ? 1 : current);

    if (this.requested !== undefined && this.requested < current) {
      this.setDone();
      this.error = domError(
        'VersionError',
        `requested version ${this.requested} is below the current version ${current}`,
      ) as DOMException;
      try {
        this.onerror?.call(this, this.fire('error'));
      } finally {
        this.factory.finishOpen(this.name);
      }
      return;
    }

    if (target > current && !connectionsClosed) {
      this.factory.waitForConnections(this.name, target, () => {
        const event = versionChangeEvent('blocked', current, target);
        this.dispatchEvent(event);
        this.onblocked?.call(this, event);
      }, () => this.run(true));
      return;
    }
    this.finishOpen(current, target);
  }

  private finishOpen(current: number, target: number): void {
    const existing = this.factory.dataFor(this.name);
    const data = existing ?? this.factory.createData(this.name, target);
    data.version = target;
    this.result = new FakeDatabase(this.factory, this.name, data);

    if (target > current) {
      // The upgrade transaction runs to completion before `success` is
      // delivered, so an `onupgradeneeded` handler can create object stores.
      const tx = this.upgrade();
      this.transaction = tx;
      const event = versionChangeEvent('upgradeneeded', current, target);
      const stores = new Map(data.stores);
      const indexes = new Map([...stores.values()].map((store) => [store, new Map(store.indexes)]));
      try {
        tx.runActive(() => {
          this.dispatchEvent(event);
          this.onupgradeneeded?.call(this, event);
        });
      } catch (error) {
        tx.recordHandlerError(error);
        tx.abortWith(domError('AbortError', 'the upgrade handler failed'));
      }
      if (tx.finished) {
        data.version = current;
        data.stores = stores;
        for (const [store, previous] of indexes) {
          store.indexes.clear();
          for (const [name, path] of previous) store.indexes.set(name, path);
        }
        if (existing === undefined) this.factory.dropData(this.name);
        this.result.close();
        queueMicrotask(() => {
          this.error = domError('AbortError', 'the version upgrade was aborted') as DOMException;
          this.setDone();
          try {
            this.onerror?.call(this, this.fire('error'));
          } finally {
            this.factory.finishOpen(this.name);
          }
        });
        return;
      }
      tx.finishVersionChange();
    }

    queueMicrotask(() => {
      this.setDone();
      try {
        this.onsuccess?.call(this, this.fire('success'));
      } finally {
        this.factory.finishOpen(this.name);
      }
    });
  }
}

class DeleteRequest extends OpenRequestBase {
  constructor(
    private readonly factory: MemoryIndexedDb,
    private readonly name: string,
  ) {
    super();
    queueMicrotask(() => {
      this.factory.dropData(this.name);
      this.setDone();
      this.onsuccess?.call(this, this.fire('success'));
    });
  }
}

// ---------------------------------------------------------------------------
// Object stores and indexes
// ---------------------------------------------------------------------------

class FakeObjectStore implements IDBObjectStore {
  readonly name: string;
  readonly keyPath: string | string[];
  readonly autoIncrement: boolean;

  constructor(
    readonly transaction: FakeTransaction,
    private readonly store: BackingStore,
  ) {
    this.name = store.name;
    this.keyPath = store.keyPath;
    this.autoIncrement = store.autoIncrement;
  }

  get indexNames(): DOMStringList {
    return makeStringList([...this.store.indexes.keys()]);
  }

  createIndex(name: string, keyPath: string | string[], _options?: IDBIndexParameters): IDBIndex {
    if (!this.transaction.isVersionChange) {
      throw domError('InvalidStateError', 'createIndex requires a versionchange transaction');
    }
    this.store.createIndex(name, keyPath);
    return new FakeIndex(this, this.store, name);
  }

  deleteIndex(name: string): void {
    this.store.indexes.delete(name);
  }

  index(name: string): IDBIndex {
    if (!this.store.indexes.has(name)) {
      throw domError('NotFoundError', `no index named "${name}" on "${this.name}"`);
    }
    return new FakeIndex(this, this.store, name);
  }

  get(key: IDBValidKey): IDBRequest<unknown> {
    this.transaction.assertActive('get');
    return new StoreRequest(this.transaction, this, () =>
      this.transaction.readOne(this.store, key),
    );
  }

  getAll(_query?: IDBValidKey | IDBKeyRange | null): IDBRequest<unknown[]> {
    this.transaction.assertActive('getAll');
    return new StoreRequest(this.transaction, this, () =>
      this.transaction.readAll(this.store),
    );
  }

  count(): IDBRequest<number> {
    this.transaction.assertActive('count');
    return new StoreRequest(this.transaction, this, () =>
      this.transaction.readAll(this.store).length,
    );
  }

  put(value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    this.transaction.assertActive('put');
    return new StoreRequest(this.transaction, this, () => {
      const resolved = key ?? this.transaction.keyForValue(this.store, value);
      this.transaction.stagePut(this.store, resolved, value);
      return resolved;
    });
  }

  add(value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    this.transaction.assertActive('add');
    return new StoreRequest(this.transaction, this, () => {
      const resolved = key ?? this.transaction.keyForValue(this.store, value);
      if (this.transaction.readOne(this.store, resolved) !== undefined) {
        throw domError('ConstraintError', `key already exists in "${this.name}"`);
      }
      this.transaction.stagePut(this.store, resolved, value);
      return resolved;
    });
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    this.transaction.assertActive('delete');
    return new StoreRequest(this.transaction, this, () => {
      this.transaction.stageDelete(this.store, key);
      return undefined;
    });
  }

  clear(): IDBRequest<undefined> {
    this.transaction.assertActive('clear');
    return new StoreRequest(this.transaction, this, () => {
      for (const record of this.transaction.readAllRecords(this.store)) {
        this.transaction.stageDelete(this.store, record.key);
      }
      return undefined;
    });
  }

  // Cursor methods are not modelled. They fail loudly rather than returning
  // something plausible, because a store that grew a cursor dependency would
  // otherwise get a fake that half-works.
  getKey(): never {
    throw notSupported('getKey');
  }
  getAllKeys(): never {
    throw notSupported('getAllKeys');
  }
  openCursor(): never {
    throw notSupported('openCursor');
  }
  openKeyCursor(): never {
    throw notSupported('openKeyCursor');
  }
}

class FakeIndex implements IDBIndex {
  readonly keyPath: string;
  readonly unique = false;
  readonly multiEntry = false;

  constructor(
    readonly objectStore: FakeObjectStore,
    private readonly store: BackingStore,
    readonly name: string,
  ) {
    this.keyPath = (this.store.indexes.get(name) ?? []).join('.');
  }

  getAll(query?: IDBValidKey | IDBKeyRange | null): IDBRequest<unknown[]> {
    const tx = this.objectStore.transaction;
    tx.assertActive('getAll');
    return new StoreRequest(tx, this, () => {
      const paths = this.store.indexes.get(this.name) ?? [];
      const wanted =
        query === undefined || query === null
          ? null
          : new Set(
              tx.readAllRecords(this.store)
                .filter((record) => readPath(record.value, paths) === query)
                .map((record) => keyId(record.key)),
            );
      return tx
        .readAllRecords(this.store)
        .filter((record) => wanted === null || wanted.has(keyId(record.key)))
        .map((record) => structuredClone(record.value));
    });
  }

  get(): never {
    throw notSupported('index.get');
  }
  getKey(): never {
    throw notSupported('index.getKey');
  }
  getAllKeys(): never {
    throw notSupported('index.getAllKeys');
  }
  count(): never {
    throw notSupported('index.count');
  }
  openCursor(): never {
    throw notSupported('index.openCursor');
  }
  openKeyCursor(): never {
    throw notSupported('index.openKeyCursor');
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** `null` in the overlay means "deleted in this transaction, not yet committed". */
type Overlay = Map<string, StoredRecord | null>;

/**
 * What the transaction needs from a queued request. Declared structurally so
 * the queue can hold a `StoreRequest` of any result type — the request classes
 * are invariant in `T` because DOM types the event handlers' `this`.
 */
interface PendingRequest {
  aborted: boolean;
  deliver(): void;
  failAborted(): void;
}

class FakeTransaction extends EventTarget implements IDBTransaction {
  readonly objectStoreNames: DOMStringList;
  readonly db: FakeDatabase;
  readonly storeNames: string[];
  error: DOMException | null = null;
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null;

  finished = false;
  isVersionChange = false;
  private active = false;
  private pending = 0;
  private queue: PendingRequest[] = [];
  private overlay = new Map<string, Overlay>();
  private stagedWrites = 0;
  private committed = false;

  constructor(
    db: FakeDatabase,
    storeNames: string[],
    readonly mode: IDBTransactionMode,
    private readonly factory: MemoryIndexedDb,
  ) {
    super();
    this.db = db;
    this.storeNames = [...storeNames];
    this.objectStoreNames = makeStringList(this.storeNames);
    this.isVersionChange = mode === 'versionchange';
    this.active = true;
    if (this.isVersionChange) db.attachUpgradeTransaction(this);
    else factory.register(this);
    setTimeout(() => {
      this.active = false;
      this.drain();
    }, 0);
  }

  get durability(): IDBTransactionDurability {
    return 'default';
  }

  objectStore(name: string): FakeObjectStore {
    this.assertActive('objectStore');
    // Real IndexedDB scopes a transaction to the stores it was opened with, and
    // `objectStore` on anything else is a NotFoundError. The binding resolved the
    // store regardless, which made "one transaction over exactly these stores"
    // untestable: a mutation could reach outside its own transaction, write a
    // third store, and the suite would still be green. Found by the mutation
    // check — remove `sessions` from `deleteProject`'s store list and nothing
    // failed, because nothing could fail.
    if (!this.storeNames.includes(name)) {
      throw domError(
        'NotFoundError',
        `no object store "${name}" in this transaction (opened with [${this.storeNames.join(', ')}])`,
      );
    }
    return new FakeObjectStore(this, this.db.backing(name));
  }

  abort(): void {
    if (this.finished) {
      throw domError('InvalidStateError', 'the transaction has already finished');
    }
    this.abortWith(null);
  }

  commit(): void {
    if (this.finished) {
      throw domError('InvalidStateError', 'the transaction has already finished');
    }
    this.active = false;
    this.drain();
  }

  /** Deliver a callback inside the active window, as a request event is. */
  runActive(fn: () => void): void {
    const wasActive = this.active;
    this.active = true;
    try {
      fn();
    } finally {
      this.active = wasActive;
    }
  }

  /** Records an exception that escaped a success callback of this transaction's requests (see `StoreRequest.deliver`). */
  recordHandlerError(error: unknown): void {
    this.factory.recordHandlerError(error);
  }

  assertActive(what: string): void {
    if (this.finished) {
      throw domError('InvalidStateError', `cannot ${what} on a finished transaction`);
    }
    if (!this.active) {
      throw domError(
        'TransactionInactiveError',
        `cannot ${what}: the transaction is inactive. IndexedDB transactions are only ` +
          'usable while a request callback is running, not after an await.',
      );
    }
  }

  enqueue(request: PendingRequest): void {
    this.pending += 1;
    this.queue.push(request);
    setTimeout(() => this.deliver(), 0);
  }

  private deliver(): void {
    if (this.finished) return;
    // A readwrite transaction must not *read* while an earlier overlapping
    // readwrite transaction is still in flight — it would see a row the other
    // transaction is about to change, which is the lost-update this is
    // modelling. Blocking here rather than only at commit is what makes two
    // tabs editing one document behave.
    if (this.factory.isBlocked(this)) {
      setTimeout(() => this.deliver(), 0);
      return;
    }
    const request = this.queue.shift();
    if (!request) return;
    this.runActive(() => request.deliver());
    this.pending -= 1;
    this.drain();
  }

  /**
   * Commit or abort. A transaction commits when it is inactive with nothing
   * outstanding — and because a request callback may enqueue another request,
   * that is the only thing keeping a chain of requests alive.
   */
  private drain(): void {
    if (this.finished || this.active || this.pending > 0) return;
    if (this.factory.isBlocked(this)) {
      setTimeout(() => this.drain(), 0);
      return;
    }
    if (this.mode !== 'readwrite') {
      this.finishCommitted();
      return;
    }
    const fault = this.factory.peekWriteFault();
    if (fault !== null && this.stagedWrites > fault.afterWrites) {
      this.factory.clearWriteFault();
      this.abortWith(
        domError(
          'QuotaExceededError',
          `fault injection: the write after ${fault.afterWrites} failed, aborting the transaction`,
        ),
      );
      return;
    }
    for (const [storeName, overlay] of this.overlay) {
      const store = this.db.backing(storeName);
      for (const [key, record] of overlay) {
        if (record === null) store.delete(keyFromId(key));
        else store.put(record.key, record.value);
      }
    }
    this.finishCommitted();
  }

  private overlayFor(store: BackingStore): Overlay {
    let overlay = this.overlay.get(store.name);
    if (!overlay) {
      overlay = new Map();
      this.overlay.set(store.name, overlay);
    }
    return overlay;
  }

  stagePut(store: BackingStore, key: IDBValidKey, value: unknown): void {
    this.stagedWrites += 1;
    this.overlayFor(store).set(keyId(key), { key, value: structuredClone(value) });
  }

  stageDelete(store: BackingStore, key: IDBValidKey): void {
    this.stagedWrites += 1;
    this.overlayFor(store).set(keyId(key), null);
  }

  /** Read-your-write: the overlay wins over the shared store, for this tx only. */
  readOne(store: BackingStore, key: IDBValidKey): unknown {
    const staged = this.overlay.get(store.name)?.get(keyId(key));
    if (staged === null) return undefined;
    if (staged) return structuredClone(staged.value);
    const record = store.get(key);
    return record ? structuredClone(record.value) : undefined;
  }

  readAllRecords(store: BackingStore): StoredRecord[] {
    const overlay = this.overlay.get(store.name);
    const merged = new Map<string, StoredRecord>();
    for (const record of store.sorted()) merged.set(keyId(record.key), record);
    for (const [key, record] of overlay ?? []) {
      if (record === null) merged.delete(key);
      else merged.set(key, record);
    }
    return [...merged.values()].sort((a, b) => compareKeys(a.key, b.key));
  }

  readAll(store: BackingStore): unknown[] {
    return this.readAllRecords(store).map((record) => structuredClone(record.value));
  }

  keyForValue(store: BackingStore, value: unknown): IDBValidKey {
    const segments = store.keySegments;
    const parts = segments.map((p) => readPath(value, [p]));
    if (parts.some((p) => p === undefined)) {
      throw domError('DataError', `value is missing the key path "${segments.join('.')}"`);
    }
    return (segments.length === 1 ? parts[0] : parts) as IDBValidKey;
  }

  /** Versionchange transactions commit when the upgrade callback returns. */
  finishVersionChange(): void {
    this.active = false;
    this.finished = true;
    this.db.detachUpgradeTransaction(this);
  }

  abortWith(error: Error | null): void {
    if (this.finished) return;
    this.finished = true;
    this.db.detachUpgradeTransaction(this);
    this.factory.unregister(this);
    if (error) this.error = error as DOMException;
    // The overlay is simply dropped: nothing this transaction wrote ever
    // reached the shared store, which is what "atomic" means here.
    this.overlay = new Map();
    for (const request of this.queue.splice(0)) {
      request.aborted = true;
      // Each request the abort cut short fails with AbortError, as an error event, and the browser fires those before the abort event
      // below. The microtasks are queued in that order, so they run in it.
      queueMicrotask(() => request.failAborted());
    }
    queueMicrotask(() => {
      const event = new Event('abort');
      this.dispatchEvent(event);
      this.onabort?.call(this as IDBTransaction, event);
    });
  }

  private finishCommitted(): void {
    if (this.committed) return;
    this.committed = true;
    this.finished = true;
    this.db.detachUpgradeTransaction(this);
    this.factory.unregister(this);
    queueMicrotask(() => {
      const event = new Event('complete');
      this.dispatchEvent(event);
      this.oncomplete?.call(this as IDBTransaction, event);
    });
  }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

class FakeDatabase extends EventTarget implements IDBDatabase {
  onabort: IDBDatabase['onabort'] = null;
  onclose: IDBDatabase['onclose'] = null;
  onerror: IDBDatabase['onerror'] = null;
  onversionchange: IDBDatabase['onversionchange'] = null;
  private closed = false;
  private upgrading: FakeTransaction | null = null;

  constructor(
    readonly factory: MemoryIndexedDb,
    readonly name: string,
    private readonly data: FactoryData,
  ) {
    super();
    this.factory.registerConnection(this);
  }

  get version(): number {
    return this.data.version;
  }

  attachUpgradeTransaction(tx: FakeTransaction): void {
    this.upgrading = tx;
  }

  detachUpgradeTransaction(tx: FakeTransaction): void {
    if (this.upgrading === tx) this.upgrading = null;
  }

  backing(storeName: string): BackingStore {
    const store = this.data.stores.get(storeName);
    if (!store) throw domError('NotFoundError', `no object store named "${storeName}"`);
    return store;
  }

  get objectStoreNames(): DOMStringList {
    return makeStringList([...this.data.stores.keys()]);
  }

  createObjectStore(
    name: string,
    options?: { keyPath?: string | string[] | null; autoIncrement?: boolean },
  ): FakeObjectStore {
    if (this.closed) throw domError('InvalidStateError', 'the connection is closed');
    if (!this.upgrading) {
      throw domError('InvalidStateError', 'createObjectStore requires a versionchange transaction');
    }
    if (this.data.stores.has(name)) {
      throw domError('ConstraintError', `object store "${name}" already exists`);
    }
    const keyPath = options?.keyPath;
    if (keyPath === undefined || keyPath === null) {
      throw domError('NotSupportedError', 'this binding requires an explicit keyPath');
    }
    const store = new BackingStore(name, keyPath, options?.autoIncrement ?? false);
    this.data.stores.set(name, store);
    return new FakeObjectStore(this.upgrading, store);
  }

  deleteObjectStore(name: string): void {
    this.data.stores.delete(name);
  }

  transaction(
    storeNames: string | Iterable<string>,
    mode: IDBTransactionMode = 'readonly',
    _options?: IDBTransactionOptions,
  ): FakeTransaction {
    if (this.closed) throw domError('InvalidStateError', 'the connection is closed');
    const names = typeof storeNames === 'string' ? [storeNames] : [...storeNames];
    for (const storeName of names) this.backing(storeName);
    // The upgrade transaction is created by the open request and attaches
    // itself, so there is nothing to guard here: a versionchange transaction is
    // only ever started by `OpenRequest`.
    return new FakeTransaction(this, names, mode, this.factory);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.factory.closeConnection(this);
  }

  notifyVersionChange(newVersion: number): void {
    const event = versionChangeEvent('versionchange', this.version, newVersion);
    this.dispatchEvent(event);
    try {
      this.onversionchange?.call(this, event);
    } catch (error) {
      this.factory.recordHandlerError(error);
    }
  }
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

interface WriteFault {
  afterWrites: number;
}

/** Recover the key from its serialized form, for the commit path. */
function keyFromId(key: string): IDBValidKey {
  return JSON.parse(key) as IDBValidKey;
}

/**
 * An `IDBFactory` over plain objects.
 *
 * The browser's own `indexedDB` satisfies the same interface, which is the
 * entire point: the store is written against IndexedDB, not against this.
 */
export class MemoryIndexedDb implements IDBFactory {
  private readonly data = new Map<string, FactoryData>();
  private readonly opening = new Map<string, (() => void)[]>();
  private readonly connections = new Set<FakeDatabase>();
  private readonly waiting = new Set<() => void>();
  private readonly running: FakeTransaction[] = [];
  private fault: WriteFault | null = null;
  private readonly handlers: unknown[] = [];

  static cmp = compareKeys;

  cmp = compareKeys;

  queueOpen(name: string, run: () => void): void {
    const queued = this.opening.get(name);
    if (queued !== undefined) {
      queued.push(run);
      return;
    }
    this.opening.set(name, [run]);
    queueMicrotask(run);
  }

  finishOpen(name: string): void {
    const queued = this.opening.get(name);
    queued?.shift();
    const next = queued?.[0];
    if (next === undefined) this.opening.delete(name);
    else queueMicrotask(next);
  }

  registerConnection(db: FakeDatabase): void {
    this.connections.add(db);
  }

  closeConnection(db: FakeDatabase): void {
    this.connections.delete(db);
    for (const resume of this.waiting) resume();
  }

  waitForConnections(name: string, newVersion: number, blocked: () => void, ready: () => void): void {
    const connections = [...this.connections].filter((db) => db.name === name);
    for (const db of connections) db.notifyVersionChange(newVersion);
    const hasConnections = (): boolean => [...this.connections].some((db) => db.name === name) || this.running.some((tx) => tx.db.name === name);
    if (!hasConnections()) {
      queueMicrotask(ready);
      return;
    }
    const resume = (): void => {
      if (hasConnections()) return;
      this.waiting.delete(resume);
      queueMicrotask(ready);
    };
    this.waiting.add(resume);
    blocked();
  }

  dataFor(name: string): FactoryData | undefined {
    return this.data.get(name);
  }

  createData(name: string, version: number): FactoryData {
    const data: FactoryData = { version, stores: new Map() };
    this.data.set(name, data);
    return data;
  }

  dropData(name: string): void {
    this.data.delete(name);
  }

  register(tx: FakeTransaction): void {
    this.running.push(tx);
  }

  unregister(tx: FakeTransaction): void {
    const at = this.running.indexOf(tx);
    if (at >= 0) this.running.splice(at, 1);
    queueMicrotask(() => {
      for (const resume of this.waiting) resume();
    });
  }

  /**
   * A readwrite transaction waits for every *earlier* readwrite transaction that
   * touches one of its stores. This is what makes a second tab's write and this
   * tab's write serialize instead of interleave.
   *
   * "Earlier" is load-bearing. Blocking on *later* transactions too would make
   * two concurrent writers wait on each other and deadlock — which is exactly
   * what the two-tab test did before this said "earlier".
   *
   * Readonly transactions are never blocked: they may run alongside a readwrite
   * one and see the state from before it, which falls out of the overlay model
   * for free — a readonly transaction reads the shared store, never somebody
   * else's uncommitted overlay.
   */
  isBlocked(tx: FakeTransaction): boolean {
    if (tx.mode !== 'readwrite') return false;
    const at = this.running.indexOf(tx);
    if (at < 0) return false;
    const mine = new Set(tx.storeNames);
    return this.running.slice(0, at).some((other) => {
      if (other.finished || other.isVersionChange) return false;
      if (other.mode !== 'readwrite') return false;
      const theirs = new Set(other.storeNames);
      return [...mine].some((name) => theirs.has(name));
    });
  }

  /**
   * The pending write fault, *without* consuming it.
   *
   * Peeking rather than taking is what makes the injection behave like a real
   * storage failure: a transaction that does not reach the failing write must
   * leave the fault armed for the next one. A take-on-read would silently
   * disarm the fault on a transaction that had not failed, and the test would
   * pass for the wrong reason.
   */
  peekWriteFault(): WriteFault | null {
    return this.fault;
  }

  clearWriteFault(): void {
    this.fault = null;
  }

  /**
   * Test seam: the next readwrite transaction aborts once it has staged
   * `afterWrites` writes.
   *
   * This is how a test proves §4's "every mutation is one IndexedDB transaction
   * (atomic by construction)". Stage a multi-part mutation, fail it part-way,
   * and assert that *none* of it survived: with one transaction per mutation
   * there is nothing left behind, and with two the first half is already
   * committed.
   */
  abortAfterWrites(afterWrites: number): void {
    this.fault = { afterWrites };
  }

  /**
   * Every value in a store, for asserting on storage rather than through the
   * store's own read path — a read-path bug must not be able to hide a write
   * that did or did not land.
   */
  rawRecords(dbName: string, storeName: string): unknown[] {
    const store = this.data.get(dbName)?.stores.get(storeName);
    if (!store) return [];
    return store.sorted().map((r) => structuredClone(r.value));
  }

  /** Records an exception that escaped a success callback (see `StoreRequest.deliver`). */
  recordHandlerError(error: unknown): void {
    this.handlers.push(error);
  }

  /**
   * Every exception that escaped a request callback, in the order it was thrown. A browser reports one as an uncaught exception and
   * aborts the transaction, as this binding does; it also keeps the exception here, so a test can assert that the store's callbacks
   * let none escape. A request that fails with an error its own `onerror` handles is not one of these.
   */
  handlerErrors(): readonly unknown[] {
    return [...this.handlers];
  }

  open(name: string, version?: number): IDBOpenDBRequest {
    return new OpenRequest(this, name, version);
  }

  deleteDatabase(name: string): IDBOpenDBRequest {
    return new DeleteRequest(this, name);
  }

  databases(): Promise<IDBDatabaseInfo[]> {
    return Promise.resolve(
      [...this.data.entries()].map(([name, data]) => ({ name, version: data.version })),
    );
  }
}
