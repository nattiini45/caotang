import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore, readTaskFiles, writeProjectState, ZIP_ENGINE, type ProjectState, type RuntimeStore } from '../../packages/store/src/index.js';
import { DEMO_INTENTS } from '../../packages/gateway/src/mock/index.js';
import { seededId } from '../../packages/ids/src/index.js';
import { TASKS_FILE, bodyHash, type AgentTask } from '../../packages/tasks/src/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import { RecurringTasks, SELF_START_NOTE, type RecurringOptions } from '../../apps/desktop/src/app/recurring-tasks.js';
import { TaskRuns } from '../../apps/desktop/src/app/task-runs.js';
import { attachCoherence } from '../../apps/desktop/src/app/coherence-io.js';
import { openTasksHome } from '../../apps/desktop/src/app/tasks-io.js';
import { exportStoredBundle, importBundle } from '../../apps/desktop/src/app/lifecycle.js';
import { DEFAULT_AGENT_SETTINGS } from '../../apps/desktop/src/app/settings.js';
import { openAppDb } from '../../apps/desktop/src/app/app-db.js';

/**
 * Recurring tasks through the app's controller (agent-harness.md §12), headless: what is due is offered and nothing more, a scan starts by
 * itself and makes no request, a model task is only offered, the file can only lower a run, and the runs are kept on this machine.
 */

const globals = globalThis as unknown as Record<string, unknown>;
let previous: { document: unknown; window: unknown } | null = null;

test.beforeAll(() => {
  previous = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});

test.afterAll(() => {
  if (previous === null) return;
  globals['document'] = previous.document;
  globals['window'] = previous.window;
});

/** A daily 09:00 scan task, due at MORNING, to be patched into the shape a test needs. */
function seedTask(seed: number, patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id: seededId('t', seed),
    name: `Task ${seed}`,
    enabled: true,
    schedule: { kind: 'daily', at: '09:00' },
    whenDue: 'offer',
    body: { kind: 'scan', scope: 'full' },
    permission: 'ask',
    ...patch,
  };
}

const BERLIN = 'Europe/Berlin';
/** 10:30 in Berlin on 2026-06-10. */
const MORNING = new Date('2026-06-10T08:30:00Z');

interface Rig {
  readonly state: ProjectState;
  readonly store: RuntimeStore;
  readonly session: ProjectSession;
  readonly providers: ProviderService;
  readonly agent: AgentController;
  readonly recurring: RecurringTasks;
  readonly runs: TaskRuns;
  readonly clock: { now: Date };
  readonly ticks: Array<() => void>;
}

async function rig(
  tasks: readonly AgentTask[],
  options: { runs?: TaskRuns; store?: RuntimeStore; state?: ProjectState; settings?: typeof DEFAULT_AGENT_SETTINGS; now?: Date } = {},
): Promise<Rig> {
  const state = options.state ?? sampleProjectState();
  const store = options.store ?? (await openRuntimeStore(new MemoryIndexedDb()));
  await writeProjectState(store, state, { now: new Date() });
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  await attachCoherence(session, store);
  session.attachTasks(await openTasksHome(state.manifest.project.id, store));
  const home = session.tasksHome();
  if (home === null) throw new Error('no tasks home');
  if (tasks.length > 0) expect(await home.save({ formatVersion: 1, tasks })).toBeNull();
  const providers = (await ProviderService.open({ db: null, vault: null })).service;
  const agent = new AgentController(session, providers, () => ({}), () => false, {}, () => options.settings ?? DEFAULT_AGENT_SETTINGS);
  const runs = options.runs ?? TaskRuns.none(state.manifest.project.id);
  const clock = { now: options.now ?? MORNING };
  const ticks: Array<() => void> = [];
  const recurringOptions: RecurringOptions = {
    session,
    agent,
    runs,
    now: () => clock.now,
    timeZone: () => BERLIN,
    visible: () => true,
    every: (tick) => {
      ticks.push(tick);
      return () => undefined;
    },
  };
  return { state, store, session, providers, agent, recurring: new RecurringTasks(recurringOptions), runs, clock, ticks };
}

const requestsMade = (r: Rig): number => r.providers.requests.entries().length + r.providers.gateway.ledger.dayRows().length;

test.describe('what is due is offered', () => {
  test('a daily task is announced and offered with Run now and Skip, and nothing runs until the writer chooses', async () => {
    const task = seedTask(1, { name: 'Read the new scenes', body: { kind: 'intent', text: DEMO_INTENTS.fillSynopses } });
    const r = await rig([task]);
    await r.recurring.attach();

    const snap = r.recurring.snapshot();
    expect(snap.offers.map((offer) => offer.name)).toEqual(['Read the new scenes']);
    expect(snap.offers[0]?.usesModel).toBe(true);
    expect(snap.announcement).toBe('Task due: Read the new scenes. Run now or Skip.');
    expect(snap.running).toBeNull();
    expect(r.agent.snapshot().turns).toEqual([]);
    expect(requestsMade(r)).toBe(0);
    await r.session.close();
  });

  test('Skip records the skip and the offer does not come back before the next occurrence', async () => {
    const task = seedTask(1);
    const r = await rig([task]);
    await r.recurring.attach();
    expect(r.recurring.snapshot().offers).toHaveLength(1);

    await r.recurring.skip(task.id);
    expect(r.recurring.snapshot().offers).toEqual([]);
    expect(r.runs.history(task.id)[0]).toMatchObject({ status: 'skipped', trigger: 'due' });

    await r.recurring.evaluate();
    expect(r.recurring.snapshot().offers).toEqual([]);
    // The next day's occurrence offers it again, as the timer finds it.
    r.clock.now = new Date('2026-06-11T08:30:00Z');
    r.ticks[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.recurring.snapshot().offers.map((offer) => offer.id)).toEqual([task.id]);
    await r.session.close();
  });

  test('a task missed for several days is offered once', async () => {
    const task = seedTask(1);
    const runs = TaskRuns.none('p_x');
    await runs.record({
      taskId: task.id,
      at: '2026-06-01T08:00:00.000Z',
      status: 'done',
      trigger: 'due',
      summary: 'Old.',
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
    });
    const r = await rig([task], { runs });
    await r.recurring.attach();
    await r.recurring.evaluate();
    await r.recurring.evaluate();
    expect(r.recurring.snapshot().offers).toHaveLength(1);
    await r.session.close();
  });

  test('a manual task, a disabled task and a task whose plan does not parse are never offered', async () => {
    const r = await rig([
      seedTask(1, { schedule: { kind: 'manual' } }),
      seedTask(2, { enabled: false }),
      seedTask(3, { body: { kind: 'plan', steps: [{ tool: 'meta.set' } as never] }, problem: 'Its plan does not parse: nope' }),
    ]);
    await r.recurring.attach();
    expect(r.recurring.snapshot().offers).toEqual([]);
    expect(r.recurring.snapshot().tasks.find((row) => row.name === 'Task 3')?.problem).toContain('does not parse');
    await r.session.close();
  });

  test('on-open tasks are offered as the project opens, once for each open', async () => {
    const task = seedTask(1, { schedule: { kind: 'on-open' } });
    const r = await rig([task]);
    await r.recurring.attach();
    expect(r.recurring.snapshot().offers).toHaveLength(1);
    r.recurring.detach();
    await r.recurring.attach();
    expect(r.recurring.snapshot().offers).toHaveLength(1);
    await r.session.close();
  });
});

test('a panel that attaches, detaches and attaches again, as an effect run twice does, reads the history and keeps the timer once', async () => {
  const task = seedTask(1, { schedule: { kind: 'on-open' }, whenDue: 'run', body: { kind: 'scan', scope: 'full' } });
  const r = await rig([task]);
  const ticks: Array<() => void> = [];
  const twice = new RecurringTasks({
    session: r.session,
    agent: r.agent,
    now: () => r.clock.now,
    timeZone: () => BERLIN,
    visible: () => true,
    every: (tick) => {
      ticks.push(tick);
      return () => undefined;
    },
  });
  const first = twice.attach();
  twice.detach();
  const second = twice.attach();
  await Promise.all([first, second]);

  expect(ticks).toHaveLength(1);
  // The scan the open made is in the history the panel reads, and was made once.
  expect(twice.snapshot().tasks[0]?.history).toHaveLength(1);
  await r.session.close();
});

test.describe('a scan starts by itself and calls no model', () => {
  test('on open it runs with no click, appends its run to the findings file and makes no request', async () => {
    const task = seedTask(1, { schedule: { kind: 'on-open' }, whenDue: 'run', body: { kind: 'scan', scope: 'full' }, name: 'Weekly scan' });
    const r = await rig([task]);
    const before = r.session.coherenceFile()?.runs.length ?? 0;
    await r.recurring.attach();

    const history = r.runs.history(task.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'done', trigger: 'due', requests: 0, promptTokens: 0, completionTokens: 0 });
    expect(history[0]?.summary).toMatch(/^Scan /);
    expect(r.session.coherenceFile()?.runs.length).toBe(before + 1);
    expect(r.recurring.snapshot().offers).toEqual([]);
    expect(r.agent.snapshot().turns).toEqual([]);
    // The request log and the ledger are the gateway's: a scan reaches neither.
    expect(requestsMade(r)).toBe(0);
    await r.session.close();
  });

  test('it leaves out a document a read rule keeps from the agent, as the agent’s own scan does', async () => {
    const scan = seedTask(1, { schedule: { kind: 'manual' }, whenDue: 'offer', body: { kind: 'scan', scope: 'full' } });
    const open = await rig([scan]);
    await open.recurring.runNow(scan.id);
    const everyone = open.session.coherenceFile()?.runs.at(-1)?.scope.docIds ?? [];
    expect(everyone.length).toBeGreaterThan(1);
    await open.session.close();

    const state = sampleProjectState();
    const hidden = state.manifest.tree.find((node) => node.title === 'The Storm');
    expect(hidden).toBeDefined();
    const ruled = await rig([scan], { state });
    ruled.session.setAgentAccess(hidden?.id ?? '', 'none');
    await ruled.recurring.runNow(scan.id);
    const scanned = ruled.session.coherenceFile()?.runs.at(-1)?.scope.docIds ?? [];
    expect(scanned).not.toContain(hidden?.id);
    expect(scanned.length).toBe(everyone.length - 1);
    expect(requestsMade(ruled)).toBe(0);
    await ruled.session.close();
  });

  test('a whole-project scan that a read rule left with no document records that nothing was scanned, not a clean result', async () => {
    const task = seedTask(1, { schedule: { kind: 'manual' }, body: { kind: 'scan', scope: 'full' } });
    const r = await rig([task]);
    r.session.setAgentAccess('manuscript', 'none');
    await r.recurring.runNow(task.id);
    const record = r.runs.history(task.id)[0];
    expect(record).toMatchObject({ status: 'failed', requests: 0 });
    expect(record?.summary).toContain('Nothing was scanned');
    expect(record?.summary).toContain('A rule in this project may be keeping the manuscript from the agent');
    await r.session.close();
  });

  test('a scan that Settings › Coherence has cut down names the checks it did not run', async () => {
    const task = seedTask(1, { schedule: { kind: 'manual' }, body: { kind: 'scan', scope: 'full' } });
    const r = await rig([task]);
    const some = new RecurringTasks({ session: r.session, agent: r.agent, runs: r.runs, enabledChecks: () => ['pov.coverage'], now: () => r.clock.now, timeZone: () => BERLIN, visible: () => true, every: () => () => undefined });
    await some.runNow(task.id);
    const record = r.runs.history(task.id)[0];
    expect(record?.status).toBe('done');
    expect(record?.summary).toMatch(/^Scan /);
    expect(record?.summary).toContain('turned off in Settings › Coherence: codex.alias-collisions');
    expect(record?.summary).not.toContain('pov.coverage,');
    await r.session.close();
  });

  test('a scan with every check on and a manuscript to read keeps its plain summary', async () => {
    const task = seedTask(1, { schedule: { kind: 'manual' }, body: { kind: 'scan', scope: 'full' } });
    const r = await rig([task]);
    await r.recurring.runNow(task.id);
    const record = r.runs.history(task.id)[0];
    expect(record?.status).toBe('done');
    expect(record?.summary).toMatch(/^Scan \w+: \d+ finding\(s\) in \d+ group\(s\) across [1-9]\d* document\(s\)\.$/);
    await r.session.close();
  });

  test('a scan whose every check is turned off records that nothing ran, and says why', async () => {
    const task = seedTask(1, { schedule: { kind: 'manual' }, body: { kind: 'scan', scope: 'full' } });
    const r = await rig([task]);
    const off = new RecurringTasks({ session: r.session, agent: r.agent, runs: r.runs, enabledChecks: () => [], now: () => r.clock.now, timeZone: () => BERLIN, visible: () => true, every: () => () => undefined });
    await off.runNow(task.id);
    expect(r.runs.history(task.id)[0]).toMatchObject({ status: 'failed' });
    expect(r.runs.history(task.id)[0]?.summary).toContain('turned off');
    await r.session.close();
  });
});

test.describe('a task that uses a model is only offered', () => {
  test('saved as run, with a cap and even with a hash that looks like consent, it is offered and says so', async () => {
    const task = seedTask(1, {
      schedule: { kind: 'on-open' },
      whenDue: 'run',
      maxModelCalls: 4,
      body: { kind: 'intent', text: DEMO_INTENTS.fillSynopses },
    });
    const r = await rig([task]);
    await r.recurring.attach();

    const row = r.recurring.snapshot().tasks[0];
    expect(row?.note).toBe(SELF_START_NOTE);
    expect(r.recurring.snapshot().offers.map((offer) => offer.id)).toEqual([task.id]);
    expect(r.agent.snapshot().turns).toEqual([]);
    expect(r.runs.history(task.id)).toEqual([]);
    expect(requestsMade(r)).toBe(0);
    expect(bodyHash(task)).toMatch(/^[0-9a-f]{64}$/);
    await r.session.close();
  });
});

test.describe('Run now', () => {
  test('is an ordinary turn under the Background role, recorded with what it used', async () => {
    const task = seedTask(1, { schedule: { kind: 'manual' }, permission: 'read-only', body: { kind: 'intent', text: DEMO_INTENTS.fillSynopses } });
    const r = await rig([task]);
    await r.recurring.attach();
    await r.recurring.runNow(task.id);

    const roles = [...new Set(r.providers.gateway.ledger.turnRows().map((row) => row.role))];
    expect(roles).toEqual(['background']);
    const run = r.runs.history(task.id)[0];
    expect(run).toMatchObject({ status: 'done', trigger: 'manual' });
    expect(run?.turnId).toBeDefined();
    expect(r.recurring.snapshot().running).toBeNull();
    await r.session.close();
  });

  test('the file’s permission can only lower the run: read-only holds the writes, and ask holds the card under an Accept edits panel', async () => {
    const readOnly = seedTask(1, { schedule: { kind: 'manual' }, permission: 'read-only', body: { kind: 'intent', text: DEMO_INTENTS.fillSynopses } });
    const a = await rig([readOnly]);
    a.agent.setMode('accept-edits');
    await a.recurring.runNow(readOnly.id);
    expect(a.agent.snapshot().turns[0]?.mode).toBe('plan-only');
    expect(a.state.manifest.tree.find((node) => node.title === 'The Storm')?.synopsis ?? '').toBe('');
    expect(a.agent.snapshot().mode).toBe('accept-edits');
    await a.session.close();

    const ask = seedTask(2, { schedule: { kind: 'manual' }, permission: 'ask', body: { kind: 'intent', text: DEMO_INTENTS.fillSynopses } });
    const b = await rig([ask]);
    b.agent.setMode('accept-edits');
    const running = b.recurring.runNow(ask.id);
    const deadline = Date.now() + 4000;
    while (b.agent.snapshot().pending === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    // Accept edits would have applied the synopses with no card; the task’s Ask holds them for the writer.
    expect(b.agent.snapshot().pending).not.toBeNull();
    expect(b.agent.snapshot().mode).toBe('ask');
    b.agent.answer({ action: 'cancel' });
    await running;
    expect(b.state.manifest.tree.find((node) => node.title === 'The Storm')?.synopsis ?? '').toBe('');
    await b.session.close();
  });

  test('is refused while the agent is working, and by a task that cannot run', async () => {
    const task = seedTask(1, { schedule: { kind: 'manual' }, body: { kind: 'intent', text: DEMO_INTENTS.fillSynopses } });
    const broken = seedTask(2, { schedule: { kind: 'manual' }, problem: 'Its plan does not parse: nope', body: { kind: 'plan', steps: [] } });
    const r = await rig([task, broken]);
    await r.recurring.runNow(broken.id);
    expect(r.recurring.snapshot().message).toContain('cannot run');
    expect(r.runs.history(broken.id)).toEqual([]);
    await r.session.close();
  });
});

test.describe('the definitions', () => {
  test('a task made in the panel is saved to the tasks file, kept across a reopen, and carried by a bundle', async () => {
    const r = await rig([]);
    const failure = await r.recurring.save({
      name: 'Friday check',
      body: 'scan',
      text: '',
      scope: 'changed',
      schedule: 'weekly',
      at: '17:00',
      day: 'fri',
      whenDue: 'offer',
      permission: 'ask',
      maxModelCalls: '',
    });
    expect(failure).toBeNull();
    const [made] = r.recurring.snapshot().tasks;
    expect(made).toMatchObject({ name: 'Friday check', schedule: 'Every Friday from 17:00', body: 'scan' });
    expect(made?.id).toMatch(/^t_[0-9A-Z]{10}$/);

    await r.session.settle();
    const files = await readTaskFiles(r.store, r.state.manifest.project.id);
    expect(Object.keys(files)).toEqual([TASKS_FILE]);
    expect(JSON.parse(files[TASKS_FILE] ?? '{}').tasks[0].name).toBe('Friday check');
    const reopened = await openTasksHome(r.state.manifest.project.id, r.store);
    expect(reopened.current().tasks.map((task) => task.name)).toEqual(['Friday check']);

    const bundle = await exportStoredBundle(r.store, r.state.manifest.project.id);
    const { unzipSync } = await ZIP_ENGINE.load();
    const entries = unzipSync(bundle.bytes);
    expect(JSON.parse(new TextDecoder().decode(entries[TASKS_FILE])).tasks[0].name).toBe('Friday check');
    // Definitions only: nothing about runs or consent travels.
    expect(new TextDecoder().decode(entries[TASKS_FILE])).not.toMatch(/consent|lastRun|summary/);
    await r.session.close();
  });

  test('a bundle round-trips the tasks, and the tasks arrive with no run history and no consent', async () => {
    const task = seedTask(1, { name: 'Imported', whenDue: 'run', body: { kind: 'scan', scope: 'full' } });
    const r = await rig([task]);
    await r.recurring.skip(task.id);
    await r.session.settle();
    const bundle = await exportStoredBundle(r.store, r.state.manifest.project.id);

    const elsewhere = await openRuntimeStore(new MemoryIndexedDb());
    const outcome = await importBundle(elsewhere, bundle.bytes, 'Imported');
    expect(outcome.kind).toBe('opened');
    if (outcome.kind !== 'opened') return;
    const imported = outcome.opened.session;
    expect(imported.tasksHome()?.current().tasks.map((entry) => entry.name)).toEqual(['Imported']);
    // The history is this machine's and is read per project, so a project that arrives has none and its task is due again.
    const runs = await TaskRuns.open(imported.projectId, null);
    expect(runs.lastRuns()).toEqual({});
    await imported.close();
    await r.session.close();
  });

  test('a draft that cannot be saved says why, and a model task saved as run needs its cap', async () => {
    const r = await rig([]);
    const draft = { name: '', body: 'intent', text: 'Read it.', scope: 'full', schedule: 'daily', at: '09:00', day: 'mon', whenDue: 'run', permission: 'ask', maxModelCalls: '' } as const;
    expect(await r.recurring.save(draft)).toBe('Give the task a name.');
    expect(await r.recurring.save({ ...draft, name: 'Reader' })).toContain('limit on its model calls');
    expect(await r.recurring.save({ ...draft, name: 'Reader', maxModelCalls: 'many' })).toContain('whole number');
    expect(await r.recurring.save({ ...draft, name: 'Reader', maxModelCalls: '3' })).toBeNull();
    expect(r.recurring.snapshot().tasks[0]?.note).toBe(SELF_START_NOTE);
    await r.session.close();
  });

  test('switching a task off or removing it takes it out of the offers, and removing it takes its history', async () => {
    const task = seedTask(1);
    const r = await rig([task]);
    await r.recurring.attach();
    expect(r.recurring.snapshot().offers).toHaveLength(1);
    expect(await r.recurring.setEnabled(task.id, false)).toBeNull();
    await r.recurring.evaluate();
    expect(r.recurring.snapshot().offers).toEqual([]);
    await r.recurring.setEnabled(task.id, true);
    await r.recurring.skip(task.id);
    expect(await r.recurring.remove(task.id)).toBeNull();
    expect(r.recurring.snapshot().tasks).toEqual([]);
    expect(r.runs.history(task.id)).toEqual([]);
    await r.session.close();
  });
});

test('the run history survives a reload, in the app database, and a project opened elsewhere starts with none', async () => {
  const factory = new MemoryIndexedDb();
  const db = await openAppDb(factory);
  const task = seedTask(1, { schedule: { kind: 'on-open' }, whenDue: 'run', body: { kind: 'scan', scope: 'full' } });
  const first = await rig([task], { runs: await TaskRuns.open('p_sample', db) });
  await first.recurring.attach();
  expect(first.runs.history(task.id)).toHaveLength(1);
  await first.session.close();

  const again = await TaskRuns.open('p_sample', db);
  expect(again.history(task.id)).toHaveLength(1);
  expect(again.lastRuns()[task.id]).toBeDefined();
  expect((await TaskRuns.open('p_elsewhere', db)).history(task.id)).toEqual([]);
  db.close();
});
