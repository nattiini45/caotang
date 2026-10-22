/**
 * Structured output (§5) and the model list. The structured path has two layers: the
 * schema always rides in a system message, and `response_format` is added only after a
 * probe has shown the endpoint takes it. Both are asserted at the wire, not in a comment.
 */

import { describe, expect, it } from 'vitest';
import { localDayKey, ProviderError } from '../src/index.js';
import { createMockProvider, MOCK_MODELS } from '../src/mock/index.js';
import { addEndpoint, collect, delta, finish, harness, KEY, ScriptedFetch, sseResponse, userMessage } from './helpers.js';

const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
const structured = { messages: [{ role: 'user' as const, content: 'draft a title' }], responseFormat: { jsonSchemaHint: schema } };

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

describe('structured output — the schema hint (§5)', () => {
  it('appends the schema as the last system message, and sends no response_format before a probe', async () => {
    const net = new ScriptedFetch().push(() => sseResponse([delta('{"title":"x"}'), finish('stop'), '[DONE]']));
    const h = harness({ net });
    await addEndpoint(h);

    await collect(h.gateway.complete(structured));

    const body = net.bodyOf(0);
    expect(body.messages).toEqual([
      { role: 'user', content: 'draft a title' },
      { role: 'system', content: `Respond with JSON matching: ${JSON.stringify(schema)}` },
    ]);
    expect(body).not.toHaveProperty('response_format');
  });

  it('sends no hint for plain text, and none when responseFormat is text', async () => {
    const net = new ScriptedFetch().push(
      () => sseResponse([finish('stop'), '[DONE]']),
      () => sseResponse([finish('stop'), '[DONE]']),
    );
    const h = harness({ net });
    await addEndpoint(h);

    await collect(h.gateway.complete({ ...userMessage('plain'), responseFormat: 'text' }));
    expect(net.bodyOf(0).messages).toEqual([{ role: 'user', content: 'plain' }]);
  });
});

describe('the response_format probe (§5)', () => {
  it('caches a successful probe on the profile, and then sends response_format on structured requests', async () => {
    const net = new ScriptedFetch().push(
      () => jsonResponse(200, { choices: [{ message: { role: 'assistant', content: '{"ok": true}' } }] }),
      () => sseResponse([finish('stop'), '[DONE]']),
    );
    const h = harness({ net });
    const profile = await addEndpoint(h);

    expect(await h.gateway.probeResponseFormat(profile.id)).toBe(true);
    const probe = net.bodyOf(0);
    expect(probe).toMatchObject({ stream: false, response_format: { type: 'json_object' } });
    expect(net.calls[0]?.url).toBe('https://a.example/v1/chat/completions');
    expect(h.profiles.get(profile.id)?.responseFormat?.supportsJsonObject).toBe(true);

    await collect(h.gateway.complete(structured));
    expect(net.bodyOf(1).response_format).toEqual({ type: 'json_object' });
    expect(net.bodyOf(1).messages).toHaveLength(2);
  });

  it('caches a refusal, so the endpoint is never sent a response_format it has said it rejects', async () => {
    const net = new ScriptedFetch().push(
      () => jsonResponse(400, { error: { message: "Unrecognized request argument: response_format" } }),
      () => sseResponse([finish('stop'), '[DONE]']),
    );
    const h = harness({ net });
    const profile = await addEndpoint(h);

    expect(await h.gateway.probeResponseFormat(profile.id)).toBe(false);
    expect(h.profiles.get(profile.id)?.responseFormat?.supportsJsonObject).toBe(false);

    await collect(h.gateway.complete(structured));
    expect(net.bodyOf(1)).not.toHaveProperty('response_format');
    expect((net.bodyOf(1).messages as unknown[]).length).toBe(2);
  });

  it('treats a 400 about something other than the format as a failure to probe, and caches nothing', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => jsonResponse(400, { error: 'model not found' })) });
    const profile = await addEndpoint(h);

    const error = await h.gateway.probeResponseFormat(profile.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(h.profiles.get(profile.id)?.responseFormat).toBeUndefined();
  });

  it('probes the profile it is pointed at, pinned to that profile’s origin and key, whatever is active', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(200, { choices: [{ message: { content: '{"ok":true}' } }] }));
    const h = harness({ net });
    await addEndpoint(h, { name: 'active' });
    const other = await addEndpoint(h, { name: 'other', baseUrl: 'https://b.example/v1', apiKey: 'sk-other-key-123456' });

    expect(await h.gateway.probeResponseFormat(other.id)).toBe(true);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]?.url).toBe('https://b.example/v1/chat/completions');
    expect(net.headerOf(0, 'authorization')).toBe('Bearer sk-other-key-123456');
  });

  it('reports the mock as supporting the format without any network', async () => {
    const h = harness();
    const mock = await h.profiles.create({ name: 'Offline', kind: 'mock' });
    expect(await h.gateway.probeResponseFormat(mock.id)).toBe(true);
    expect(h.profiles.get(mock.id)?.responseFormat?.supportsJsonObject).toBe(true);
  });

  it('forgets the cached probe once the endpoint changes, so the next probe answers for the new one', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(200, {}));
    const h = harness({ net });
    const profile = await addEndpoint(h);
    await h.gateway.probeResponseFormat(profile.id);
    await h.profiles.update(profile.id, { baseUrl: 'https://c.example/v1', apiKey: 'sk-moved-key-123456' });
    expect(h.profiles.get(profile.id)?.responseFormat).toBeUndefined();
  });
});

describe('listModels (§3)', () => {
  it('GETs {baseUrl}/models with the bearer key, and reads ids and context windows', async () => {
    const net = new ScriptedFetch().push(() =>
      jsonResponse(200, { data: [{ id: 'llama-3', context_length: 8192 }, { id: 'tiny' }] }),
    );
    const h = harness({ net });
    const profile = await addEndpoint(h, { baseUrl: 'https://openrouter.ai/api/v1/' });

    const models = await h.gateway.listModels(profile.id);
    expect(models).toEqual([{ id: 'llama-3', contextWindow: 8192 }, { id: 'tiny' }]);
    expect(net.calls[0]?.url).toBe('https://openrouter.ai/api/v1/models');
    expect(net.calls[0]?.init.method).toBe('GET');
    expect(net.headerOf(0, 'authorization')).toBe(`Bearer ${KEY}`);
  });

  it('raises auth for a rejected key, and never retries it', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(401, 'no'));
    const h = harness({ net });
    const profile = await addEndpoint(h);
    const error = await h.gateway.listModels(profile.id).catch((e: unknown) => e);
    expect((error as ProviderError).kind).toBe('auth');
    expect(net.calls).toHaveLength(1);
  });

  it('raises protocol when the answer has no model list', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => jsonResponse(200, { status: 'ok' })) });
    const profile = await addEndpoint(h);
    const error = await h.gateway.listModels(profile.id).catch((e: unknown) => e);
    expect((error as ProviderError).kind).toBe('protocol');
  });

  it('answers for the mock profile from the fixed list, with no network', async () => {
    const h = harness();
    const mock = await h.profiles.create({ name: 'Offline', kind: 'mock' });
    expect(await h.gateway.listModels(mock.id)).toEqual(MOCK_MODELS);
    expect(h.net.calls).toHaveLength(0);
  });

  it('lists a non-active profile’s models on its own endpoint, pinned by the egress guard', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => jsonResponse(200, { data: [{ id: 'm' }] })) });
    await addEndpoint(h, { name: 'active' });
    const other = await addEndpoint(h, { name: 'other', baseUrl: 'https://b.example/v1', apiKey: 'sk-other-key-123456' });
    expect(await h.gateway.listModels(other.id)).toEqual([{ id: 'm' }]);
    expect(h.net.calls[0]?.url).toBe('https://b.example/v1/models');
    expect(h.net.headerOf(0, 'authorization')).toBe('Bearer sk-other-key-123456');
  });
});

describe('the capability row of a mock profile (modelCaps)', () => {
  it('answers a mock profile from the mock itself, so the mock\'s own row is reachable', async () => {
    const h = harness({ mock: createMockProvider({ capsTools: true }) });
    const mock = await h.profiles.create({ name: 'Offline', kind: 'mock' });

    expect(h.gateway.modelCaps(mock.id)).toEqual({ tools: true });
  });

  it('reports the conservative empty row for the shipped mock', async () => {
    const h = harness();
    const mock = await h.profiles.create({ name: 'Offline', kind: 'mock' });

    expect(h.gateway.modelCaps(mock.id)).toEqual({});
  });
});

describe('the mock provider keeps its own ledger (accountTokens hook)', () => {
  it('records the hook call against the mock ledger, dated from its manual clock rather than real time', () => {
    const mock = createMockProvider();
    mock.accountTokens({ promptTokens: 4, completionTokens: 2 }, { profileId: 'mock', model: 'mock/echo-1' });
    expect(mock.ledger.dayRows()).toEqual([
      { date: localDayKey(0), profileId: 'mock', model: 'mock/echo-1', role: 'chat', promptTokens: 4, completionTokens: 2, requests: 1 },
    ]);
  });
});
