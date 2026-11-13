import { afterEach, describe, expect, it } from 'vitest';
import { transact } from '../src/runtime/store.js';
import {
  AGENT_SESSION_PROJECT_INDEX, AGENT_SESSION_STORE, DEFAULT_AGENT_SESSION_RETENTION,
  DOCUMENT_STORE, PROJECT_STORE, RUNTIME_DB_VERSION, RUN_EVENT_STORE, RUN_STORE,
  SESSION_STORE, SNAPSHOT_STORE, MemoryIndexedDb, ProjectNotFoundError,
  agentSessionReferences, appendRunEvents, createEmptyManifest, createProjectState,
  createRun, deleteProject, deleteRun, openRuntimeStore, planAgentSessionEviction,
  pruneAgentSessions, pruneRuns, readAgentSessions, readRun, readRunBaseline,
  readRunEvents, readRuns, removeAgentSession, saveAgentSession, settleAgentSessionTurn,
  updateRun, writeBodySnapshot, writeProjectState, writeRunBaseline,
  type AgentSessionRow, type RunRow, type RuntimeStore, type SessionSummary,
} from '../src/index.js';

const DB = 'agent-sessions-test';
const P = 'p_A';
const Q = 'p_B';
const DAY = 86_400_000;
const opened: RuntimeStore[] = [];
afterEach(() => { for (const store of opened.splice(0)) store.close(); });

const session = (sessionId: string, runIds: readonly string[] = [], over: Partial<AgentSessionRow> = {}): AgentSessionRow => ({
  projectId: P, sessionId, formatVersion: 1, title: 'Opening', createdAt: 1, updatedAt: 2,
  active: false, turns: runIds.map((runId) => ({ runId, role: 'chat' })), ...over,
});
const run = (runId: string, over: Partial<RunRow> = {}): RunRow => ({
  schema: 3, projectId: P, runId, kind: 'turn', intent: 'Tighten', createdAt: 1,
  updatedAt: 2, status: 'finished', ...over,
});

async function fixture() {
  const factory = new MemoryIndexedDb();
  const store = await openRuntimeStore(factory, DB);
  opened.push(store);
  for (const id of [P, Q]) {
    const manifest = createEmptyManifest('Project', new Date(0));
    manifest.project.id = id;
    await writeProjectState(store, createProjectState(manifest));
  }
  return { factory, store };
}

async function logged(store: RuntimeStore, runId: string, over: Partial<RunRow> = {}) {
  await createRun(store, run(runId, over));
  await appendRunEvents(store, runId, [{ seq: 0, t: 'turn.start' }, { seq: 1, t: 'turn.end' }]);
}

describe('additive v5 upgrade', () => {
  it.each([3, 4])('keeps every store and record from v%i and closes the old tab cooperatively', async (version) => {
    const factory = new MemoryIndexedDb();
    const records: Record<string, { key: string | string[]; rows: object[] }> = {
      [PROJECT_STORE]: { key: 'id', rows: [{ id: P, manifest: createEmptyManifest('Old', new Date(0)), storedAt: 'then', extra: true }] },
      [DOCUMENT_STORE]: { key: ['projectId', 'id'], rows: [{ projectId: P, id: 'scene', body: 'body', revision: 9 }] },
      [SESSION_STORE]: { key: ['projectId', 'index'], rows: [{ projectId: P, index: 0, line: 'writing statistics' }] },
      [SNAPSHOT_STORE]: { key: ['projectId', 'docId', 'revision'], rows: [{ projectId: P, docId: 'scene', revision: 8, body: 'before', capturedAt: 1 }] },
      ...(version === 4 ? {
        [RUN_STORE]: { key: 'runId', rows: [{ ...run('old'), baseline: { version: 1, capturedAt: 1, textFiles: { scene: 'before' }, binaryFiles: {}, revisions: {} }, future: 'kept' }] },
        [RUN_EVENT_STORE]: { key: ['runId', 'seq'], rows: [{ runId: 'old', seq: 0, t: 'messages', appended: [{ role: 'assistant', content: 'kept' }] }] },
      } : {}),
    };
    let changed = false;
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(DB, version);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        for (const [name, { key }] of Object.entries(records)) {
          const store = request.result.createObjectStore(name, { keyPath: key });
          if (name === RUN_EVENT_STORE) store.createIndex('byRun', 'runId');
          else if (name !== PROJECT_STORE) store.createIndex('byProject', 'projectId');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { changed = true; db.close(); };
        const tx = db.transaction(Object.keys(records), 'readwrite');
        for (const [name, { rows }] of Object.entries(records)) for (const row of rows) tx.objectStore(name).put(row);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      };
    });
    const store = await openRuntimeStore(factory, DB);
    opened.push(store);
    expect(changed).toBe(true);
    expect(RUNTIME_DB_VERSION).toBe(5);
    expect(store.db.version).toBe(5);
    expect(Array.from(store.db.objectStoreNames).sort()).toEqual([
      AGENT_SESSION_STORE, DOCUMENT_STORE, PROJECT_STORE, RUN_EVENT_STORE, RUN_STORE, SESSION_STORE, SNAPSHOT_STORE,
    ].sort());
    for (const [name, { rows }] of Object.entries(records)) expect(factory.rawRecords(DB, name)).toEqual(rows);
    expect(await readAgentSessions(store, P)).toEqual([]);
    const tx = store.db.transaction(AGENT_SESSION_STORE);
    expect(tx.objectStore(AGENT_SESSION_STORE).keyPath).toEqual(['projectId', 'sessionId']);
    expect(tx.objectStore(AGENT_SESSION_STORE).indexNames.contains(AGENT_SESSION_PROJECT_INDEX)).toBe(true);
  });
});

describe('session metadata and settled presentation', () => {
  it('keeps role-local summaries through reload and refuses malformed coverage atomically', async () => {
    const { factory, store } = await fixture();
    await logged(store, 'r');
    await saveAgentSession(store, session('old', [], { active: true }));
    const summary = {
      version: 1 as const, covers: { from: 'chat.turn-1', to: 'chat.turn-5', turns: 5 },
      text: "## Writer's standing requests\nKeep Hale gruff.\n\n## Decisions\nUse the ferry.\n\n## Done\nRead the opening.\n\n## Open threads\nFind the letter.",
      origin: 'manual' as const, focus: 'Keep the letter decision.', external: true, editedAt: 1234, readPolicy: 'a'.repeat(64),
    };
    const row = session('current', ['r'], { active: true, summaries: { chat: summary, drafting: { ...summary, external: false } } });
    await settleAgentSessionTurn(store, row, 'r', { saved: true });
    await expect(settleAgentSessionTurn(store, {
      ...row, sessionId: 'refused', summaries: { chat: { ...summary, covers: { ...summary.covers, turns: 0 } } },
    }, 'r', { saved: false })).rejects.toThrow('invalid agent session summary');
    expect(await readRun(store, 'r')).toMatchObject({ presentation: { saved: true } });
    expect((await readAgentSessions(store, P)).filter((value) => value.active)).toEqual([row]);
    store.close();
    const reopened = await openRuntimeStore(factory, DB);
    opened.push(reopened);
    expect(await readAgentSessions(reopened, P)).toContainEqual(row);
    expect((await readAgentSessions(reopened, P)).find((value) => value.sessionId === 'old')).not.toHaveProperty('summaries');
    expect(reopened.db.version).toBe(5);
  });

  it.each([
    { readPolicy: 'short' }, { readPolicy: 'A'.repeat(64) }, { readPolicy: 3 },
    { editedAt: -1 }, { editedAt: NaN }, { editedAt: Infinity }, { editedAt: 'today' },
    { external: 'yes' }, { origin: 'edited' }, { focus: 3 },
  ])('refuses malformed additive summary metadata without replacing presentation or selection: %j', async (invalid) => {
    const { store } = await fixture();
    await logged(store, 'r');
    const original = session('kept', ['r'], { active: true });
    await settleAgentSessionTurn(store, original, 'r', { saved: true });
    const summary = { version: 1, covers: { from: 'chat.turn-1', to: 'chat.turn-1', turns: 1 }, text: 'Earlier.', origin: 'manual', external: false, ...invalid } as SessionSummary;
    await expect(settleAgentSessionTurn(store, { ...original, sessionId: 'refused', summaries: { chat: summary } }, 'r', { saved: false })).rejects.toThrow('invalid agent session summary');
    expect(await readAgentSessions(store, P)).toEqual([original]);
    expect(await readRun(store, 'r')).toMatchObject({ presentation: { saved: true } });
  });

  it('round-trips only references, flags and fork metadata, ordered by update with a stable tie', async () => {
    const { factory, store } = await fixture();
    await logged(store, 'r');
    const row = session('a', ['r'], { active: true, forkedFrom: { sessionId: 'parent', turnSeq: 1 }, turns: [{ runId: 'r', role: 'drafting', rewound: true, restoredAt: 9, restoredFromStep: 2 }] });
    await saveAgentSession(store, session('z', ['r']));
    await saveAgentSession(store, row);
    await saveAgentSession(store, session('new', [], { updatedAt: 3 }));
    await saveAgentSession(store, session('a', [], { projectId: Q, active: true }));
    expect(await readAgentSessions(store, P)).toEqual([session('new', [], { updatedAt: 3 }), row, session('z', ['r'])]);
    expect(await readAgentSessions(store, Q)).toEqual([session('a', [], { projectId: Q, active: true })]);
    expect(factory.rawRecords(DB, AGENT_SESSION_STORE).find((value) => (value as AgentSessionRow).projectId === P && (value as AgentSessionRow).sessionId === 'a')).toEqual(row);
    expect(await readRun(store, 'r')).not.toHaveProperty('presentation');
    expect(await agentSessionReferences(store, P, 'r')).toBe(2);
    expect(await agentSessionReferences(store, Q, 'r')).toBe(0);
  });

  it('writes presentation on the existing run and clears active only within its project', async () => {
    const { factory, store } = await fixture();
    await logged(store, 'r');
    await saveAgentSession(store, session('old', [], { active: true }));
    await saveAgentSession(store, session('other', [], { projectId: Q, active: true }));
    const presentation = { formatVersion: 1, report: { status: 'replied' }, cards: ['safe record'] };
    const row = session('current', ['r'], { active: true });
    const events = await readRunEvents(store, 'r');
    await settleAgentSessionTurn(store, row, 'r', presentation);
    expect(await readRun(store, 'r')).toEqual({ ...run('r'), presentation });
    expect(await readRunEvents(store, 'r')).toEqual(events);
    expect((await readAgentSessions(store, P)).filter((value) => value.active)).toEqual([row]);
    expect((await readAgentSessions(store, Q))[0]?.active).toBe(true);
    expect(factory.rawRecords(DB, AGENT_SESSION_STORE)).not.toContainEqual(expect.objectContaining({ presentation }));
    store.close();
    const reopened = await openRuntimeStore(factory, DB);
    opened.push(reopened);
    expect(await readRun(reopened, 'r')).toEqual({ ...run('r'), presentation });
    expect(await readAgentSessions(reopened, P)).toContainEqual(row);
  });

  it('serializes concurrent activation so only one session remains active', async () => {
    const { store } = await fixture();
    await Promise.all([saveAgentSession(store, session('a', [], { active: true })), saveAgentSession(store, session('b', [], { active: true }))]);
    expect((await readAgentSessions(store, P)).filter((row) => row.active).map((row) => row.sessionId)).toEqual(['b']);
  });

  it.each(['running', 'awaiting-approval', 'interrupted'] as const)('refuses %s references without changing either record', async (status) => {
    const { store } = await fixture();
    await createRun(store, run('r', { status }));
    await expect(saveAgentSession(store, session('a', ['r']))).rejects.toThrow('not settled');
    await expect(settleAgentSessionTurn(store, session('a', ['r']), 'r', {})).rejects.toThrow('not settled');
    expect(await readRun(store, 'r')).toEqual(run('r', { status }));
    expect(await readAgentSessions(store, P)).toEqual([]);
  });

  it('refuses missing projects, missing runs, foreign runs and an unreferenced report', async () => {
    const { store } = await fixture();
    await createRun(store, run('foreign', { projectId: Q }));
    await expect(saveAgentSession(store, session('a', [], { projectId: 'absent' }))).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(saveAgentSession(store, session('a', ['missing']))).rejects.toThrow('does not belong');
    await expect(saveAgentSession(store, session('a', ['foreign']))).rejects.toThrow('does not belong');
    await expect(settleAgentSessionTurn(store, session('a'), 'foreign', {})).rejects.toThrow('must be referenced');
    expect(await readAgentSessions(store, P)).toEqual([]);
  });

  it('accepts failed settled runs and counts sessions rather than repeated references', async () => {
    const { store } = await fixture();
    await createRun(store, run('failed', { status: 'failed' }));
    await settleAgentSessionTurn(store, session('a', ['failed', 'failed']), 'failed', { status: 'failed' });
    expect(await agentSessionReferences(store, P, 'failed')).toBe(1);
  });

  it('rolls presentation, metadata and active clearing back together on a write failure', async () => {
    const { factory, store } = await fixture();
    await logged(store, 'r');
    const original = session('old', [], { active: true });
    await saveAgentSession(store, original);
    factory.abortAfterWrites(1);
    await expect(settleAgentSessionTurn(store, session('new', ['r'], { active: true }), 'r', { settled: true })).rejects.toBeDefined();
    expect(await readRun(store, 'r')).toEqual(run('r'));
    expect(await readAgentSessions(store, P)).toEqual([original]);
    expect(factory.handlerErrors()).toEqual([]);
  });

  it('rolls an earlier presentation write back if another reference fails validation', async () => {
    const { factory, store } = await fixture();
    await logged(store, 'r');
    await expect(settleAgentSessionTurn(store, session('new', ['r', 'absent']), 'r', {})).rejects.toThrow('does not belong');
    expect(await readRun(store, 'r')).toEqual(run('r'));
    expect(await readAgentSessions(store, P)).toEqual([]);
    expect(factory.handlerErrors()).toEqual([]);
  });
});

describe('shared run ownership and deletion', () => {
  it('does not lower role counters when the newest referenced run is discarded', async () => {
    const { store } = await fixture();
    await logged(store, 'latest');
    await saveAgentSession(store, session('a', ['latest'], { nextTurn: { chat: 8, drafting: 3 }, active: true }));
    await deleteRun(store, 'latest');
    expect((await readAgentSessions(store, P))[0]).toMatchObject({ turns: [], nextTurn: { chat: 8, drafting: 3 } });
    await expect(saveAgentSession(store, session('invalid', [], { nextTurn: { chat: -1 } }))).rejects.toThrow('positive whole numbers');
  });

  it('keeps a fork’s shared run until the last session goes, leaving checkpoint snapshots untouched', async () => {
    const { factory, store } = await fixture();
    await logged(store, 'shared', { status: 'running' });
    const baseline = { version: 1 as const, capturedAt: 1, textFiles: { scene: 'before' }, binaryFiles: {}, revisions: {} };
    await writeRunBaseline(store, P, 'shared', baseline);
    await updateRun(store, 'shared', { status: 'finished' });
    await logged(store, 'only-parent');
    await logged(store, 'foreign', { projectId: Q });
    await writeBodySnapshot(store, { projectId: P, docId: 'scene', revision: 1, body: 'pinned', capturedAt: 1, command: 'doc.write' });
    const snapshots = factory.rawRecords(DB, SNAPSHOT_STORE);
    await saveAgentSession(store, session('parent', ['shared', 'only-parent']));
    const fork = session('fork', ['shared'], { forkedFrom: { sessionId: 'parent', turnSeq: 1 } });
    await saveAgentSession(store, fork);
    await saveAgentSession(store, session('parent', ['foreign'], { projectId: Q }));
    await removeAgentSession(store, P, 'parent');
    expect(await readAgentSessions(store, P)).toEqual([fork]);
    expect(await readRun(store, 'only-parent')).toBeUndefined();
    expect(await readRunEvents(store, 'only-parent')).toEqual([]);
    expect(await readRunBaseline(store, P, 'shared')).toEqual(baseline);
    expect(await readRunEvents(store, 'shared')).toHaveLength(2);
    await removeAgentSession(store, P, 'fork');
    expect(await readRun(store, 'shared')).toBeUndefined();
    expect(await readRunEvents(store, 'shared')).toEqual([]);
    expect(await readRun(store, 'foreign')).toBeDefined();
    expect(await readAgentSessions(store, Q)).toHaveLength(1);
    expect(factory.rawRecords(DB, SNAPSHOT_STORE)).toEqual(snapshots);
  });

  it('rolls session deletion and backing-log deletion back together', async () => {
    const { factory, store } = await fixture();
    await logged(store, 'r');
    const row = session('a', ['r']);
    await saveAgentSession(store, row);
    factory.abortAfterWrites(2);
    await expect(removeAgentSession(store, P, 'a')).rejects.toBeDefined();
    expect(await readAgentSessions(store, P)).toEqual([row]);
    expect(await readRun(store, 'r')).toEqual(run('r'));
    expect(await readRunEvents(store, 'r')).toHaveLength(2);
    await removeAgentSession(store, P, 'absent');
    expect(await readAgentSessions(store, P)).toEqual([row]);
  });

  it('Discard log atomically removes every reference, keeping the other turns and fork provenance', async () => {
    const { factory, store } = await fixture();
    await logged(store, 'shared');
    await logged(store, 'kept');
    await saveAgentSession(store, session('parent', ['shared', 'kept']));
    const fork = session('fork', ['shared'], { forkedFrom: { sessionId: 'parent', turnSeq: 1 } });
    await saveAgentSession(store, fork);
    factory.abortAfterWrites(2);
    await expect(deleteRun(store, 'shared')).rejects.toBeDefined();
    expect(await agentSessionReferences(store, P, 'shared')).toBe(2);
    expect(await readRunEvents(store, 'shared')).toHaveLength(2);
    await deleteRun(store, 'shared');
    expect(await agentSessionReferences(store, P, 'shared')).toBe(0);
    expect(await readAgentSessions(store, P)).toContainEqual({ ...fork, turns: [] });
    expect(await readAgentSessions(store, P)).toContainEqual(session('parent', ['kept']));
    expect(await readRun(store, 'shared')).toBeUndefined();
    expect(await readRunEvents(store, 'shared')).toEqual([]);
    expect(await readRunEvents(store, 'kept')).toHaveLength(2);
  });

  it('deletes project sessions and logs in one transaction without touching another project', async () => {
    const { factory, store } = await fixture();
    await logged(store, 'r');
    await logged(store, 'q', { projectId: Q });
    await saveAgentSession(store, session('a', ['r']));
    await saveAgentSession(store, session('a', ['q'], { projectId: Q }));
    factory.abortAfterWrites(2);
    await expect(deleteProject(store, P)).rejects.toBeDefined();
    expect(await readAgentSessions(store, P)).toHaveLength(1);
    expect(await readRunEvents(store, 'r')).toHaveLength(2);
    expect(await deleteProject(store, P)).toBe(true);
    expect(await readAgentSessions(store, P)).toEqual([]);
    expect(await readRun(store, 'r')).toBeUndefined();
    expect(await readRunEvents(store, 'r')).toEqual([]);
    expect(await readAgentSessions(store, Q)).toHaveLength(1);
    expect(await readRunEvents(store, 'q')).toHaveLength(2);
  });
});

describe('retention', () => {
  it('plans the 50-session/30-day fixture without mutation and counts a stale active session in the cap', () => {
    const now = 100 * DAY;
    const rows = [
      session('active', [], { active: true, updatedAt: 1 }),
      ...Array.from({ length: 55 }, (_, index) => session(`s${String(index).padStart(2, '0')}`, [], { updatedAt: now - index })),
      session('expired', [], { updatedAt: now - 31 * DAY }),
    ];
    const before = structuredClone(rows);
    expect(DEFAULT_AGENT_SESSION_RETENTION).toEqual({ days: 30, count: 50 });
    expect(planAgentSessionEviction(rows, now).map((row) => row.sessionId)).toEqual(['s49', 's50', 's51', 's52', 's53', 's54', 'expired']);
    expect(rows).toEqual(before);
    expect(planAgentSessionEviction(rows, now, { days: 30, count: 1 })).toHaveLength(56);
    expect(planAgentSessionEviction([session('boundary', [], { updatedAt: now - 30 * DAY })], now)).toEqual([]);
  });

  it('uses stable update ties, ages without a count overflow, and cannot pin unbounded active rows', () => {
    const now = 100 * DAY;
    expect(planAgentSessionEviction([session('z'), session('a')], 2, { days: 30, count: 1 }).map((row) => row.sessionId)).toEqual(['z']);
    expect(planAgentSessionEviction([session('expired')], now).map((row) => row.sessionId)).toEqual(['expired']);
    expect(planAgentSessionEviction(['a', 'b', 'c'].map((id) => session(id, [], { active: true })), now, { days: 30, count: 1 }).map((row) => row.sessionId)).toEqual(['b', 'c']);
    for (const keep of [{ days: 0, count: 1 }, { days: 30, count: 0 }, { days: NaN, count: 50 }, { days: 30, count: 1.5 }]) expect(() => planAgentSessionEviction([], now, keep)).toThrow('positive whole-number');
  });

  it('evicts multiple sessions atomically and collects runs shared only among evicted sessions', async () => {
    const { factory, store } = await fixture();
    for (const id of ['shared', 'gone']) await logged(store, id);
    await saveAgentSession(store, session('active', ['shared'], { active: true }));
    await saveAgentSession(store, session('old-a', ['shared', 'gone']));
    await saveAgentSession(store, session('old-b', ['gone']));
    await saveAgentSession(store, session('other', [], { projectId: Q }));
    factory.abortAfterWrites(2);
    await expect(pruneAgentSessions(store, P, 100 * DAY)).rejects.toBeDefined();
    expect(await readAgentSessions(store, P)).toHaveLength(3);
    expect(await readRunEvents(store, 'gone')).toHaveLength(2);
    expect(await pruneAgentSessions(store, P, 100 * DAY)).toBe(2);
    expect(await readAgentSessions(store, P)).toEqual([session('active', ['shared'], { active: true })]);
    expect(await readRun(store, 'gone')).toBeUndefined();
    expect(await readRunEvents(store, 'gone')).toEqual([]);
    expect(await readRunEvents(store, 'shared')).toHaveLength(2);
    expect(await readAgentSessions(store, Q)).toHaveLength(1);
  });

  it('pins a 100-turn session and its fork without consuming the unreferenced run cap', async () => {
    const { store } = await fixture();
    const now = 100 * DAY;
    const ids = Array.from({ length: 100 }, (_, index) => `pinned-${index}`);
    await transact<void>(store.db, [RUN_STORE, RUN_EVENT_STORE], 'readwrite', (tx, done) => {
      const rows = [...ids.map((id) => run(id)), ...Array.from({ length: 55 }, (_, index) => run(`free-${index}`, { createdAt: now - 100 + index, updatedAt: now }))];
      for (const row of rows) {
        tx.objectStore(RUN_STORE).add(row);
        tx.objectStore(RUN_EVENT_STORE).add({ runId: row.runId, seq: 0, t: 'turn.start' });
      }
      done();
    });
    await logged(store, 'expired');
    await logged(store, 'open', { status: 'interrupted' });
    await logged(store, 'foreign', { projectId: Q });
    await saveAgentSession(store, session('long', ids, { active: true }));
    await saveAgentSession(store, session('fork', ids.slice(0, 50), { forkedFrom: { sessionId: 'long', turnSeq: 50 } }));
    expect(await pruneRuns(store, P, now)).toBe(6);
    expect(await readRuns(store, P)).toHaveLength(151);
    expect(await readRun(store, 'free-4')).toBeUndefined();
    expect(await readRunEvents(store, 'free-4')).toEqual([]);
    expect(await readRun(store, 'free-5')).toBeDefined();
    expect(await readRun(store, ids[0] ?? '')).toBeDefined();
    expect(await readRunEvents(store, 'open')).toHaveLength(2);
    expect(await readRun(store, 'foreign')).toBeDefined();
  });

  it('serializes reference validation with pruning instead of leaving a dangling reference', async () => {
    const { store } = await fixture();
    await logged(store, 'retained');
    const saved = saveAgentSession(store, session('a', ['retained']));
    const prune = pruneRuns(store, P, 100 * DAY);
    await saved;
    expect(await prune).toBe(0);
    expect(await readRun(store, 'retained')).toBeDefined();
    await logged(store, 'removed');
    const firstPrune = pruneRuns(store, P, 100 * DAY);
    const refused = saveAgentSession(store, session('b', ['removed']));
    await expect(refused).rejects.toThrow('does not belong');
    expect(await firstPrune).toBe(1);
    expect(await readAgentSessions(store, P)).toEqual([session('a', ['retained'])]);
  });

  it('rolls run pruning back without deleting session-pinned logs', async () => {
    const { factory, store } = await fixture();
    await logged(store, 'pinned');
    await logged(store, 'free');
    await saveAgentSession(store, session('a', ['pinned']));
    factory.abortAfterWrites(1);
    await expect(pruneRuns(store, P, 100 * DAY)).rejects.toBeDefined();
    expect(await readRunEvents(store, 'free')).toHaveLength(2);
    expect(await readRunEvents(store, 'pinned')).toHaveLength(2);
    expect(await agentSessionReferences(store, P, 'pinned')).toBe(1);
  });
});
