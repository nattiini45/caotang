import { expect, test } from '@playwright/test';

import { addDocument, getBody, MemoryIndexedDb, openRuntimeStore, type ProjectState } from '../../packages/store/src/index.js';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore } from '../../packages/gateway/src/index.js';
import { createMockProvider, isDraftCall, isPlannerCall, userTextOf, type MockScript } from '../../packages/gateway/src/mock/index.js';
import type { Command } from '../../packages/bus/src/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import type { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';

/**
 * The two axes of a checkpoint in the controller the panel drives (agent-harness §5): the project is restored, the conversation is
 * rewound, or both. What the model is sent is read from the drafting request, the only call that carries L6. Everything is in memory.
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

const SCENES = ['The Ferry', 'The Gale', 'The Reef', 'The Quay'] as const;
const INTENTS = ['Name the ferryman.', 'Name the gale.', 'Name the reef.', 'Name the quay.'] as const;

async function scriptedProviders(scripts: readonly MockScript[]): Promise<ProviderService> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Scripted', kind: 'mock', isActive: true });
  const gateway = createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [...scripts] }) });
  return { gateway, active: () => profile, demoProfile: async () => profile, persist: async () => undefined } as unknown as ProviderService;
}

function plansASceneDraft(doc: string, intent: string): MockScript {
  return {
    match: (req) => isPlannerCall(req) && userTextOf(req).includes(`Request: ${intent}`),
    respond: () => ({
      content: JSON.stringify({
        steps: [{ tool: 'scene.draft', params: { doc, instruction: 'Continue the chapter.', mode: 'continue' }, expect: 'drafted' }],
      }),
    }),
  };
}

/** Approves every card the controller shows. A screenplay scene lets the approval through without a draft preview. */
function autoApprover(controller: AgentController): () => void {
  let lastPending = false;
  return controller.subscribe(() => {
    const snapshot = controller.snapshot();
    if (!snapshot.busy) return;
    if (snapshot.pending === null) {
      lastPending = false;
      return;
    }
    if (lastPending || !snapshot.approvable) return;
    lastPending = true;
    Promise.resolve().then(() => controller.answer({ action: 'approve' }));
  });
}

async function fixture() {
  const state: ProjectState = sampleProjectState();
  for (const title of SCENES) addDocument(state, { parentId: 'manuscript', title, kind: 'screenplay', body: '', now: new Date() });
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const seen: string[] = [];
  const controller = new AgentController(
    session,
    await scriptedProviders([
      ...SCENES.map((scene, index) => plansASceneDraft(scene, INTENTS[index]!)),
      {
        match: (req) => isDraftCall(req) && userTextOf(req).includes('Continue the chapter.'),
        respond: (req) => {
          seen.push(userTextOf(req));
          return { content: 'The ferry rowed on.' };
        },
      },
    ]),
  );
  const unsubscribe = autoApprover(controller);
  const bodyOf = (title: string): string => {
    const node = state.manifest.tree.find((candidate) => candidate.title === title);
    return node === undefined ? '' : getBody(state, node.id);
  };
  const run = async (count: number) => {
    const reports = [];
    for (let index = 0; index < count; index += 1) reports.push(await controller.submit(INTENTS[index]!));
    return reports;
  };
  return { controller, session, seen, bodyOf, run, close: async () => (unsubscribe(), await session.close()) };
}

/** The turns of the recent-turns section of a drafting request, as the lines the model reads. */
const turnsIn = (request: string | undefined): string => (request ?? '').slice((request ?? '').indexOf('# Recent turns'), (request ?? '').indexOf('# Task'));

test('restoring a turn marks every turn it took back as restored, in the panel and in the next prompt', async () => {
  const f = await fixture();
  const [first, second, third] = await f.run(3);

  const outcome = await f.controller.restore(first!.turnId);
  expect(outcome).toMatchObject({ ok: true, later: 2 });
  expect(f.controller.snapshot().turns.map((turn) => turn.restoredAt !== null)).toEqual([true, true, true]);
  expect(f.controller.snapshot().turns.map((turn) => turn.rewound)).toEqual([false, false, false]);
  for (const scene of SCENES.slice(0, 3)) expect(f.bodyOf(scene)).toBe('');

  await f.controller.submit(INTENTS[3]);
  await f.close();
  const shown = turnsIn(f.seen[3]);
  // The window is the last two turns; both say the writer took their changes back, though only the first was clicked.
  expect(shown).toContain(`- Turn ${second!.turnId}`);
  expect(shown).toContain(`- Turn ${third!.turnId}`);
  expect(shown.match(/restored by the writer at \d\d:\d\d; these changes are no longer in the project/g)).toHaveLength(2);
});

test('rewinding the conversation hides the turn and later ones from the model, puts them aside in the panel and changes no project state', async () => {
  const f = await fixture();
  const [first, second, third] = await f.run(3);
  const before = SCENES.map((scene) => f.bodyOf(scene));
  const groups = f.session.undo.groups().map((group) => group.id);

  expect(f.controller.canRewind(second!.turnId)).toBe(true);
  const rewound = f.controller.rewindConversation(second!.turnId);

  expect(rewound).toEqual({ intent: INTENTS[1], rewound: [second!.turnId, third!.turnId] });
  expect(f.controller.snapshot().turns.map((turn) => turn.rewound)).toEqual([false, true, true]);
  expect(f.controller.canRewind(second!.turnId)).toBe(false);
  expect(SCENES.map((scene) => f.bodyOf(scene))).toEqual(before);
  expect(f.session.undo.groups().map((group) => group.id)).toEqual(groups);

  await f.controller.submit(INTENTS[3]);
  await f.close();
  const shown = turnsIn(f.seen[3]);
  expect(shown).toContain(`- Turn ${first!.turnId}`);
  expect(shown).not.toContain(second!.turnId);
  expect(shown).not.toContain(third!.turnId);
  // The rewound turns are still the panel's: their checkpoints stand, so the project can still be restored from them.
  expect(f.controller.canRestore(second!.turnId)).toBe(true);
});

test('restore both takes the project back first, then rewinds the conversation, and hands back the instruction', async () => {
  const f = await fixture();
  const [first, second] = await f.run(2);

  const outcome = await f.controller.restoreBoth(second!.turnId);

  expect(outcome).toEqual({ ok: true, later: 0, intent: INTENTS[1] });
  expect(f.bodyOf('The Gale')).toBe('');
  expect(f.bodyOf('The Ferry')).not.toBe('');
  expect(f.controller.snapshot().turns.map((turn) => turn.rewound)).toEqual([false, true]);
  await f.controller.submit(INTENTS[3]);
  await f.close();
  expect(turnsIn(f.seen[2])).toContain(`- Turn ${first!.turnId}`);
  expect(turnsIn(f.seen[2])).not.toContain(second!.turnId);
});

test('restore both with a compensation that fails leaves the conversation alone, marks what was taken back, and says why', async () => {
  const f = await fixture();
  const [first] = await f.run(1);
  // A change of the writer's whose undo throws, between the first turn and the second.
  const failing = { issuedBy: 'user', name: 'doc.write' } as unknown as Command;
  f.session.undo.register(f.session.undo.targetFor(failing, 0), {
    kind: 'compensable',
    commandId: 'cmd_failing',
    name: 'doc.write',
    label: 'a change that cannot be taken back',
    restore: () => {
      throw new Error('the stored text moved');
    },
  });
  const [, second] = [first, await f.controller.submit(INTENTS[1])];

  const outcome = await f.controller.restoreBoth(first!.turnId);

  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.message).toContain('the stored text moved');
  // The second turn was taken back before the failure, so it is marked restored; the conversation is not rewound.
  expect(f.controller.snapshot().turns.map((turn) => turn.rewound)).toEqual([false, false]);
  expect(f.controller.snapshot().turns.map((turn) => turn.restoredAt !== null)).toEqual([false, true]);
  expect(f.bodyOf('The Gale')).toBe('');
  expect(f.bodyOf('The Ferry')).not.toBe('');

  await f.controller.submit(INTENTS[2]);
  await f.close();
  const shown = turnsIn(f.seen[2]);
  expect(shown).toContain(`- Turn ${first!.turnId}`);
  expect(shown).toContain(`- Turn ${second!.turnId}`);
  expect(shown.match(/restored by the writer/g)).toHaveLength(1);
});

test('a turn cannot be rewound while one is running', async () => {
  const f = await fixture();
  const [first] = await f.run(1);
  const pending = f.controller.submit(INTENTS[1]);
  expect(f.controller.canRewind(first!.turnId)).toBe(false);
  expect(f.controller.rewindConversation(first!.turnId)).toBeNull();
  await pending;
  await f.close();
});
