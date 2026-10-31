/**
 * A tool's output schema, from both ends: the listing reads and pins it, and `mcp.invoke` holds a non-error answer's
 * `structuredContent` to it (extensibility.md §3.3, §3.5, §12 A4). The content blocks are rendered verbatim whatever happens here.
 *
 * Two servers answer: the scripted mock, which says exactly what a case needs, and the SDK's own in-process server, so the real wire's
 * client does not turn a mismatch into a failed call before `mcp.invoke` can say that the tool already ran.
 */

import type { ApplyContext } from '@caotang/bus';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyMcpInvoke,
  createLoadedTools,
  createMcpClient,
  createMcpTransport,
  pinHash,
  prepareInvoke,
  type InvokeDeps,
  type McpClient,
  type MockMcpScript,
  type WireTool,
} from '../src/index.js';
import { SHELF_KEY, STORY_KEY, echoScript, openClient, qualified } from './fixtures.js';
import { FIXED_NOW, serverFor, startInProcessServer, textResult, type FixtureTool, type InProcessServer } from './support.js';

const PAGES = {
  type: 'object',
  properties: { pages: { type: 'array', items: { type: 'string' } }, total: { type: 'integer', minimum: 0 } },
  required: ['pages', 'total'],
  additionalProperties: false,
};

/** `lore_lookup`, a trusted read, with the output schema given (or none). */
function lookup(outputSchema?: unknown): WireTool {
  return {
    name: 'lore_lookup',
    description: 'Look up a lore entry by name, aliases included.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    ...(outputSchema === undefined ? {} : { outputSchema }),
    annotations: { readOnlyHint: true },
  };
}

type Answer = ReturnType<MockMcpScript['respond']>;

/** A connected, approved story server whose one tool is declared and answered as the case says. */
async function served(outputSchema: unknown, answer: Answer) {
  const scripts: Record<string, MockMcpScript> = {
    [STORY_KEY]: { listTools: [lookup(outputSchema)], respond: () => answer },
    [SHELF_KEY]: echoScript([]),
  };
  const opened = await openClient({ approve: [STORY_KEY], scripts });
  const loaded = createLoadedTools();
  loaded.beginTurn('turn-1');
  loaded.load([qualified(STORY_KEY, 'lore_lookup')]);
  const prepared = prepareInvoke({ client: opened.client, loaded }, { serverKey: STORY_KEY, toolName: 'lore_lookup', args: { name: 'Mara' } });
  if (!prepared.ok) throw new Error(`fixture did not validate: ${prepared.error.message}`);
  return { client: opened.client, params: prepared.value, deps: { client: opened.client, loaded, transport: createMcpTransport(opened.client) } satisfies InvokeDeps };
}

const IN_PROSE = [{ type: 'text', text: 'Two pages match.' }];
const report = (): Pick<ApplyContext, 'report'> => ({ report: () => undefined });

describe('the listing reads and pins the output schema', () => {
  it('carries a declared output schema on the descriptor, verbatim, and none for a tool that declares none', async () => {
    const { client } = await served(PAGES, { content: IN_PROSE });
    expect(client.describe(STORY_KEY, 'lore_lookup')?.outputSchema).toEqual(PAGES);
    const plain = await served(undefined, { content: IN_PROSE });
    expect(plain.client.describe(STORY_KEY, 'lore_lookup')).not.toHaveProperty('outputSchema');
  });

  it('hashes a tool with no output schema as it always did, and a declared one differently', async () => {
    const plain = await served(undefined, { content: IN_PROSE });
    const declared = await served(PAGES, { content: IN_PROSE });
    const before = await pinHash({
      toolName: 'lore_lookup',
      description: 'Look up a lore entry by name, aliases included.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      annotations: { readOnlyHint: true },
    });
    expect(plain.client.describe(STORY_KEY, 'lore_lookup')?.candidateHash).toBe(before);
    expect(declared.client.describe(STORY_KEY, 'lore_lookup')?.candidateHash).not.toBe(before);
  });

  it('makes a change to the output schema a change to the tool: its pin is no longer verified until it is reviewed again', async () => {
    let schema: unknown = PAGES;
    const script: MockMcpScript = { listTools: [], respond: () => ({ content: IN_PROSE }) };
    const scripts: Record<string, MockMcpScript> = { [STORY_KEY]: script, [SHELF_KEY]: echoScript([]) };
    script.listTools = [lookup(schema)];
    const opened = await openClient({ approve: [STORY_KEY], scripts });
    expect(opened.client.describe(STORY_KEY, 'lore_lookup')?.pinState).toBe('verified');
    schema = { ...PAGES, required: ['pages'] };
    script.listTools = [lookup(schema)];
    await opened.client.refresh(STORY_KEY);
    expect(opened.client.describe(STORY_KEY, 'lore_lookup')?.pinState).toBe('changed');
  });
});

describe('mcp.invoke holds a non-error answer to the output schema its tool declared', () => {
  it('returns a matching structured result with the content blocks verbatim', async () => {
    const { deps, params } = await served(PAGES, { content: IN_PROSE, structuredContent: { pages: ['a', 'b'], total: 2 } });
    const outcome = await applyMcpInvoke(deps, params, report());
    if (!outcome.ok) throw new Error(`expected the answer: ${outcome.error.message}`);
    expect(outcome.value.content).toEqual(IN_PROSE);
    expect(outcome.value.isError).toBe(false);
  });

  it('refuses a mismatch as a postcondition, listing every path and saying the tool already ran', async () => {
    const { deps, params } = await served(PAGES, { content: IN_PROSE, structuredContent: { pages: ['a', 7], total: -1, extra: true } });
    const reports: Parameters<ApplyContext['report']>[0][] = [];
    const outcome = await applyMcpInvoke(deps, params, { report: (entry) => reports.push(entry) });
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.code).toBe('postcondition');
    expect(outcome.error.target).toBe('lore_lookup');
    expect(outcome.error.message).toContain('/pages/1 must be string');
    expect(outcome.error.message).toContain('/total must be >= 0');
    expect(outcome.error.message).toContain('/extra is not allowed');
    expect(outcome.error.message).toContain('The tool ran on the server, so any effect it had is already in place');
    expect(JSON.stringify(outcome)).not.toContain('Two pages match.');
    expect(reports).toEqual([{ affected: [], summary: 'called Story Bible › lore_lookup (external) — the structured result did not match its output schema' }]);
  });

  it('names the structured content itself when the root is the wrong type', async () => {
    const { deps, params } = await served(PAGES, { content: IN_PROSE, structuredContent: 'two pages' });
    const outcome = await applyMcpInvoke(deps, params, report());
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.message).toContain('the structured content must be object');
  });

  it('refuses an answer with no structured content when the tool declared a schema, and says the tool ran', async () => {
    const { deps, params } = await served(PAGES, { content: IN_PROSE });
    const outcome = await applyMcpInvoke(deps, params, report());
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.code).toBe('postcondition');
    expect(outcome.error.message).toContain('declared an output schema but returned no structured content');
    expect(outcome.error.message).toContain('already in place');
  });

  it('does not check an answer from a tool that declared no schema, whatever it carries', async () => {
    const { deps, params } = await served(undefined, { content: IN_PROSE, structuredContent: { anything: [1, 'two', null] } });
    const outcome = await applyMcpInvoke(deps, params, report());
    expect(outcome.ok).toBe(true);
  });

  it('does not check an answer the tool reported as an error', async () => {
    const { deps, params } = await served(PAGES, { content: [{ type: 'text', text: 'No such entry.' }], isError: true, structuredContent: { error: 'no entry' } });
    const outcome = await applyMcpInvoke(deps, params, report());
    if (!outcome.ok) throw new Error(`expected the error answer: ${outcome.error.message}`);
    expect(outcome.value.isError).toBe(true);
    expect(outcome.value.content).toEqual([{ type: 'text', text: 'No such entry.' }]);
  });

  it('accepts structured content that is not an object when the schema allows it (2026-07-28)', async () => {
    for (const [schema, value] of [
      [{ type: 'array', items: { type: 'integer' } }, [1, 2, 3]],
      [{ type: 'string' }, 'two pages'],
      [{ type: ['number', 'null'] }, null],
    ] as const) {
      const { deps, params } = await served(schema, { content: IN_PROSE, structuredContent: value });
      const outcome = await applyMcpInvoke(deps, params, report());
      expect(outcome.ok, JSON.stringify(schema)).toBe(true);
    }
  });

  it('refuses an output schema it cannot check, by the keyword, rather than passing the answer on unchecked', async () => {
    const { deps, params } = await served({ type: 'object', unevaluatedProperties: false }, { content: IN_PROSE, structuredContent: {} });
    const outcome = await applyMcpInvoke(deps, params, report());
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.message).toContain('its output schema uses unevaluatedProperties, which Caotang cannot check');
    expect(outcome.error.message).toContain('already in place');
  });

  it('counts structured content toward the 8,000-token cap, and refuses an answer whose blocks alone would fit', async () => {
    const big = { pages: ['x'.repeat(1_000)], total: 1 };
    const { deps, params } = await served(PAGES, { content: [{ type: 'text', text: 'One page.' }], structuredContent: big });
    const fits = await applyMcpInvoke({ ...deps, resultTokenCap: 200 }, params, report());
    expect(fits.ok).toBe(false);
    if (fits.ok) return;
    expect(fits.error.code).toBe('limit-exceeded');
    expect(fits.error.message).toContain('over the 200-token cap');
    const roomy = await applyMcpInvoke({ ...deps, resultTokenCap: 1_000 }, params, report());
    expect(roomy.ok).toBe(true);
  });
});

describe('over the SDK’s own wire', () => {
  const servers: InProcessServer[] = [];
  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.close();
  });

  const TOOL: FixtureTool = {
    name: 'search_pages',
    description: 'Search the wiki.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    outputSchema: PAGES,
    annotations: { readOnlyHint: true },
  };
  const KEY = 's_AAAAAAAAAA';

  async function wired(structuredContent: unknown): Promise<{ client: McpClient; deps: InvokeDeps; params: Parameters<typeof applyMcpInvoke>[1] }> {
    const server = startInProcessServer({ tools: [{ ...TOOL }], respond: () => ({ ...textResult('Two pages match.'), structuredContent }) });
    servers.push(server);
    const client = createMcpClient({
      settings: { enabled: true, servers: [serverFor(KEY)] },
      fetch: server.fetch,
      probe: async () => false,
      now: () => FIXED_NOW,
      listTimeoutMs: 2_000,
      callTimeoutMs: 2_000,
      onChange: () => undefined,
    });
    await client.connect(KEY);
    const approved = client.approveReview(KEY, client.review(KEY)?.fingerprint ?? '');
    if (!approved.ok) throw new Error(approved.error);
    const loaded = createLoadedTools();
    loaded.beginTurn('turn-1');
    loaded.load([`mcp__${KEY}__search_pages`]);
    const prepared = prepareInvoke({ client, loaded }, { serverKey: KEY, toolName: 'search_pages', args: { query: 'Mara' } });
    if (!prepared.ok) throw new Error(prepared.error.message);
    return { client, deps: { client, loaded, transport: createMcpTransport(client) }, params: prepared.value };
  }

  it('reads the declared schema off tools/list and pins it', async () => {
    const { client } = await wired({ pages: [], total: 0 });
    expect(client.describe(KEY, 'search_pages')?.outputSchema).toEqual(PAGES);
    expect(client.describe(KEY, 'search_pages')?.pinState).toBe('verified');
  });

  it('passes a matching structured result through', async () => {
    const { deps, params } = await wired({ pages: ['Mara'], total: 1 });
    const outcome = await applyMcpInvoke(deps, params, report());
    if (!outcome.ok) throw new Error(`expected the answer: ${outcome.error.message}`);
    expect(outcome.value.content).toEqual([{ type: 'text', text: 'Two pages match.' }]);
  });

  it('refuses a mismatch with mcp.invoke’s own sentence, not the SDK’s, so the writer is told the tool ran', async () => {
    const { deps, params } = await wired({ pages: 'Mara', total: 1 });
    const outcome = await applyMcpInvoke(deps, params, report());
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.code).toBe('postcondition');
    expect(outcome.error.message).toContain('/pages must be array');
    expect(outcome.error.message).toContain('already in place');
    expect(outcome.error.message).not.toContain('Structured content does not match');
  });
});
