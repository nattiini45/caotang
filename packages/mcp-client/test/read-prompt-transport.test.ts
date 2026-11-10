import { describe, expect, it, vi } from 'vitest';

import { createMcpClient, createMcpTransport, createMockWire, WireError, type MockMcpScript, type WireDeps, type WirePromptResult } from '../src/index.js';
import { STORY_KEY, echoScript, storyTools } from './fixtures.js';
import { serverFor } from './support.js';

const PROMPT = { name: 'recap', description: 'A recap', arguments: [{ name: 'chapter', required: true }] };
const ANSWER: WirePromptResult = { messages: [{ role: 'user', content: { type: 'text', text: '  words\n' } }] };

async function setup(answer: () => Promise<WirePromptResult> = async () => ANSWER, approve = true) {
  const script: MockMcpScript = { ...echoScript(storyTools()), prompts: [PROMPT] };
  const wire = createMockWire(script);
  wire.getPrompt = answer;
  const client = createMcpClient({ settings: { enabled: true, servers: [serverFor(STORY_KEY, 'Story Bible')] }, wire: () => wire });
  await client.connect(STORY_KEY);
  if (approve) await client.approveReview(STORY_KEY, client.review(STORY_KEY)?.fingerprint ?? '');
  return { client, script, wire, transport: createMcpTransport(client) };
}

async function sdkSetup() {
  const state = { prompts: [PROMPT], changeDuringGet: false };
  const methods: string[] = [];
  const fetch: WireDeps['fetch'] = async (_input, init) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as { id: string | number; method: string };
    methods.push(request.method);
    let result: object;
    if (request.method === 'server/discover') {
      result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, prompts: {} } };
    } else if (request.method === 'tools/list') result = { tools: storyTools() };
    else if (request.method === 'prompts/list') result = { prompts: state.prompts };
    else if (request.method === 'prompts/get') {
      if (state.changeDuringGet) state.prompts = [{ ...PROMPT, description: 'changed' }];
      result = ANSWER;
    } else throw new Error(`unexpected request ${request.method}`);
    return new Response(JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: { ...result, resultType: 'complete', ttlMs: 60_000, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'prompt-fixture', version: '1' } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createMcpClient({ settings: { enabled: true, servers: [serverFor(STORY_KEY)] }, fetch, probe: async () => false });
  await client.connect(STORY_KEY);
  expect((await client.approveReview(STORY_KEY, client.review(STORY_KEY)?.fingerprint ?? '')).ok).toBe(true);
  return { client, state, methods, transport: createMcpTransport(client) };
}

describe('prompt pin checks through the real SDK with a positive server TTL', () => {
  it.each(['before', 'during'] as const)('refuses an advertised definition changed %s getPrompt', async (when) => {
    const { client, state, methods, transport } = await sdkSetup();
    try {
      if (when === 'before') state.prompts = [{ ...PROMPT, description: 'changed' }];
      else state.changeDuringGet = true;
      await expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).rejects.toMatchObject({ error: { code: 'pin_mismatch' } });
      expect(methods.filter((method) => method === 'prompts/list')).toHaveLength(when === 'before' ? 2 : 3);
      expect(methods.filter((method) => method === 'prompts/get')).toHaveLength(when === 'before' ? 0 : 1);
    } finally {
      await client.close();
    }
  });

  it('keeps picker TTL caching but revalidates a transport read on both sides', async () => {
    const { client, methods, transport } = await sdkSetup();
    try {
      await client.refreshCatalog(STORY_KEY);
      await client.refreshCatalog(STORY_KEY);
      expect(methods.filter((method) => method === 'prompts/list')).toHaveLength(1);
      await expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).resolves.toEqual(ANSWER);
      expect(methods.filter((method) => method === 'prompts/list')).toHaveLength(3);
      expect(methods.filter((method) => method === 'tools/list')).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});

describe('reviewed prompt transport', () => {
  it('preserves roles and text exactly', async () => {
    const { transport, wire } = await setup();
    const listPrompts = vi.spyOn(wire, 'listPrompts');
    const listTools = vi.spyOn(wire, 'listTools');
    const getPrompt = vi.spyOn(wire, 'getPrompt');
    await expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).resolves.toEqual(ANSWER);
    expect(listPrompts).toHaveBeenCalledTimes(2);
    expect(listPrompts.mock.invocationCallOrder[0]).toBeLessThan(getPrompt.mock.invocationCallOrder[0]!);
    expect(listPrompts.mock.invocationCallOrder[1]).toBeGreaterThan(getPrompt.mock.invocationCallOrder[0]!);
    expect(listTools).not.toHaveBeenCalled();
  });

  it('refuses new and changed prompts', async () => {
    const fresh = await setup(undefined, false);
    await expect(fresh.transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).rejects.toMatchObject({ error: { code: 'pin_mismatch' } });
    const opened = await setup();
    opened.script.prompts = [{ ...PROMPT, description: 'changed' }];
    await opened.client.refreshCatalog(STORY_KEY);
    await expect(opened.transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).rejects.toMatchObject({ error: { code: 'pin_mismatch' } });
  });

  it.each(['changed', 'removed', 'unavailable'] as const)('refuses a prompt %s before the read without a picker refresh', async (change) => {
    const getPrompt = vi.fn(async () => ANSWER);
    const { script, transport } = await setup(getPrompt);
    if (change === 'changed') script.prompts = [{ ...PROMPT, description: 'changed' }];
    else if (change === 'removed') script.prompts = [];
    else script.fail = (phase) => { if (phase === 'prompts') throw new WireError('network', 'unavailable'); };

    await expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).rejects.toMatchObject({ error: { code: 'pin_mismatch' } });
    expect(getPrompt).not.toHaveBeenCalled();
  });

  it.each(['changed', 'removed', 'unavailable'] as const)('refuses an answer when the prompt is %s during getPrompt without a picker refresh', async (change) => {
    const { script, transport } = await setup(async () => {
      if (change === 'changed') script.prompts = [{ ...PROMPT, description: 'changed' }];
      else if (change === 'removed') script.prompts = [];
      else script.fail = (phase) => { if (phase === 'prompts') throw new WireError('network', 'unavailable'); };
      return ANSWER;
    });

    await expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).rejects.toMatchObject({ error: { code: 'pin_mismatch' } });
  });

  it.each(['catalogue', 'tools'] as const)('waits for an older %s listing and lists again before getPrompt', async (listing) => {
    const getPrompt = vi.fn(async () => ANSWER);
    const { client, script, wire, transport } = await setup(getPrompt);
    let started!: () => void;
    const listingStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const listPrompts = wire.listPrompts;
    let hold = true;
    wire.listPrompts = async (options) => {
      const prompts = await listPrompts(options);
      if (hold) {
        hold = false;
        started();
        await held;
      }
      return prompts;
    };
    const older = listing === 'catalogue' ? client.refreshCatalog(STORY_KEY) : client.refresh(STORY_KEY);
    await listingStarted;
    const refused = expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).rejects.toMatchObject({ error: { code: 'pin_mismatch' } });
    script.prompts = [{ ...PROMPT, description: 'changed after the older listing started' }];
    release();
    await older;
    await refused;
    expect(getPrompt).not.toHaveBeenCalled();
  });

  it('keeps reviewed pins and tool health when a prompt listing fails', async () => {
    const { client, script, transport } = await setup();
    const pins = client.settings().servers[0]?.pinnedPrompts;
    script.fail = (phase) => { if (phase === 'prompts') throw new WireError('network', 'unavailable'); };

    await expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).rejects.toMatchObject({ error: { code: 'pin_mismatch' } });
    expect(client.catalogStatus(STORY_KEY).promptsUnavailable).toBeDefined();
    expect(client.healthOf(STORY_KEY)?.state).toBe('healthy');
    expect(client.settings().servers[0]?.pinnedPrompts).toEqual(pins);
  });

  it.each(['configuration', 'connection', 'replacement', 'review'] as const)('does not rebind pending prompt arguments when %s changes during preflight', async (change) => {
    const script: MockMcpScript = { ...echoScript(storyTools()), prompts: [PROMPT] };
    const original = createMockWire(script);
    const replacement = createMockWire(script);
    const originalRead = vi.spyOn(original, 'getPrompt').mockResolvedValue(ANSWER);
    const replacementRead = vi.spyOn(replacement, 'getPrompt').mockResolvedValue(ANSWER);
    let current = original;
    const client = createMcpClient({ settings: { enabled: true, servers: [serverFor(STORY_KEY)] }, wire: () => current });
    await client.connect(STORY_KEY);
    expect((await client.approveReview(STORY_KEY, client.review(STORY_KEY)!.fingerprint)).ok).toBe(true);
    let started!: () => void;
    const listingStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const listPrompts = original.listPrompts;
    let hold = true;
    original.listPrompts = async (options) => {
      const prompts = await listPrompts(options);
      if (hold) {
        hold = false;
        started();
        await pending;
      }
      return prompts;
    };
    const read = createMcpTransport(client).readPrompt(STORY_KEY, 'recap', { chapter: 'private pending arguments' });
    await listingStarted;
    if (change === 'configuration') await client.updateServer(STORY_KEY, { name: 'Renamed source' });
    else if (change === 'review') {
      script.prompts = [{ ...PROMPT, description: 'Newly reviewed definition' }];
      await client.disconnect(STORY_KEY);
      await client.connect(STORY_KEY);
    } else {
      if (change === 'replacement') {
        current = replacement;
        await client.updateServer(STORY_KEY, { url: 'https://replacement.example/mcp' });
      } else await client.disconnect(STORY_KEY);
      await client.connect(STORY_KEY);
    }
    expect((await client.approveReview(STORY_KEY, client.review(STORY_KEY)!.fingerprint)).ok).toBe(true);
    const refused = expect(read).rejects.toMatchObject({ error: { code: 'pin_mismatch' } });
    release();
    await refused;
    expect(originalRead).not.toHaveBeenCalled();
    expect(replacementRead).not.toHaveBeenCalled();
    await client.close();
  });

  it('does not refuse a reviewed prompt when only the resource listing fails', async () => {
    const { script, transport } = await setup();
    script.resources = [];
    script.fail = (phase) => { if (phase === 'resources') throw new WireError('network', 'unavailable'); };

    await expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).resolves.toEqual(ANSWER);
  });

  it.each(['before', 'during', 'after'] as const)('refuses an aborted read %s getPrompt', async (when) => {
    const controller = new AbortController();
    const getPrompt = vi.fn(async () => {
      if (when === 'during') controller.abort();
      return ANSWER;
    });
    const { script, transport, wire } = await setup(getPrompt);
    const listPrompts = vi.spyOn(wire, 'listPrompts');
    if (when === 'before') controller.abort();
    if (when === 'after') {
      let listings = 0;
      script.record = ({ phase }) => { if (phase === 'prompts' && ++listings === 2) controller.abort(); };
    }

    await expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' }, { signal: controller.signal })).rejects.toMatchObject({ error: { code: 'timeout' } });
    if (when === 'before') {
      expect(getPrompt).not.toHaveBeenCalled();
      expect(listPrompts).not.toHaveBeenCalled();
    }
    else expect(wire.getPrompt).toHaveBeenCalledWith('recap', { chapter: 'one' }, expect.objectContaining({ signal: controller.signal }));
  });

  it('refuses missing, undeclared and non-string arguments', async () => {
    const { transport } = await setup();
    for (const args of [{}, { chapter: '  \n' }, { chapter: 'one', extra: 'x' }, { chapter: 3 }]) {
      await expect(transport.readPrompt(STORY_KEY, 'recap', args as Record<string, string>)).rejects.toMatchObject({ error: { code: 'schema' } });
    }
  });

  it('refuses non-text blocks and over-cap answers', async () => {
    for (const content of [{ type: 'image', data: 'x' }, { type: 'text', text: 'x'.repeat(32_001) }]) {
      const { transport } = await setup(async () => ({ messages: [{ role: 'user', content }] }));
      await expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).rejects.toMatchObject({ error: { code: 'server_error' } });
    }
  });

  it('refuses oversized descriptions and malformed messages or roles', async () => {
    const answers: unknown[] = [
      { ...ANSWER, description: 'x'.repeat(32_001) },
      { messages: 'not an array' },
      { messages: [{ role: 'system', content: { type: 'text', text: 'hello' } }] },
      { messages: [null] },
      { ...ANSWER, description: 3 },
    ];
    for (const answer of answers) {
      const { transport } = await setup(async () => answer as WirePromptResult);
      await expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).rejects.toMatchObject({ error: { code: 'server_error' } });
    }
  });

  it.each(['review', 'disabled', 'server-disabled', 'disconnected', 'configuration'] as const)('refuses an answer when %s changes during the read', async (change) => {
    let finish!: (result: WirePromptResult) => void;
    const pending = new Promise<WirePromptResult>((resolve) => { finish = resolve; });
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const { client, script, transport } = await setup(() => { started(); return pending; });
    const read = transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' });
    await reading;
    if (change === 'review') {
      script.prompts = [{ ...PROMPT, description: 'changed' }];
      await client.refreshCatalog(STORY_KEY);
      await client.approveReview(STORY_KEY, client.review(STORY_KEY)?.fingerprint ?? '');
    } else if (change === 'disabled') {
      await client.setMasterEnabled(false);
    } else if (change === 'server-disabled') await client.updateServer(STORY_KEY, { enabled: false });
    else if (change === 'disconnected') await client.disconnect(STORY_KEY);
    else await client.updateServer(STORY_KEY, { name: 'Changed name' });
    finish(ANSWER);
    await expect(read).rejects.toBeDefined();
  });

  it('maps wire failures', async () => {
    const { transport } = await setup(async () => { throw new WireError('input-required', 'input needed'); });
    await expect(transport.readPrompt(STORY_KEY, 'recap', { chapter: 'one' })).rejects.toMatchObject({ error: { code: 'input_required' } });
  });
});
