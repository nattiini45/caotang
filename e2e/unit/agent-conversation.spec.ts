import { expect, test } from '@playwright/test';

import { addDocument, getBody, MemoryIndexedDb, openRuntimeStore, type ProjectState, type RuntimeStore } from '../../packages/store/src/index.js';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore } from '../../packages/gateway/src/index.js';
import { createMockProvider, isDraftCall, isPlannerCall, userTextOf, type MockScript } from '../../packages/gateway/src/mock/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import type { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';

/**
 * The conversation the agent panel keeps across turns (context-assembly §2, L6). Two turns in the same
 * open project share one agent session, so the second turn's scene.draft call carries the first turn's
 * intent and outcome as L6 (the planner's `meta` tool is L0+L1+L7 only, so the L6 surface that matters
 * for "what did I just do" is the draft call's prompt). The conversation lives in memory only: it ends
 * with the controller — a project switch or a reload — or with the session rebuild a profile, model
 * or thinking change makes, and the app has no other affordance that clears it within a visit.
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

/** A screenplay scene, so the draft-preview gate treats its draft as previewed when the card is shown (agent-model §5.2). */
function withScreenplayScene(state: ProjectState, title: string): void {
  addDocument(state, { parentId: 'manuscript', title, kind: 'screenplay', body: '', now: new Date() });
}

/**
 * A provider service on a scripted mock profile, whose scripts answer every request and send nothing to
 * the network. Every drafting call is kept in `seen`, in order, so a test can read what the model was
 * shown for each turn.
 */
async function scriptedProviders(scripts: readonly MockScript[]): Promise<ProviderService> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Scripted', kind: 'mock', isActive: true });
  const gateway = createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [...scripts] }) });
  return { gateway, active: () => profile, demoProfile: async () => profile, persist: async () => undefined } as unknown as ProviderService;
}

/**
 * A planner script that proposes one `scene.draft` step against `doc`. The match is guarded on the
 * turn's own request text, because the mock gateway picks the first matching script and never consumes
 * it: an unguarded planner match would answer every turn from the first script alone.
 */
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

/** A drafting script that answers each `scene.draft` call, and keeps every request it answered. */
function draftsAScene(seen: string[]): MockScript {
  return {
    match: (req) => isDraftCall(req) && userTextOf(req).includes('Continue the chapter.'),
    respond: (req) => {
      seen.push(userTextOf(req));
      return { content: 'The ferry rowed on.' };
    },
  };
}

/** Approves every card the controller shows. The screenplay scene lets the approval through without a draft preview. */
function autoApprover(controller: AgentController, approvals: { count: number }): () => void {
  let lastPending = false;
  return controller.subscribe(() => {
    const snapshot = controller.snapshot();
    if (!snapshot.busy) return;
    if (snapshot.pending === null) {
      lastPending = false;
      return;
    }
    if (lastPending) return;
    if (!snapshot.approvable) return;
    lastPending = true;
    approvals.count += 1;
    Promise.resolve().then(() => controller.answer({ action: 'approve' }));
  });
}

test('the second turn in an open panel carries the first turn as L6, so the model reads what it just did', async () => {
  const state = sampleProjectState();
  withScreenplayScene(state, 'The Ferry');
  // A title of its own: the sample already holds a prose document called "The Storm", and a second
  // document with that exact title would make the draft step's lookup ambiguous.
  withScreenplayScene(state, 'The Gale');
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = await sessionOver(state, store);
  const seen: string[] = [];
  const controller = new AgentController(
    session,
    await scriptedProviders([
      plansASceneDraft('The Ferry', 'Name the ferryman.'),
      plansASceneDraft('The Gale', 'Name the gale.'),
      draftsAScene(seen),
    ]),
  );
  const approvals = { count: 0 };
  const unsubscribe = autoApprover(controller, approvals);

  const first = await controller.submit('Name the ferryman.');
  const second = await controller.submit('Name the gale.');

  unsubscribe();
  await session.close();

  expect(first?.status).toBe('applied');
  expect(second?.status).toBe('applied');
  expect(approvals.count).toBe(2);

  // Each turn drafted its own scene, so the two planner scripts both ran: had one of them never
  // matched, its scene would still be empty.
  const bodyOf = (title: string): string => {
    const node = state.manifest.tree.find((candidate) => candidate.title === title);
    return node === undefined ? '' : getBody(state, node.id);
  };
  expect(bodyOf('The Ferry')).toContain('The ferry rowed on.');
  expect(bodyOf('The Gale')).toContain('The ferry rowed on.');

  // The second turn's draft call carries the first turn's intent as L6, because the two turns share
  // one agent session (context-assembly §2). The draft tool's prompt assembles every layer, including L6.
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(seen[0]).not.toContain('Intent: Name the ferryman.');
  expect(seen[1]).toContain('Intent: Name the ferryman.');
});
