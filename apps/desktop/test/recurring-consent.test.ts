import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { i18n } from '@lingui/core';
import { seededId } from '@caotang/ids';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type ChatRequest } from '@caotang/gateway';
import { createMockProvider } from '@caotang/gateway/mock';
import { MemoryIndexedDb, openRuntimeStore, writeProjectState } from '@caotang/store';
import { bodyHash, type AgentTask } from '@caotang/tasks';
import { AgentController } from '../src/app/agent.js';
import { setActiveAppDb, type AppDb, type TaskConsentRow, type TaskRunRow } from '../src/app/app-db.js';
import { sampleProjectState } from '../src/app/demo.js';
import type { ProviderService } from '../src/app/providers.js';
import { RecurringTasks } from '../src/app/recurring-tasks.js';
import { DEFAULT_AGENT_SETTINGS } from '../src/app/settings.js';
import { ProjectSession } from '../src/app/session.js';
import { TaskConsents } from '../src/app/task-consents.js';
import { TaskRuns } from '../src/app/task-runs.js';
import { TaskStore } from '../src/app/task-store.js';
import { openTasksHome } from '../src/app/tasks-io.js';
import { messages } from '../src/i18n/locales/en/messages.po';
import { messages as germanMessages } from '../src/i18n/locales/de/messages.po';

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  i18n.load('en', messages);
  i18n.activate('en');
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  setActiveAppDb(null);
  vi.unstubAllGlobals();
});

function memoryDb(): AppDb {
  const values = new Map<string, unknown>();
  const consents = new Map<string, TaskConsentRow>();
  const runs = new Map<string, TaskRunRow>();
  return {
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async list<T>(prefix: string) { return [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })); },
    async delete(key) { values.delete(key); },
    taskConsents: {
      async list(projectId) { return [...consents.values()].filter((row) => row.projectId === projectId); },
      async put(row) { consents.set(row.key, structuredClone(row)); },
      async delete(keys) { for (const key of keys) consents.delete(key); },
    },
    taskRuns: {
      async list(projectId) { return [...runs.values()].filter((row) => row.projectId === projectId); },
      async put(row) { runs.set(row.key, structuredClone(row)); },
      async delete(keys) { for (const key of keys) runs.delete(key); },
    },
    close() {},
  };
}

async function fixture(cap = 2, settingCap?: number, previous?: { readonly state: ReturnType<typeof sampleProjectState>; readonly db: AppDb }) {
  const state = previous?.state ?? sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state, { now: new Date() });
  const session = new ProjectSession({ store, state, projectId: state.manifest.project.id, shadow: null });
  session.attachTasks(await openTasksHome(session.projectId, store));
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  const requests: ChatRequest[] = [];
  const gateway = createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [{ match: () => true, respond: (request) => { requests.push(request); return { content: 'A quiet synopsis.' }; } }] }) });
  const providers = { gateway, active: () => profile, get: (id: string) => profiles.get(id), resolveForRole: () => ({ profile, model: profile.defaultModel }), persist: async () => undefined } as unknown as ProviderService;
  const db = previous?.db ?? memoryDb();
  setActiveAppDb(db);
  const agent = new AgentController(session, providers, () => ({}), () => false, { store: new TaskStore(db), locksAvailable: () => true }, () => ({ ...DEFAULT_AGENT_SETTINGS, budget: settingCap === undefined ? {} : { maxModelCalls: settingCap } }));
  await session.harnessReady();
  agent.attach();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const task: AgentTask = {
    id: seededId('t', 1), name: 'Daily synopses', enabled: true, schedule: { kind: 'daily', at: '00:00' }, whenDue: 'run',
    permission: 'ask', maxModelCalls: cap,
    body: { kind: 'plan', steps: [{ tool: 'synopsis.fill', params: { docs: ['The Landing', 'The Storm'], source: 'text', max_words: 20 }, expect: 'Two synopses' }] },
  };
  await session.tasksHome()!.save({ formatVersion: 1, tasks: [task] });
  const consents = await TaskConsents.open(session.projectId, db);
  const runs = await TaskRuns.open(session.projectId, db);
  const recurring = new RecurringTasks({ session, agent, consents, runs, visible: () => true, timeZone: () => 'UTC', every: () => () => undefined });
  cleanup.push(async () => { recurring.detach(); agent.detach(); await agent.tasksIdle(); await session.close(); });
  await recurring.attach();
  return { state, session, agent, db, consents, runs, recurring, requests, task, gateway };
}

it('requires a separate exact-task allowance, stages without changing the project or holding the panel, and reconciles one run', async () => {
  const f = await fixture();
  expect(f.recurring.snapshot().offers).toHaveLength(1);
  expect(f.requests).toHaveLength(0);
  const before = JSON.stringify(f.state.manifest);
  expect(await f.recurring.allowSelfStart(f.task.id, bodyHash(f.task))).toBeNull();
  await Promise.all([f.recurring.evaluate(), f.recurring.evaluate()]);
  await f.agent.tasksIdle();
  await f.recurring.evaluate();
  expect(f.requests).toHaveLength(2);
  expect(f.requests.every((request) => request.role === 'background')).toBe(true);
  expect(JSON.stringify(f.state.manifest)).toBe(before);
  expect(f.agent.snapshot().turns).toEqual([]);
  expect(f.agent.taskViews()).toMatchObject([{ status: 'ready', recurringTaskId: f.task.id }]);
  expect(f.runs.history(f.task.id)).toMatchObject([{ status: 'ready', requests: 2 }]);
  const reloadedRuns = await TaskRuns.open(f.session.projectId, f.db);
  expect(reloadedRuns.history(f.task.id)).toHaveLength(1);
  await f.recurring.evaluate();
  expect(f.requests).toHaveLength(2);
});

it('invalidates a saved edit even when the writer later reverts it, and refuses a stale allowance dialog', async () => {
  const f = await fixture();
  await f.recurring.allowSelfStart(f.task.id, bodyHash(f.task));
  const original = f.recurring.snapshot().tasks[0]!.draft;
  expect(await f.recurring.save({ ...original, maxModelCalls: '3' }, f.task.id)).toBeNull();
  expect(await f.recurring.allowSelfStart(f.task.id, bodyHash(f.task))).toContain('changed');
  expect(await f.recurring.save(original, f.task.id)).toBeNull();
  expect((await TaskConsents.open(f.session.projectId, f.db)).get(f.task.id)).toBeUndefined();
  await f.recurring.evaluate();
  expect(f.requests).toHaveLength(0);
  expect(f.recurring.snapshot().offers).toHaveLength(1);
});

it('holds the shared staging cap to the lower app limit', async () => {
  const f = await fixture(5, 1);
  await f.recurring.allowSelfStart(f.task.id, bodyHash(f.task));
  await f.recurring.evaluate();
  await f.agent.tasksIdle();
  await f.recurring.evaluate();
  expect(f.requests).toHaveLength(1);
  expect(f.runs.history(f.task.id)[0]?.requests).toBe(1);
  expect(f.agent.taskViews()[0]?.errors.join(' ')).toContain('limit of 1');
});

it('starts no paid work when queue persistence fails', async () => {
  const f = await fixture();
  await f.recurring.allowSelfStart(f.task.id, bodyHash(f.task));
  f.db.put = async () => { throw Error('storage blocked'); };
  await f.recurring.evaluate();
  await f.agent.tasksIdle();
  expect(f.requests).toHaveLength(0);
  expect(f.agent.taskViews()).toEqual([]);
  expect(f.runs.history(f.task.id)).toEqual([]);
  expect(f.recurring.snapshot().offers).toHaveLength(1);
});

it('takes a revoked allowance back durably before the next scheduler tick', async () => {
  const f = await fixture();
  await f.recurring.allowSelfStart(f.task.id, bodyHash(f.task));
  expect(await f.recurring.revokeSelfStart(f.task.id)).toBeNull();
  expect((await TaskConsents.open(f.session.projectId, f.db)).get(f.task.id)).toBeUndefined();
  await f.recurring.evaluate();
  expect(f.requests).toHaveLength(0);
  expect(f.recurring.snapshot().offers).toHaveLength(1);
});

it.each(['revoke', 'disable', 'edit', 'remove'] as const)('%s cancels recovered automatic work durably instead of leaving it resumable', async (action) => {
  const first = await fixture(5);
  await first.recurring.allowSelfStart(first.task.id, bodyHash(first.task));
  await first.recurring.evaluate();
  await first.agent.tasksIdle();
  await first.recurring.evaluate();
  first.recurring.detach();
  first.agent.detach();
  await first.agent.tasksIdle();
  const store = new TaskStore(first.db);
  const stored = (await store.list(first.session.projectId))[0]!;
  await store.save({ ...stored, status: 'interrupted', createdAt: Date.now() - 86_400_000, items: stored.items.map((item) => ({ ...item, state: 'pending' as const })) });
  const recovered = await fixture(5, undefined, first);
  expect(recovered.agent.taskViews()[0]).toMatchObject({ status: 'interrupted', canResume: true });
  expect(recovered.recurring.snapshot().offers).toHaveLength(0);
  let failure: string | null;
  if (action === 'revoke') failure = await recovered.recurring.revokeSelfStart(recovered.task.id);
  else if (action === 'disable') failure = await recovered.recurring.setEnabled(recovered.task.id, false);
  else if (action === 'edit') failure = await recovered.recurring.save({ ...recovered.recurring.snapshot().tasks[0]!.draft, maxModelCalls: '6' }, recovered.task.id);
  else failure = await recovered.recurring.remove(recovered.task.id);
  expect(failure).toBeNull();
  expect(recovered.agent.taskViews()[0]).toMatchObject({ status: 'cancelled', canResume: false });
  expect((await store.list(first.session.projectId))[0]?.status).toBe('cancelled');
  await recovered.agent.resumeTask(stored.id);
  await recovered.agent.tasksIdle();
  await recovered.recurring.evaluate();
  expect(recovered.requests).toHaveLength(0);
  expect(recovered.recurring.snapshot().offers).toHaveLength(action === 'revoke' || action === 'edit' ? 1 : 0);
});

it('holds Inbox review to the current task permission even under Auto mode', async () => {
  const f = await fixture();
  await f.recurring.allowSelfStart(f.task.id, bodyHash(f.task));
  await f.recurring.evaluate();
  await f.agent.tasksIdle();
  const queued = f.agent.taskViews()[0]!;
  expect(queued.status).toBe('ready');
  await f.session.tasksHome()!.save({ formatVersion: 1, tasks: [{ ...f.task, permission: 'read-only' }] });
  const before = JSON.stringify(f.state.manifest);
  f.agent.setMode('auto');
  const reviewed = await f.agent.reviewTask(queued.id);
  expect(reviewed?.status).toBe('failed');
  expect(JSON.stringify(f.state.manifest)).toBe(before);
  expect(f.agent.snapshot().turns.at(-1)?.mode).toBe('plan-only');
  expect(f.agent.snapshot().pending).toBeNull();
  expect(f.agent.taskViews()[0]?.status).toBe('ready');
  expect(f.requests).toHaveLength(2);
});

it('fences a request waiting for gateway admission when the task is disabled', async () => {
  const f = await fixture();
  const original = f.gateway.complete.bind(f.gateway);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let waiting = false;
  f.gateway.complete = async function* (request, signal, beforeSend) {
    waiting = true;
    await gate;
    yield* original(request, signal, beforeSend);
  };
  await f.recurring.allowSelfStart(f.task.id, bodyHash(f.task));
  await f.recurring.evaluate();
  await expect.poll(() => waiting).toBe(true);
  expect(await f.recurring.setEnabled(f.task.id, false)).toBeNull();
  release();
  await f.agent.tasksIdle();
  expect(f.requests).toHaveLength(0);
  expect(f.agent.taskViews()[0]?.status).toBe('cancelled');
});

it('refuses a paid call when its durable allowance reservation fails', async () => {
  const f = await fixture();
  await f.recurring.allowSelfStart(f.task.id, bodyHash(f.task));
  const put = f.db.put.bind(f.db);
  f.db.put = async (key, value) => {
    if ((value as { reservedCalls?: number }).reservedCalls) throw Error('reservation blocked');
    await put(key, value);
  };
  await f.recurring.evaluate();
  await f.agent.tasksIdle();
  expect(f.requests).toHaveLength(0);
  expect(f.agent.taskViews()[0]?.errors.join(' ')).toContain('no model request was sent');
});

it('does not grant a task edited while its allowance write was pending', async () => {
  const f = await fixture();
  const db = f.db.taskConsents!;
  const put = db.put.bind(db);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  db.put = async (row) => { await gate; await put(row); };
  const granting = f.recurring.allowSelfStart(f.task.id, bodyHash(f.task));
  const changed = { ...f.task, maxModelCalls: 3 };
  await f.session.tasksHome()!.save({ formatVersion: 1, tasks: [changed] });
  release();
  expect(await granting).toContain('changed');
  expect((await TaskConsents.open(f.session.projectId, f.db)).get(f.task.id)).toBeUndefined();
  await f.recurring.evaluate();
  expect(f.requests).toHaveLength(0);
});

it('lets Skip cancel an automatic admission while its queue save is pending', async () => {
  const f = await fixture();
  await f.recurring.allowSelfStart(f.task.id, bodyHash(f.task));
  const put = f.db.put.bind(f.db);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let saving = false;
  f.db.put = async (key, value) => { saving = true; await gate; await put(key, value); };
  const evaluation = f.recurring.evaluate();
  await expect.poll(() => saving).toBe(true);
  await f.recurring.skip(f.task.id);
  release();
  await evaluation;
  await f.agent.tasksIdle();
  expect(f.requests).toHaveLength(0);
  expect(f.recurring.snapshot().offers).toHaveLength(0);
  expect(f.runs.history(f.task.id)).toMatchObject([{ status: 'skipped' }]);
});

it('does not admit automatic work while disabling the task is still being saved', async () => {
  const f = await fixture();
  await f.recurring.allowSelfStart(f.task.id, bodyHash(f.task));
  const home = f.session.tasksHome()!;
  const save = home.save.bind(home);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let saving = false;
  home.save = async (file) => { saving = true; await gate; return save(file); };
  const disabling = f.recurring.setEnabled(f.task.id, false);
  await expect.poll(() => saving).toBe(true);
  await f.recurring.evaluate();
  expect(f.requests).toHaveLength(0);
  expect(f.agent.taskViews()).toHaveLength(0);
  release();
  expect(await disabling).toBeNull();
});

it('says the schedule and the plan summary through the interface catalogue', async () => {
  i18n.load('de', germanMessages);
  i18n.activate('de');
  try {
    const f = await fixture();
    const row = f.recurring.snapshot().tasks[0]!;
    expect(row.schedule).toBe('Jeden Tag ab 00:00');
    expect(row.doing).toBe('Einen Plan mit 1 Schritt ausführen');
  } finally {
    i18n.activate('en');
  }
});
