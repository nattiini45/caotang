import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, getBody, openRuntimeStore, serializeManifest, validateManifest, type ProjectState, type RuntimeStore } from '../../packages/store/src/index.js';
import { DEMO_INTENTS } from '../../packages/gateway/src/mock/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import { DEFAULT_AGENT_SETTINGS, normalizeAgent, type AgentSettings } from '../../apps/desktop/src/app/settings.js';

/**
 * The permission modes through the app's controller, headless on the demo provider (agent-harness §4): the mode is a setting plus this
 * panel's override and nothing a project file can set; Plan only keeps what it refused and "Switch to Ask and run this plan" sends it;
 * Accept edits applies the demo's synopses with no card, and the turn says which mode it ran in.
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

async function controllerOver(state: ProjectState, store: RuntimeStore, settings: () => AgentSettings = () => DEFAULT_AGENT_SETTINGS) {
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const providers = (await ProviderService.open({ db: null, vault: null })).service;
  return { session, controller: new AgentController(session, providers, () => ({}), () => false, {}, settings) };
}

async function until(predicate: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const synopsisOf = (state: ProjectState, title: string): string => state.manifest.tree.find((node) => node.title === title)?.synopsis ?? '';

test('a panel starts in the setting’s mode, its own pick wins over it, and a locked Auto is refused and reads as Ask', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  let settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, defaultMode: 'accept-edits' };
  const { session, controller } = await controllerOver(state, store, () => settings);
  expect(controller.snapshot().mode).toBe('accept-edits');
  controller.setMode('plan-only');
  expect(controller.snapshot().mode).toBe('plan-only');
  expect(controller.snapshot().modes).toEqual(['plan-only', 'ask', 'accept-edits', 'auto']);
  settings = { ...settings, lockAuto: true };
  controller.refresh();
  expect(controller.snapshot().modes).toEqual(['plan-only', 'ask', 'accept-edits']);
  controller.setMode('auto');
  expect(controller.snapshot().mode).toBe('plan-only');
  expect(controller.snapshot().message).toContain('turned off');
  await session.close();
});

test('an agent.mode key in caotang.json changes nothing: a project carries no mode, and a save leaves the key out', async () => {
  const state = sampleProjectState();
  const docFiles = state.manifest.tree.filter((node) => node.type === 'document').map((node) => `${node.id}.md`);
  const loaded = validateManifest({ ...JSON.parse(JSON.stringify(state.manifest)), agent: { mode: 'auto', defaultMode: 'auto' } }, { docFiles });
  expect(loaded.errors.map((error) => error.message)).toEqual([]);
  // The manifest keeps no key it does not own when it is written, and nothing in the app reads one for a mode.
  expect(serializeManifest(loaded.manifest as never)).not.toContain('"agent"');
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const { session, controller } = await controllerOver(state, store);
  expect(controller.snapshot().mode).toBe('ask');
  await session.close();
  // The settings slice is the one place a mode comes from, and a stored Auto under a lock reads as Ask.
  expect(normalizeAgent({ defaultMode: 'auto', lockAuto: true }).defaultMode).toBe('ask');
});

test('Plan only runs no write, keeps the plan, and Switch to Ask runs it as a card the writer decides', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const { session, controller } = await controllerOver(state, store);
  controller.setMode('plan-only');
  const report = await controller.submit(DEMO_INTENTS.fillSynopses, { demo: true });
  expect(report?.status).toBe('replied');
  expect(report?.mode).toBe('plan-only');
  expect(report?.heldSteps?.map((step) => step.tool)).toEqual(['synopsis.fill']);
  expect(synopsisOf(state, 'The Storm')).toBe('');
  expect(controller.snapshot().turns[0]?.mode).toBe('plan-only');

  const turnId = report?.turnId ?? '';
  const running = controller.runHeldPlan(turnId);
  await until(() => controller.snapshot().pending !== null, 'the held plan to wait for a decision');
  expect(controller.snapshot().mode).toBe('ask');
  controller.answer({ action: 'approve' });
  const ran = await running;
  expect(ran?.status).toBe('applied');
  expect(synopsisOf(state, 'The Storm')).not.toBe('');
  expect(controller.snapshot().heldRun).toEqual([turnId]);
  expect(await controller.runHeldPlan(turnId)).toBeNull();
  await session.close();
});

test('Accept edits applies the synopses with no card, as one checkpoint, and the turn and its checkpoint name the mode', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const { session, controller } = await controllerOver(state, store);
  controller.setMode('accept-edits');
  const report = await controller.submit(DEMO_INTENTS.fillSynopses, { demo: true });
  expect(report?.status).toBe('applied');
  expect(report?.cards.map((card) => [card.kind, card.decision])).toEqual([['auto', 'auto']]);
  expect(controller.snapshot().pending).toBeNull();
  const turn = controller.snapshot().turns[0];
  expect(turn?.planAuto).toBe(true);
  expect(turn?.mode).toBe('accept-edits');
  expect(turn?.checkpoint?.mode).toBe('accept-edits');
  expect(synopsisOf(state, 'The Landing')).not.toBe('');
  expect(getBody(state, state.manifest.tree.find((node) => node.title === 'The Friend')?.id ?? '')).toBe('');
  await session.close();
});
