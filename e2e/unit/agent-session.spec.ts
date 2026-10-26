import { expect, test } from '@playwright/test';

import {
  MemoryIndexedDb,
  getBody,
  getRevision,
  openRuntimeStore,
  readBodySnapshots,
  readProjectState,
  readSessions,
  type ProjectState,
  type RuntimeStore,
} from '../../packages/store/src/index.js';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type ChatChunk } from '../../packages/gateway/src/index.js';
import { DEMO_INTENTS, createMockProvider, isPlannerCall, userTextOf, type MockScript } from '../../packages/gateway/src/mock/index.js';
import type { GhostPreview } from '../../packages/editor/src/tiptap/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import { DEMO_PROFILE_NAME, ProviderService } from '../../apps/desktop/src/app/providers.js';
import { activityMarkdown } from '../../apps/desktop/src/app/activity-model.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';

/**
 * The agent controller and the session under it, run headless on the demo provider: the demo intents through the real loop,
 * the decision a writer makes on a card, the checkpoint that takes a turn back, the snapshot sweep on open, and the writing
 * session's line. The session is the app's own; only the document and the window events are stood in for, since Node has none.
 * A drafted scene is approved only once its draft has been on screen, so these tests stand in for the editor's ghost region with
 * a recording one, and show it on screen the way the editor does.
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

const FRIEND_TITLE = 'The Friend';

function idOfTitle(state: ProjectState, title: string): string {
  const node = state.manifest.tree.find((entry) => entry.title === title);
  if (node === undefined) throw new Error(`no node titled ${title}`);
  return node.id;
}

async function sessionOver(state: ProjectState, store: RuntimeStore, extra: { retention?: { checkpointCap: number; checkpointDays: number } } = {}) {
  return new ProjectSession({
    store,
    projectId: state.manifest.project.id,
    state,
    shadow: null,
    ...(extra.retention === undefined ? {} : { retention: extra.retention }),
  });
}

/** The provider services on the demo profile, with no network: the demo provider answers from its scripts. */
async function demoProviders(): Promise<ProviderService> {
  return (await ProviderService.open({ db: null, vault: null })).service;
}

/** Resolves once `predicate` holds, polling briefly; fails the test if it never does. */
async function until(predicate: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A ghost region that keeps what the controller writes into it, standing in for the editor's own ghost preview. */
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

test('the continuity demo is a read: its findings go to the Findings inbox, the reply counts them, and the turn carries none', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const controller = new AgentController(session, await demoProviders());

  const report = await controller.submit(DEMO_INTENTS.continuity);

  expect(report?.status).toBe('replied');
  expect(report?.text).toContain('Found 1 continuity finding');
  const turn = controller.snapshot().turns[0];
  expect(turn?.checkpoint).toBeNull();
  expect(turn?.plan).toBeNull();
  // The demo intent runs the coherence scan (coherence.md §7), so its finding is in the Findings inbox, and the turn carries none.
  expect(turn?.findings.length).toBe(0);
  expect(session.state.coherence?.findings.length).toBe(1);
  expect(turn?.provider).toBe(DEMO_PROFILE_NAME);
  await session.close();
});

test('a drafted scene waits for the writer, is written on approval, and restores to before the turn', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const controller = new AgentController(session, await demoProviders());
  const friend = idOfTitle(state, FRIEND_TITLE);

  const running = controller.submit(DEMO_INTENTS.draftScene);
  await until(() => controller.snapshot().pending !== null, 'the draft to wait for a decision');

  // The draft is shown, and nothing is written until the writer decides.
  expect(controller.snapshot().ghosts[0]?.text.startsWith('The ferry came in')).toBe(true);
  expect(getBody(state, friend)).toBe('');

  const region = recordingGhost();
  controller.attachGhost(friend, region);
  controller.setEditorVisible(friend, true);
  controller.answer({ action: 'approve' });
  const report = await running;

  expect(report?.status).toBe('applied');
  expect(getBody(state, friend).startsWith('The ferry came in')).toBe(true);
  expect(report?.undoGroupId).toBeDefined();
  expect(controller.snapshot().ghosts).toEqual([]);
  expect(region.written()).toBe('');

  // The checkpoint takes the turn back: nothing was written after it, so nothing else goes back with it.
  expect(await controller.restore(report!.turnId)).toEqual({ ok: true, later: 0 });
  expect(getBody(state, friend)).toBe('');

  // The activity export names the turn and the change it made, in the order they happened.
  const markdown = activityMarkdown({
    title: state.manifest.project.name,
    entries: session.log.entries(),
    turns: controller.snapshot().turns,
    now: 0,
  });
  expect(markdown).toContain('## Agent turns');
  expect(markdown).toContain(`### ${DEMO_INTENTS.draftScene}`);
  expect(markdown).toContain('Text replaced');
  await session.close();
});

test('an approval waits until the draft is on screen in its scene, and a scene whose editor is hidden does not count', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const controller = new AgentController(session, await demoProviders());
  const friend = idOfTitle(state, FRIEND_TITLE);

  const running = controller.submit(DEMO_INTENTS.draftScene);
  await until(() => controller.snapshot().pending !== null, 'the draft to wait for a decision');

  // Nothing is on screen yet, so the approval is refused, the card stays, and the writer is told where the draft is.
  controller.answer({ action: 'approve' });
  expect(controller.snapshot().pending).not.toBeNull();
  expect(controller.snapshot().approvable).toBe(false);
  expect(controller.snapshot().message).toContain('Open “The Friend”');
  expect(getBody(state, friend)).toBe('');

  // Mounted, but the corkboard is the view: the draft is not on screen, so the approval is still refused.
  const region = recordingGhost();
  controller.attachGhost(friend, region);
  controller.setEditorVisible(friend, false);
  controller.answer({ action: 'approve' });
  expect(controller.snapshot().pending).not.toBeNull();
  expect(controller.snapshot().drafts?.steps[0]?.draft?.text.startsWith('The ferry came in')).toBe(true);

  controller.setEditorVisible(friend, true);
  expect(controller.snapshot().approvable).toBe(true);
  controller.answer({ action: 'approve' });
  expect((await running)?.status).toBe('applied');
  expect(getBody(state, friend).startsWith('The ferry came in')).toBe(true);
  await session.close();
});

test('restoring to before a turn takes back the changes made after it, and says how many went back with it', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const controller = new AgentController(session, await demoProviders());
  const friend = idOfTitle(state, FRIEND_TITLE);

  const running = controller.submit(DEMO_INTENTS.draftScene);
  await until(() => controller.snapshot().pending !== null, 'the draft to wait for a decision');
  const region = recordingGhost();
  controller.attachGhost(friend, region);
  controller.setEditorVisible(friend, true);
  controller.answer({ action: 'approve' });
  const report = await running;
  expect(getBody(state, friend).startsWith('The ferry came in')).toBe(true);

  // The writer keeps typing after the turn: the typing is a change of its own, made after the checkpoint.
  session.dispatch('doc.write', { docId: friend, body: 'Typed after the turn.' });
  expect(controller.laterChanges(report!.turnId)).toHaveLength(1);

  // The restore takes the typing back too, so the scene is as it was before the turn, and the result says so.
  expect(await controller.restore(report!.turnId)).toEqual({ ok: true, later: 1 });
  expect(getBody(state, friend)).toBe('');
  await session.close();
});

test('cancelling a draft writes nothing, and retires its ghost', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const controller = new AgentController(session, await demoProviders());

  const running = controller.submit(DEMO_INTENTS.draftScene);
  await until(() => controller.snapshot().pending !== null, 'the draft to wait for a decision');
  controller.answer({ action: 'cancel' });
  const report = await running;

  expect(report?.status).toBe('cancelled');
  expect(getBody(state, idOfTitle(state, FRIEND_TITLE))).toBe('');
  expect(controller.snapshot().ghosts).toEqual([]);
  expect(controller.snapshot().pending).toBeNull();
  await session.close();
});

test('a controller whose panel has gone does not wait for a decision it can never receive', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const controller = new AgentController(session, await demoProviders());

  controller.detach();
  const report = await controller.submit(DEMO_INTENTS.draftScene);

  expect(report?.status).toBe('cancelled');
  expect(getBody(state, idOfTitle(state, FRIEND_TITLE))).toBe('');
  // Attached again (React's second effect run), it takes decisions as before.
  controller.attach();
  expect(controller.snapshot().busy).toBe(false);
  await session.close();
});

test('a demo turn runs on the built-in demo profile, and never reaches an endpoint that is active', async () => {
  let requests = 0;
  const providers = (
    await ProviderService.open({
      db: null,
      vault: null,
      fetch: async () => {
        requests += 1;
        return new Response('not used', { status: 500 });
      },
    })
  ).service;
  const endpoint = await providers.addProfile({ name: 'Endpoint', kind: 'endpoint', baseUrl: 'https://127.0.0.1:5999/v1', defaultModel: 'test-model' });
  await providers.activate(endpoint.view.id);
  expect(providers.active()?.id).toBe(endpoint.view.id);
  requests = 0;

  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const controller = new AgentController(session, providers);

  const report = await controller.submit(DEMO_INTENTS.continuity, { demo: true });

  expect(report?.status).toBe('replied');
  expect(report?.text).toContain('Found 1 continuity finding');
  expect(requests).toBe(0);
  expect(controller.snapshot().turns[0]?.provider).toBe(DEMO_PROFILE_NAME);
  await session.close();
});

test('a turn starts with the dialogue tools loaded when a dialogue container is selected, and loads nothing for prose', async () => {
  const state = sampleProjectState();
  const prose = state.manifest.tree.find((node) => node.type === 'document');
  if (prose === undefined) throw new Error('the sample has no document');
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const preloaded: (readonly string[])[] = [];
  const preload = session.harness.preload;
  session.harness.preload = (turnId, names) => {
    preloaded.push(names);
    preload(turnId, names);
  };
  const controller = new AgentController(session, await demoProviders());

  session.dispatch('view.setSelection', { nodeIds: [prose.id] });
  await controller.submit(DEMO_INTENTS.continuity);
  expect(preloaded).toEqual([]);

  // A dialogue container is a node the media track marks with its type, as the binder's New dialogue does.
  Object.assign(prose, { type: 'dialogue', kind: 'branching' });
  await controller.submit(DEMO_INTENTS.continuity);
  expect(preloaded).toEqual([['dialogue.draft', 'dialogue.table']]);
  await session.close();
});

test('the snapshot sweep runs when a project opens, and keeps the checkpoint cap (command-bus §5.1)', async () => {
  const state = sampleProjectState();
  const projectId = state.manifest.project.id;
  const friend = idOfTitle(state, FRIEND_TITLE);
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const first = await sessionOver(state, store, { retention: { checkpointCap: 100, checkpointDays: 30 } });
  for (const body of ['a', 'ab', 'abc', 'abcd']) first.dispatch('doc.write', { docId: friend, body });
  await first.settle();
  // Snapshots are written by the bus's sink, which the apply does not wait for, so they are read once they have landed.
  let before = await readBodySnapshots(store, projectId);
  for (let attempt = 0; attempt < 200 && before.length < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    before = await readBodySnapshots(store, projectId);
  }
  expect(before.length).toBeGreaterThanOrEqual(3);
  await first.close();

  const reopened = await readProjectState(store, projectId);
  const second = await sessionOver(reopened, store, { retention: { checkpointCap: 2, checkpointDays: 30 } });
  await second.maintenance();
  const after = await readBodySnapshots(store, projectId);

  expect(after.length).toBeLessThanOrEqual(2);
  // The first snapshot of the document is its diff baseline, and the sweep does not take it (command-bus §5.1, rule 5).
  const oldest = Math.min(...before.map((row) => row.revision));
  expect(after.map((row) => row.revision)).toContain(oldest);
  expect(second.maintenanceError()).toBeNull();
  await second.close();
});

test('the words of a sitting are counted into its session line, and the line is kept when the sitting ends', async () => {
  const state = sampleProjectState();
  const projectId = state.manifest.project.id;
  const friend = idOfTitle(state, FRIEND_TITLE);
  const store: RuntimeStore = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);

  expect(session.sittingOpen()).toBe(false);
  session.autosave.open(friend, { body: getBody(state, friend), revision: getRevision(state, friend) });
  session.autosave.noteEdit(friend, 'one two three four five');
  await session.autosave.flush(friend);
  expect(session.sittingOpen()).toBe(true);
  expect(session.sittingWords()).toBe(5);

  await session.close();
  const lines = await readSessions(store, projectId);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ wordsWritten: 5, docIds: [friend] });
});

test('an agent turn is not a sitting: its writes are not counted as words the writer typed', async () => {
  const state = sampleProjectState();
  const projectId = state.manifest.project.id;
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const controller = new AgentController(session, await demoProviders());

  const running = controller.submit(DEMO_INTENTS.draftScene);
  await until(() => controller.snapshot().pending !== null, 'the draft to wait for a decision');
  const region = recordingGhost();
  controller.attachGhost(idOfTitle(state, FRIEND_TITLE), region);
  controller.setEditorVisible(idOfTitle(state, FRIEND_TITLE), true);
  controller.answer({ action: 'approve' });
  await running;
  await session.close();

  expect(await readSessions(store, projectId)).toHaveLength(0);
});

/**
 * A provider service on a scripted mock profile: the scripts answer every request and nothing goes to the network. The controller
 * reads only the parts of the service it needs (its gateway, the active profile, the demo profile and the usage save).
 */
async function scriptedProviders(scripts: readonly MockScript[]): Promise<ProviderService> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Scripted', kind: 'mock', isActive: true });
  const gateway = createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [...scripts] }) });
  const service = { gateway, active: () => profile, demoProfile: async () => profile, persist: async () => undefined };
  return service as unknown as ProviderService;
}

/** A reply that is held until `gate` opens, the way a model's answer arrives after its request has been sent. */
async function* heldReply(gate: Promise<void>, content: string): AsyncGenerator<ChatChunk> {
  await gate;
  yield { delta: content };
  yield { finishReason: 'stop' };
}

/** A plan of steps, as the planner's reply carries it. */
const planOf = (...steps: readonly { tool: string; params: Record<string, unknown>; expect: string }[]): string => JSON.stringify({ steps });

test('a second turn is refused while an approved turn is still running its adjusting call, and the panel says it is working', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const friend = idOfTitle(state, FRIEND_TITLE);
  const intent = 'Summarise the friend.';
  // A synopsis of 450 words is over the 2000-character limit, which the apply checks and the card does not, so the apply refuses it
  // and the planner is asked to adjust the step. That answer is held until the test releases it.
  const long = planOf({ tool: 'synopsis.fill', params: { docs: [FRIEND_TITLE], source: 'text', max_words: 1000 }, expect: 'The Friend has a synopsis' });
  const short = planOf({ tool: 'synopsis.fill', params: { docs: [FRIEND_TITLE], source: 'text', max_words: 50 }, expect: 'The Friend has a short synopsis' });
  const longSynopsis = Array.from({ length: 450 }, () => 'word').join(' ');
  let drafted = 0;
  let adjusting = false;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AgentController(
    session,
    await scriptedProviders([
      {
        match: (req) => isPlannerCall(req) && userTextOf(req).includes(`Request: ${intent}`),
        respond: (req) => {
          if (!req.messages.some((message) => message.role === 'assistant')) return { content: long };
          adjusting = true;
          return heldReply(held, short);
        },
      },
      {
        match: (req) => req.responseFormat === 'text' && userTextOf(req).includes('Brief: write the synopsis of this document.'),
        respond: () => {
          drafted += 1;
          return { content: drafted === 1 ? longSynopsis : 'A short synopsis.' };
        },
      },
    ]),
  );

  const running = controller.submit(intent);
  await until(() => controller.snapshot().pending !== null, 'the plan card');
  controller.answer({ action: 'approve' });

  // The approved step is refused at apply, and the planner is asked to adjust it. That answer is still on its way, so the turn is
  // running: no card waits, the panel is busy, and a second submit is refused rather than started under the first.
  await until(() => adjusting, 'the adjusting call');
  const during = controller.snapshot();
  expect(during.busy).toBe(true);
  expect(during.pending).toBeNull();
  expect(await controller.submit('Say hello.')).toBeNull();

  // The adjusted step comes back as a card, which the writer approves; the turn then settles and the panel is free.
  release();
  await until(() => controller.snapshot().approvable, 'the adjusted card');
  controller.answer({ action: 'approve' });
  const report = await running;
  expect(report?.status).toBe('applied');
  expect(controller.snapshot().busy).toBe(false);
  expect(state.manifest.tree.find((node) => node.id === friend)?.synopsis).toBe('A short synopsis.');
  await session.close();
});

test('approving a compile lists the project’s images again before it compiles, as the export dialog does', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const compile = planOf({ tool: 'export.compile', params: { selection: { root: 'manuscript' }, format: 'md' }, expect: 'the manuscript is compiled' });
  const controller = new AgentController(
    session,
    await scriptedProviders([{ match: (req) => isPlannerCall(req) && userTextOf(req).includes('Request: Compile the manuscript.'), respond: () => ({ content: compile }) }]),
  );
  // The order the listing and the compile happen in: the listing is recorded when it is taken, with whether the compile's activity
  // row was already written, and the compile once the turn has settled.
  const compiled = (): boolean => session.harness.log.entries().some((entry) => entry.command.startsWith('export.'));
  const order: string[] = [];
  const listing = session.exportsReady.bind(session);
  session.exportsReady = async () => {
    order.push(compiled() ? 'list after the compile' : 'list');
    await listing();
  };

  const running = controller.submit('Compile the manuscript.');
  await until(() => controller.snapshot().approvable, 'the compile card');
  expect(order).toEqual([]);
  controller.answer({ action: 'approve' });
  await running;
  if (compiled()) order.push('compile');

  // The listing was taken once, before the approved compile ran, so the compile names the images as they are now.
  expect(order).toEqual(['list', 'compile']);
  await session.close();
});

test('an approved compile waits for the writer again when the project’s images could not be listed again, as the export dialog does not compile then', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const compile = planOf({ tool: 'export.compile', params: { selection: { root: 'manuscript' }, format: 'md' }, expect: 'the manuscript is compiled' });
  const controller = new AgentController(
    session,
    await scriptedProviders([{ match: (req) => isPlannerCall(req) && userTextOf(req).includes('Request: Compile the manuscript.'), respond: () => ({ content: compile }) }]),
  );
  const exported = (): boolean => session.harness.log.entries().some((entry) => entry.command.startsWith('export.'));
  const listing = session.exportsReady.bind(session);
  let fail = true;
  session.exportsReady = async () => {
    if (fail) throw new Error('the listing failed');
    await listing();
  };

  const running = controller.submit('Compile the manuscript.');
  await until(() => controller.snapshot().approvable, 'the compile card');
  controller.answer({ action: 'approve' });
  await until(() => controller.snapshot().message !== null, 'the listing refusal');
  const held = controller.snapshot();
  expect(held.message).toContain('images could not be listed again (the listing failed)');
  expect(held.message).toContain('the export was not applied');
  expect(held.pending).not.toBeNull();
  expect(exported()).toBe(false);

  // Once the listing works, approving again compiles.
  fail = false;
  controller.answer({ action: 'approve' });
  await running;
  expect(exported()).toBe(true);
  await session.close();
});

test('an approved compile whose image listing fails after Stop is cancelled, not parked again, and nothing is exported', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const compile = planOf({ tool: 'export.compile', params: { selection: { root: 'manuscript' }, format: 'md' }, expect: 'the manuscript is compiled' });
  const controller = new AgentController(
    session,
    await scriptedProviders([{ match: (req) => isPlannerCall(req) && userTextOf(req).includes('Request: Compile the manuscript.'), respond: () => ({ content: compile }) }]),
  );
  let listing = false;
  let fail: (error: Error) => void = () => undefined;
  session.exportsReady = () =>
    new Promise<void>((_, reject) => {
      listing = true;
      fail = reject;
    });

  const running = controller.submit('Compile the manuscript.');
  await until(() => controller.snapshot().approvable, 'the compile card');
  controller.answer({ action: 'approve' });
  await until(() => listing, 'the image listing');
  controller.stop();
  fail(new Error('the listing failed'));
  const report = await running;

  expect(report?.status).toBe('cancelled');
  expect(controller.snapshot().message).toContain('images could not be listed again (the listing failed)');
  expect(controller.snapshot().pending).toBeNull();
  expect(controller.snapshot().busy).toBe(false);
  expect(session.harness.log.entries().some((entry) => entry.command.startsWith('export.'))).toBe(false);
  await session.close();
});

test('a compile the mode approves is held for the writer when the project’s images could not be listed again, and nothing is exported', async () => {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const compile = planOf({ tool: 'export.compile', params: { selection: { root: 'manuscript' }, format: 'md' }, expect: 'the manuscript is compiled' });
  const controller = new AgentController(
    session,
    await scriptedProviders([{ match: (req) => isPlannerCall(req) && userTextOf(req).includes('Request: Compile the manuscript.'), respond: () => ({ content: compile }) }]),
  );
  session.exportsReady = async () => {
    throw new Error('the listing failed');
  };
  controller.setMode('auto');

  const running = controller.submit('Compile the manuscript.');
  await until(() => controller.snapshot().pending !== null, 'the held compile card');
  const held = controller.snapshot();
  expect(held.message).toContain('images could not be listed again');
  expect(held.message).toContain('this export was not applied automatically');
  expect(session.harness.log.entries().some((entry) => entry.command.startsWith('export.'))).toBe(false);

  controller.answer({ action: 'cancel' });
  await running;
  expect(session.harness.log.entries().some((entry) => entry.command.startsWith('export.'))).toBe(false);
  await session.close();
});
