import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore, createRunLogPort, type ProjectState, type RunEventInput, type RunRow, type RunStatus, type RuntimeStore } from '../../packages/store/src/index.js';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type ChatChunk } from '../../packages/gateway/src/index.js';
import { createMockProvider, isPlannerCall, userTextOf, type MockScript } from '../../packages/gateway/src/mock/index.js';
import { RUN_LOG_VERSION, structureDigest } from '../../packages/harness/src/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import type { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';

/**
 * The interrupted runs the agent controller offers back (agent-harness §5.1, "Durable runs and resume"). The runs are seeded into a real
 * in-memory runtime store through the run-log port the controller reads, and `loadInterrupted` decides which are offered and what the
 * card says: only an interrupted run whose log was written whole, a log this build cannot read for discarding only.
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

async function scriptedProviders(scripts: readonly MockScript[]): Promise<ProviderService> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Scripted', kind: 'mock', isActive: true });
  const gateway = createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [...scripts] }) });
  return { gateway, active: () => profile, demoProfile: async () => profile, persist: async () => undefined } as unknown as ProviderService;
}

function idOfTitle(state: ProjectState, title: string): string {
  const node = state.manifest.tree.find((entry) => entry.title === title);
  if (node === undefined) throw new Error(`no node titled ${title}`);
  return node.id;
}

async function open(scripts: readonly MockScript[] = []) {
  const state = sampleProjectState();
  const store: RuntimeStore = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const controller = new AgentController(session, await scriptedProviders(scripts));
  const landing = idOfTitle(state, 'The Landing');
  return { state, store, session, controller, port: createRunLogPort(store), projectId: state.manifest.project.id, landing, revision: state.documents.get(landing)?.revision ?? 0 };
}

let clock = 1_000;

interface Seed {
  readonly runId: string;
  readonly projectId: string;
  readonly intent: string;
  readonly status?: RunStatus;
  readonly schema?: number;
  readonly cannotResume?: true;
  readonly events: readonly Record<string, unknown>[];
}

/** One run in the store, its events numbered and stamped the way the writer does. */
async function seed(port: ReturnType<typeof createRunLogPort>, run: Seed): Promise<void> {
  clock += 1;
  const row: RunRow = {
    schema: run.schema ?? RUN_LOG_VERSION,
    runId: run.runId,
    projectId: run.projectId,
    kind: 'turn',
    intent: run.intent,
    createdAt: clock,
    updatedAt: clock,
    status: run.status ?? 'interrupted',
    ...(run.cannotResume === undefined ? {} : { cannotResume: true as const }),
  };
  await port.create(row);
  await port.append(run.runId, run.events.map((event, seq) => ({ ...event, seq, at: clock + seq }) as unknown as RunEventInput));
}

const STEPS = [
  { tool: 'meta.set', params: { targets: [] }, expect: 'one' },
  { tool: 'meta.set', params: { targets: [] }, expect: 'two' },
];

/** The log of a run that applied the first step of a two-step plan, which left the revisions in `after`. */
function appliedFirstStep(intent: string, structure: string, after: Record<string, number>): Record<string, unknown>[] {
  return [
    { t: 'turn.start', v: RUN_LOG_VERSION, turnId: 't1', intent, wire: 'planner', native: false },
    { t: 'messages', turnId: 't1', appended: [{ role: 'user', content: `Request: ${intent}` }] },
    { t: 'card.pending', turnId: 't1', kind: 'plan', steps: STEPS, proposals: [null, null], revisions: [null, null], done: [] },
    { t: 'card.decided', turnId: 't1', decision: 'approved' },
    { t: 'step.intent', turnId: 't1', callId: 'c.0', index: 0, tool: 'meta.set', expect: after, structure },
    { t: 'step.applied', turnId: 't1', callId: 'c.0', index: 0, tool: 'meta.set', summary: 'Labelled', after },
  ];
}

const planner = (intent: string) => (req: Parameters<MockScript['match']>[0]): boolean => isPlannerCall(req) && userTextOf(req).includes(`Request: ${intent}`);

test('an interrupted run with a whole log is offered back with the steps it applied and the steps it planned', async () => {
  const { state, port, projectId, controller, session, landing, revision } = await open();
  await seed(port, { runId: 'run_GOOD', projectId, intent: 'Label the scenes.', events: appliedFirstStep('Label the scenes.', structureDigest(state.manifest), { [landing]: revision }) });

  await controller.loadInterrupted();

  expect(controller.snapshot().interrupted).toEqual([{ runId: 'run_GOOD', intent: 'Label the scenes.', applied: 1, total: 2, spend: null, resumable: true, note: null }]);
  await session.close();
});

test('a run that is running or finished, one whose log failed to write, or one of another project is not offered', async () => {
  const { state, port, projectId, controller, session, landing, revision } = await open();
  const events = appliedFirstStep('Label the scenes.', structureDigest(state.manifest), { [landing]: revision });
  await seed(port, { runId: 'run_RUNNING', projectId, intent: 'Still running.', status: 'running', events });
  await seed(port, { runId: 'run_WAITING', projectId, intent: 'Waiting on a card.', status: 'awaiting-approval', events });
  await seed(port, { runId: 'run_FINISHED', projectId, intent: 'Finished.', status: 'finished', events });
  await seed(port, { runId: 'run_NOLOG', projectId, intent: 'The log stopped.', cannotResume: true, events });
  await seed(port, { runId: 'run_OTHER', projectId: 'p_SOMEONEELSE', intent: 'Another project.', events });
  await seed(port, { runId: 'run_GOOD', projectId, intent: 'Label the scenes.', events });

  await controller.loadInterrupted();

  expect(controller.snapshot().interrupted.map((view) => view.runId)).toEqual(['run_GOOD']);
  await session.close();
});

test('a run whose log cannot be read just now stays listed, discard-only, and the runs after it are still listed', async () => {
  const { state, port, projectId, controller, session, landing, revision } = await open();
  const broken = 'n_BROKEN0000';
  const documents = state.documents;
  const read = documents.get.bind(documents);
  // Reading this one document fails, as it would if the project were mid-reload.
  documents.get = ((id: string) => {
    if (id === broken) throw new Error('the document could not be read');
    return read(id);
  }) as typeof documents.get;
  const structure = structureDigest(state.manifest);
  await seed(port, { runId: 'run_THROWS', projectId, intent: 'Unreadable.', events: appliedFirstStep('Unreadable.', structure, { [broken]: 1 }) });
  await seed(port, { runId: 'run_AFTER', projectId, intent: 'Label the scenes.', events: appliedFirstStep('Label the scenes.', structure, { [landing]: revision }) });

  await controller.loadInterrupted();

  const views = controller.snapshot().interrupted;
  expect(views.map((view) => view.runId)).toEqual(['run_THROWS', 'run_AFTER']);
  expect(views[0]).toMatchObject({ runId: 'run_THROWS', intent: 'Unreadable.', applied: 0, total: 0, spend: null, resumable: false });
  expect(views[0]?.note).toBe('This run’s log could not be read just now. It has not been changed; reopen the project to try again, or discard it.');
  expect(views[0]?.note).not.toContain('damaged');
  expect(views[1]).toMatchObject({ runId: 'run_AFTER', resumable: true });
  // Nothing was discarded, and Resume refuses the run that could not be read.
  expect((await port.open(projectId)).map((run) => run.runId)).toEqual(['run_THROWS', 'run_AFTER']);
  expect(await controller.resumeRun('run_THROWS')).toBeNull();
  expect(controller.snapshot().message).toBe('That run can no longer be resumed.');
  await session.close();
});

test('when the run log cannot be opened the writer is told once, and a message already showing is left alone', async () => {
  const { controller, session } = await open();
  const log = (controller as unknown as { runLog: { open: (projectId: string) => Promise<readonly unknown[]> } }).runLog;
  log.open = async () => {
    throw new Error('the store is not available');
  };

  await controller.loadInterrupted();
  expect(controller.snapshot().message).toBe('Interrupted agent runs could not be checked: the store is not available');
  expect(controller.snapshot().interrupted).toEqual([]);

  // A later check, after the writer has moved on, does not say it again.
  (controller as unknown as { message: string | null }).message = null;
  controller.refresh();
  await controller.loadInterrupted();
  expect(controller.snapshot().message).toBeNull();
  await session.close();

  // And a message already showing, such as a turn's result, is not replaced.
  const second = await open();
  const other = (second.controller as unknown as { runLog: { open: (projectId: string) => Promise<readonly unknown[]> }; message: string | null });
  other.runLog.open = async () => {
    throw new Error('the store is not available');
  };
  other.message = 'The turn stopped unexpectedly: boom';
  second.controller.refresh();
  await second.controller.loadInterrupted();
  expect(second.controller.snapshot().message).toBe('The turn stopped unexpectedly: boom');
  await second.session.close();
});

test('a log of another version or with a damaged event is offered for discarding only, with a note and no counts', async () => {
  const { state, port, projectId, controller, session, landing, revision } = await open();
  const events = appliedFirstStep('Label the scenes.', structureDigest(state.manifest), { [landing]: revision });
  await seed(port, { runId: 'run_OLD', projectId, intent: 'From another version.', schema: RUN_LOG_VERSION + 1, events });
  await seed(port, { runId: 'run_DAMAGED', projectId, intent: 'Damaged.', events: [events[0] as Record<string, unknown>, { t: 'card.pending', turnId: 't1', kind: 'plan', steps: STEPS, proposals: [null] }] });

  await controller.loadInterrupted();

  const views = controller.snapshot().interrupted;
  expect(views.map((view) => view.runId)).toEqual(['run_OLD', 'run_DAMAGED']);
  for (const view of views) {
    expect(view).toMatchObject({ applied: 0, total: 0, spend: null, resumable: false });
    expect(view.note).toContain('damaged or was written by another version');
  }
  expect(views.map((view) => view.intent)).toEqual(['From another version.', 'Damaged.']);
  await session.close();
});

test('loadInterrupted leaves the list alone while a turn is running, and fills it once the turn has settled', async () => {
  const reached = { open: false };
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold: MockScript = {
    match: planner('Think about it.'),
    respond: () =>
      (async function* (): AsyncGenerator<ChatChunk> {
        reached.open = true;
        await held;
        yield { delta: JSON.stringify({ reply: 'Done thinking.' }) };
        yield { finishReason: 'stop' };
      })(),
  };
  const { state, port, projectId, controller, session, landing, revision } = await open([hold]);
  await seed(port, { runId: 'run_GOOD', projectId, intent: 'Label the scenes.', events: appliedFirstStep('Label the scenes.', structureDigest(state.manifest), { [landing]: revision }) });

  const running = controller.submit('Think about it.');
  await until(() => controller.snapshot().busy && reached.open, 'the turn to ask the model');
  await controller.loadInterrupted();
  expect(controller.snapshot().interrupted).toEqual([]);

  release();
  await running;
  await until(() => controller.snapshot().interrupted.length === 1, 'the interrupted run to be listed');
  expect(controller.snapshot().interrupted.map((view) => view.runId)).toEqual(['run_GOOD']);
  await session.close();
});

/** The log of a run that stopped on its plan card, with the spend it had by then and a model call the stop lost. */
function waitingOnCard(intent: string, landing: string, spend: Record<string, number>): Record<string, unknown>[] {
  return [
    { t: 'turn.start', v: RUN_LOG_VERSION, turnId: 't1', intent, wire: 'planner', native: false },
    { t: 'messages', turnId: 't1', appended: [{ role: 'user', content: `Request: ${intent}` }] },
    { t: 'spend', turnId: 't1', spend, reservedCalls: 1 },
    {
      t: 'card.pending',
      turnId: 't1',
      kind: 'plan',
      steps: [{ tool: 'meta.set', params: { targets: [landing], label: 'act-2' }, expect: 'The Landing is labelled' }],
      proposals: [null],
      revisions: [null],
      done: [],
    },
  ];
}

/** Counts every model call the controller makes, whatever it asks. */
function countingModel(calls: { count: number }): MockScript {
  return {
    match: () => true,
    respond: () => {
      calls.count += 1;
      return { content: JSON.stringify({ reply: 'Nothing to do.' }) };
    },
  };
}

test('Resume does not start when the run log cannot be read a second time: it says so, makes no model call and keeps the log', async () => {
  const calls = { count: 0 };
  const { port, projectId, controller, session, landing } = await open([countingModel(calls)]);
  const spend = { modelCalls: 3, promptTokens: 100, completionTokens: 40, estimatedTokens: 0, steps: 0, activeMs: 500 };
  await seed(port, { runId: 'run_GOOD', projectId, intent: 'Label the landing.', events: waitingOnCard('Label the landing.', landing, spend) });
  await controller.loadInterrupted();
  expect(controller.snapshot().interrupted.map((view) => [view.runId, view.resumable])).toEqual([['run_GOOD', true]]);

  // The first read (the card's) worked; the one Resume makes fails once, and the run's own reads after it would work.
  const log = (controller as unknown as { runLog: { events: (runId: string) => Promise<readonly unknown[]> } }).runLog;
  const read = log.events.bind(log);
  let failed = false;
  log.events = async (runId) => {
    if (failed) return read(runId);
    failed = true;
    throw new Error('the store could not be read');
  };
  // A run that wrongly started would be waiting on its plan card; one that is refused settles with nothing. No clock decides which.
  let settled = false;
  const resumed = controller.resumeRun('run_GOOD').finally(() => {
    settled = true;
  });
  await until(() => settled || controller.snapshot().pending !== null, 'the resume to settle or to reach its plan card');
  const started = !settled;
  if (started) controller.answer({ action: 'cancel' });
  const report = await resumed;

  expect(started).toBe(false);
  expect(report).toBeNull();
  const snapshot = controller.snapshot();
  expect(snapshot.message).toBe('The run log could not be read: the store could not be read. The run was not resumed. Try again, or discard the log.');
  expect(snapshot.busy).toBe(false);
  expect(snapshot.pending).toBeNull();
  expect(snapshot.turns).toHaveLength(0);
  expect(calls.count).toBe(0);
  expect((await port.open(projectId)).map((run) => run.runId)).toEqual(['run_GOOD']);
  await session.close();
});

test('Resume starts the run’s meter from the spend its log holds, with the model call the stop lost counted as spent', async () => {
  const calls = { count: 0 };
  const { port, projectId, controller, session, landing } = await open([countingModel(calls)]);
  const spend = { modelCalls: 3, promptTokens: 100, completionTokens: 40, estimatedTokens: 0, steps: 0, activeMs: 500 };
  await seed(port, { runId: 'run_GOOD', projectId, intent: 'Label the landing.', events: waitingOnCard('Label the landing.', landing, spend) });
  await controller.loadInterrupted();

  const resumed = controller.resumeRun('run_GOOD');
  await until(() => controller.snapshot().pending !== null, 'the plan card to come back');
  controller.answer({ action: 'cancel' });
  const report = await resumed;

  expect(report?.spend).toMatchObject({ modelCalls: 4, promptTokens: 100, completionTokens: 40 });
  expect(report?.status).toBe('cancelled');
  expect(report?.modelCalls).toBe(4);
  expect(calls.count).toBe(0);
  await session.close();
});

test('Resume does not start when the log was read but is damaged: it says the log is damaged, not to try again, and keeps the log', async () => {
  const calls = { count: 0 };
  const { port, projectId, controller, session, landing } = await open([countingModel(calls)]);
  const spend = { modelCalls: 3, promptTokens: 100, completionTokens: 40, estimatedTokens: 0, steps: 0, activeMs: 500 };
  await seed(port, { runId: 'run_GOOD', projectId, intent: 'Label the landing.', events: waitingOnCard('Label the landing.', landing, spend) });
  await controller.loadInterrupted();
  expect(controller.snapshot().interrupted.map((view) => [view.runId, view.resumable])).toEqual([['run_GOOD', true]]);

  // The log reads, but a row of it is not an event this build knows: the read Resume makes cannot be summarized.
  const log = (controller as unknown as { runLog: { events: (runId: string) => Promise<readonly unknown[]> } }).runLog;
  log.events = async () => [{ t: 'nonsense', seq: 0, at: 1 }];
  expect(await controller.resumeRun('run_GOOD')).toBeNull();

  const snapshot = controller.snapshot();
  expect(snapshot.message).toBe('This run’s log is damaged or was written by another version of Caotang, so the run was not resumed. You can discard the log.');
  expect(snapshot.message).not.toContain('Try again');
  expect(snapshot.busy).toBe(false);
  expect(snapshot.turns).toHaveLength(0);
  expect(calls.count).toBe(0);
  expect((await port.open(projectId)).map((run) => run.runId)).toEqual(['run_GOOD']);
  await session.close();
});

/** A model that holds a turn open on `intent` until `release` is called, and says when it has been asked. */
function holdingModel(intent: string): { readonly script: MockScript; readonly reached: { open: boolean }; readonly release: () => void } {
  const reached = { open: false };
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const script: MockScript = {
    match: planner(intent),
    respond: () =>
      (async function* (): AsyncGenerator<ChatChunk> {
        reached.open = true;
        await held;
        yield { delta: JSON.stringify({ reply: 'Done thinking.' }) };
        yield { finishReason: 'stop' };
      })(),
  };
  return { script, reached, release: () => release() };
}

test('Resume is refused while another turn is running: no second turn starts and the run’s log is kept', async () => {
  const hold = holdingModel('Think about it.');
  const { state, port, projectId, controller, session, landing, revision } = await open([hold.script]);
  await seed(port, { runId: 'run_GOOD', projectId, intent: 'Label the scenes.', events: appliedFirstStep('Label the scenes.', structureDigest(state.manifest), { [landing]: revision }) });
  await controller.loadInterrupted();
  expect(controller.snapshot().interrupted.map((view) => [view.runId, view.resumable])).toEqual([['run_GOOD', true]]);

  const running = controller.submit('Think about it.');
  await until(() => controller.snapshot().busy && hold.reached.open, 'the turn to ask the model');
  const turnsBefore = controller.snapshot().turns.length;

  expect(await controller.resumeRun('run_GOOD')).toBeNull();
  expect(controller.snapshot().message).toBe('The agent is working on another turn. Resume the run when it has finished.');
  expect(controller.snapshot().turns).toHaveLength(turnsBefore);
  expect(controller.snapshot().pending).toBeNull();

  hold.release();
  await running;
  const rows = await port.open(projectId);
  expect(rows.find((run) => run.runId === 'run_GOOD')?.status).toBe('interrupted');
  await until(() => controller.snapshot().interrupted.length === 1, 'the interrupted run to be listed again');
  await session.close();
});

test('Resume is refused for a run that is not listed and for one that is listed as discard-only: no turn starts, no model call is made, nothing is discarded', async () => {
  const calls = { count: 0 };
  const { state, port, projectId, controller, session, landing, revision } = await open([countingModel(calls)]);
  const events = appliedFirstStep('Label the scenes.', structureDigest(state.manifest), { [landing]: revision });
  await seed(port, { runId: 'run_OLD', projectId, intent: 'From another version.', schema: RUN_LOG_VERSION + 1, events });
  await seed(port, { runId: 'run_GOOD', projectId, intent: 'Label the scenes.', events });
  await controller.loadInterrupted();
  expect(controller.snapshot().interrupted.map((view) => [view.runId, view.resumable])).toEqual([['run_OLD', false], ['run_GOOD', true]]);

  for (const runId of ['run_MISSING', 'run_OLD']) {
    (controller as unknown as { message: string | null }).message = null;
    controller.refresh();
    expect(await controller.resumeRun(runId), runId).toBeNull();
    const snapshot = controller.snapshot();
    expect(snapshot.message, runId).toBe('That run can no longer be resumed.');
    expect(snapshot.busy).toBe(false);
    expect(snapshot.pending).toBeNull();
    expect(snapshot.turns).toHaveLength(0);
    expect(calls.count).toBe(0);
  }
  expect((await port.open(projectId)).map((run) => run.runId).sort()).toEqual(['run_GOOD', 'run_OLD']);
  await session.close();
});

type OpenLog = { open: (projectId: string) => Promise<readonly RunRow[]> };

test('a check of the interrupted runs that fails after a turn has begun says nothing over that turn', async () => {
  const hold = holdingModel('Think about it.');
  const { controller, session } = await open([hold.script]);
  const log = (controller as unknown as { runLog: OpenLog }).runLog;
  const real = log.open.bind(log);
  let openGate = (): void => {};
  const opening = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let first = true;
  log.open = async (projectId) => {
    if (!first) return real(projectId);
    first = false;
    await opening;
    throw new Error('the store is not available');
  };

  // The check has begun and waits on the store when the next turn starts; the store then fails.
  const loading = controller.loadInterrupted();
  const running = controller.submit('Think about it.');
  await until(() => controller.snapshot().busy && hold.reached.open, 'the turn to ask the model');
  openGate();
  await loading;
  expect(controller.snapshot().message).toBeNull();

  hold.release();
  await running;
  expect(controller.snapshot().message).toBeNull();
  await session.close();
});

test('the writer is told again when the run log stops being readable after it was read, and not before', async () => {
  const { controller, session } = await open();
  const log = (controller as unknown as { runLog: OpenLog }).runLog;
  const real = log.open.bind(log);
  let failing = true;
  log.open = async (projectId) => {
    if (failing) throw new Error('the store is not available');
    return real(projectId);
  };
  const told = 'Interrupted agent runs could not be checked: the store is not available';
  const clear = (): void => {
    (controller as unknown as { message: string | null }).message = null;
    controller.refresh();
  };

  await controller.loadInterrupted();
  expect(controller.snapshot().message).toBe(told);
  clear();
  await controller.loadInterrupted();
  expect(controller.snapshot().message).toBeNull();

  failing = false;
  await controller.loadInterrupted();
  expect(controller.snapshot().message).toBeNull();

  failing = true;
  await controller.loadInterrupted();
  expect(controller.snapshot().message).toBe(told);
  await session.close();
});

test('two checks that finish out of order leave the list the later check found', async () => {
  const { state, port, projectId, controller, session, landing, revision } = await open();
  await seed(port, { runId: 'run_GOOD', projectId, intent: 'Label the scenes.', events: appliedFirstStep('Label the scenes.', structureDigest(state.manifest), { [landing]: revision }) });
  const log = (controller as unknown as { runLog: OpenLog }).runLog;
  const real = log.open.bind(log);
  let openGate = (): void => {};
  const opening = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let calls = 0;
  log.open = async (id) => {
    calls += 1;
    if (calls > 1) return [];
    // The earlier check reads the store first and is slow to answer; the later one finds the run gone.
    const rows = await real(id);
    await opening;
    return rows;
  };

  const earlier = controller.loadInterrupted();
  await controller.loadInterrupted();
  expect(controller.snapshot().interrupted).toEqual([]);
  openGate();
  await earlier;
  expect(controller.snapshot().interrupted).toEqual([]);
  await session.close();
});
