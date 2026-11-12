import { expect, test } from '@playwright/test';
import { MemoryIndexedDb, appendRunEvents, createRun, openRuntimeStore, readAgentSessions, readRunEvents, readRuns, saveAgentSession, writeProjectState, type RuntimeStore } from '../../packages/store/src/index.js';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore } from '../../packages/gateway/src/index.js';
import { createMockProvider, isPlannerCall, userTextOf } from '../../packages/gateway/src/mock/index.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import { sessionMarkdown } from '../../apps/desktop/src/app/agent-session-model.js';
import { AGENT_SESSION_STORE, RUN_STORE, transact } from '../../packages/store/src/runtime/store.js';
import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import type { ProviderService } from '../../apps/desktop/src/app/providers.js';

const globals = globalThis as unknown as Record<string, unknown>;
let previous: { document: unknown; window: unknown };
test.beforeAll(() => {
  previous = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});
test.afterAll(() => { globals['document'] = previous.document; globals['window'] = previous.window; });

async function fixture() {
  const state = sampleProjectState();
  const factory = new MemoryIndexedDb();
  const store = await openRuntimeStore(factory);
  await writeProjectState(store, state);
  const seen: string[] = [];
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Local mock', kind: 'mock', isActive: true });
  const gateway = createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [{
    match: isPlannerCall,
    respond: (request) => { seen.push(userTextOf(request)); return { content: JSON.stringify({ reply: 'The ferryman knows about the letter.' }) }; },
  }] }) });
  const providers = { gateway, active: () => profile, demoProfile: async () => profile, persist: async () => undefined } as unknown as ProviderService;
  const sessions: ProjectSession[] = [];
  const controller = () => {
    const session = new ProjectSession({ state, store, projectId: state.manifest.project.id, shadow: null });
    sessions.push(session);
    return new AgentController(session, providers);
  };
  return { state, store, factory, seen, sessions, profiles, keys, profile, controller, close: async () => { for (const session of sessions) await session.close(); store.close(); } };
}

function refuseSessionWrites(store: RuntimeStore, reason: string): () => void {
  const transaction = store.db.transaction.bind(store.db);
  let refuse = true;
  store.db.transaction = (names, mode, options) => {
    if (refuse && mode === 'readwrite' && (typeof names === 'string' ? names === AGENT_SESSION_STORE : Array.from(names).includes(AGENT_SESSION_STORE))) throw new Error(reason);
    return transaction(names, mode, options);
  };
  return () => { refuse = false; };
}

test('a reload projects the settled reply and continues its session with increasing ids and L6', async () => {
  const f = await fixture();
  try {
    const first = f.controller();
    const report = await first.submit('Who knows about the letter?');
    expect(report?.status).toBe('replied');
    const id = first.snapshot().sessionId;
    const reopened = f.controller();
    expect(await reopened.loadSessions()).toBe(true);
    expect(reopened.snapshot().sessionId).toBe(id);
    expect(reopened.snapshot().turns).toHaveLength(1);
    expect(reopened.snapshot().storedTurnIds.has(report!.turnId)).toBe(true);
    expect(reopened.snapshot().turns[0]?.report?.text).toBe('The ferryman knows about the letter.');
    const next = await reopened.submit('And who does not?');
    expect(next?.turnId).toBe(`${id}.turn-2`);
    const preview = await reopened.previewRequest('Remember our earlier answers.');
    expect(JSON.stringify(preview)).toContain('Who knows about the letter?');
    expect(JSON.stringify(preview)).toContain('The ferryman knows about the letter.');
    expect(reopened.snapshot().conversationSessions[0]?.turns).toHaveLength(2);
  } finally { await f.close(); }
});

test('an empty project loads its conversation without retention or metadata writes', async () => {
  const f = await fixture();
  try {
    let writes = 0;
    const transact = f.store.db.transaction.bind(f.store.db);
    f.store.db.transaction = (names, mode, options) => {
      if (mode === 'readwrite' && (typeof names === 'string' ? names === AGENT_SESSION_STORE : Array.from(names).includes(AGENT_SESSION_STORE))) writes++;
      return transact(names, mode, options);
    };
    const agent = f.controller();
    expect(await agent.loadSessions()).toBe(true);
    expect(agent.snapshot().turns).toEqual([]);
    expect(writes).toBe(0);
    expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});

test('a turn submitted during hydration waits and continues the saved active session', async () => {
  const f = await fixture();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let running: ReturnType<AgentController['submit']> | undefined;
  try {
    const first = f.controller();
    await first.submit('The original conversation.');
    const original = first.snapshot().sessionId;
    await first.newSession();
    await first.submit('The other conversation.');
    const other = first.snapshot().sessionId;
    await first.openSession(original);
    const reopened = f.controller();
    const reader = reopened as unknown as { readConversations: () => Promise<void> };
    const read = reader.readConversations.bind(reopened);
    reader.readConversations = async () => { await gate; await read(); };
    const hydration = reopened.loadSessions();
    expect(reopened.snapshot().sessionLoad.kind).toBe('loading');
    running = reopened.submit('Submitted while history is loading.');
    expect(reopened.snapshot().phase).toBe('starting');
    expect(f.seen).toHaveLength(2);
    release();
    expect(await hydration).toBe(true);
    const report = await running;
    expect(report?.status).toBe('replied');
    expect(report?.turnId).toBe(`${original}.turn-2`);
    expect(reopened.snapshot().sessionId).toBe(original);
    expect(reopened.snapshot().turns.map((turn) => turn.intent)).toEqual(['The original conversation.', 'Submitted while history is loading.']);
    const sessions = await readAgentSessions(f.store, f.state.manifest.project.id);
    expect(sessions.find((row) => row.sessionId === original)?.turns).toHaveLength(2);
    expect(sessions.find((row) => row.sessionId === other)?.turns).toHaveLength(1);
    expect(f.seen).toHaveLength(3);
  } finally { release(); await running; await f.close(); }
});

test('new, switch and fork keep separate conversations without manuscript writes or duplicate logs', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    const first = await agent.submit('Remember the lighthouse.');
    await agent.submit('Remember the storm.');
    const original = agent.snapshot().sessionId;
    const before = JSON.stringify([...f.state.documents]);
    await agent.forkSession(first!.turnId);
    const fork = agent.snapshot().sessionId;
    expect(fork).not.toBe(original);
    expect(agent.snapshot().conversationSessions.find((row) => row.sessionId === fork)?.title).toBe('Remember the lighthouse. · fork 1');
    expect(agent.snapshot().turns.map((turn) => turn.turnId)).toEqual([first!.turnId]);
    expect(agent.snapshot().conversationSessions.find((row) => row.sessionId === fork)?.forkedFrom).toEqual({ sessionId: original, turnSeq: 1 });
    expect(await readRuns(f.store, f.state.manifest.project.id)).toHaveLength(2);
    expect(JSON.stringify([...f.state.documents])).toBe(before);
    await agent.newSession();
    const empty = agent.snapshot().sessionId;
    expect(agent.snapshot().turns).toEqual([]);
    await agent.openSession(original);
    expect(agent.snapshot().turns).toHaveLength(2);
    await agent.openSession(fork);
    expect(agent.snapshot().turns).toHaveLength(1);
    await agent.deleteSession(original);
    expect(await readRuns(f.store, f.state.manifest.project.id)).toHaveLength(1);
    expect(agent.snapshot().turns).toHaveLength(1);
    expect((await readAgentSessions(f.store, f.state.manifest.project.id)).map((row) => row.sessionId)).toContain(empty);
  } finally { await f.close(); }
});

test('forks of the same parent keep distinct saved default labels', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    const turn = await agent.submit('Remember the lighthouse.');
    const parent = agent.snapshot().sessionId;
    await agent.forkSession(turn!.turnId);
    await agent.openSession(parent);
    await agent.forkSession(turn!.turnId);
    const reopened = f.controller();
    expect(await reopened.loadSessions()).toBe(true);
    expect(reopened.snapshot().conversationSessions.map((row) => row.title).sort()).toEqual([
      'Remember the lighthouse.',
      'Remember the lighthouse. · fork 1',
      'Remember the lighthouse. · fork 2',
    ]);
  } finally { await f.close(); }
});

test('rewind markers survive reload independently of a fork and exports round-trip', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    const turn = await agent.submit('Keep the ferry blue.');
    const original = agent.snapshot().sessionId;
    await agent.forkSession(turn!.turnId);
    const fork = agent.snapshot().sessionId;
    expect(agent.rewindConversation(turn!.turnId)?.rewound).toEqual([turn!.turnId]);
    await agent.openSession(original);
    expect(agent.snapshot().turns[0]?.rewound).toBe(false);
    await agent.openSession(fork);
    expect(agent.snapshot().turns[0]?.rewound).toBe(true);
    const rows = await readAgentSessions(f.store, f.state.manifest.project.id);
    const row = rows.find((item) => item.sessionId === fork)!;
    const markdown = sessionMarkdown(row, agent.snapshot().turns);
    const head = JSON.parse(markdown.slice(4, markdown.indexOf('\n---\n', 4)));
    expect(head.session).toEqual(row);
    expect(head.turns[0].report.summary).toBe(turn?.summary);
    const reopened = f.controller();
    expect(await reopened.loadSessions()).toBe(true);
    expect(reopened.snapshot().turns[0]?.rewound).toBe(true);
  } finally { await f.close(); }
});

test('discard requires the shared-session count and removes the turn from every fork', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    const turn = await agent.submit('Remember the letter.');
    await agent.forkSession(turn!.turnId);
    await agent.loadInterrupted();
    const run = (await readRuns(f.store, f.state.manifest.project.id))[0]!;
    expect(agent.sessionReferenceCount(run.runId)).toBe(2);
    await agent.discardRun(run.runId);
    expect(await readRuns(f.store, f.state.manifest.project.id)).toHaveLength(1);
    await agent.discardRun(run.runId, 2);
    expect(await readRuns(f.store, f.state.manifest.project.id)).toHaveLength(0);
    expect(agent.snapshot().turns).toHaveLength(0);
    expect((await readAgentSessions(f.store, f.state.manifest.project.id)).every((row) => row.turns.length === 0)).toBe(true);
  } finally { await f.close(); }
});

test('settled presentation omits reasoning, ghost, stream and preview payloads and keeps run events v3', async () => {
  const f = await fixture();
  try {
    await f.keys.putPayload(f.profile.id, { apiKey: 'fake-session-api-key-sentinel', customHeaders: { 'x-test-header': 'fake-session-header-sentinel' } });
    const agent = f.controller();
    await agent.submit('Tell me about the lighthouse.');
    const run = (await readRuns(f.store, f.state.manifest.project.id))[0]!;
    const presentation = run.presentation as { turn: { reasoning: string; ghost: unknown; streamed: string; requestContext?: unknown } };
    expect(presentation.turn.reasoning).toBe('');
    expect(presentation.turn.ghost).toBeNull();
    expect(presentation.turn.streamed).toBe('');
    expect(presentation.turn.requestContext).toBeUndefined();
    expect((await readRunEvents(f.store, run.runId))[0]).toMatchObject({ t: 'turn.start', v: 3 });
    const serialized = JSON.stringify({ runs: await readRuns(f.store, f.state.manifest.project.id), events: await readRunEvents(f.store, run.runId), sessions: await readAgentSessions(f.store, f.state.manifest.project.id) });
    expect(serialized).not.toContain('fake-session-api-key-sentinel');
    expect(serialized).not.toContain('fake-session-header-sentinel');
  } finally { await f.close(); }
});

test('forking through a rewound turn reactivates its history only in the fork', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    const turn = await agent.submit('Keep the harbour quiet.');
    const original = agent.snapshot().sessionId;
    expect(agent.rewindConversation(turn!.turnId)?.rewound).toEqual([turn!.turnId]);
    await agent.forkSession(turn!.turnId);
    expect(agent.snapshot().turns[0]?.rewound).toBe(false);
    const preview = await agent.previewRequest('What did I ask before?');
    expect(JSON.stringify(preview)).toContain('Keep the harbour quiet.');
    await agent.openSession(original);
    expect(agent.snapshot().turns[0]?.rewound).toBe(true);
  } finally { await f.close(); }
});

test('a failed conversation save is explicit, blocks switching and can be retried without another model call', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    const retryWrites = refuseSessionWrites(f.store, 'session storage refused');
    const turn = await agent.submit('Keep this answer even if storage refuses.');
    expect(turn?.status).toBe('replied');
    expect(agent.snapshot().sessionSave.kind).toBe('failed');
    expect(agent.snapshot().sessionSave.failure).toContain('session storage refused');
    const id = agent.snapshot().sessionId;
    await agent.newSession();
    expect(agent.snapshot().sessionId).toBe(id);
    expect(f.seen).toHaveLength(1);
    retryWrites();
    await agent.retrySessionSave();
    expect(agent.snapshot().sessionSave).toEqual({ kind: 'idle', failure: null });
    expect((await readAgentSessions(f.store, f.state.manifest.project.id))[0]?.turns).toHaveLength(1);
    expect(f.seen).toHaveLength(1);
  } finally { await f.close(); }
});

test('two messages enqueued in the same tick both run once and in order', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    await agent.loadSessions();
    agent.enqueue('First queued message.');
    agent.enqueue('Second queued message.');
    await expect.poll(() => agent.snapshot().turns.filter((turn) => turn.report !== null).length).toBe(2);
    expect(agent.snapshot().turns.map((turn) => turn.intent)).toEqual(['First queued message.', 'Second queued message.']);
    expect(f.seen).toHaveLength(2);
    expect(agent.snapshot().queue).toHaveLength(0);
  } finally { await f.close(); }
});

test('a save refusal preserves the queued head until a save-only retry succeeds', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    const retryWrites = refuseSessionWrites(f.store, 'storage refused');
    await agent.submit('Keep the settled turn.');
    agent.enqueue('Keep the queued message.');
    await expect.poll(() => agent.snapshot().queuePaused).toBe(true);
    agent.runQueue();
    expect(agent.snapshot().queue.map((item) => item.intent)).toEqual(['Keep the queued message.']);
    expect(f.seen).toHaveLength(1);
    retryWrites();
    await agent.retrySessionSave();
    agent.runQueue();
    await expect.poll(() => agent.snapshot().turns.filter((turn) => turn.report !== null).length).toBe(2);
    expect(f.seen).toHaveLength(2);
  } finally { await f.close(); }
});

test('a marker save that fails while switching keeps the live conversation and marker', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    const report = await agent.submit('Remember the harbour.');
    const original = agent.snapshot().sessionId;
    await agent.newSession();
    const other = agent.snapshot().sessionId;
    await agent.openSession(original);
    f.factory.abortAfterWrites(0);
    expect(agent.rewindConversation(report!.turnId)).not.toBeNull();
    await agent.openSession(other);
    expect(agent.snapshot().sessionSave.kind).toBe('failed');
    expect(agent.snapshot().sessionId).toBe(original);
    expect(agent.snapshot().turns[0]?.rewound).toBe(true);
    await agent.retrySessionSave();
    const reopened = f.controller();
    await reopened.loadSessions();
    expect(reopened.snapshot().sessionId).toBe(original);
    expect(reopened.snapshot().turns[0]?.rewound).toBe(true);
  } finally { await f.close(); }
});

test('discarding the latest turn never reuses its id or ledger rows, even after reload', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    const first = await agent.submit('Keep turn one.');
    const second = await agent.submit('Discard turn two.');
    const id = agent.snapshot().sessionId;
    await agent.loadInterrupted();
    const run = (await readRuns(f.store, f.state.manifest.project.id)).find((row) => row.intent === 'Discard turn two.')!;
    await agent.discardRun(run.runId, 1);
    const third = await agent.submit('This must be turn three.');
    expect(third?.turnId).toBe(`${id}.turn-3`);
    expect(third?.tokens.requests).toBe(1);
    await agent.loadInterrupted();
    const latest = (await readRuns(f.store, f.state.manifest.project.id)).find((row) => row.intent === 'This must be turn three.')!;
    await agent.discardRun(latest.runId, 1);
    const reopened = f.controller();
    const fourth = await reopened.submit('This must be turn four.');
    expect(fourth?.turnId).toBe(`${id}.turn-4`);
    expect(fourth?.tokens.requests).toBe(1);
    expect(fourth?.turnId).not.toBe(first?.turnId);
    expect(fourth?.turnId).not.toBe(second?.turnId);
    expect((await readAgentSessions(f.store, f.state.manifest.project.id))[0]?.nextTurn?.chat).toBe(5);
  } finally { await f.close(); }
});

test('presentation-less v3 runs are grouped in order and recover their durable usage', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    const first = await agent.submit('Legacy first request.');
    const second = await agent.submit('Legacy second request.');
    const id = agent.snapshot().sessionId;
    const runs = await readRuns(f.store, f.state.manifest.project.id);
    await transact<void>(f.store.db, [AGENT_SESSION_STORE, RUN_STORE], 'readwrite', (tx, done) => {
      tx.objectStore(AGENT_SESSION_STORE).delete([f.state.manifest.project.id, id]);
      for (const { presentation: _presentation, ...run } of runs) tx.objectStore(RUN_STORE).put(run);
      done();
    });
    const reopened = f.controller();
    expect(await reopened.loadSessions()).toBe(true);
    expect(reopened.snapshot().sessionId).toBe(id);
    expect(reopened.snapshot().turns.map((turn) => turn.turnId)).toEqual([first!.turnId, second!.turnId]);
    expect(reopened.snapshot().turns[0]?.report?.tokens).toEqual(first?.tokens);
    const continued = await reopened.submit('Legacy follow-up.');
    expect(continued?.turnId).toBe(`${id}.turn-3`);
    const preview = await reopened.previewRequest('What did we discuss?');
    expect(JSON.stringify(preview)).toContain('Legacy second request.');
    expect(JSON.stringify(preview)).toContain('The ferryman knows about the letter.');
  } finally { await f.close(); }
});

for (const existing of [false, true]) test(`legacy migration preserves every role counter after unbilled logs are discarded, with existing metadata ${existing}`, async () => {
  const f = await fixture();
  try {
    const projectId = f.state.manifest.project.id;
    const sessionId = 'legacy';
    const at = Date.now();
    if (existing) await saveAgentSession(f.store, { projectId, sessionId, formatVersion: 1, title: 'Existing conversation', active: true, createdAt: at, updatedAt: at, turns: [], nextTurn: { chat: 20, drafting: 4, background: 12 } });
    for (const [role, number] of [['chat', 9], ['drafting', 7], ['background', 5]] as const) {
      const turnId = `${sessionId}${role === 'chat' ? '' : `.${role}`}.turn-${number}`;
      await createRun(f.store, { schema: 3, projectId, runId: role, kind: 'turn', intent: `Legacy ${role}`, createdAt: at, updatedAt: at, status: 'finished', outcome: 'replied' });
      await appendRunEvents(f.store, role, [
        { t: 'turn.start', v: 3, seq: 0, at, turnId, intent: `Legacy ${role}`, wire: 'planner', native: false },
        { t: 'turn.end', seq: 1, at, turnId, status: 'replied', summary: 'An earlier answer.' },
      ]);
    }
    const agent = f.controller();
    expect(await agent.loadSessions()).toBe(true);
    expect(agent.snapshot().sessionId).toBe(sessionId);
    expect(agent.snapshot().sessionUsage.totals.requests).toBe(0);
    const counters = existing ? { chat: 20, drafting: 8, background: 12 } : { chat: 10, drafting: 8, background: 6 };
    expect((await readAgentSessions(f.store, projectId))[0]?.nextTurn).toEqual(counters);
    await agent.loadInterrupted();
    for (const role of ['chat', 'drafting', 'background']) await agent.discardRun(role, 1);
    expect(await readRuns(f.store, projectId)).toEqual([]);
    expect((await readAgentSessions(f.store, projectId))[0]?.nextTurn).toEqual(counters);
    const reopened = f.controller();
    const report = await reopened.submit('Continue after discarding imported logs.');
    expect(report?.turnId).toBe(`${sessionId}.turn-${counters.chat}`);
    expect(report?.tokens.requests).toBe(1);
  } finally { await f.close(); }
});

test('simultaneous session actions cannot persist one active row while showing another', async () => {
  const f = await fixture();
  try {
    const agent = f.controller();
    await agent.submit('Original session.');
    const original = agent.snapshot().sessionId;
    await Promise.all([agent.newSession(), agent.openSession(original)]);
    const active = (await readAgentSessions(f.store, f.state.manifest.project.id)).filter((row) => row.active);
    expect(active).toHaveLength(1);
    expect(active[0]?.sessionId).toBe(agent.snapshot().sessionId);
    expect(agent.snapshot().sessionId).not.toBe(original);
  } finally { await f.close(); }
});
