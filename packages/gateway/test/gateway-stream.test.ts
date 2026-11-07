/**
 * The streaming path, end to end through the gateway: the request it sends, the chunks
 * it yields, the terminal chunk that closes every stream, the abort contract (§3), and
 * the egress guard that decides which origin a request may reach.
 */

import { describe, expect, it, vi } from 'vitest';
import { createGateway, EgressDeniedError, ProfileError, estimateTokens } from '../src/index.js';
import { createMockProvider } from '../src/mock/index.js';
import {
  addEndpoint,
  collect,
  delta,
  deltasOf,
  finish,
  flush,
  harness,
  KEY,
  openSse,
  ScriptedFetch,
  sseResponse,
  userMessage,
} from './helpers.js';

describe('complete() — the happy path', () => {
  it('yields each delta as it arrives, then one terminal chunk with the provider usage', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([delta('Hel'), delta('lo'), finish('stop', { prompt_tokens: 7, completion_tokens: 2 }), '[DONE]'])) });
    await addEndpoint(h);

    const { chunks, error } = await collect(h.gateway.complete(userMessage('hi')));
    expect(error).toBeUndefined();
    expect(chunks.map((c) => c.delta).filter(Boolean)).toEqual(['Hel', 'lo']);
    expect(chunks.at(-1)).toEqual({ finishReason: 'stop', usage: { promptTokens: 7, completionTokens: 2 } });
    expect(chunks.filter((c) => c.finishReason !== undefined)).toHaveLength(1);
  });

  it('sends a bearer-authenticated POST to {baseUrl}/chat/completions with the spec body', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])) });
    await addEndpoint(h, { baseUrl: 'https://openrouter.ai/api/v1/', defaultModel: 'openai/gpt-4.1-mini' });

    await collect(h.gateway.complete({ messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }] }));

    const call = h.net.calls[0];
    expect(call?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('manual');
    expect(h.net.headerOf(0, 'authorization')).toBe(`Bearer ${KEY}`);
    expect(h.net.headerOf(0, 'content-type')).toBe('application/json');
    expect(h.net.headerOf(0, 'accept')).toBe('text/event-stream');

    const body = h.net.bodyOf(0);
    expect(body).toMatchObject({
      model: 'openai/gpt-4.1-mini',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 4096,
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(body).not.toHaveProperty('response_format');
    // No built-in sampling default: neither the request nor the profile set a temperature, so none is sent.
    expect(body).not.toHaveProperty('temperature');
  });

  it('lets the request override the model, temperature, output limit, and stop sequences', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])) });
    await addEndpoint(h, { temperature: 0.2, maxOutputTokens: 100 });

    await collect(
      h.gateway.complete({ ...userMessage('x'), model: 'override-model', temperature: 0.9, maxOutputTokens: 50, stop: ['END'] }),
    );

    expect(h.net.bodyOf(0)).toMatchObject({ model: 'override-model', temperature: 0.9, max_tokens: 50, stop: ['END'] });
  });

  it('uses the profile defaults when the request says nothing', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])) });
    await addEndpoint(h, { temperature: 0.2, maxOutputTokens: 100 });

    await collect(h.gateway.complete(userMessage('x')));

    expect(h.net.bodyOf(0)).toMatchObject({ model: 'model-x', temperature: 0.2, max_tokens: 100 });
  });

  it('estimates usage when the provider streams none, and says so by counting what was delivered', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([delta('abcdefgh'), finish('stop'), '[DONE]'])) });
    await addEndpoint(h);
    const request = userMessage('abcdefgh');

    const { chunks } = await collect(h.gateway.complete(request));
    expect(chunks.at(-1)).toEqual({
      finishReason: 'stop',
      usage: { promptTokens: estimateTokens('abcdefgh'), completionTokens: estimateTokens('abcdefgh') },
    });
  });

  it('treats [DONE] without a finish reason as a normal stop', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([delta('ok'), '[DONE]'])) });
    await addEndpoint(h);
    const { chunks } = await collect(h.gateway.complete(userMessage('x')));
    expect(chunks.at(-1)?.finishReason).toBe('stop');
    expect(deltasOf(chunks)).toBe('ok');
  });

  it('maps a length finish to length, and passes the partial answer through as a normal stream', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([delta('cut'), finish('length'), '[DONE]'])) });
    await addEndpoint(h);
    const { chunks, error } = await collect(h.gateway.complete(userMessage('x')));
    expect(error).toBeUndefined();
    expect(chunks.at(-1)?.finishReason).toBe('length');
  });

  it('maps a content-filter finish to error, because the answer was withheld and cannot be vouched for', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('content_filter'), '[DONE]'])) });
    await addEndpoint(h);
    const { chunks } = await collect(h.gateway.complete(userMessage('x')));
    expect(chunks.at(-1)?.finishReason).toBe('error');
  });

  it('reads a stream whose events arrive in pieces across the network', async () => {
    const body = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => body.response) });
    await addEndpoint(h);

    const run = collect(h.gateway.complete(userMessage('x')));
    await flush();
    body.raw('data: {"choices":[{"delta":{"content":"spl');
    body.raw('it"},"finish_reason":null}]}\r\n\r');
    body.raw('\n');
    body.event(finish('stop'));
    body.raw('data: [DONE]\n\n');
    const { chunks } = await run;
    expect(deltasOf(chunks)).toBe('split');
    expect(chunks.at(-1)?.finishReason).toBe('stop');
  });
});

describe('complete() — abort (§3)', () => {
  it('resolves with what arrived and finishReason error, counting only the deltas actually delivered', async () => {
    const body = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => body.response) });
    await addEndpoint(h);
    const controller = new AbortController();
    const iterator = h.gateway.complete(userMessage('go'), controller.signal)[Symbol.asyncIterator]();

    body.event(delta('one '));
    body.event(delta('two '));
    body.event(delta('three '));
    expect((await iterator.next()).value).toEqual({ delta: 'one ' });
    expect((await iterator.next()).value).toEqual({ delta: 'two ' });

    controller.abort();
    const terminal = await iterator.next();
    expect(terminal.done).toBe(false);
    expect(terminal.value).toEqual({
      finishReason: 'error',
      usage: { promptTokens: expect.any(Number), completionTokens: estimateTokens('one two ') },
    });
    expect((await iterator.next()).done).toBe(true);
  });

  it('ends a stream aborted before the response arrives, without throwing and without a fetch retry', async () => {
    const net = new ScriptedFetch().push(() => new Promise<Response>(() => undefined));
    const h = harness({ net });
    await addEndpoint(h);
    const controller = new AbortController();

    const run = collect(h.gateway.complete(userMessage('go'), controller.signal));
    await flush();
    controller.abort();
    const { chunks, error } = await run;

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ finishReason: 'error', usage: { promptTokens: expect.any(Number), completionTokens: 0 } }]);
    expect(net.calls).toHaveLength(1);
  });

  it('ends at once, without throwing, when the signal is already aborted before the call', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => new Promise<Response>(() => undefined)) });
    await addEndpoint(h);
    const controller = new AbortController();
    controller.abort();
    const { chunks, error } = await collect(h.gateway.complete(userMessage('go'), controller.signal));
    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ finishReason: 'error', usage: { promptTokens: expect.any(Number), completionTokens: 0 } }]);
  });
});

describe('complete() — the egress guard (command-bus §4, extensibility §4)', () => {
  it('sends a request for a non-active profile to that profile’s own origin with that profile’s key', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])) });
    await addEndpoint(h, { name: 'active', baseUrl: 'https://a.example/v1' });
    const other = await addEndpoint(h, { name: 'other', baseUrl: 'https://b.example/v1', apiKey: 'sk-other-key-123456' });
    const reveal = vi.spyOn(h.keys, 'revealPayload');

    const { error } = await collect(h.gateway.complete({ ...userMessage('x'), profileId: other.id }));

    expect(error).toBeUndefined();
    expect(h.net.calls).toHaveLength(1);
    expect(h.net.calls[0]?.url).toBe('https://b.example/v1/chat/completions');
    expect(h.net.headerOf(0, 'authorization')).toBe('Bearer sk-other-key-123456');
    // The key that was read is the request's own profile's — never the active one.
    expect(reveal).toHaveBeenCalledWith(other.id);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('allows a request to the active profile’s origin even when a different profile is named, if they share it', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])) });
    await addEndpoint(h, { name: 'active', baseUrl: 'https://a.example/v1' });
    const sibling = await addEndpoint(h, { name: 'sibling', baseUrl: 'https://a.example/v2', apiKey: 'sk-sibling-key-123456' });

    const { error } = await collect(h.gateway.complete({ ...userMessage('x'), profileId: sibling.id }));
    expect(error).toBeUndefined();
    expect(h.net.calls[0]?.url).toBe('https://a.example/v2/chat/completions');
  });

  it('never sends the stored key to a new origin: a save that moves the origin without a key is refused, and requests stay on the old one', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])) });
    const endpoint = await addEndpoint(h, { name: 'active', baseUrl: 'https://a.example/v1' });

    await expect(h.profiles.update(endpoint.id, { baseUrl: 'https://attacker.example/v1' })).rejects.toBeInstanceOf(ProfileError);

    const { error } = await collect(h.gateway.complete(userMessage('x')));
    expect(error).toBeUndefined();
    expect(h.net.calls).toHaveLength(1);
    expect(h.net.calls[0]?.url).toBe('https://a.example/v1/chat/completions');
    expect(h.net.headerOf(0, 'authorization')).toBe(`Bearer ${KEY}`);
  });

  it('pins each request to its resolved profile’s origin, so a non-active endpoint still answers on its own endpoint while the mock is active', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([delta('ok'), finish('stop'), '[DONE]'])) });
    await h.profiles.create({ name: 'Offline', kind: 'mock' });
    const endpoint = await addEndpoint(h, { name: 'remote', baseUrl: 'https://a.example/v1' });

    const { error } = await collect(h.gateway.complete({ ...userMessage('x'), profileId: endpoint.id }));
    expect(error).toBeUndefined();
    expect(h.net.calls).toHaveLength(1);
    expect(h.net.calls[0]?.url).toBe('https://a.example/v1/chat/completions');
    expect(h.net.headerOf(0, 'authorization')).toBe(`Bearer ${KEY}`);
  });

  it('refuses a redirect instead of following it, so a POST body is never sent to the new location', async () => {
    const h = harness({
      net: new ScriptedFetch().push(() => new Response(null, { status: 307, headers: { location: 'https://evil.example/collect' } })),
    });
    await addEndpoint(h);

    const { error } = await collect(h.gateway.complete(userMessage('manuscript text')));
    expect(error).toBeInstanceOf(EgressDeniedError);
    expect((error as Error).message).toMatch(/does not follow redirects/);
    expect(h.net.calls).toHaveLength(1);
    expect(h.net.calls[0]?.url).toBe('https://a.example/v1/chat/completions');
  });
});

describe('complete() — profile resolution', () => {
  it('fails clearly when no profile is active, instead of guessing', async () => {
    const h = harness();
    const { error } = await collect(h.gateway.complete(userMessage('x')));
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as ProfileError).code).toBe('no-active');
  });

  it('fails clearly for a profile id that does not exist', async () => {
    const h = harness();
    await addEndpoint(h);
    const { error } = await collect(h.gateway.complete({ ...userMessage('x'), profileId: 'prv_ZZZZZZZZZZ' }));
    expect((error as ProfileError).code).toBe('not-found');
  });

  it('reports a stored key that cannot be read, rather than sending the request without one', async () => {
    const h = harness({ net: new ScriptedFetch() });
    await addEndpoint(h);
    vi.spyOn(h.keys, 'revealPayload').mockResolvedValue(undefined);

    const { error } = await collect(h.gateway.complete(userMessage('x')));
    expect((error as ProfileError).code).toBe('key-unreadable');
    expect(h.net.calls).toHaveLength(0);
  });
});

describe('complete() — the mock profile', () => {
  it('answers from the script with no network at all', async () => {
    const h = harness();
    await h.profiles.create({ name: 'Offline', kind: 'mock' });

    const { chunks, error } = await collect(h.gateway.complete(userMessage('hello caotang')));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('hello caotang');
    expect(chunks.at(-1)?.finishReason).toBe('stop');
    expect(h.net.calls).toHaveLength(0);
  });

  it('routes through an injected mock when one is supplied', async () => {
    const mock = createMockProvider();
    const h = harness();
    const gateway = createGateway({
      profiles: h.profiles,
      keys: h.keys,
      clock: h.clock,
      mock,
      fetch: h.net.fn,
    });
    await h.profiles.create({ name: 'Offline', kind: 'mock' });
    await collect(gateway.complete(userMessage('seen by the mock')));
    expect(mock.calls.at(-1)?.messages[0]?.content).toBe('seen by the mock');
  });
});
