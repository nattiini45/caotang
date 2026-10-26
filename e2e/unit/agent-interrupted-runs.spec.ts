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
  await port.append(run.runId, run.events.map((event, seq) => ({ ...event, seq, at: clock + seq }) as RunEventInput));
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

test('a run whose log cannot be summarized is skipped, and the runs after it are still listed', async () => {
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

  expect(controller.snapshot().interrupted.map((view) => view.runId)).toEqual(['run_AFTER']);
  await session.close();
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
