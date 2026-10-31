/**
 * The Tier-2 gateway and the external call, end to end through the harness (extensibility §5, §6),
 * and the storyboard port that the store registry's shot commands make wired (storyboard.md §4).
 *
 * The external server is the MCP client's own mock wire, connected and reviewed the way a person would connect it.
 * Nothing touches the network. Each test states one property of the spec's contract.
 */
import { describe, expect, it } from 'vitest';

import {
  PIN_MISMATCH_TEXT,
  createMcpClient,
  createMockWireFactory,
  qualifiedNameOf,
  type McpClient,
  type McpServerConfig,
  type MockMcpScript,
  type WireTool,
} from '@caotang/mcp-client';
import { createProjectCommandRegistry } from '@caotang/store';
import { addShotNode, addStoryboardFolder, shotFieldOf } from '@caotang/storyboard';
import { VIDEO_TEMPLATE_IDS } from '@caotang/video-prompt-pack';

import type { ChatRequest } from '@caotang/gateway';

import {
  EXTERNAL_CHECKPOINT_NOTE,
  createAgentSession,
  type AgentEvent,
  type Harness,
  type TurnReport,
} from '../src/index.js';
import { mockGateway } from './agent/gateway.js';
import { answer, steps, transcript } from './agent/scripts.js';
import { CHAPTER_ONE, FRIEND, OPENED, makeHarness, makeState, refusalOf, run, valueOf } from './fixtures.js';
import { textOf } from '@caotang/gateway';

const KEY = 's_STORYB0001';
const SEARCH = qualifiedNameOf(KEY, 'search_lore');
const WRITE = qualifiedNameOf(KEY, 'write_note');
const ADDED = '2026-10-08T09:00:00.000Z';

const server: McpServerConfig = {
  key: KEY,
  name: 'Story Bible',
  transport: 'http',
  url: 'https://s-storyb0001.fixture.test/mcp',
  auth: { kind: 'none' },
  enabled: true,
  trustReads: false,
  pinnedTools: {},
  addedAt: ADDED,
};

/** A read-only lookup and a write, as a server would list them. The annotation is what makes the lookup a read. */
const TOOLS: WireTool[] = [
  {
    name: 'search_lore',
    description: 'Search the story bible for an entry.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_note',
    description: 'Write a note into the story bible.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
];

/** A connected, reviewed client over the mock wire. `calls` records every call that reached the server. */
async function connectedClient(calls: string[]): Promise<McpClient> {
  return (await connectedScripted(calls)).client;
}

/** As {@link connectedClient}, and the script it runs, so a test can change what the server lists and answers. */
async function connectedScripted(calls: string[]): Promise<{ readonly client: McpClient; readonly script: MockMcpScript }> {
  const script: MockMcpScript = {
    listTools: TOOLS,
    respond: (tool) => {
      calls.push(tool);
      return { content: [{ type: 'text', text: `answer from ${tool}` }], isError: false };
    },
  };
  const client = createMcpClient({
    settings: { enabled: true, servers: [server] },
    wire: createMockWireFactory({ [KEY]: script }),
    probe: async () => false,
    now: () => ADDED,
    listTimeoutMs: 2_000,
    callTimeoutMs: 2_000,
  });
  await client.connect(KEY);
  const card = client.review(KEY);
  if (card !== undefined) client.approveReview(KEY, card.fingerprint);
  return { client, script };
}

describe('tool.search — the Tier-2 gateway (extensibility §5)', () => {
  it('is a read wired with no server connected, and its answer says so rather than failing', () => {
    const outcome = valueOf(run(makeHarness(), 'tool.search', { query: 'lore' }));
    expect(outcome.data['matches']).toEqual([]);
    expect(outcome.notes?.join(' ')).toContain('no MCP servers connected');
  });

  it('lets an external caller search without changing the loads of the native turn, which share one loaded set', async () => {
    const calls: string[] = [];
    const client = await connectedClient(calls);
    client.setTrustReads(KEY, true);
    const harness = makeHarness({ mcp: { client } });
    run(harness, 'tool.search', { query: 'lore' }, { turnId: 'turn-native' });
    // An external search for the write tool loads it for the external turn, and that load is put back when the call returns.
    run(harness, 'tool.search', { query: 'write_note' }, { turnId: 'turn-external', source: 'mcp' });
    expect(harness.loadedExternalTools().map((tool) => tool.qualifiedName)).toEqual([SEARCH]);
    const outcome = await harness.callExternal({ name: SEARCH, callId: 'call-native', params: { query: 'x' } }, { turnId: 'turn-native' });
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(['search_lore']);
  });

  it('loads the matches for the turn, names them in the planner’s addendum, and drops them when the turn ends', async () => {
    const calls: string[] = [];
    const harness = makeHarness({ mcp: { client: await connectedClient(calls) } });
    const found = valueOf(run(harness, 'tool.search', { query: 'lore' }, { turnId: 'turn-search' }));
    expect(found.data['surfaced']).toEqual([SEARCH]);
    expect(harness.loadedExternalTools().map((tool) => tool.qualifiedName)).toEqual([SEARCH]);
    expect(harness.loadedAddendum()).toContain(SEARCH);
    harness.endTurn('turn-search');
    expect(harness.loadedAddendum()).toBeUndefined();
    expect(harness.loadedExternalTools()).toEqual([]);
  });
});

describe('mcp.invoke — an external call through the bus (extensibility §6)', () => {
  it('runs a loaded read the user trusts, and writes its one row from the mcp source', async () => {
    const calls: string[] = [];
    const client = await connectedClient(calls);
    client.setTrustReads(KEY, true);
    const harness = makeHarness({ mcp: { client } });
    run(harness, 'tool.search', { query: 'lore' }, { turnId: 'turn-read' });
    const outcome = await harness.callExternal({ name: SEARCH, callId: 'call-read', params: { query: 'Hanne' } }, { turnId: 'turn-read' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.data['untrusted']).toBe(true);
    expect(outcome.value.data['content']).toEqual([{ type: 'text', text: 'answer from search_lore' }]);
    expect(calls).toEqual(['search_lore']);
    const rows = harness.log.entries().filter((entry) => entry.command === 'mcp.invoke');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'mcp', issuedBy: 'agent', summary: 'called Story Bible › search_lore (external)' });
  });

  it('refuses a tool the turn has not loaded, names tool.search as the way to load it, and writes no row', async () => {
    const calls: string[] = [];
    const harness = makeHarness({ mcp: { client: await connectedClient(calls) } });
    const outcome = await harness.callExternal({ name: SEARCH, callId: 'call-unloaded', params: { query: 'x' } }, { turnId: 'turn-unloaded' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain('call tool.search first');
    expect(calls).toEqual([]);
    expect(harness.log.length).toBe(0);
  });

  it('refuses a write-confirm external tool without an approval, and runs it once the turn carries a one-step confirmation', async () => {
    const calls: string[] = [];
    const harness = makeHarness({ mcp: { client: await connectedClient(calls) } });
    run(harness, 'tool.search', { query: 'write_note' }, { turnId: 'turn-write' });
    const refused = await harness.callExternal({ name: WRITE, callId: 'call-write-0', params: { text: 'A note.' } }, { turnId: 'turn-write' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('permission-denied');
    expect(calls).toEqual([]);
    const confirmed = await harness.callExternal(
      { name: WRITE, callId: 'call-write-1', params: { text: 'A note.' } },
      { turnId: 'turn-write', permission: { confirmed: true } },
    );
    expect(confirmed.ok).toBe(true);
    expect(calls).toEqual(['write_note']);
  });

  it('refuses a write-confirm external tool under a turn whose whole plan was approved, since an external call is confirmed per call (extensibility §4 rule 2)', async () => {
    const calls: string[] = [];
    const harness = makeHarness({ mcp: { client: await connectedClient(calls) } });
    run(harness, 'tool.search', { query: 'write_note' }, { turnId: 'turn-plan' });
    // The plan card approved every step of the plan. The external write is not a step the writer read in the card, so
    // the bus reads only a one-step confirmation, and this call carries none.
    const outcome = await harness.callExternal(
      { name: WRITE, callId: 'call-plan', params: { text: 'A note.' } },
      { turnId: 'turn-plan', permission: { approvedPlan: true } },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('permission-denied');
    expect(calls).toEqual([]);
  });

  it('answers a replayed callId from its record, and does not call the server a second time', async () => {
    const calls: string[] = [];
    const client = await connectedClient(calls);
    client.setTrustReads(KEY, true);
    const harness = makeHarness({ mcp: { client } });
    run(harness, 'tool.search', { query: 'lore' }, { turnId: 'turn-replay' });
    const first = await harness.callExternal({ name: SEARCH, callId: 'call-once', params: { query: 'a' } }, { turnId: 'turn-replay' });
    const second = await harness.callExternal({ name: SEARCH, callId: 'call-once', params: { query: 'a' } }, { turnId: 'turn-replay' });
    expect(second).toEqual(first);
    expect(calls).toEqual(['search_lore']);
  });

  it('refuses an external caller before anything connects, because it may not reach another server through Caotang', async () => {
    const calls: string[] = [];
    const harness = makeHarness({ mcp: { client: await connectedClient(calls) } });
    const outcome = await harness.callExternal({ name: SEARCH, callId: 'call-mcp', params: { query: 'x' } }, { turnId: 'turn-mcp', source: 'mcp' });
    expect(outcome.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('is not reachable through the synchronous call, which cannot wait for a server', () => {
    const error = refusalOf(run(makeHarness(), SEARCH, { query: 'x' }));
    expect(error.message).toContain('is not a tool in this build');
  });
});

describe('a loaded tool is bound to the definition the turn saw (extensibility §4 rule 3, §6 expectedPins)', () => {
  it('refuses a call once the server changed the tool and the writer re-approved the change, because the turn read the old definition', async () => {
    const calls: string[] = [];
    const { client, script } = await connectedScripted(calls);
    client.setTrustReads(KEY, true);
    const harness = makeHarness({ mcp: { client } });
    // The search loads the tool under the hash it shows: the definition this turn reads.
    run(harness, 'tool.search', { query: 'lore' }, { turnId: 'turn-drift' });
    // The server changes the description. The listing is read again, and the writer approves the new definition, so the
    // tool is verified again. Only the call's binding to the shown hash can tell the turn's definition from this one.
    script.listTools = TOOLS.map((tool) => (tool.name === 'search_lore' ? { ...tool, description: 'Search the story bible, and its new appendix.' } : tool));
    await client.refresh(KEY);
    const card = client.review(KEY);
    if (card !== undefined) client.approveReview(KEY, card.fingerprint);
    const outcome = await harness.callExternal({ name: SEARCH, callId: 'call-drift', params: { query: 'x' } }, { turnId: 'turn-drift' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain(PIN_MISMATCH_TEXT);
    expect(calls).toEqual([]);
  });
});

/** A storyboard with one shot, built the way the storyboard module builds one, in the state the harness reads. */
function withShot() {
  const state = makeState();
  const folder = addStoryboardFolder(state, { parentId: CHAPTER_ONE, title: 'Scene — Shots', now: OPENED });
  const shot = addShotNode(state, { parentId: folder.id, title: 'Shot 1', stored: {}, now: OPENED });
  return { state, shot };
}

describe('shots.annotate — the storyboard port, wired where the shot commands are (storyboard.md §4)', () => {
  it('is wired by default: a camera change applies through the bus as one undo group, and the undo restores the shot', () => {
    const { state, shot } = withShot();
    const harness = makeHarness({}, state);
    const outcome = valueOf(run(harness, 'shots.annotate', { shots: [shot.id], spec: { shotSize: 'CU' } }, { turnId: 'turn-shot' }));
    expect(outcome.undoGroupId).toBeDefined();
    expect(shotFieldOf(state.manifest.tree.find((node) => node.id === shot.id)!)).toMatchObject({ shotSize: 'CU' });
    expect(harness.log.entries().map((entry) => entry.command)).toContain('shot.setMeta');
    expect(harness.undo.undo(outcome.undoGroupId!).ok).toBe(true);
    expect((shotFieldOf(state.manifest.tree.find((node) => node.id === shot.id)!) as { shotSize?: string } | undefined)?.shotSize).toBeUndefined();
  });

  it('refuses a value outside the closed vocabulary, and changes nothing', () => {
    const { state, shot } = withShot();
    const before = JSON.stringify(state.manifest.tree);
    const error = refusalOf(run(makeHarness({}, state), 'shots.annotate', { shots: [shot.id], spec: { shotSize: 'HUGE' } }));
    expect(error.code).toBe('invalid-params');
    expect(JSON.stringify(state.manifest.tree)).toBe(before);
  });

  it('is wired in a registry the app built without the shot commands, because the harness completes it, so the planner lists it', () => {
    const { state, shot } = withShot();
    const harness = makeHarness({ registry: appRegistry() }, state);
    expect(harness.tools().find((tool) => tool.name === 'shots.annotate')).toMatchObject({ callable: true, wired: true });
    const outcome = valueOf(run(harness, 'shots.annotate', { shots: [shot.id], spec: { shotSize: 'CU' } }, { turnId: 'turn-app-shot' }));
    expect(outcome.undoGroupId).toBeDefined();
    expect(shotFieldOf(state.manifest.tree.find((node) => node.id === shot.id)!)).toMatchObject({ shotSize: 'CU' });
  });
});

/**
 * A registry built the way the desktop's session builds its own (its snapshots and its exporter, and no shot commands
 * or external call). The harness is handed this one, so the completion it does is what the agent sees.
 */
function appRegistry() {
  return createProjectCommandRegistry({
    clock: { now: () => 0 },
    snapshots: () => undefined,
    exporter: {
      compile: () => {
        throw new Error('this registry is built for the test, and nothing in it exports');
      },
    },
  });
}

describe('an app-built registry is completed with the external call too (finding 10, extensibility §6)', () => {
  it('runs an external read through the app’s registry, since the harness adds mcp.invoke to a registry that lacks it', async () => {
    const calls: string[] = [];
    const client = await connectedClient(calls);
    client.setTrustReads(KEY, true);
    const harness = makeHarness({ registry: appRegistry(), mcp: { client } });
    run(harness, 'tool.search', { query: 'lore' }, { turnId: 'turn-app-mcp' });
    const outcome = await harness.callExternal({ name: SEARCH, callId: 'call-app-mcp', params: { query: 'x' } }, { turnId: 'turn-app-mcp' });
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(['search_lore']);
  });
});

describe('the model-backed tools stay unwired without a provider (storyboard.md §4, video-prompt-pack.md §6)', () => {
  it('refuses prompt.draft as not wired, so a provider-less build cannot draft a prompt', () => {
    const error = refusalOf(run(makeHarness(), 'prompt.draft', { shots: ['n_SHOT0000001'], vendor: VIDEO_TEMPLATE_IDS[0] }));
    expect(error.message).toContain('has no implementation in this build');
  });

  it('refuses shots.derive as not wired, since its proposal is one the model stages', () => {
    const error = refusalOf(run(makeHarness(), 'shots.derive', { doc: 'n_SCENE000001' }));
    expect(error.message).toContain('has no implementation in this build');
  });
});

/**
 * One turn of a real session on the real bus, answered by the mock provider. The planner's requests are kept, in order,
 * so a test reads what the model was shown, not what the loop meant to show it.
 */
async function turnWith(harness: Harness, intent: string, replies: readonly string[]): Promise<{ readonly report: TurnReport; readonly requests: ChatRequest[] }> {
  const requests: ChatRequest[] = [];
  const gateway = await mockGateway([transcript(intent, replies, requests)]);
  const session = createAgentSession({ harness, gateway, decide: async () => ({ action: 'approve' }), sessionId: 'external' });
  const report = await session.submit(intent);
  return { report, requests };
}

describe('the agent loop and a loaded external tool, end to end (extensibility §4, §5, §6)', () => {
  it('puts a loaded tool’s name, description and schema in front of the planner after its search, and runs a read of it through the bus', async () => {
    const calls: string[] = [];
    const { client } = await connectedScripted(calls);
    client.setTrustReads(KEY, true);
    const harness = makeHarness({ mcp: { client } });
    const intent = 'Look Hanne up in the story bible.';
    const { report, requests } = await turnWith(harness, intent, [
      steps({ tool: 'tool.search', params: { query: 'lore' }, expect: 'the lore tool is loaded' }),
      steps({ tool: SEARCH, params: { query: 'Hanne' }, expect: 'the entry about Hanne' }),
      answer('Hanne is in the story bible.'),
    ]);
    expect(report.status).toBe('replied');
    // The planner's second request is the first one after the search. It carries the loaded tool as the model reads it:
    // the qualified name and risk, the description verbatim, and the input schema the server advertised.
    const afterSearch = requests[1]?.messages.map((message) => textOf(message.content)).join('\n') ?? '';
    expect(afterSearch).toContain('Tools loaded for this turn.');
    expect(afterSearch).toContain(`- ${SEARCH} [read] — Search the story bible for an entry.`);
    expect(afterSearch).toContain(
      `  params: ${JSON.stringify({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false })}`,
    );
    // The read ran once, through the bus, from the loop, and its row carries the external source.
    expect(calls).toEqual(['search_lore']);
    expect(report.trace.map((entry) => [entry.tool, entry.outcome])).toEqual([
      ['tool.search', 'ok'],
      [SEARCH, 'ok'],
    ]);
    expect(harness.log.entries().filter((entry) => entry.command === 'mcp.invoke')).toMatchObject([{ source: 'mcp' }]);
  });

  it('puts an external write the planner names on a confirm card of its own, and runs nothing when the writer declines it', async () => {
    const calls: string[] = [];
    const { client } = await connectedScripted(calls);
    const harness = makeHarness({ mcp: { client } });
    const intent = 'Note the sighting in the story bible.';
    const gateway = await mockGateway([
      transcript(intent, [
        steps({ tool: 'tool.search', params: { query: 'write_note' }, expect: 'the write tool is loaded' }),
        steps({ tool: WRITE, params: { text: 'A sighting.' }, expect: 'the note is written' }),
      ]),
    ]);
    const session = createAgentSession({ harness, gateway, decide: async () => ({ action: 'cancel' }), sessionId: 'external' });
    const report = await session.submit(intent);
    expect(report.status).toBe('cancelled');
    expect(report.cards.map((card) => [card.kind, card.tools, card.decision])).toEqual([['confirm', [WRITE], 'cancelled']]);
    expect(calls).toEqual([]);
    expect(harness.log.entries().filter((entry) => entry.command === 'mcp.invoke')).toEqual([]);
  });
});

describe('a load is named to the planner once, in the request that follows it (context-assembly §2)', () => {
  it('the request after a search names the tools it loaded in their descriptors, and the request before it names none', async () => {
    const calls: string[] = [];
    const { client } = await connectedScripted(calls);
    const harness = makeHarness({ mcp: { client } });
    const { requests } = await turnWith(harness, 'Find the lore about Hanne.', [
      steps({ tool: 'tool.search', params: { query: 'lore' }, expect: 'the lore tool is loaded' }),
      answer('Found it.'),
    ]);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const before = requests[0]?.messages.map((message) => textOf(message.content)).join('\n') ?? '';
    const after = requests[1]?.messages.map((message) => textOf(message.content)).join('\n') ?? '';
    expect(before).not.toContain('Tools loaded this turn');
    // The descriptors the search sent name the tool, so the one-line addendum for the same set is not sent a second time.
    expect(after).toContain('Tools loaded for this turn.');
    expect(after).not.toContain(`Tools loaded this turn, callable by name: ${SEARCH}.`);
  });
});

describe('a mixed turn names its external side effects on its checkpoint row (extensibility §6, mixed turns)', () => {
  it('a turn that reads an external tool and then changes Caotang carries the scope note on its checkpoint', async () => {
    const calls: string[] = [];
    const { client } = await connectedScripted(calls);
    client.setTrustReads(KEY, true);
    const harness = makeHarness({ mcp: { client } });
    const intent = 'Look Hanne up, then label The Friend act-2.';
    const events: AgentEvent[] = [];
    const gateway = await mockGateway([
      transcript(intent, [
        steps({ tool: 'tool.search', params: { query: 'lore' }, expect: 'the lore tool is loaded' }),
        steps({ tool: SEARCH, params: { query: 'Hanne' }, expect: 'the lore for Hanne is read' }),
        steps({ tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' }),
        answer('Done.'),
      ]),
    ]);
    const session = createAgentSession({
      harness,
      gateway,
      decide: async () => ({ action: 'approve' }),
      sessionId: 'external',
      emit: (event) => events.push(event),
    });
    const report = await session.submit(intent);
    expect(report.status).toBe('applied');
    expect(calls).toEqual(['search_lore']);
    expect(events.find((event) => event.type === 'checkpoint')).toMatchObject({ type: 'checkpoint', note: EXTERNAL_CHECKPOINT_NOTE });
  });
});

describe('an unloaded external tool is still refused, whatever a deferred native row is', () => {
  // Deferral is about context, not trust (agent-harness §3): a native row the turn has not loaded is preflighted, but loading an
  // external tool is where its pin is bound, so the loop refuses its qualified name until tool.search has loaded it.
  it('refuses the qualified name before any search, tells the model to call tool.search first, and reaches no server', async () => {
    const calls: string[] = [];
    const { client } = await connectedScripted(calls);
    client.setTrustReads(KEY, true);
    const harness = makeHarness({ mcp: { client } });
    const { report, requests } = await turnWith(harness, 'Look Hanne up in the story bible.', [
      steps({ tool: SEARCH, params: { query: 'Hanne' }, expect: 'the entry about Hanne' }),
      answer('That tool was not loaded.'),
    ]);
    expect(report.status).toBe('replied');
    expect(calls).toEqual([]);
    expect(report.trace).toEqual([]);
    const next = requests[1]?.messages.map((message) => textOf(message.content)).join('\n') ?? '';
    expect(next).toContain(`"${SEARCH}" is not an external tool loaded this turn. Nothing was run. Call tool.search first, then call the tool by the qualified name it returns.`);
  });

  it('lists native rows before external tools in one search, and loads both for the turn', async () => {
    const calls: string[] = [];
    const harness = makeHarness({ mcp: { client: (await connectedScripted(calls)).client } });
    // "story" matches a bounded set of native storyboard rows and both Story Bible tools, so the cap cannot hide the external half.
    const found = valueOf(run(harness, 'tool.search', { query: 'story', limit: 20 }, { turnId: 'turn-both' }));
    const matches = found.data['matches'] as { source: string; name: string }[];
    const firstExternal = matches.findIndex((match) => match.source === 'external');
    expect(firstExternal).toBeGreaterThan(0);
    expect(matches.slice(0, firstExternal).every((match) => match.source === 'native')).toBe(true);
    expect(matches.slice(firstExternal).map((match) => match.name)).toEqual([SEARCH, WRITE]);
    expect(harness.loadedExternalTools().map((tool) => tool.qualifiedName)).toEqual([SEARCH, WRITE]);
    expect(harness.loadedNativeTools().map((tool) => tool.name)).toEqual(matches.slice(0, firstExternal).map((match) => match.name));
  });
});
