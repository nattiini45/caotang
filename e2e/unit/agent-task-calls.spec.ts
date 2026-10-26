import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore, type ProjectState, type RuntimeStore } from '../../packages/store/src/index.js';
import { DEMO_INTENTS } from '../../packages/gateway/src/mock/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from '../../apps/desktop/src/app/settings.js';

/**
 * A recurring task's model-call cap through the app's controller, headless on the demo provider (agent-harness §14): the cap can only
 * lower the limit the writer set in Settings › Agent, so a tasks.json never lets a run make more calls than the writer allowed.
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

async function controllerOver(state: ProjectState, store: RuntimeStore, settings: () => AgentSettings) {
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const providers = (await ProviderService.open({ db: null, vault: null })).service;
  return { session, controller: new AgentController(session, providers, () => ({}), () => false, {}, settings) };
}

/** A plan-only turn on the demo provider, under a Settings limit (or none) and the cap a recurring task passes. */
async function plannedUnder(settingsCalls: number | undefined, taskCalls: number) {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, budget: settingsCalls === undefined ? {} : { maxModelCalls: settingsCalls } };
  const { session, controller } = await controllerOver(state, store, () => settings);
  controller.setMode('plan-only');
  const report = await controller.submit(DEMO_INTENTS.fillSynopses, { demo: true, maxModelCalls: taskCalls });
  await session.close();
  return report;
}

test('a task’s call cap of 100 does not raise a Settings limit of 1: the turn stops at one call', async () => {
  const report = await plannedUnder(1, 100);
  expect(report?.status).toBe('failed');
  expect(report?.modelCalls).toBe(1);
});

test('a task’s cap below the Settings limit lowers it: Settings 5 and a task cap of 1 stop at one call', async () => {
  const report = await plannedUnder(5, 1);
  expect(report?.status).toBe('failed');
  expect(report?.modelCalls).toBe(1);
});

test('with no Settings limit the task’s own cap applies, and a cap the turn does not reach changes nothing', async () => {
  const capped = await plannedUnder(undefined, 1);
  expect(capped?.status).toBe('failed');
  expect(capped?.modelCalls).toBe(1);
  const roomy = await plannedUnder(undefined, 3);
  expect(roomy?.status).toBe('replied');
  expect(roomy?.modelCalls).toBe(2);
});
