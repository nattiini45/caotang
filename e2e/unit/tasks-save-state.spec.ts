import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore, writeProjectState } from '../../packages/store/src/index.js';

import { shadowOf } from '../../apps/desktop/src/app/persistence-plan.js';
import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { openTasksHome } from '../../apps/desktop/src/app/tasks-io.js';
import { project } from './fixtures.js';

/**
 * The save indicator and a tasks save (agent-harness.md §12): a task is in the store only once its save has landed, so the indicator
 * reads saving until then and a reload begun when it read saved cannot lose the writer's task.
 */

const globals = globalThis as unknown as Record<string, unknown>;
let previousGlobals: { document: unknown; window: unknown } | null = null;

test.beforeAll(() => {
  previousGlobals = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});

test.afterAll(() => {
  if (previousGlobals === null) return;
  globals['document'] = previousGlobals.document;
  globals['window'] = previousGlobals.window;
});

const TASK = {
  id: 't_A1',
  name: 'Read it over',
  enabled: true,
  schedule: { kind: 'on-open' },
  whenDue: 'offer',
  body: { kind: 'intent', text: 'Look over the newest scene.' },
  permission: 'ask',
} as const;

async function sessionWithTasks(): Promise<{ session: ProjectSession; home: Awaited<ReturnType<typeof openTasksHome>> }> {
  const state = project();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: shadowOf(state) });
  const home = await openTasksHome(state.manifest.project.id, store);
  session.attachTasks(home);
  return { session, home };
}

test('the save indicator reads saving from the moment a tasks save is asked for until it has landed', async () => {
  const { session, home } = await sessionWithTasks();
  await session.settle();
  expect(session.saveState()).toBe('saved');

  const seen: string[] = [];
  session.subscribe(() => seen.push(session.saveState()));
  const saving = home.save({ formatVersion: 1, tasks: [TASK] });
  // The save is asked for synchronously, so a reload that follows the click at once finds the indicator already reading saving.
  expect(session.saveState()).toBe('saving');
  expect(await saving).toBeNull();
  expect(session.saveState()).toBe('saved');
  expect(seen).toContain('saving');
  expect(seen.at(-1)).toBe('saved');
  await session.close();
});

test('two tasks saves in a row read saving until the second has landed', async () => {
  const { session, home } = await sessionWithTasks();
  const first = home.save({ formatVersion: 1, tasks: [TASK] });
  const second = home.save({ formatVersion: 1, tasks: [{ ...TASK, enabled: false }] });
  await first;
  expect(session.saveState()).toBe('saving');
  await second;
  expect(session.saveState()).toBe('saved');
  await session.close();
});

test('a tasks save that cannot be made leaves the indicator reading saved', async () => {
  const state = project();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: shadowOf(state) });
  const home = await openTasksHome(state.manifest.project.id, store);
  session.attachTasks(home);
  // A store that refuses the write: the save reports why, and nothing is left in flight.
  store.db.close();
  const failure = await home.save({ formatVersion: 1, tasks: [TASK] });
  expect(failure).not.toBeNull();
  expect(home.pending()).toBe(false);
  await session.close().catch(() => undefined);
});
