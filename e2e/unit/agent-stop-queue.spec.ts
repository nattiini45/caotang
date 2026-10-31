import { expect, test } from '@playwright/test';

import { getBody, MemoryIndexedDb, openRuntimeStore, type ProjectState, type RuntimeStore } from '../../packages/store/src/index.js';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type ChatChunk } from '../../packages/gateway/src/index.js';
import { createMockProvider, isDraftCall, isPlannerCall, userTextOf, type MockScript } from '../../packages/gateway/src/mock/index.js';
import type { GhostPreview } from '../../packages/editor/src/tiptap/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController, queuePausedText, type AgentSnapshot } from '../../apps/desktop/src/app/agent.js';
import type { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';

/**
 * Stop, steer and the queue of the agent controller (agent-harness §2, "Stop and steer"; §8). The controller runs the real loop on a
 * scripted mock profile: a stop ends a turn the way a cancel does, a note reaches the running turn, and a message typed while a turn
 * runs is a future turn that starts once the turn before it has settled.
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

async function sessionOver(state: ProjectState, store: RuntimeStore) {
  return new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
}

async function scriptedProviders(scripts: readonly MockScript[]): Promise<ProviderService> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Scripted', kind: 'mock', isActive: true });
  const gateway = createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [...scripts] }) });
  return { gateway, active: () => profile, demoProfile: async () => profile, persist: async () => undefined } as unknown as ProviderService;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

/** Waits until the running turn has reached its planner request: `busy` is true earlier, while the harness loads. */
async function untilPlanning(controller: AgentController): Promise<void> {
  await until(() => controller.snapshot().turns.at(-1)?.phase === 'planning', 'the turn to start planning');
}

/** A door a test holds shut, and opens when it wants the turn behind it to go on. */
function door(): { readonly isOpen: () => boolean; readonly open: () => void } {
  let open = false;
  return { isOpen: () => open, open: () => void (open = true) };
}

const planner = (intent: string) => (req: Parameters<MockScript['match']>[0]): boolean => isPlannerCall(req) && userTextOf(req).includes(`Request: ${intent}`);

/** The planner's reply to `intent`, sent once `gate` opens. Until then the stream idles in small steps, so a stop can interrupt it. */
function heldReply(intent: string, text: string, gate: ReturnType<typeof door>): MockScript {
  return {
    match: planner(intent),
    respond: () =>
      (async function* (): AsyncGenerator<ChatChunk> {
        while (!gate.isOpen()) {
          yield { reasoningDelta: '' };
          await sleep(5);
        }
        yield { delta: JSON.stringify({ reply: text }) };
        yield { finishReason: 'stop' };
      })(),
  };
}

/** An answer with no wait. */
function quickReply(intent: string, text: string): MockScript {
  return { match: planner(intent), respond: () => ({ content: JSON.stringify({ reply: text }) }) };
}

/** A planner that proposes one scene draft of The Friend. */
function plansADraft(intent: string): MockScript {
  return {
    match: planner(intent),
    respond: () => ({
      content: JSON.stringify({ steps: [{ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open the friend.', mode: 'draft' }, expect: 'a draft' }] }),
    }),
  };
}

/** A draft that writes itself a piece at a time until `limit` pieces are out, so a stop can land in the middle of it. */
function slowDraft(pieces: string[]): MockScript {
  return {
    match: (req) => isDraftCall(req) && userTextOf(req).includes('Open the friend.'),
    respond: () =>
      (async function* (): AsyncGenerator<ChatChunk> {
        for (let index = 0; index < 400; index += 1) {
          pieces.push('word ');
          yield { delta: 'word ' };
          await sleep(5);
        }
        yield { finishReason: 'stop' };
      })(),
  };
}

function recordingGhost(): GhostPreview & { written(): string } {
  let text = '';
  const region = {
    clear(): void {
      text = '';
    },
    append(delta: string): void {
      text += delta;
    },
    written: (): string => text,
  };
  return region as unknown as GhostPreview & { written(): string };
}

function idOfTitle(state: ProjectState, title: string): string {
  const node = state.manifest.tree.find((entry) => entry.title === title);
  if (node === undefined) throw new Error(`no node titled ${title}`);
  return node.id;
}

async function open(scripts: readonly MockScript[]) {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const controller = new AgentController(session, await scriptedProviders(scripts));
  return { state, session, controller };
}

test('Stop ends a turn that is planning, as the writer’s, and the controller is ready for the next message', async () => {
  const gate = door();
  const { session, controller } = await open([heldReply('Think about it.', 'Done thinking.', gate)]);

  const running = controller.submit('Think about it.');
  await until(() => controller.snapshot().busy, 'the turn to start');
  expect(controller.snapshot().stoppable).toBe(true);
  // A turn is busy while its harness still loads; the stop is "during planning" only once the planner has been asked.
  await untilPlanning(controller);
  controller.stop();
  expect(controller.snapshot().stopping).toBe(true);
  expect(controller.snapshot().announcement).toBe('Stopping the turn.');
  const report = await running;

  expect(report?.status).toBe('cancelled');
  expect(report?.stop).toEqual({ by: 'user', during: 'planning' });
  expect(report?.summary).toBe('Stopped by you. Nothing was written.');
  const snapshot = controller.snapshot();
  expect(snapshot.busy).toBe(false);
  expect(snapshot.stoppable).toBe(false);
  expect(snapshot.stopping).toBe(false);
  expect(snapshot.announcement).toBe('Stopped by you.');
  expect(snapshot.turns[0]?.report?.stop?.by).toBe('user');
  await session.close();
});

test('Stop clears a scene draft that was streaming into its ghost region, and writes nothing', async () => {
  const pieces: string[] = [];
  const { state, session, controller } = await open([plansADraft('Draft the friend.'), slowDraft(pieces)]);
  const friend = idOfTitle(state, 'The Friend');
  const region = recordingGhost();
  controller.attachGhost(friend, region);
  controller.setEditorVisible(friend, true);

  const running = controller.submit('Draft the friend.');
  await until(() => region.written().length > 10, 'the draft to stream');
  controller.stop();
  const report = await running;

  expect(report?.status).toBe('cancelled');
  expect(report?.stop?.by).toBe('user');
  expect(region.written()).toBe('');
  expect(getBody(state, friend)).toBe('');
  expect(controller.snapshot().ghosts).toEqual([]);
  // The stream was cut short, not run to its end.
  expect(pieces.length).toBeLessThan(400);
  await session.close();
});

test('Stop while a card waits cancels the card exactly as Cancel does', async () => {
  const { state, session, controller } = await open([plansADraft('Draft the friend.'), { match: (req) => isDraftCall(req), respond: () => ({ content: 'The friend came in.' }) }]);
  const friend = idOfTitle(state, 'The Friend');

  const running = controller.submit('Draft the friend.');
  await until(() => controller.snapshot().pending !== null, 'the card to wait');
  expect(controller.snapshot().stoppable).toBe(true);
  controller.stop();
  const report = await running;

  expect(report?.status).toBe('cancelled');
  expect(report?.stop).toEqual({ by: 'user', during: 'awaiting-approval' });
  expect(report?.cards[0]).toMatchObject({ kind: 'confirm', decision: 'cancelled' });
  expect(controller.snapshot().pending).toBeNull();
  expect(getBody(state, friend)).toBe('');
  await session.close();
});

test('messages typed while a turn runs are queued, run in order, and a turn starts only once the one before has settled', async () => {
  const gate = door();
  const { session, controller } = await open([heldReply('First one.', 'One.', gate), quickReply('Second one.', 'Two.'), quickReply('Third one.', 'Three.')]);
  const counts: number[] = [];
  const queues: number[] = [];
  const busy: boolean[] = [];
  controller.subscribe(() => {
    counts.push(controller.turnCount());
    queues.push(controller.snapshot().queue.length);
    busy.push(controller.snapshot().busy);
  });

  const first = controller.submit('First one.');
  await until(() => controller.snapshot().busy, 'the first turn to start');
  controller.enqueue('Second one.');
  controller.enqueue('Third one.');
  expect(controller.snapshot().queue.map((entry) => entry.intent)).toEqual(['Second one.', 'Third one.']);
  // Enqueueing started nothing: the first turn is the only one that has started.
  expect(controller.turnCount()).toBe(1);
  await sleep(50);
  expect(controller.turnCount()).toBe(1);
  expect(controller.snapshot().turns).toHaveLength(1);

  gate.open();
  await first;
  await until(() => controller.snapshot().turns.length === 3 && !controller.snapshot().busy, 'the queue to run');

  expect(controller.snapshot().turns.map((turn) => turn.intent)).toEqual(['First one.', 'Second one.', 'Third one.']);
  expect(controller.snapshot().turns.map((turn) => turn.report?.text)).toEqual(['One.', 'Two.', 'Three.']);
  expect(controller.snapshot().queue).toEqual([]);
  // No two turns ever ran at once: a turn started (the count went up) only while nothing else was busy.
  for (let index = 1; index < counts.length; index += 1) {
    if ((counts[index] as number) > (counts[index - 1] as number)) expect(busy[index - 1]).toBe(false);
  }
  expect(controller.turnCount()).toBe(3);
  expect(Math.max(...queues)).toBe(2);
  await session.close();
});

test('a queued message can be edited, reordered and removed before it runs', async () => {
  const gate = door();
  const { session, controller } = await open([heldReply('Hold on.', 'Held.', gate), quickReply('Beta.', 'B.'), quickReply('Gamma.', 'G.'), quickReply('Delta.', 'D.')]);
  const running = controller.submit('Hold on.');
  await until(() => controller.snapshot().busy, 'the turn to start');
  controller.enqueue('Alpha.');
  controller.enqueue('Beta.');
  controller.enqueue('Gamma.');
  controller.enqueue('Delta.');
  const [alpha, , gamma] = controller.snapshot().queue;
  controller.editQueued((alpha as { id: string }).id, 'Beta.');
  controller.removeQueued((gamma as { id: string }).id);
  const delta = controller.snapshot().queue.at(-1);
  controller.moveQueued((delta as { id: string }).id, 0);
  expect(controller.snapshot().queue.map((entry) => entry.intent)).toEqual(['Delta.', 'Beta.', 'Beta.']);

  gate.open();
  await running;
  await until(() => controller.snapshot().turns.length === 4 && !controller.snapshot().busy, 'the queue to run');
  expect(controller.snapshot().turns.map((turn) => turn.intent)).toEqual(['Hold on.', 'Delta.', 'Beta.', 'Beta.']);
  await session.close();
});

test('a note the running turn ended without reading becomes the first queued message, and is never merged with the others', async () => {
  const gate = door();
  const { session, controller } = await open([heldReply('Read it.', 'Read.', gate), quickReply('Later one.', 'Later.'), quickReply('Also check the ending.', 'Checked.')]);
  const seen: AgentSnapshot[] = [];
  controller.subscribe(() => seen.push(controller.snapshot()));

  const running = controller.submit('Read it.');
  // The planner is already asked, so the note below is one the turn cannot read before it ends.
  await untilPlanning(controller);
  controller.enqueue('Later one.');
  expect(controller.steer('Also check the ending.')).toBe('sent');
  expect(controller.snapshot().notes).toEqual([expect.objectContaining({ text: 'Also check the ending.', lands: 'next-model-call' })]);
  gate.open();
  await running;
  await until(() => controller.snapshot().turns.length === 3 && !controller.snapshot().busy, 'the queue to run');

  // The note was the first queued message, marked, ahead of the message typed before it; each ran as a turn of its own.
  const queued = seen.find((snapshot) => snapshot.queue.some((entry) => entry.fromUndeliveredNote === true));
  expect(queued?.queue.map((entry) => [entry.intent, entry.fromUndeliveredNote === true])).toEqual([
    ['Also check the ending.', true],
    ['Later one.', false],
  ]);
  expect(controller.snapshot().turns.map((turn) => turn.intent)).toEqual(['Read it.', 'Also check the ending.', 'Later one.']);
  expect(controller.snapshot().notes).toEqual([]);
  await session.close();
});

test('a note reaches the running turn’s next request, and a note sent while a card waits offers Send with Cancel instead of dropping the card', async () => {
  const requests: string[] = [];
  const noted: MockScript = {
    match: (req) => isPlannerCall(req) && userTextOf(req).includes('Request: Draft the friend.') && userTextOf(req).includes('Note from the writer'),
    respond: (req) => {
      requests.push(userTextOf(req));
      return { content: JSON.stringify({ reply: 'Understood, no draft.' }) };
    },
  };
  const { state, session, controller } = await open([
    noted,
    plansADraft('Draft the friend.'),
    { match: (req) => isDraftCall(req), respond: () => ({ content: 'The friend came in.' }) },
  ]);
  const friend = idOfTitle(state, 'The Friend');

  const running = controller.submit('Draft the friend.');
  await until(() => controller.snapshot().pending !== null, 'the card to wait');
  // The card is on screen: the note is not sent, and the card is neither approved nor dropped.
  expect(controller.steer('Skip the draft, please.')).toBe('card-waiting');
  expect(controller.snapshot().pending).not.toBeNull();
  expect(controller.snapshot().notes).toEqual([]);

  controller.sendWithCancel('Skip the draft, please.');
  const report = await running;

  expect(report?.cards[0]).toMatchObject({ decision: 'cancelled' });
  expect(report?.status).toBe('replied');
  expect(report?.steering).toEqual([expect.objectContaining({ text: 'Skip the draft, please.', deliveredAtCall: 3 })]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('Note from the writer, sent while you were working: Skip the draft, please.');
  expect(getBody(state, friend)).toBe('');
  await session.close();
});

test('a note written while the turn’s harness is still loading is held, and the first request reads it', async () => {
  const requests: string[] = [];
  const noted: MockScript = {
    match: (req) => isPlannerCall(req) && userTextOf(req).includes('Request: Look at it.'),
    respond: (req) => {
      requests.push(userTextOf(req));
      return { content: JSON.stringify({ reply: 'Looked.' }) };
    },
  };
  const { session, controller } = await open([noted]);

  const running = controller.submit('Look at it.');
  expect(controller.snapshot().busy).toBe(true);
  expect(controller.snapshot().turns).toHaveLength(0);
  expect(controller.steer('Mind the ending.')).toBe('sent');
  expect(controller.snapshot().notes).toEqual([expect.objectContaining({ text: 'Mind the ending.', lands: 'next-model-call' })]);
  const report = await running;

  expect(report?.steering).toEqual([expect.objectContaining({ text: 'Mind the ending.', deliveredAtCall: 1 })]);
  expect(requests[0]).toContain('Note from the writer, sent while you were working: Mind the ending.');
  expect(controller.snapshot().notes).toEqual([]);
  expect(controller.snapshot().queue).toEqual([]);
  await session.close();
});

test('the queue pauses after a turn that stops on a question, and Run the queue resumes it', async () => {
  // A planner that fails like a provider does, so the turn ends failed with an ask-back.
  const failing: MockScript = { match: planner('Fail first.'), respond: () => ({ content: '', error: { kind: 'network' } }) };
  const { session, controller } = await open([failing, quickReply('After the failure.', 'Fine.')]);

  const first = controller.submit('Fail first.');
  await until(() => controller.snapshot().busy, 'the turn to start');
  controller.enqueue('After the failure.');
  const report = await first;
  await sleep(50);

  expect(report?.status).toBe('failed');
  expect(report?.askBack).toBeDefined();
  const paused = controller.snapshot();
  expect(paused.queuePaused).toBe(true);
  expect(paused.announcement).toBe(queuePausedText());
  expect(paused.queue.map((entry) => entry.intent)).toEqual(['After the failure.']);
  expect(paused.turns).toHaveLength(1);

  controller.runQueue();
  await until(() => controller.snapshot().turns.length === 2 && !controller.snapshot().busy, 'the queue to resume');
  expect(controller.snapshot().queuePaused).toBe(false);
  expect(controller.snapshot().turns[1]?.report?.text).toBe('Fine.');
  await session.close();
});

test('Stop does not hold the queue: the next message starts once the stopped turn has settled', async () => {
  const gate = door();
  const { session, controller } = await open([heldReply('Stop me.', 'Never.', gate), quickReply('Then this.', 'Ran.')]);
  const running = controller.submit('Stop me.');
  await until(() => controller.snapshot().busy, 'the turn to start');
  controller.enqueue('Then this.');
  controller.stop();
  const report = await running;
  expect(report?.stop?.by).toBe('user');
  await until(() => controller.snapshot().turns.length === 2 && !controller.snapshot().busy, 'the queue to run');
  expect(controller.snapshot().turns[1]?.report?.text).toBe('Ran.');
  await session.close();
});
