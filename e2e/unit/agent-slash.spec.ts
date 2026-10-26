import { expect, test } from '@playwright/test';

import { addDocument, getBody, MemoryIndexedDb, openRuntimeStore, type ProjectState } from '../../packages/store/src/index.js';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore } from '../../packages/gateway/src/index.js';
import { createMockProvider, isDraftCall, isPlannerCall, userTextOf, type MockScript } from '../../packages/gateway/src/mock/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import type { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import { restoreTarget, type RestorableTurn } from '../../apps/desktop/src/app/slash-model.js';

/**
 * Slash commands in the agent controller (agent-harness §2, "Slash commands"): a line is resolved before any model call, a command
 * becomes the plan it names or an answer under the box, and none of it skips a card. The model is the mock provider, and a counter
 * on the gateway says how many requests a line caused.
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

interface Rig {
  readonly controller: AgentController;
  readonly session: ProjectSession;
  readonly state: ProjectState;
  /** Model requests the gateway was asked to send. */
  readonly requests: () => number;
}

/** A scene whose draft needs no preview before its card is approved (agent-model §5.2). */
function withScene(state: ProjectState, title: string): void {
  addDocument(state, { parentId: 'manuscript', title, kind: 'screenplay', body: '', now: new Date() });
}

async function rig(scripts: readonly MockScript[], prepare: (state: ProjectState) => void = () => undefined): Promise<Rig> {
  const state = sampleProjectState();
  prepare(state);
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Scripted', kind: 'mock', isActive: true });
  const base = createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [...scripts] }) });
  let requests = 0;
  const gateway = { ...base, complete: (...args: Parameters<typeof base.complete>) => (requests += 1, base.complete(...args)) };
  const providers = { gateway, active: () => profile, demoProfile: async () => profile, persist: async () => undefined } as unknown as ProviderService;
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  return { controller: new AgentController(session, providers), session, state, requests: () => requests };
}

/** Lets the turn a line started run to its end, approving every card it shows. */
async function settled(controller: AgentController, decision: 'approve' | 'cancel' | 'leave' = 'approve'): Promise<void> {
  const off = controller.subscribe(() => {
    const snapshot = controller.snapshot();
    if (decision === 'leave' || snapshot.pending === null || !snapshot.approvable) return;
    void Promise.resolve().then(() => controller.answer({ action: decision }));
  });
  for (let waited = 0; waited < 400; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const snapshot = controller.snapshot();
    if (controller.turnCount() > 0 && !snapshot.busy) break;
    if (decision === 'leave' && snapshot.pending !== null) break;
  }
  off();
}

const planner = (intent: string, step: { tool: string; params: Record<string, unknown>; expect: string }): MockScript => ({
  match: (req) => isPlannerCall(req) && userTextOf(req).includes(`Request: ${intent}`),
  respond: () => ({ content: JSON.stringify({ steps: [step] }) }),
});

const drafts = (text: string, marker: string): MockScript => ({
  match: (req) => isDraftCall(req) && userTextOf(req).includes(marker),
  respond: () => ({ content: text }),
});

test('/draft builds the plan from the typed title, runs no planner, and still stops at its card', async () => {
  const { controller, session, state, requests } = await rig([drafts('The ferry rowed on.', 'Brief: Open the scene.')], (s) => withScene(s, 'The Ferry'));
  expect(controller.sendLine('/draft "The Ferry" -- Open the scene.')).toEqual({ kind: 'sent' });
  await settled(controller, 'leave');
  // The card waits for the writer: a command is not an approval.
  expect(controller.snapshot().pending?.card.steps.map((step) => step.tool)).toEqual(['scene.draft']);
  expect(getBody(state, state.manifest.tree.find((node) => node.title === 'The Ferry')?.id ?? '')).toBe('');
  controller.answer({ action: 'approve' });
  await settled(controller, 'approve');
  const report = controller.snapshot().turns[0]?.report;
  expect(report?.status).toBe('applied');
  expect(report?.command).toBe('draft');
  expect(controller.snapshot().turns[0]?.intent).toBe('Draft “The Ferry”');
  expect(getBody(state, state.manifest.tree.find((node) => node.title === 'The Ferry')?.id ?? '')).toContain('The ferry rowed on.');
  // The only request was the draft itself.
  expect(requests()).toBe(1);
  await session.close();
});

test('an ambiguous title is answered under the box with its candidates, before any model call', async () => {
  const { controller, session, requests } = await rig([]);
  expect(controller.sendLine('/draft The')).toEqual({ kind: 'kept' });
  const note = controller.snapshot().command;
  expect(note?.kind).toBe('ask');
  expect(note?.lines.length).toBeGreaterThan(1);
  expect(note?.lines.every((line) => line.startsWith('The '))).toBe(true);
  expect(controller.turnCount()).toBe(0);
  expect(requests()).toBe(0);
  await session.close();
});

test('/context lists the next request’s layers and what it left out, with zero model calls', async () => {
  const { controller, session, requests } = await rig([]);
  expect(controller.sendLine('/context')).toEqual({ kind: 'shown' });
  const note = controller.snapshot().command;
  expect(note?.kind).toBe('context');
  expect(note?.title).toMatch(/would send about [\d,]+ tokens/);
  expect(note?.lines.some((line) => line.startsWith('L0 System: '))).toBe(true);
  expect(note?.lines.some((line) => line.startsWith('L7 Task: '))).toBe(true);
  expect(note?.lines).toContain('Nothing was left out.');
  expect(controller.turnCount()).toBe(0);
  expect(requests()).toBe(0);
  await session.close();
});

test('/help lists every command, and one command by name', async () => {
  const { controller, session } = await rig([]);
  controller.sendLine('/help');
  const all = controller.snapshot().command;
  expect(all?.lines.filter((line) => line.startsWith('/')).map((line) => line.split(' ')[0])).toEqual(['/help', '/plan', '/draft', '/synopses', '/scan', '/review', '/compile', '/restore', '/context']);
  controller.sendLine('/help compile');
  expect(controller.snapshot().command?.title).toBe('/compile');
  controller.dismissCommandNote();
  expect(controller.snapshot().command).toBeNull();
  await session.close();
});

test('/restore with no finished turn says so, and /restore last offers the existing confirmation for the newest turn that wrote', async () => {
  const { controller, session, state } = await rig([drafts('The ferry rowed on.', 'Brief: Open the scene.')], (s) => withScene(s, 'The Ferry'));
  expect(controller.sendLine('/restore')).toEqual({ kind: 'kept' });
  expect(controller.snapshot().command?.title).toContain('No finished turn has a checkpoint');
  controller.sendLine('/draft "The Ferry" -- Open the scene.');
  await settled(controller);
  expect(controller.sendLine('/restore 9')).toEqual({ kind: 'kept' });
  expect(controller.snapshot().command?.title).toContain('Turn 9 is not in this panel');
  const outcome = controller.sendLine('/restore last');
  expect(outcome).toMatchObject({ kind: 'restore', turnId: controller.snapshot().turns[0]?.turnId });
  // Nothing was restored by the command: the panel asks first.
  expect(getBody(state, state.manifest.tree.find((node) => node.title === 'The Ferry')?.id ?? '')).toContain('The ferry rowed on.');
  await session.close();
});

test('/plan sends the request without the slash and shows a plan card for a single reversible step', async () => {
  const script = planner('add a note to The Landing', { tool: 'notes.append', params: { doc: 'The Landing', text: 'Check the tide.' }, expect: 'the note is added' });
  const { controller, session, state } = await rig([script]);
  const notesOf = (): string => state.manifest.tree.find((node) => node.title === 'The Landing')?.notes ?? '';
  expect(controller.sendLine('/plan add a note to The Landing')).toEqual({ kind: 'sent' });
  await settled(controller, 'leave');
  // Without /plan this single write-auto step runs at once; the command shows its card.
  expect(controller.snapshot().pending?.kind).toBe('plan');
  expect(notesOf()).not.toContain('Check the tide.');
  controller.answer({ action: 'approve' });
  await settled(controller);
  expect(controller.snapshot().turns[0]?.report?.command).toBe('plan');
  expect(controller.snapshot().turns[0]?.intent).toBe('add a note to The Landing');
  expect(notesOf()).toContain('Check the tide.');
  await session.close();
});

test('a line that names no command is sent as a request with a note, and // sends a literal slash', async () => {
  const { controller, session } = await rig([{ match: (req) => isPlannerCall(req), respond: () => ({ content: JSON.stringify({ reply: 'ok' }) }) }]);
  controller.sendLine('/foo bar');
  expect(controller.snapshot().command?.title).toBe('Sent as a request');
  await settled(controller);
  expect(controller.snapshot().turns[0]?.intent).toBe('/foo bar');
  expect(controller.snapshot().turns[0]?.report?.command).toBeUndefined();
  controller.sendLine('//draft is a word here');
  await settled(controller);
  expect(controller.snapshot().turns[1]?.intent).toBe('/draft is a word here');
  await session.close();
});

test('while a turn waits on a card, a command that starts or restores a turn is kept, a plain line queues, and help answers at once', async () => {
  const { controller, session } = await rig([planner('open the gate', { tool: 'scene.draft', params: { doc: 'The Landing', instruction: 'Continue the chapter.', mode: 'continue' }, expect: 'drafted' }), drafts('More.', 'Continue the chapter.')]);
  controller.sendLine('open the gate');
  await settled(controller, 'leave');
  expect(controller.snapshot().busy).toBe(true);
  expect(controller.sendLine('/plan something else')).toEqual({ kind: 'kept' });
  expect(controller.snapshot().command?.title).toBe('A turn is running');
  expect(controller.sendLine('/restore')).toEqual({ kind: 'kept' });
  expect(controller.sendLine('a plain note for later')).toEqual({ kind: 'sent' });
  expect(controller.snapshot().queue.map((entry) => entry.intent)).toEqual(['a plain note for later']);
  expect(controller.sendLine('/help')).toEqual({ kind: 'shown' });
  controller.answer({ action: 'cancel' });
  await session.close();
});

test('a document a read rule withholds cannot be named by a command, and its title is not listed', async () => {
  const { controller, session, state } = await rig([]);
  const storm = state.manifest.tree.find((node) => node.title === 'The Storm');
  if (storm === undefined) throw new Error('the sample has no Storm');
  session.setAgentRules([{ effect: 'deny', tool: '*', scope: { subtree: storm.id }, access: 'read' }]);
  controller.sendLine('/draft "The Storm"');
  expect(controller.snapshot().command?.kind).toBe('ask');
  expect(JSON.stringify(controller.snapshot().command)).not.toContain(storm.id);
  controller.sendLine('/draft The');
  expect(controller.snapshot().command?.lines).not.toContain('The Storm');
  await session.close();
});

test('restoreTarget reads last, a number and an id, and says why a turn cannot be restored', () => {
  const turn = (turnId: string, checkpoint: boolean, stands: boolean): RestorableTurn => ({ turnId, report: null, checkpoint, stands });
  const turns = [turn('s.turn-1', true, true), turn('s.turn-2', false, false), turn('s.turn-3', true, false), turn('s.turn-4', true, true), turn('s.turn-5', false, false)];
  expect(restoreTarget(turns, undefined)).toMatchObject({ turn: { turnId: 's.turn-4' } });
  expect(restoreTarget(turns, 'last')).toMatchObject({ turn: { turnId: 's.turn-4' } });
  expect(restoreTarget(turns, '1')).toMatchObject({ turn: { turnId: 's.turn-1' } });
  expect(restoreTarget(turns, 's.turn-4')).toMatchObject({ turn: { turnId: 's.turn-4' } });
  expect(restoreTarget(turns, '2')).toEqual({ says: 'Turn 2 wrote nothing, so there is nothing to restore.' });
  expect(restoreTarget(turns, '3')).toEqual({ says: 'Turn 3 was already restored, or the undo history has moved past it.' });
  expect(restoreTarget(turns, '9')).toMatchObject({ says: expect.stringContaining('not in this panel') });
  expect(restoreTarget([], 'last')).toMatchObject({ says: expect.stringContaining('No finished turn') });
});
