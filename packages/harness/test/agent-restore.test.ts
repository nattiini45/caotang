/**
 * The two axes of a checkpoint (agent-harness §5, context-assembly §2 L6): the writer can rewind the conversation, take the
 * project's changes back while keeping the conversation, or both. Each test drives the real session on the real bus with a
 * mock model, and reads what the planner is shown from the requests the gateway receives.
 */

import { describe, expect, it } from 'vitest';

import { createMcpClient, createMockWireFactory, qualifiedNameOf, type McpClient, type McpServerConfig } from '@caotang/mcp-client';

import type { ChatRequest } from '@caotang/gateway';
import { draftScript, userTextOf } from '@caotang/gateway/mock';

import { TOOL_NAMES, createAgentPorts, createAgentSession, createContextPort, createHarness, type AgentEvent, type AgentSession } from '../src/index.js';
import { FRIEND, LANDING, STORM, clock, makeHarness, makeState, snapshotOf } from './fixtures.js';
import { mockGateway } from './agent/gateway.js';
import { steps, transcript } from './agent/scripts.js';

const ONE = 'Continue The Landing once.';
const TWO = 'Continue The Landing twice.';
const THREE = 'Continue The Landing thrice.';
/** L6 is read by the drafting calls, so each turn continues a scene and the draft request is the one that is inspected. */
const continuing = (brief: string) =>
  steps({ tool: 'scene.draft', params: { doc: 'The Landing', instruction: brief, mode: 'continue' }, expect: 'The Landing continues' });

async function fixture(options: { formatTime?: (at: number) => string } = {}) {
  const harness = createHarness({ state: makeState(), ports: createAgentPorts() });
  const seen: Record<string, ChatRequest[]> = { [ONE]: [], [TWO]: [], [THREE]: [] };
  const drafting = (brief: string, intent: string) =>
    draftScript((req) => {
      if (req.responseFormat !== 'text' || !userTextOf(req).includes(`Brief: ${brief}`)) return undefined;
      if (seen[intent]![seen[intent]!.length - 1] !== req) seen[intent]!.push(req);
      return 'The tide turned.';
    });
  const gateway = await mockGateway([
    transcript(ONE, [continuing('First brief.')]),
    transcript(TWO, [continuing('Second brief.')]),
    transcript(THREE, [continuing('Third brief.')]),
    drafting('First brief.', ONE),
    drafting('Second brief.', TWO),
    drafting('Third brief.', THREE),
  ]);
  const session: AgentSession = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state: harness.state, ...(options.formatTime === undefined ? {} : { config: { formatTime: options.formatTime } }) }),
    decide: async () => ({ action: 'approve' }),
  });
  /** The recent-turns section of the planner request the last submit of `intent` sent. */
  const recentTurns = (intent: string): string => {
    const text = userTextOf(seen[intent]![seen[intent]!.length - 1]!);
    return text.slice(text.indexOf('# Recent turns'), text.indexOf('# Task'));
  };
  return { harness, session, recentTurns };
}

describe('rewinding the conversation', () => {
  it('drops the turn and every later one from the next prompt, returns the intent, and touches no project state', async () => {
    const f = await fixture();
    const first = await f.session.submit(ONE);
    const second = await f.session.submit(TWO);
    const before = snapshotOf(f.harness.state);
    const groups = f.harness.undo.groups().map((group) => group.id);

    const rewound = f.session.rewindConversation(second.turnId);

    expect(rewound).toEqual({ intent: TWO, rewound: [second.turnId] });
    expect(snapshotOf(f.harness.state)).toBe(before);
    expect(f.harness.undo.groups().map((group) => group.id)).toEqual(groups);
    expect(f.session.reports()).toHaveLength(2);

    await f.session.submit(THREE);
    const shown = f.recentTurns(THREE);
    expect(shown).toContain(`- Turn ${first.turnId}`);
    expect(shown).not.toContain(second.turnId);
  });

  it('rewinds from an earlier turn through the latest, and keeps the window full from the turns before it', async () => {
    const f = await fixture();
    const first = await f.session.submit(ONE);
    const second = await f.session.submit(TWO);
    const third = await f.session.submit(THREE);

    const rewound = f.session.rewindConversation(second.turnId);
    expect(rewound.rewound).toEqual([second.turnId, third.turnId]);

    await f.session.submit(ONE);
    const shown = f.recentTurns(ONE);
    expect(shown).toContain(`- Turn ${first.turnId}`);
    expect(shown).not.toContain(second.turnId);
    expect(shown).not.toContain(third.turnId);
  });

  it('returns nothing for a turn it does not know', async () => {
    const f = await fixture();
    await f.session.submit(ONE);
    expect(f.session.rewindConversation('no.such.turn')).toEqual({ intent: '', rewound: [] });
  });
});

describe('restoring the project and keeping the conversation', () => {
  it('makes the turn’s outcome line say the writer took the changes back', async () => {
    const f = await fixture({ formatTime: () => '14:02' });
    const first = await f.session.submit(ONE);
    expect(f.session.restore(first.turnId).ok).toBe(true);
    f.session.markRestored([first.turnId], Date.UTC(2026, 9, 22, 14, 2));

    await f.session.submit(TWO);
    expect(f.recentTurns(TWO)).toContain('restored by the writer at 14:02; these changes are no longer in the project');
  });

  it('marks every turn it is given, and a partial restore names its step on the first only', async () => {
    const f = await fixture({ formatTime: () => '09:30' });
    const first = await f.session.submit(ONE);
    const second = await f.session.submit(TWO);
    f.session.markRestored([first.turnId, second.turnId], 0, 2);

    await f.session.submit(THREE);
    const shown = f.recentTurns(THREE);
    expect(shown).toContain('steps 2 onward restored by the writer at 09:30;');
    expect(shown.match(/restored by the writer/g)).toHaveLength(2);
    expect(shown.match(/steps 2 onward/g)).toHaveLength(1);
  });

  it('does not mark a turn that was rewound', async () => {
    const f = await fixture();
    const first = await f.session.submit(ONE);
    f.session.rewindConversation(first.turnId);
    f.session.markRestored([first.turnId], 0);
    await f.session.submit(TWO);
    expect(f.recentTurns(TWO)).not.toContain('restored by the writer');
  });
});

const THREE_STEPS = 'Tag three scenes.';
const ONE_STEP = 'Tag one scene.';
/** Three steps: the second labels two documents at once, which the bus runs as two commands under one step. */
const threeSteps = steps(
  { tool: 'meta.set', params: { targets: [LANDING], status: 'revised' }, expect: 'The Landing is revised' },
  { tool: 'meta.set', params: { targets: [STORM, FRIEND], label: 'act-2' }, expect: 'The Storm and The Friend are act-2' },
  { tool: 'meta.set', params: { targets: [LANDING], keywords_add: ['storm'] }, expect: 'The Landing has new keywords' },
);
const firstOnly = steps({ tool: 'meta.set', params: { targets: [LANDING], status: 'revised' }, expect: 'The Landing is revised' });

/** The fixture project with the identity `makeState` draws at random fixed, so two runs can be compared byte for byte. */
function fixedState() {
  const state = makeState();
  state.manifest.project.id = 'p_FIXED00001';
  state.manifest.project.identifier = { uuid: 'urn:uuid:00000000-0000-4000-8000-000000000001' };
  return state;
}

async function stepped(intent: string, plan: string) {
  const harness = createHarness({ state: fixedState(), ports: createAgentPorts(), clock: clock.now });
  const gateway = await mockGateway([transcript(intent, [plan])]);
  const events: AgentEvent[] = [];
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state: harness.state }),
    decide: async () => ({ action: 'approve' }),
    emit: (event) => events.push(event),
  });
  const report = await session.submit(intent);
  const cards = events.filter((event): event is Extract<AgentEvent, { type: 'card' }> => event.type === 'card' && event.card.status === 'done').map((event) => event.card.id);
  return { harness, session, report, cards: [...new Set(cards)] };
}

describe('step checkpoints', () => {
  it('tags every entry of an agent turn with the call it was dispatched under, and a compound step’s commands with its id and an index', async () => {
    const f = await stepped(THREE_STEPS, threeSteps);
    expect(f.report.status).toBe('applied');
    const entries = f.harness.undo.group(f.report.undoGroupId!)!.entries;
    const prefix = f.cards[0]!.slice(0, f.cards[0]!.lastIndexOf('.'));
    expect(entries.map((entry) => entry.callId)).toEqual([`${prefix}.0:0`, `${prefix}.1:0`, `${prefix}.1:1`, `${prefix}.2:0`]);
    // Ids come from the harness: the turn's id and a counter, never the text of a reply.
    expect(entries.every((entry) => entry.callId?.startsWith(`${f.report.turnId}:`))).toBe(true);
  });

  it('lists every step that wrote as restorable, in the order they ran', async () => {
    const f = await stepped(THREE_STEPS, threeSteps);
    expect(f.cards).toHaveLength(3);
    expect(f.session.restorableSteps(f.report.turnId)).toEqual(f.cards);
  });

  it('restores the project to before step 2, byte-equal to a run of only step 1, and keeps the turn’s checkpoint for the rest', async () => {
    const f = await stepped(THREE_STEPS, threeSteps);
    const one = await stepped(ONE_STEP, firstOnly);

    const outcome = f.session.restoreStep(f.report.turnId, f.cards[1]);

    expect(outcome.ok && outcome.value.failures).toEqual([]);
    expect(snapshotOf(f.harness.state)).toBe(snapshotOf(one.harness.state));
    // Step 1 is still applied and still restorable; the steps taken back are not.
    expect(f.session.restorableSteps(f.report.turnId)).toEqual([f.cards[0]]);
    expect(f.harness.undo.group(f.report.undoGroupId!)?.entries).toHaveLength(1);
    // The rest of the turn comes back with the ordinary restore.
    expect(f.session.restore(f.report.turnId).ok).toBe(true);
    expect(snapshotOf(f.harness.state)).toBe(snapshotOf(fixedState()));
  });

  it('restores a step whose own commands are two, with both, and the later step', async () => {
    const f = await stepped(THREE_STEPS, threeSteps);
    const before = f.harness.undo.group(f.report.undoGroupId!)!.entries.length;
    expect(before).toBe(4);
    expect(f.session.restoreStep(f.report.turnId, f.cards[1]!).ok).toBe(true);
    expect(f.harness.undo.group(f.report.undoGroupId!)?.entries).toHaveLength(1);
  });

  it('without a step id is the whole turn, and an unknown step or turn is not-found', async () => {
    const f = await stepped(THREE_STEPS, threeSteps);
    const unknown = f.session.restoreStep(f.report.turnId, 'no.such.step');
    expect(unknown.ok).toBe(false);
    expect(f.session.restoreStep('no.such.turn', f.cards[0]).ok).toBe(false);
    expect(f.harness.undo.group(f.report.undoGroupId!)?.entries).toHaveLength(4);

    expect(f.session.restoreStep(f.report.turnId).ok).toBe(true);
    expect(snapshotOf(f.harness.state)).toBe(snapshotOf(fixedState()));
    expect(f.session.restorableSteps(f.report.turnId)).toEqual([]);
  });

  it('records the id of a single directly approved call, so its step can be restored', async () => {
    const f = await stepped(ONE_STEP, firstOnly);
    expect(f.report.status).toBe('applied');
    expect(f.cards).toHaveLength(1);
    expect(f.session.restorableSteps(f.report.turnId)).toEqual(f.cards);

    const outcome = f.session.restoreStep(f.report.turnId, f.cards[0]);

    expect(outcome.ok).toBe(true);
    expect(snapshotOf(f.harness.state)).toBe(snapshotOf(fixedState()));
  });

  it('records no step for a call the model made up: the ids are the harness’s own', async () => {
    const f = await stepped(THREE_STEPS, threeSteps);
    expect(f.session.restoreStep(f.report.turnId, `${f.report.turnId}:p1.0:0`).ok).toBe(false);
    expect(f.session.restoreStep(f.report.turnId, 'call_1').ok).toBe(false);
  });
});

const KEY = 's_STORYB0002';
const WRITE = qualifiedNameOf(KEY, 'write_note');
const ADDED = '2026-10-08T09:00:00.000Z';
const server: McpServerConfig = {
  key: KEY,
  name: 'Story Bible',
  transport: 'http',
  url: 'https://s-storyb0002.fixture.test/mcp',
  auth: { kind: 'none' },
  enabled: true,
  trustReads: false,
  pinnedTools: {},
  addedAt: ADDED,
};

async function connected(): Promise<McpClient> {
  const client = createMcpClient({
    settings: { enabled: true, servers: [server] },
    wire: createMockWireFactory({
      [KEY]: {
        listTools: [
          {
            name: 'write_note',
            description: 'Write a note into the story bible.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
          },
        ],
        respond: () => ({ content: [{ type: 'text', text: 'written' }], isError: false }),
      },
    }),
    probe: async () => false,
    now: () => ADDED,
    listTimeoutMs: 2_000,
    callTimeoutMs: 2_000,
  });
  await client.connect(KEY);
  const card = client.review(KEY);
  if (card !== undefined) client.approveReview(KEY, card.fingerprint);
  return client;
}

describe('step checkpoints in a plan that mixes native and external steps', () => {
  const intent = 'Tag, note, tag.';
  const FIND_WRITE = steps({ tool: 'tool.search', params: { query: 'write' }, expect: 'the write tool is loaded' });
  const mixed = steps(
    { tool: 'meta.set', params: { targets: [LANDING], status: 'revised' }, expect: 'The Landing is revised' },
    { tool: WRITE, params: { text: 'A note.' }, expect: 'a note is written' },
    { tool: 'meta.set', params: { targets: [STORM], label: 'act-2' }, expect: 'The Storm is act-2' },
  );

  async function run() {
    const harness = makeHarness({ mcp: { client: await connected() } }, fixedState());
    const gateway = await mockGateway([transcript(intent, [FIND_WRITE, mixed])]);
    const events: AgentEvent[] = [];
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state: harness.state }),
      decide: async () => ({ action: 'approve' }),
      emit: (event) => events.push(event),
      sessionId: 'mix',
    });
    const report = await session.submit(intent);
    return { harness, session, report };
  }

  it('records the call ids a native run was dispatched under, not the card ids, and restores from them', async () => {
    const f = await run();
    expect(f.report.status).toBe('applied');
    const entries = f.harness.undo.group(f.report.undoGroupId!)!.entries.map((entry) => entry.callId);
    // The native run before the external step is `.s0` and the one after it `.s2`: the step index follows the run's own.
    expect(entries.map((id) => id?.slice(id.indexOf('.s')))).toEqual(['.s0.0:0', '.s2.2:0']);

    const steps = f.session.restorableSteps(f.report.turnId);
    expect(steps).toHaveLength(3);
    // The external step wrote nothing Caotang can take back, so a restore from it begins at the next step that did.
    const outcome = f.session.restoreStep(f.report.turnId, steps[1]);
    expect(outcome.ok && outcome.value.undone).toHaveLength(1);
    expect(f.harness.state.manifest.tree.find((node) => node.id === LANDING)?.status).toBe('revised');
    expect(f.harness.state.manifest.tree.find((node) => node.id === STORM)?.label).toBeNull();
    expect(f.session.restorableSteps(f.report.turnId)).toEqual([steps[0]]);
  });
});

describe('the agent has no way to rewind', () => {
  it('registers no tool for a rewind or a restore', () => {
    expect(TOOL_NAMES.filter((name) => /rewind|restore|checkpoint/i.test(name))).toEqual([]);
    // 36 agent-visible tools and the four externalOnly host-model rows (#81), which only the MCP server lists.
    expect(TOOL_NAMES).toHaveLength(40);
  });
});
