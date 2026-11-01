/**
 * An external write in the agent's own cards (extensibility §4 rule 2, §6): a loaded write-confirm tool asks the writer on a
 * one-step confirm card of its own, and runs only under that card's approval. A reply may mix native and external steps: the
 * native steps run under the plan card, and the external write asks again where it sits in the reply. The external server is
 * the MCP client's mock wire, connected and reviewed the way a person would connect it. Nothing touches the network.
 */

import { describe, expect, it } from 'vitest';

import { createMcpClient, createMockWireFactory, qualifiedNameOf, type McpClient, type McpServerConfig, type WireTool } from '@caotang/mcp-client';

import { createAgentSession, type Decision, type PendingCard, type TurnReport } from '../../src/index.js';
import { mockGateway } from './gateway.js';
import { steps, transcript } from './scripts.js';
import { FRIEND, makeHarness, makeState } from '../fixtures.js';

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

/** A session over a harness with the external server connected, and the decisions the writer makes, in order. */
async function sessionFor(intent: string, replies: readonly string[], decisions: readonly Decision[]) {
  const calls: string[] = [];
  const state = makeState();
  const harness = makeHarness({ mcp: { client: await connectedClient(calls) } }, state);
  const gateway = await mockGateway([transcript(intent, replies)]);
  const queue = [...decisions];
  const pending: PendingCard[] = [];
  const session = createAgentSession({
    harness,
    gateway,
    decide: async (card) => {
      pending.push(card);
      return queue.shift() ?? { action: 'approve' };
    },
    sessionId: 'ext',
  });
  return { session, calls, state, pending };
}

/** The reply that finds the write tool: a read, which loads it for the turn, and nothing else. */
const FIND_WRITE = steps({ tool: 'tool.search', params: { query: 'write_note' }, expect: 'the write tool is loaded' });

describe('an external write asks the writer on its own confirm card (extensibility §4 rule 2, §6)', () => {
  it('runs an external write once its one-step confirm card is approved', async () => {
    const intent = 'Note the lore.';
    const { session, calls, pending } = await sessionFor(intent, [FIND_WRITE, steps({ tool: WRITE, params: { text: 'A note.' }, expect: 'a note is written' })], []);
    const report: TurnReport = await session.submit(intent);
    expect(report.status).toBe('applied');
    expect(pending.map((card) => card.kind)).toEqual(['confirm']);
    expect(report.cards.map((card) => [card.kind, card.tools, card.decision])).toEqual([['confirm', [WRITE], 'approved']]);
    expect(calls).toEqual(['write_note']);
    expect(report.trace.map((row) => [row.tool, row.outcome])).toEqual([
      ['tool.search', 'ok'],
      [WRITE, 'ok'],
    ]);
  });

  it('does not run an external write the writer declines on its confirm card, and the turn is cancelled with nothing written', async () => {
    const intent = 'Note the lore, then stop.';
    const { session, calls } = await sessionFor(intent, [FIND_WRITE, steps({ tool: WRITE, params: { text: 'A note.' }, expect: 'a note is written' })], [
      { action: 'cancel' },
    ]);
    const report = await session.submit(intent);
    expect(report.status).toBe('cancelled');
    expect(report.cards.map((card) => [card.kind, card.tools, card.decision])).toEqual([['confirm', [WRITE], 'cancelled']]);
    expect(calls).toEqual([]);
    expect(report.trace.filter((row) => row.tool === WRITE)).toEqual([]);
  });

  it('a plan approval does not approve an external write in it: the write asks on its own card, and runs once that card is approved', async () => {
    const intent = 'Label The Friend, then note the lore.';
    const reply = steps(
      { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' },
      { tool: WRITE, params: { text: 'A note.' }, expect: 'a note is written' },
    );
    const { session, calls, state } = await sessionFor(intent, [FIND_WRITE, reply], [{ action: 'approve' }, { action: 'approve' }]);
    const report = await session.submit(intent);
    expect(report.status).toBe('applied');
    expect(report.cards.map((card) => [card.kind, card.tools, card.decision])).toEqual([
      ['plan', ['meta.set', WRITE], 'approved'],
      ['confirm', [WRITE], 'approved'],
    ]);
    expect(calls).toEqual(['write_note']);
    expect(state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBe('act-2');
  });

  it('stops a mixed reply when the writer declines the external write, and keeps the native step the writer approved', async () => {
    const intent = 'Label The Friend, then note the lore.';
    const reply = steps(
      { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' },
      { tool: WRITE, params: { text: 'A note.' }, expect: 'a note is written' },
    );
    const { session, calls, state } = await sessionFor(intent, [FIND_WRITE, reply], [{ action: 'approve' }, { action: 'cancel' }]);
    const report = await session.submit(intent);
    expect(report.status).toBe('cancelled');
    expect(report.cards.map((card) => [card.kind, card.tools, card.decision])).toEqual([
      ['plan', ['meta.set', WRITE], 'approved'],
      ['confirm', [WRITE], 'cancelled'],
    ]);
    expect(calls).toEqual([]);
    // The native step ran before the external write's card, so it stays applied, and the summary says what was written.
    expect(state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBe('act-2');
    expect(report.summary).toContain('Written before the cancel');
  });
});
