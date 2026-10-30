import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore } from '../../packages/store/src/index.js';
import { DEMO_INTENTS } from '../../packages/gateway/src/mock/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { contextPreviewOf } from '../../apps/desktop/src/app/context-preview.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';

/**
 * The model's limits reach the app's prompts (issue #69, phase 1; context-assembly §5): the app's context port carries the window, output
 * cap and price of the profile and model the turn resolved, so a step's preview has the window the plan card warns against and the cost
 * it shows, and the Settings preview reads the active Chat role's limits the same way.
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

const PRICE = { prompt: 1, completion: 2 };

/** The provider services with a priced mock profile active, on a model whose window the mock reports (32,000 tokens). */
async function pricedProviders(): Promise<{ providers: ProviderService; profileId: string }> {
  const providers = (await ProviderService.open({ db: null, vault: null })).service;
  const saved = await providers.addProfile({ name: 'Priced mock', kind: 'mock', isActive: true, defaultModel: 'mock/stream-1', pricePer1k: PRICE, maxOutputTokens: 1_000 });
  await providers.activate(saved.view.id);
  // The window comes from the model listing, as an endpoint's does once its save-time probe has run.
  await providers.gateway.listModels(saved.view.id);
  return { providers, profileId: saved.view.id };
}

async function until(predicate: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a scene draft’s step preview carries the model’s window and its cost at the profile’s price', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const { providers } = await pricedProviders();
  // The Settings budgets carry no limits of their own, as the app's do (Workspace passes contextConfigOf).
  const controller = new AgentController(session, providers, () => ({}), () => false);

  const running = controller.submit(DEMO_INTENTS.draftScene);
  await until(() => controller.snapshot().pending !== null, 'the draft card');
  const step = controller.snapshot().pending?.card.steps.find((candidate) => candidate.tool === 'scene.draft');
  expect(step?.context?.window?.contextWindow).toBe(32_000);
  // The completion estimate is the profile's own reply cap, not the 4,096 default, and the cost is priced from it.
  expect(step?.context?.completionTokens).toBe(1_000);
  const cost = step?.context?.cost;
  expect(cost?.completionUsd).toBeCloseTo(2, 6);
  expect(cost?.totalUsd).toBeGreaterThan(2);

  controller.answer({ action: 'cancel' });
  await running;
  await session.close();
});

test('a turn’s prompts read the profile that turn resolved, not the one active now: a demo turn carries the demo profile’s limits', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const { providers } = await pricedProviders();
  const controller = new AgentController(session, providers, () => ({}), () => false);

  // The priced profile is active, but a demo intent runs on the unpriced demo profile; a prompt read from the active profile would
  // carry its window and a cost.
  const running = controller.submit(DEMO_INTENTS.draftScene, { demo: true });
  await until(() => controller.snapshot().pending !== null, 'the draft card');
  const step = controller.snapshot().pending?.card.steps.find((candidate) => candidate.tool === 'scene.draft');
  expect(step?.context).toBeDefined();
  expect(step?.context?.cost).toBeUndefined();
  expect(step?.context?.window).toBeUndefined();
  expect(step?.context?.completionTokens).toBe(4_096);
  controller.answer({ action: 'cancel' });
  await running;
  await session.close();
});

test('the next turn reads the profile it resolves to, so a profile switched between turns gives its own reply cap and price', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const { providers } = await pricedProviders();
  const controller = new AgentController(session, providers, () => ({}), () => false);
  const draftStep = () => controller.snapshot().pending?.card.steps.find((candidate) => candidate.tool === 'scene.draft');

  const first = controller.submit(DEMO_INTENTS.draftScene);
  await until(() => controller.snapshot().pending !== null, 'the first draft card');
  expect(draftStep()?.context?.completionTokens).toBe(1_000);
  controller.answer({ action: 'cancel' });
  await first;

  const other = await providers.addProfile({ name: 'Dearer mock', kind: 'mock', isActive: true, defaultModel: 'mock/echo-1', pricePer1k: { prompt: 3, completion: 5 }, maxOutputTokens: 2_000 });
  await providers.activate(other.view.id);
  await providers.gateway.listModels(other.view.id);
  const second = controller.submit(DEMO_INTENTS.draftScene);
  await until(() => controller.snapshot().pending !== null, 'the second draft card');
  expect(draftStep()?.context?.completionTokens).toBe(2_000);
  expect(draftStep()?.context?.window?.contextWindow).toBe(128_000);
  expect(draftStep()?.context?.cost?.completionUsd).toBeCloseTo(10, 6);
  controller.answer({ action: 'cancel' });
  await second;
  await session.close();
});

test('the Settings prompt preview carries the limits it is given, and none without them', async () => {
  const state = sampleProjectState();
  const { providers } = await pricedProviders();
  const doc = state.manifest.tree.find((node) => node.title === 'The Friend')?.id;
  const limits = providers.limitsForRole('chat');
  expect(limits).toMatchObject({ contextWindow: 32_000, maxOutputTokens: 1_000, pricePer1k: PRICE });

  const view = contextPreviewOf(state, doc, { layerBudgets: {} }, limits);
  expect(view.kind).toBe('prompt');
  if (view.kind !== 'prompt') return;
  expect(view.preview.window?.contextWindow).toBe(32_000);
  expect(view.preview.cost?.totalUsd).toBeGreaterThan(0);

  const bare = contextPreviewOf(state, doc, { layerBudgets: {} });
  expect(bare.kind === 'prompt' ? bare.preview.cost : 'none').toBeUndefined();
});
