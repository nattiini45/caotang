import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore, type ProjectState } from '../../packages/store/src/index.js';
import { DEMO_INTENTS } from '../../packages/gateway/src/mock/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';

/**
 * A turn's task role and mode (agent-harness §2, §12): a recurring task's turn runs under the Background role, its requests reach the
 * usage ledger under that role, the chat conversation is not its conversation, and a mode it is given replaces the panel's for its cards.
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

async function open(state: ProjectState) {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const providers = (await ProviderService.open({ db: null, vault: null })).service;
  const controller = new AgentController(session, providers, () => ({}), () => false);
  return { session, providers, controller };
}

const rolesInLedger = (providers: ProviderService): string[] => [...new Set(providers.gateway.ledger.turnRows().map((row) => row.role))];

test('a turn with no role runs under chat, and one that names Background reaches the ledger under Background', async () => {
  const { session, providers, controller } = await open(sampleProjectState());
  controller.setMode('plan-only');

  await controller.submit(DEMO_INTENTS.fillSynopses, { demo: true });
  expect(rolesInLedger(providers)).toEqual(['chat']);

  await controller.submit(DEMO_INTENTS.fillSynopses, { demo: true, role: 'background' });
  expect(rolesInLedger(providers).sort()).toEqual(['background', 'chat']);
  // Each role has a session of its own, so the turn ids of the two never collide.
  const ids = controller.snapshot().turns.map((turn) => turn.turnId);
  expect(new Set(ids).size).toBe(ids.length);
  await session.close();
});

test('a mode the turn is given replaces the panel’s for its cards and is not left behind', async () => {
  const { session, controller } = await open(sampleProjectState());
  controller.setMode('accept-edits');

  // Accept edits would apply the synopses with no card; the turn was given Plan only, so it keeps them.
  const report = await controller.submit(DEMO_INTENTS.fillSynopses, { demo: true, mode: 'plan-only' });
  expect(report?.status).toBe('replied');
  expect(report?.mode).toBe('plan-only');
  expect(report?.heldSteps?.map((step) => step.tool)).toEqual(['synopsis.fill']);
  expect(controller.snapshot().mode).toBe('accept-edits');
  await session.close();
});
