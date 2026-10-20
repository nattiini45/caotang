/**
 * The planner on the native tool-call wire: when the model's capabilities report `tools`, the request
 * declares the registry's tools instead of asking for the JSON envelope, the reply's calls are the
 * plan's steps, and every call is answered by a `tool` message keyed by its id. The steps, the cards
 * and the ladder are the same ones the JSON wire produces — these tests check the same behaviours
 * `loop.test.ts` and `external-cards.test.ts` check, at the wire's seams.
 *
 * The gateway is the real one, over the mock provider, with `modelCaps` wrapped to report `tools: true`
 * for the mock profile: that is the one thing a real capable profile would change about the request.
 * The external server is the MCP client's mock wire, connected the way a person would connect it.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest, Gateway, ThinkingLevel } from '@caotang/gateway';
import { userTextOf, type MockScript } from '@caotang/gateway/mock';
import { createMcpClient, createMockWireFactory, qualifiedNameOf, type McpClient, type McpServerConfig, type WireTool } from '@caotang/mcp-client';

import {
  createAgentPorts,
  createAgentSession,
  createContextPort,
  PLANNER_SYSTEM_PREFIX,
  type AgentEvent,
  type AgentSession,
  type Decision,
  type PendingCard,
} from '../../src/index.js';
import { mockGateway } from './gateway.js';
import { prose } from './scripts.js';
import { CHAPTER_ONE, FRIEND, makeHarness, makeState } from '../fixtures.js';
import type { ProjectState } from '@caotang/store';

/* ------------------------------------------------------------------ *
 * Native replies, scripted.
 * ------------------------------------------------------------------ */

/** A call a scripted native reply makes. `args` is serialised; a string is sent verbatim, for a malformed one. */
interface NativeCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/** One native planner reply: its text, the calls it asks for, and the reasoning text it carries. */
interface NativeReply {
  readonly content?: string;
  readonly calls?: readonly NativeCall[];
  readonly reasoning?: string;
}

/** Whether a request is the planner's on the native wire: the agent's system message, with tools declared. */
function isNativePlanner(req: ChatRequest): boolean {
  const first = req.messages[0];
  return (req.tools?.length ?? 0) > 0 && first?.role === 'system' && first.content.startsWith(PLANNER_SYSTEM_PREFIX);
}

/** How many planner replies a request already carries. */
function repliesSoFar(req: ChatRequest): number {
  return req.messages.filter((message) => message.role === 'assistant').length;
}

/** The messages a request carries for one call id, in wire order. */
function messagesFor(req: ChatRequest, id: string) {
  return req.messages.filter((message) => message.role === 'tool' && message.toolCallId === id);
}

/** The `tool` message answering one call. */
function resultFor(req: ChatRequest, id: string) {
  const message = messagesFor(req, id)[0];
  if (message === undefined) return undefined;
  return { message, body: JSON.parse(message.content) as { ok?: boolean; data?: unknown; error?: unknown } };
}

function responseOf(reply: NativeReply | undefined) {
  return {
    content: reply?.content ?? '',
    ...(reply?.calls === undefined || reply.calls.length === 0
      ? {}
      : {
          toolCalls: reply.calls.map((call) => ({
            id: call.id,
            name: call.name,
            argumentsJson: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
          })),
        }),
    ...(reply?.reasoning === undefined ? {} : { reasoning: reply.reasoning }),
  };
}

/**
 * A planner's answers for one intent, as `transcript` gives them for the JSON wire: the replies before
 * the last are picked by how far the conversation has gone, and the last answers any call of the intent.
 */
function nativeTranscript(intent: string, replies: readonly NativeReply[]): MockScript[] {
  const calls = Math.max(0, replies.length - 1);
  const scripts: MockScript[] = Array.from({ length: calls }, (_value, index) => ({
    match: (req) => isNativePlanner(req) && repliesSoFar(req) === index,
    respond: () => responseOf(replies[index]),
  }));
  return [
    ...scripts,
    {
      match: (req) => isNativePlanner(req) && userTextOf(req).includes(`Request: ${intent}`),
      respond: () => responseOf(replies[replies.length - 1]),
    },
  ];
}

/* ------------------------------------------------------------------ *
 * The session: a real gateway reporting `tools`, and the decisions the writer makes.
 * ------------------------------------------------------------------ */

const KEY = 's_STORYB0002';
const SEARCH = qualifiedNameOf(KEY, 'search_lore');
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

/** A connected, reviewed client over the mock wire. `calls` records each call that reached the server. */
async function connectedClient(calls: string[]): Promise<McpClient> {
  const client = createMcpClient({
    settings: { enabled: true, servers: [server] },
    wire: createMockWireFactory({
      [KEY]: {
        listTools: TOOLS,
        respond: (tool) => {
          calls.push(tool);
          return { content: [{ type: 'text', text: `answer from ${tool}` }], isError: false };
        },
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

interface NativeFixture {
  readonly session: AgentSession;
  /** Every request the gateway saw, in order — planner calls carry `tools`; drafting calls do not. */
  readonly seen: ChatRequest[];
  readonly pending: PendingCard[];
  readonly events: AgentEvent[];
  /** The external calls that reached the mock server. */
  readonly calls: string[];
  readonly state: ProjectState;
}

/** A gateway whose model reports native-tool support, with every request recorded. */
async function nativeGateway(scripts: readonly MockScript[], seen: ChatRequest[]): Promise<Gateway> {
  const base = await mockGateway(scripts);
  return {
    ...base,
    modelCaps: () => ({ tools: true }),
    complete: (req, signal) => {
      seen.push(req);
      return base.complete(req, signal);
    },
  };
}

interface NativeOptions {
  readonly decisions?: readonly Decision[];
  readonly decide?: (card: PendingCard) => Promise<Decision> | Decision;
  readonly thinking?: ThinkingLevel;
  /** Connect the story-bible server, so `tool.search` has tools to load. */
  readonly mcp?: boolean;
  readonly state?: ProjectState;
}

async function nativeFixture(scripts: readonly MockScript[], options: NativeOptions = {}): Promise<NativeFixture> {
  const calls: string[] = [];
  const state = options.state ?? makeState();
  // The ports the product wires in — scene.draft and friends are callable only through them.
  const harness = makeHarness({ ports: createAgentPorts(), ...(options.mcp === true ? { mcp: { client: await connectedClient(calls) } } : {}) }, state);
  const seen: ChatRequest[] = [];
  const gateway = await nativeGateway(scripts, seen);
  const queue = [...(options.decisions ?? [])];
  const pending: PendingCard[] = [];
  const events: AgentEvent[] = [];
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state: () => state }),
    decide: async (card) => {
      if (options.decide !== undefined) return options.decide(card);
      pending.push(card);
      return queue.shift() ?? { action: 'approve' };
    },
    emit: (event) => events.push(event),
    sessionId: 'nvt',
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
  });
  return { session, seen, pending, events, calls, state };
}

/** The planner requests of the fixture, in order — the requests that carried tools. */
function plannerRequests(seen: readonly ChatRequest[]): ChatRequest[] {
  return seen.filter((req) => (req.tools?.length ?? 0) > 0);
}

const namesOf = (req: ChatRequest): string[] => (req.tools ?? []).map((tool) => tool.name);

/* ------------------------------------------------------------------ */

describe('the planner on the native tool-call wire', () => {
  it('declares the registry tools on the request, with no reply envelope, and declares the tools a search loads on the next one', async () => {
    const intent = 'Find the lore tools, read the bible, and label The Friend.';
    const fixture = await nativeFixture(
      nativeTranscript(intent, [
        { calls: [{ id: 'call_s', name: 'tool.search', args: { query: '' } }] },
        {
          content: 'The bible is loaded; reading it and labelling.',
          calls: [
            { id: 'call_r', name: SEARCH, args: { query: 'keeper' } },
            { id: 'call_w', name: 'meta.set', args: { targets: [FRIEND], label: 'act-2' } },
          ],
        },
      ]),
      { mcp: true },
    );
    const report = await fixture.session.submit(intent);
    expect(report.status).toBe('applied');

    const [first, second] = plannerRequests(fixture.seen);
    // The request carries the tools, declared for the model to call natively — and no envelope.
    expect(first?.toolChoice).toBe('auto');
    expect(first?.responseFormat).toBeUndefined();
    const system = first?.messages[0]?.content ?? '';
    expect(system.startsWith(PLANNER_SYSTEM_PREFIX)).toBe(true);
    expect(system).not.toContain('"steps"');
    expect(system).not.toContain('"reply"');
    const names = namesOf(first as ChatRequest);
    expect(names).toContain('tool.search');
    expect(names).toContain('meta.set');
    expect(names).not.toContain(SEARCH);
    // Each declaration's schema is the registry's own JSON Schema, verbatim.
    const meta = first?.tools?.find((tool) => tool.name === 'meta.set');
    expect(meta?.parameters).toEqual(expect.objectContaining({ type: 'object' }));
    expect(JSON.stringify(meta?.parameters)).toContain('"targets"');

    // The search's answer went back as a tool message keyed by its call id, and the loaded descriptors
    // followed it as a user note — after them, so the model reads results before the new tools.
    const answer = resultFor(second as ChatRequest, 'call_s');
    expect(answer?.message.isError).toBeUndefined();
    expect(answer?.body.ok).toBe(true);
    const surfaced = (answer?.body.data as { surfaced?: string[] }).surfaced ?? [];
    expect(surfaced).toContain(SEARCH);
    expect(surfaced).toContain(WRITE);
    const resultsAt = second?.messages.findIndex((m) => m.role === 'tool' && m.toolCallId === 'call_s') ?? -1;
    const loadedAt = second?.messages.findIndex((m) => m.role === 'user' && m.content.includes('External tools loaded for this turn')) ?? -1;
    expect(loadedAt).toBeGreaterThan(resultsAt);
    // And the freshly loaded tools are declared on that very request, by qualified name.
    expect(namesOf(second as ChatRequest)).toEqual(expect.arrayContaining([SEARCH, WRITE]));

    // The mixed plan ran: the external read through its one card-free path, the write under the plan card.
    expect(fixture.calls).toEqual(['search_lore']);
    expect(fixture.state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBe('act-2');
    // The reply's text is the plan's rationale: the wire carries no `expect`, so the card shows it.
    expect(fixture.pending[0]?.card.steps[1]?.expect).toBe('The bible is loaded; reading it and labelling.');
  });

  it('answers a call whose arguments do not parse with a keyed tool error and the refusal in words', async () => {
    const intent = 'Read and label The Friend.';
    const fixture = await nativeFixture(
      nativeTranscript(intent, [
        {
          calls: [
            { id: 'bad', name: 'meta.set', args: '{not json' },
            { id: 'good', name: 'doc.read', args: { doc: FRIEND } },
          ],
        },
        { content: 'Understood — nothing was run for that call.' },
      ]),
    );
    const report = await fixture.session.submit(intent);
    expect(report.status).toBe('replied');

    const second = plannerRequests(fixture.seen)[1];
    // The malformed call is refused by its id; the good call is reported not run, because the reply staged nothing.
    const bad = resultFor(second as ChatRequest, 'bad');
    expect(bad?.message.isError).toBe(true);
    expect(bad?.body).toEqual({ ok: false, error: expect.stringContaining('not valid JSON') });
    const good = resultFor(second as ChatRequest, 'good');
    expect(good?.message.isError).toBe(true);
    expect(good?.body).toEqual({ ok: false, error: expect.stringContaining('did not run') });
    // The refusal reads as the JSON wire's would: the step, and why, as a user message after the results.
    const last = second?.messages.at(-1);
    expect(last?.role).toBe('user');
    expect(last?.content).toContain('Step 1 (meta.set) was refused');
    expect(last?.content).toContain('not valid JSON');
    // Nothing ran: no card, no trace row, no write.
    expect(report.trace).toHaveLength(0);
    expect(fixture.state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBeNull();
  });

  it('refuses a reply with more calls than the plan bound allows, answering every call, and runs none of them', async () => {
    const intent = 'Read The Friend many times over.';
    // One call over the plan schema's bound (plan.ts PLAN_STEPS_MAX): the native reply must be held to
    // the same number the JSON reply is, and the refusal must go back to the model, not fail the turn.
    const calls = Array.from({ length: 31 }, (_unused, index) => ({ id: `r${index}`, name: 'doc.read', args: { doc: FRIEND } }));
    const fixture = await nativeFixture(
      nativeTranscript(intent, [{ calls }, { content: 'Understood — that was too many calls for one reply.' }]),
    );
    const report = await fixture.session.submit(intent);
    expect(report.status).toBe('replied');

    const second = plannerRequests(fixture.seen)[1];
    // Every call is answered by its id with the refusal, as a malformed call's is.
    const first = resultFor(second as ChatRequest, 'r0');
    expect(first?.message.isError).toBe(true);
    expect(first?.body).toEqual({ ok: false, error: expect.stringContaining('at most 30') });
    const last = resultFor(second as ChatRequest, 'r30');
    expect(last?.message.isError).toBe(true);
    // The refusal reads as the JSON wire's would, as a user message after the results.
    const told = second?.messages.at(-1);
    expect(told?.role).toBe('user');
    expect(told?.content).toContain('Your steps were refused');
    expect(told?.content).toContain('at most 30');
    // None of the calls ran.
    expect(report.trace).toHaveLength(0);
  });

  it('answers a call its preflight refused with an error result, then the refusal in words', async () => {
    const intent = 'Label The Friend as act-9.';
    const fixture = await nativeFixture(
      nativeTranscript(intent, [
        { calls: [{ id: 'c1', name: 'meta.set', args: { targets: [FRIEND], label: 'act-9' } }] },
        { content: 'Right — act-9 is not a label in the vocabulary.' },
      ]),
    );
    const report = await fixture.session.submit(intent);
    expect(report.status).toBe('replied');

    const second = plannerRequests(fixture.seen)[1];
    const answer = resultFor(second as ChatRequest, 'c1');
    expect(answer?.message.isError).toBe(true);
    expect(answer?.body).toEqual({ ok: false, error: expect.stringContaining('act-9') });
    const told = second?.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n') ?? '';
    expect(told).toContain('refused before anything ran');
    // The refusal is a status card, as a refused step is on the JSON wire — and no step ran.
    expect(report.steps).toHaveLength(0);
    expect(fixture.state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBeNull();
  });

  it('still gates a write-confirm call behind the card the writer approves, with the reply’s text as the step’s rationale', async () => {
    const intent = 'Rename Chapter 1 to Prologue.';
    const fixture = await nativeFixture(
      nativeTranscript(intent, [
        {
          content: 'Renaming the chapter as asked.',
          calls: [{ id: 'c1', name: 'binder.restructure', args: { ops: [{ action: 'rename', node: CHAPTER_ONE, title: 'Prologue' }] } }],
        },
      ]),
    );
    const report = await fixture.session.submit(intent);
    expect(report.status).toBe('applied');
    // One write-confirm call is one confirm card, and it ran only after the approval.
    expect(fixture.pending.map((card) => card.kind)).toEqual(['confirm']);
    expect(fixture.pending[0]?.card.steps[0]?.expect).toBe('Renaming the chapter as asked.');
    expect(report.steps[0]?.expect).toBe('Renaming the chapter as asked.');
    expect(fixture.state.manifest.tree.find((node) => node.id === CHAPTER_ONE)?.title).toBe('Prologue');
  });

  it('does not write for a call the writer declines on its card', async () => {
    const intent = 'Rename Chapter 1 to Prologue.';
    const fixture = await nativeFixture(
      nativeTranscript(intent, [
        {
          calls: [{ id: 'c1', name: 'binder.restructure', args: { ops: [{ action: 'rename', node: CHAPTER_ONE, title: 'Prologue' }] } }],
        },
      ]),
      { decisions: [{ action: 'cancel' }] },
    );
    const report = await fixture.session.submit(intent);
    expect(report.status).toBe('cancelled');
    expect(fixture.state.manifest.tree.find((node) => node.id === CHAPTER_ONE)?.title).toBe('Chapter 1');
  });

  it('keeps the reply’s calls and reasoning blocks on the assistant message the next request replays', async () => {
    const intent = 'Read The Friend.';
    const fixture = await nativeFixture(
      nativeTranscript(intent, [
        {
          calls: [{ id: 'r1', name: 'doc.read', args: { doc: FRIEND } }],
          reasoning: 'checking which document holds the friend',
        },
        { content: 'The Friend is empty.' },
      ]),
    );
    const report = await fixture.session.submit(intent);
    expect(report.status).toBe('replied');

    const second = plannerRequests(fixture.seen)[1];
    const assistant = second?.messages.filter((m) => m.role === 'assistant').at(-1);
    expect(assistant?.toolCalls).toEqual([{ id: 'r1', name: 'doc.read', argumentsJson: JSON.stringify({ doc: FRIEND }) }]);
    // The reasoning block is replayed verbatim — the adapter reads `raw` for its own wire, nothing reads it here.
    expect(assistant?.reasoning).toEqual([
      { text: 'checking which document holds the friend', raw: { type: 'mock-reasoning', text: 'checking which document holds the friend' } },
    ]);
    // The read's answer is its own tool message, keyed by the call's id and carrying its data.
    const answer = resultFor(second as ChatRequest, 'r1');
    expect(answer?.body).toEqual({ ok: true, data: expect.objectContaining({ doc: expect.objectContaining({ id: FRIEND }) }) });
    expect(answer?.message.isError).toBeUndefined();
  });

  it('sends the session’s thinking level on every model request', async () => {
    const intent = 'Say hello.';
    const fixture = await nativeFixture(nativeTranscript(intent, [{ content: 'Hello.' }]), { thinking: 'high' });
    await fixture.session.submit(intent);
    expect(fixture.seen.length).toBeGreaterThan(0);
    for (const req of fixture.seen) expect(req.thinking).toBe('high');
  });

  it('answers a failed step’s tool message and its corrective, then runs the corrected call it is sent', async () => {
    const intent = 'Label The Friend, then draft it twice.';
    const fixture = await nativeFixture(
      [
        ...nativeTranscript(intent, [
          {
            calls: [
              { id: 'c1', name: 'meta.set', args: { targets: [FRIEND], label: 'act-2' } },
              { id: 'c2', name: 'scene.draft', args: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' } },
              // The Friend is empty when the plan is checked, so this step passes the preflight; the step before it
              // fills the scene, so the apply refuses this one — a refusal the model adjusts, as the JSON wire does.
              { id: 'c3', name: 'scene.draft', args: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' } },
            ],
          },
          // The adjusted step the model sends after the refusal: continue, not draft.
          { calls: [{ id: 'c4', name: 'scene.draft', args: { doc: 'The Friend', instruction: 'Open.', mode: 'continue' } }] },
        ]),
        prose('Brief: Open.', 'The ferry came in.'),
      ],
      { decisions: [{ action: 'approve' }, { action: 'approve' }] },
    );
    const report = await fixture.session.submit(intent);
    expect(report.status).toBe('applied');

    const second = plannerRequests(fixture.seen)[1];
    // The ladder's request carries every call's answer: the two that ran, the one that refused, and not-run for none.
    expect(resultFor(second as ChatRequest, 'c1')?.body.ok).toBe(true);
    expect(resultFor(second as ChatRequest, 'c2')?.body.ok).toBe(true);
    const failed = resultFor(second as ChatRequest, 'c3');
    expect(failed?.message.isError).toBe(true);
    expect(failed?.body.ok).toBe(false);
    // The corrective is the ladder's own words, worded for a call — and the ask-back verbatim.
    const told = second?.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    expect(told).toContain('Step 3 (scene.draft) did not apply');
    expect(told).toContain('one corrected call for scene.draft');
    // The corrected call's result is keyed to it when the ladder shows the card again — asserted by the run itself.
    const body = fixture.state.documents.get(FRIEND)?.body ?? '';
    expect(body.split('The ferry came in.').length - 1).toBe(2);
  });

  it('answers an edited step’s call with the run the writer approved, not a not-run', async () => {
    const intent = 'Label The Friend, then draft it twice.';
    const fixture = await nativeFixture(
      [
        ...nativeTranscript(intent, [
          {
            calls: [
              { id: 'c1', name: 'meta.set', args: { targets: [FRIEND], label: 'act-2' } },
              { id: 'c2', name: 'scene.draft', args: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' } },
              { id: 'c3', name: 'scene.draft', args: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' } },
            ],
          },
          { calls: [{ id: 'c4', name: 'scene.draft', args: { doc: 'The Friend', instruction: 'Open.', mode: 'continue' } }] },
        ]),
        prose('Brief: Open.', 'The ferry came in.'),
      ],
      // The writer changes the label on the card, then approves: the step that runs is a new object,
      // but it still answers the call that asked for it.
      { decisions: [{ action: 'edit', edits: [{ op: 'set', index: 0, path: ['params', 'label'], value: 'act-1' }] }, { action: 'approve' }, { action: 'approve' }] },
    );
    const report = await fixture.session.submit(intent);
    expect(report.status).toBe('applied');
    expect(fixture.state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBe('act-1');
    const second = plannerRequests(fixture.seen)[1];
    const labelled = resultFor(second as ChatRequest, 'c1');
    expect(labelled?.body.ok).toBe(true);
    expect(labelled?.message.isError).toBeUndefined();
  });
});

describe('the wire the planner speaks', () => {
  it('keeps the JSON envelope for a model that reports no tool support', async () => {
    const intent = 'Label The Friend as act-2.';
    const seen: ChatRequest[] = [];
    const state = makeState();
    const harness = makeHarness({}, state);
    // The real gateway over a mock profile: `modelCaps` answers `{}`, which is the JSON wire's switch.
    const base = await mockGateway([
      {
        match: (req) => typeof req.responseFormat === 'object' && userTextOf(req).includes(`Request: ${intent}`),
        respond: () => ({ content: JSON.stringify({ steps: [{ tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled' }] }) }),
      },
    ]);
    const gateway: Gateway = { ...base, complete: (req, signal) => (seen.push(req), base.complete(req, signal)) };
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state: () => state }),
      decide: async () => ({ action: 'approve' }),
      sessionId: 'jfb',
    });
    const report = await session.submit(intent);
    expect(report.status).toBe('applied');
    const planner = seen.find((req) => req.messages[0]?.content.startsWith(PLANNER_SYSTEM_PREFIX));
    expect(planner?.tools).toBeUndefined();
    expect(planner?.responseFormat).toEqual(expect.objectContaining({ jsonSchemaHint: expect.anything() }));
    const system = planner?.messages[0]?.content ?? '';
    expect(system).toContain('"steps"');
    expect(state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBe('act-2');
  });
});
