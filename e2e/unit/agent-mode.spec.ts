import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, createRunLogPort, getBody, openRuntimeStore, serializeManifest, validateManifest, type ProjectState, type RuntimeStore } from '../../packages/store/src/index.js';
import { planResume } from '../../packages/harness/src/index.js';
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

test('Accept edits does not apply a card unattended when the writer’s typing could not be saved: the card is put to the writer, and an approval waits for the save', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const { session, controller } = await controllerOver(state, store);
  const saves = session.autosave as unknown as { flush: () => Promise<{ docId: string; outcome: string }[]> };
  const flush = saves.flush.bind(saves);
  let failing = true;
  saves.flush = async () => (failing ? [{ docId: 'any', outcome: 'failed' }] : flush());
  controller.setMode('accept-edits');
  const running = controller.submit(DEMO_INTENTS.fillSynopses, { demo: true });
  await until(() => controller.snapshot().pending !== null, 'the held card to wait for the writer');
  expect(controller.snapshot().message).toContain('Your typing could not be saved, so this card was not applied automatically');
  expect(synopsisOf(state, 'The Storm')).toBe('');
  // Approving while the save still fails leaves the card where it is and says so; nothing is written.
  controller.answer({ action: 'approve' });
  await until(() => controller.snapshot().message?.includes('Approve it again') === true, 'the approval to be refused');
  expect(controller.snapshot().pending).not.toBeNull();
  expect(synopsisOf(state, 'The Storm')).toBe('');
  // Once the save works the same card can be approved and applies.
  failing = false;
  controller.answer({ action: 'approve' });
  const report = await running;
  expect(report?.status).toBe('applied');
  expect(report?.cards.map((card) => card.kind)).toEqual(['confirm']);
  expect(synopsisOf(state, 'The Storm')).not.toBe('');
  await session.close();
});

test('a macro’s held steps are retried under the macro’s command, so the retry stays the writer’s and a resumed one does too', async () => {
  const state = sampleProjectState();
  state.manifest.macros = [{
    id: 'm_7K2QX9M4A1',
    slug: 'fill',
    name: 'Fill the synopses',
    description: '',
    params: { kind: 'object', description: 'p', properties: {}, required: [] },
    steps: [{ tool: 'synopsis.fill', params: { docs: ['The Storm'], source: 'text', max_words: 20 }, expect: 'The scene has a synopsis' }],
  }];
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const { session, controller } = await controllerOver(state, store);
  controller.setMode('plan-only');
  expect(controller.runMacro('m_7K2QX9M4A1', {})).toEqual({ started: true });
  await until(() => controller.snapshot().turns[0]?.report?.heldSteps !== undefined, 'the macro’s steps to be held');
  const turnId = controller.snapshot().turns[0]?.turnId ?? '';
  expect(controller.snapshot().turns[0]?.command).toBe('macro-fill');

  const running = controller.runHeldPlan(turnId);
  await until(() => controller.snapshot().pending !== null, 'the held plan to wait for a decision');
  // The retry carries the macro’s command, which is what a run resumed after a reload is told apart by (the loop hides such a run).
  expect(controller.snapshot().turns[1]?.command).toBe('macro-fill');
  const port = createRunLogPort(store);
  const logged = await Promise.all((await port.open(session.projectId)).map(async (run) => planResume(await port.events(run.runId), () => undefined).replay));
  expect(logged.some((replay) => replay?.command === 'macro-fill' && replay.intent === 'Run the macro “Fill the synopses”')).toBe(true);
  controller.answer({ action: 'approve' });
  expect((await running)?.status).toBe('applied');
  await session.close();
});

test('Accept edits records the applied draft for its editor, so review marks can show it, and a card held for unsaved typing records none', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const { session, controller } = await controllerOver(state, store);
  const friend = state.manifest.tree.find((node) => node.title === 'The Friend')?.id ?? '';
  // The editor asks on the store change that lands the text, as EditorPane does.
  const asked: ReturnType<AgentController['consumeApply']>[] = [];
  session.subscribe(() => {
    if (getBody(state, friend) === '') return;
    asked.push(controller.consumeApply(friend, 1));
  });
  controller.setMode('accept-edits');
  const report = await controller.submit(DEMO_INTENTS.draftScene);
  expect(report?.status).toBe('applied');
  expect(getBody(state, friend).startsWith('The ferry came in')).toBe(true);
  const apply = asked.find((entry) => entry !== null);
  expect(apply).toMatchObject({ docId: friend, revision: 1 });
  const call = (apply as { toolCallId: string }).toolCallId;
  expect(controller.turnOf(call)).toBe(report?.turnId);
  // The record is spent by the question: a later change to the scene is not taken for another apply.
  expect(controller.consumeApply(friend, 2)).toBeNull();
  await session.close();
});

test('Accept edits records no apply for a draft whose card was held for the writer’s unsaved typing', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const { session, controller } = await controllerOver(state, store);
  const friend = state.manifest.tree.find((node) => node.title === 'The Friend')?.id ?? '';
  const saves = session.autosave as unknown as { flush: () => Promise<{ docId: string; outcome: string }[]> };
  saves.flush = async () => [{ docId: 'any', outcome: 'failed' }];
  controller.setMode('accept-edits');
  const running = controller.submit(DEMO_INTENTS.draftScene);
  await until(() => controller.snapshot().pending !== null, 'the held card to wait for the writer');
  expect(controller.consumeApply(friend, 1)).toBeNull();
  controller.answer({ action: 'cancel' });
  await running;
  await session.close();
});

test('a scene drafted by two steps of one card answers each store change with its own step, in order, and a question about another scene spends nothing', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const { session, controller } = await controllerOver(state, store);
  const friend = state.manifest.tree.find((node) => node.title === 'The Friend')?.id ?? '';
  const other = state.manifest.tree.find((node) => node.type === 'document' && node.id !== friend)?.id ?? '';
  const inner = controller as unknown as { onEvent: (event: unknown) => void; armDrafts: () => void; runningTurnId: string | null };
  const ghost = (callId: string) => ({ type: 'ghost', callId, docTitle: 'The Friend', text: `Draft ${callId}.`, words: 2 });
  inner.onEvent(ghost('call-1'));
  inner.onEvent(ghost('call-2'));
  inner.runningTurnId = 'turn-1';
  inner.armDrafts();
  // The question is about the revision it was asked with; another scene's question neither answers nor spends this one's record.
  expect(controller.consumeApply(other, 1)).toBeNull();
  expect(controller.consumeApply(friend, 1)).toMatchObject({ docId: friend, revision: 1, toolCallId: 'call-1' });
  expect(controller.consumeApply(friend, 2)).toMatchObject({ docId: friend, revision: 2, toolCallId: 'call-2' });
  expect(controller.consumeApply(friend, 3)).toBeNull();
  expect(controller.turnOf('call-1')).toBe('turn-1');
  expect(controller.turnOf('call-2')).toBe('turn-1');
  await session.close();
});
