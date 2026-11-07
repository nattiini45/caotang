/**
 * Request parameters (provider-gateway §2, "Request parameters"): what the model rows say each model takes, and what a profile's
 * own `params` change about the body. No sampling default is sent; a temperature goes out only when the request or the profile
 * sets one and the caps allow it. The OpenAI rows carry what the live API was seen to accept on 2026-11-07.
 */

import { describe, expect, it } from 'vitest';
import { ProfileError, resolveRoute } from '../src/index.js';
import type { NewProfile, RequestParams, ThinkingLevel, ToolDef } from '../src/types.js';
import { addEndpoint, collect, finish, harness, KEY, ScriptedFetch, sseResponse, userMessage } from './helpers.js';

const TOOL: ToolDef = {
  name: 'doc.read',
  description: 'Read a document',
  parameters: { type: 'object', properties: { doc: { type: 'string' }, selection: { type: 'object' } }, required: ['doc'] },
};

/** Sends one request through a fresh gateway and returns the body that went on the wire. */
async function bodyFor(profile: Partial<NewProfile>, req: Parameters<ReturnType<typeof harness>['gateway']['complete']>[0]) {
  const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])) });
  await addEndpoint(h, profile);
  await collect(h.gateway.complete(req));
  return { body: h.net.bodyOf(0) as Record<string, unknown>, url: h.net.calls[0]?.url, h };
}

const OPENAI: Partial<NewProfile> = { preset: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6.1-sol' };
const GENERIC: Partial<NewProfile> = { preset: 'generic', baseUrl: 'https://llm.example/v1', defaultModel: 'my-model' };

describe('the OpenAI rows on the Responses route', () => {
  it('never sends temperature or top_p, even when a caller asks for temperature 0', async () => {
    const { body, url } = await bodyFor({ ...OPENAI, temperature: 0.4 }, { ...userMessage('hi'), temperature: 0 });
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
  });

  it('declares every function tool with strict: false, so optional parameters stay optional', async () => {
    const { body } = await bodyFor(OPENAI, { ...userMessage('hi'), tools: [TOOL] });
    const tools = body.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: 'function', strict: false, parameters: TOOL.parameters });
  });

  it.each<[string, ThinkingLevel, string | undefined]>([
    ['gpt-6.1-sol', 'max', 'max'],
    ['gpt-6.1-sol', 'xhigh', 'xhigh'],
    ['gpt-6.1-sol', 'high', 'high'],
    ['gpt-6.1-sol', 'off', undefined], // the row lists no off: nothing is sent
    ['gpt-6-sol', 'off', 'none'],
    ['gpt-6-sol', 'max', 'max'],
    ['gpt-5.5', 'xhigh', 'xhigh'],
    ['gpt-5.5', 'max', undefined], // gpt-5.5 rejects max
  ])('sends %s at %s as %s', async (model, thinking, wire) => {
    const { body } = await bodyFor({ ...OPENAI, defaultModel: model }, { ...userMessage('hi'), thinking });
    if (wire === undefined) expect(body).not.toHaveProperty('reasoning');
    else expect(body.reasoning).toEqual({ effort: wire });
  });

  it('asks for a JSON object as a text format when the caller wants structured output', async () => {
    const { body } = await bodyFor(OPENAI, { ...userMessage('hi'), responseFormat: { jsonSchemaHint: { type: 'object' } } });
    expect(body.text).toEqual({ format: { type: 'json_object' } });
  });

  it('answers the format check from the row without a request', async () => {
    const h = harness();
    await addEndpoint(h, OPENAI);
    expect(await h.gateway.probeResponseFormat()).toBe(true);
    expect(h.net.calls).toHaveLength(0);
    expect(h.profiles.active()?.responseFormat?.supportsJsonObject).toBe(true);
  });

  it('prices gpt-6.1-sol from OpenAI’s list', () => {
    const h = harness();
    return addEndpoint(h, OPENAI).then(() => {
      expect(h.gateway.modelLimits(undefined, 'gpt-6.1-sol').pricePer1k).toEqual({ prompt: 0.002, completion: 0.01 });
    });
  });

  it('lets a profile send a temperature anyway', async () => {
    const { body } = await bodyFor({ ...OPENAI, temperature: 0.3, params: { temperature: true } }, userMessage('hi'));
    expect(body.temperature).toBe(0.3);
  });
});

describe('the Anthropic rows on the Messages route', () => {
  const ANTHROPIC: Partial<NewProfile> = { preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-haiku-5-5' };

  it('denies temperature and sends no tool strict flag', async () => {
    const { body } = await bodyFor({ ...ANTHROPIC, temperature: 0.5 }, { ...userMessage('hi'), temperature: 0, tools: [TOOL] });
    expect(body).not.toHaveProperty('temperature');
    expect((body.tools as Record<string, unknown>[])[0]).not.toHaveProperty('strict');
  });

  it('sends each level as its own effort name', async () => {
    const { body } = await bodyFor(ANTHROPIC, { ...userMessage('hi'), thinking: 'xhigh' });
    expect(body.output_config).toEqual({ effort: 'xhigh' });
  });

  it('sends a profile’s own wire value for a level', async () => {
    const { body } = await bodyFor({ ...ANTHROPIC, params: { effort: { low: 'low', max: 'high' } } }, { ...userMessage('hi'), thinking: 'max' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });
});

describe('a custom OpenAI-compatible endpoint', () => {
  it('sends no temperature unless the request or the profile sets one', async () => {
    expect((await bodyFor(GENERIC, userMessage('hi'))).body).not.toHaveProperty('temperature');
    expect((await bodyFor({ ...GENERIC, temperature: 0.4 }, userMessage('hi'))).body.temperature).toBe(0.4);
    expect((await bodyFor({ ...GENERIC, temperature: 0.4 }, { ...userMessage('hi'), temperature: 0 })).body.temperature).toBe(0);
  });

  it('never sends a temperature when the profile turns it off', async () => {
    const { body } = await bodyFor({ ...GENERIC, temperature: 0.4, params: { temperature: false } }, { ...userMessage('hi'), temperature: 0 });
    expect(body).not.toHaveProperty('temperature');
  });

  it('sends no strict flag by default, and the profile’s when it sets one', async () => {
    const plain = await bodyFor(GENERIC, { ...userMessage('hi'), tools: [TOOL] });
    expect(((plain.body.tools as Record<string, unknown>[])[0]?.function as Record<string, unknown>)).not.toHaveProperty('strict');
    const strict = await bodyFor({ ...GENERIC, params: { toolStrict: false } }, { ...userMessage('hi'), tools: [TOOL] });
    expect(((strict.body.tools as Record<string, unknown>[])[0]?.function as Record<string, unknown>).strict).toBe(false);
  });

  it('offers and sends the thinking levels the profile names, with their wire values', async () => {
    const params: RequestParams = { effort: { low: 'low', high: 'high', max: 'xhigh' } };
    const { body, h } = await bodyFor({ ...GENERIC, params }, { ...userMessage('hi'), thinking: 'max' });
    expect(body.reasoning_effort).toBe('xhigh');
    expect(h.gateway.modelCaps().effortLevels).toEqual(['low', 'high', 'max']);
    // A level the profile does not name is not sent.
    expect((await bodyFor({ ...GENERIC, params }, { ...userMessage('hi'), thinking: 'medium' })).body).not.toHaveProperty('reasoning_effort');
  });

  it('sends no thinking field when the profile names no levels', async () => {
    const { body, h } = await bodyFor({ ...GENERIC, params: { effort: {} } }, { ...userMessage('hi'), thinking: 'high' });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(h.gateway.modelCaps().effortLevels).toEqual([]);
  });

  it('leaves out the extra fields the profile denies', async () => {
    const { body } = await bodyFor({ ...GENERIC, params: { deny: ['stop', 'tools'] } }, { ...userMessage('hi'), stop: ['END'], tools: [TOOL] });
    expect(body).not.toHaveProperty('stop');
    expect(body).not.toHaveProperty('tools');
  });
});

describe('resolveRoute with a profile’s params', () => {
  it('keeps the row when the profile sets nothing', () => {
    const plain = resolveRoute({ preset: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'gpt-6.1-sol');
    expect(plain.caps.denylist).toEqual(['temperature', 'top_p']);
    expect(plain.caps.toolStrict).toBe(false);
  });

  it('moves temperature off and on the denylist and keeps the rest', () => {
    const on = resolveRoute({ preset: 'openai', baseUrl: 'https://api.openai.com/v1', params: { temperature: true, deny: ['stop'] } }, 'gpt-6.1-sol');
    expect(on.caps.denylist).toEqual(['top_p', 'stop']);
    const off = resolveRoute({ preset: 'generic', baseUrl: 'https://x.example/v1', params: { temperature: false } }, 'm');
    expect(off.caps.denylist).toEqual(['temperature']);
  });

  it('gives a custom endpoint the route’s own effort style when it turns thinking on', () => {
    expect(resolveRoute({ preset: 'generic', baseUrl: 'https://x.example/v1', params: { effort: { low: 'low' } } }, 'm').caps.effortStyle).toBe('reasoning_effort');
  });
});

describe('profile params in the store', () => {
  it('stores, shows and clears a profile’s params and temperature', async () => {
    const h = harness();
    const view = await addEndpoint(h, { ...GENERIC, temperature: 0.6, params: { temperature: true, toolStrict: false, effort: { low: 'low', max: ' xhigh ' }, deny: [' top_p ', 'top_p', ''] } });
    expect(view.params).toEqual({ temperature: true, toolStrict: false, effort: { low: 'low', max: 'xhigh' }, deny: ['top_p'] });
    const cleared = await h.profiles.update(view.id, { params: null, temperature: null });
    expect(cleared.params).toBeUndefined();
    expect(cleared.temperature).toBeUndefined();
    // An absent field keeps what is saved.
    const kept = await h.profiles.update(view.id, { params: { toolStrict: true } });
    expect((await h.profiles.update(kept.id, { name: 'renamed' })).params).toEqual({ toolStrict: true });
  });

  it('refuses a level that is not one, a wire value that is not a word, and a field name that is not one', async () => {
    const h = harness();
    const bad = (params: unknown) => h.profiles.create({ name: 'x', kind: 'endpoint', baseUrl: 'https://x.example/v1', apiKey: KEY, defaultModel: 'm', params: params as RequestParams });
    await expect(bad({ effort: { extreme: 'max' } })).rejects.toBeInstanceOf(ProfileError);
    await expect(bad({ effort: { max: 'max", "x": "y' } })).rejects.toMatchObject({ field: 'params' });
    await expect(bad({ deny: ['top p'] })).rejects.toMatchObject({ field: 'params' });
    await expect(bad({ temperature: 'yes' })).rejects.toMatchObject({ field: 'params' });
  });

  it('treats params with nothing set as no override', async () => {
    const h = harness();
    expect((await addEndpoint(h, { params: {} })).params).toBeUndefined();
  });
});
