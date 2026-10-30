/**
 * Prompt caching (provider-gateway §3, issue #86) and the usage breakdown it needs (issue #78, step 2).
 *
 * The request marks where its reusable prefix ends with `parts[].cacheBoundary`; each adapter maps that to its provider's own
 * mechanism, and a row that does not cache sends the body it sent before caching existed, byte for byte.
 */

import { describe, expect, it } from 'vitest';

import { anthropicMessagesAdapter } from '../src/adapters/anthropic-messages.js';
import { cacheSettingsFor, fnv1a64, type CacheSettings } from '../src/adapters/cache.js';
import { openaiChatAdapter } from '../src/adapters/openai-chat.js';
import { openaiResponsesAdapter } from '../src/adapters/openai-responses.js';
import type { AdapterContext, ProviderAdapter, StreamPiece } from '../src/adapters/types.js';
import { resolveRoute } from '../src/presets/index.js';
import { createSseParser } from '../src/sse.js';
import type { ChatMessage, ChatRequest, ModelCaps, ToolDef, Usage } from '../src/types.js';
import { addEndpoint, bodyInput, collect, harness, sseResponse } from './helpers.js';

const LONG = 'Stable system text for the planner. '.repeat(200);
const PROJECT = 'Title: Harbor Notes. '.repeat(120);

const TOOLS: ToolDef[] = [
  { name: 'doc.read', description: 'Read a document.', parameters: { type: 'object', properties: { doc: { type: 'string' } } } },
  { name: 'scene.draft', description: 'Draft a scene.'.repeat(200), parameters: { type: 'object', properties: {} } },
];

/** A planner-shaped request: a system message, then one user message split into stable parts and a volatile tail. */
function plannerRequest(over: Partial<ChatRequest> = {}): ChatRequest {
  const parts = [{ text: `# Project\n${PROJECT}`, cacheBoundary: true }, { text: '# Task\nSummarise.' }, { text: '# Status\nWords: 930.' }];
  const user: ChatMessage = { role: 'user', content: parts.map((part) => part.text).join('\n\n'), parts };
  return { messages: [{ role: 'system', content: LONG }, user], tools: TOOLS, ...over };
}

const ctxFor = (preset: string, model: string): AdapterContext => {
  const spec = resolveRoute({ preset, baseUrl: 'https://x.example/v1' }, model);
  return { baseUrl: 'https://x.example/v1', model, quirks: spec.quirks, caps: spec.caps };
};

const cacheOf = (caps: ModelCaps, ttl: '5m' | '1h' = '5m', req: ChatRequest = plannerRequest()): CacheSettings => {
  const settings = cacheSettingsFor({ mode: 'auto', ttl }, caps, 'profile-1', req);
  if (settings === undefined) throw new Error('the row does not cache');
  return settings;
};

const build = (adapter: ProviderAdapter, req: ChatRequest, ctx: AdapterContext, cache?: CacheSettings): Record<string, unknown> => ({
  ...adapter.buildBody({ ...bodyInput(req, ctx), ...(cache === undefined ? {} : { cache }) }),
});

/** Every `cache_control` in a body, wherever it sits. */
function controls(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(controls);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  return [...(record.cache_control === undefined ? [] : [record.cache_control]), ...Object.values(record).flatMap(controls)];
}

function parse(adapter: ProviderAdapter, ctx: AdapterContext, frames: readonly unknown[]): StreamPiece[] {
  const sse = createSseParser();
  const parser = adapter.createStreamParser(ctx);
  const text = frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
  return [...sse.push(text), ...sse.end()].flatMap((event) => parser.push(event));
}

const usageIn = (pieces: readonly StreamPiece[]): Usage | undefined => pieces.filter((piece) => piece.usage !== undefined).at(-1)?.usage;

describe('Anthropic: cache_control breakpoints', () => {
  const ctx = ctxFor('anthropic', 'claude-sonnet-5-5');

  it('marks the last tool, the system block and the boundary part, adds the top-level breakpoint, and never more than four', () => {
    const body = build(anthropicMessagesAdapter, plannerRequest(), ctx, cacheOf(ctx.caps));
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system).toEqual([{ type: 'text', text: LONG, cache_control: { type: 'ephemeral' } }]);
    const [user] = body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(user?.content.map((block) => block.cache_control)).toEqual([{ type: 'ephemeral' }, undefined, undefined]);
    expect(user?.content.map((block) => block.text).join('\n\n')).toBe(plannerRequest().messages[1]?.content);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(controls(body)).toHaveLength(4);
  });

  it('writes the hour-long lifetime on every breakpoint, so no shorter one comes first', () => {
    const body = build(anthropicMessagesAdapter, plannerRequest(), ctx, cacheOf(ctx.caps, '1h'));
    expect(controls(body)).toEqual(Array.from({ length: 4 }, () => ({ type: 'ephemeral', ttl: '1h' })));
  });

  it('leaves out a block breakpoint whose prefix is under the row minimum, and keeps the top-level one', () => {
    const short: ChatRequest = {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'a\n\nb', parts: [{ text: 'a', cacheBoundary: true }, { text: 'b' }] },
      ],
    };
    const body = build(anthropicMessagesAdapter, short, ctx, cacheOf(ctx.caps, '5m', short));
    expect(body.system).toEqual([{ type: 'text', text: 'Be brief.' }]);
    expect(controls(body)).toEqual([{ type: 'ephemeral' }]);
  });

  it('sends no cache field on a row that does not cache explicitly', () => {
    const plain = build(anthropicMessagesAdapter, plannerRequest(), ctx);
    expect(controls(plain)).toEqual([]);
    expect(plain.system).toBe(LONG);
    expect((plain.messages as { content: unknown }[])[0]?.content).toBe(plannerRequest().messages[1]?.content);
  });

  it('adds cache reads and writes back into the prompt count', () => {
    const pieces = parse(anthropicMessagesAdapter, ctx, [
      { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 1800, cache_creation_input_tokens: 248, output_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 503 } },
      { type: 'message_stop' },
    ]);
    expect(usageIn(pieces)).toEqual({ promptTokens: 2098, completionTokens: 503, cachedPromptTokens: 1800, cacheWritePromptTokens: 248 });
  });
});

describe('OpenAI Responses: breakpoints and the routing key', () => {
  it('on an explicit row, sends the system text as a developer message and marks it and the boundary part', () => {
    const ctx = ctxFor('openai', 'gpt-6-sol');
    const req = plannerRequest({ responseFormat: { jsonSchemaHint: { type: 'object' } } });
    const body = build(openaiResponsesAdapter, req, ctx, cacheOf(ctx.caps, '5m', req));
    expect(body.instructions).toBeUndefined();
    expect(body.prompt_cache_key).toBeUndefined();
    const input = body.input as { role: string; content: Record<string, unknown>[] }[];
    expect(input.map((item) => item.role)).toEqual(['developer', 'developer', 'user']);
    expect(input[0]?.content).toEqual([{ type: 'input_text', text: LONG, prompt_cache_breakpoint: { mode: 'explicit' } }]);
    // The schema hint follows the system text, so a structured and a plain call of one kind share the system prefix.
    expect(input[1]?.content[0]?.text).toMatch(/^Respond with JSON matching/);
    expect(input[2]?.content.map((part) => part.prompt_cache_breakpoint)).toEqual([{ mode: 'explicit' }, undefined, undefined]);
  });

  it('on a row before GPT-5.6, sends a stable prompt_cache_key that names no project, and the hint after the system text', () => {
    const ctx = ctxFor('openai', 'gpt-5.5');
    const req = plannerRequest({ responseFormat: { jsonSchemaHint: { type: 'object' } } });
    const one = build(openaiResponsesAdapter, req, ctx, cacheOf(ctx.caps, '5m', req));
    const two = build(openaiResponsesAdapter, req, ctx, cacheOf(ctx.caps, '5m', req));
    expect(one.prompt_cache_key).toMatch(/^caotang-[0-9a-f]{16}$/);
    expect(one.prompt_cache_key).toBe(two.prompt_cache_key);
    expect(String(one.prompt_cache_key)).not.toContain('Harbor');
    expect(String(one.instructions)).toMatch(/^Stable system text[\s\S]*Respond with JSON matching/);
    expect(one.prompt_cache_retention).toBeUndefined();
    expect(JSON.stringify(one)).not.toContain('prompt_cache_breakpoint');
  });

  it('reads cached and written tokens and reasoning from the usage details', () => {
    const ctx = ctxFor('openai', 'gpt-6-sol');
    const pieces = parse(openaiResponsesAdapter, ctx, [
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 15000, output_tokens: 300, input_tokens_details: { cached_tokens: 12000, cache_write_tokens: 3000 }, output_tokens_details: { reasoning_tokens: 120 } } },
      },
    ]);
    expect(usageIn(pieces)).toEqual({ promptTokens: 15000, completionTokens: 300, cachedPromptTokens: 12000, cacheWritePromptTokens: 3000, reasoningTokens: 120 });
  });
});

describe('Chat Completions usage breakdown', () => {
  const ctx: AdapterContext = { baseUrl: 'https://x.example/v1', model: 'm', quirks: {}, caps: {} };

  it('reads OpenAI details and DeepSeek hit counts, and drops a figure larger than its total', () => {
    const openai = parse(openaiChatAdapter, ctx, [
      { choices: [], usage: { prompt_tokens: 2000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 1920 }, completion_tokens_details: { reasoning_tokens: 10 } } },
    ]);
    expect(usageIn(openai)).toEqual({ promptTokens: 2000, completionTokens: 50, cachedPromptTokens: 1920, reasoningTokens: 10 });
    const deepseek = parse(openaiChatAdapter, ctx, [{ choices: [], usage: { prompt_tokens: 900, completion_tokens: 5, prompt_cache_hit_tokens: 768 } }]);
    expect(usageIn(deepseek)).toEqual({ promptTokens: 900, completionTokens: 5, cachedPromptTokens: 768 });
    const odd = parse(openaiChatAdapter, ctx, [{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 99 } } }]);
    expect(usageIn(odd)).toEqual({ promptTokens: 10, completionTokens: 5 });
  });
});

describe('the gateway: policy, rows that do not cache, and the forecast terms', () => {
  const ok = () =>
    sseResponse([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']);

  it('sends a body byte-identical to an unsplit request on a row with no cache field (a generic endpoint)', async () => {
    const h = harness();
    await addEndpoint(h);
    h.net.push(ok, ok);
    const split = plannerRequest({ tools: undefined });
    const joined: ChatRequest = { messages: split.messages.map((m) => ({ role: m.role, content: m.content })) };
    await collect(h.gateway.complete(split));
    await collect(h.gateway.complete(joined));
    const [first, second] = h.net.calls.map((call) => call.init.body);
    expect(first).toBe(second);
    expect(first).not.toMatch(/cache/);
  });

  it('places breakpoints on an Anthropic profile, and none when its caching is off', async () => {
    const anthropic = () =>
      sseResponse([{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]);
    const h = harness();
    const on = await addEndpoint(h, { preset: 'anthropic', baseUrl: undefined, defaultModel: 'claude-sonnet-5-5' });
    const off = await addEndpoint(h, { preset: 'anthropic', baseUrl: undefined, defaultModel: 'claude-sonnet-5-5', name: 'Off', promptCache: { mode: 'off' } });
    h.net.push(anthropic, anthropic);
    await collect(h.gateway.complete({ ...plannerRequest(), profileId: on.id }));
    await collect(h.gateway.complete({ ...plannerRequest(), profileId: off.id }));
    const [cached, plain] = [h.net.bodyOf(0), h.net.bodyOf(1)];
    expect(controls(cached)).toHaveLength(4);
    expect(controls(plain)).toEqual([]);
    expect(h.gateway.modelLimits(on.id).cache).toEqual({ readMultiplier: 0.05, writeMultiplier: 1.25, minTokens: 512 });
    expect(h.gateway.modelLimits(off.id).cache).toBeUndefined();
  });

  it('a request may turn caching off for itself, and the hour-long lifetime is priced at twice the prompt', async () => {
    const h = harness();
    const profile = await addEndpoint(h, { preset: 'anthropic', baseUrl: undefined, defaultModel: 'claude-sonnet-5-5', promptCache: { mode: 'auto', ttl: '1h' } });
    expect(h.gateway.modelLimits(profile.id).cache?.writeMultiplier).toBe(2);
    h.net.push(() => sseResponse([{ type: 'message_stop' }]));
    await collect(h.gateway.complete({ ...plannerRequest(), cache: { mode: 'off' } }));
    expect(String(h.net.calls[0]?.init.body)).not.toContain('cache_control');
  });
});

describe('profiles keep their caching policy', () => {
  it('stores, updates and refuses a policy', async () => {
    const h = harness();
    const made = await addEndpoint(h, { promptCache: { mode: 'auto', ttl: '1h' } });
    expect(made.promptCache).toEqual({ mode: 'auto', ttl: '1h' });
    const changed = await h.profiles.update(made.id, { promptCache: { mode: 'off' } });
    expect(changed.promptCache).toEqual({ mode: 'off' });
    const kept = await h.profiles.update(made.id, { name: 'Renamed' });
    expect(kept.promptCache).toEqual({ mode: 'off' });
    await expect(addEndpoint(h, { promptCache: { mode: 'auto', ttl: '2h' as '1h' } })).rejects.toThrow(/5 minutes or 1 hour/);
  });

  it('hashes with FNV-1a 64', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
  });
});
