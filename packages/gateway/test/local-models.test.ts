/**
 * Local model servers (Ollama, LM Studio, llama.cpp) through the gateway — provider-gateway.md §2, §4, §9. The network is
 * a scripted fetch that throws what a browser throws, and time is the manual clock, so nothing here needs a server.
 */

import { describe, expect, it } from 'vitest';
import { createManualClock, DEFAULT_RETRY, DEFAULT_TIMEOUTS, EgressDeniedError, ProviderError, providerMessages, RequestLog } from '../src/index.js';
import { assertEgress, type TransportDeps } from '../src/transport.js';
import {
  addEndpoint,
  collect,
  delta,
  finish,
  flush,
  harness,
  KEY,
  openSse,
  ScriptedFetch,
  sseResponse,
  START,
  userMessage,
  type Harness,
} from './helpers.js';

/** A local profile on the preset's default address. */
const addLocal = (h: Harness, preset: string, overrides: Record<string, unknown> = {}) =>
  h.profiles.create({ name: `Local ${preset}`, kind: 'endpoint', preset, defaultModel: 'llama3.2', ...overrides });

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What a browser rejects `fetch` with for a CORS refusal, a refused connection and a Local Network Access denial: the same thing. */
const failedToFetch = (): TypeError => new TypeError('Failed to fetch');

/** The answer to the no-CORS reachability request: an opaque response, as a browser gives for a server that answers. */
const opaque = (): Response => new Response(null, { status: 200 });

async function failureOf(h: Harness): Promise<ProviderError> {
  const { error } = await collect(h.gateway.complete(userMessage('x')));
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

describe('the egress pin on an http loopback origin', () => {
  const deps = (origin: string): TransportDeps => ({
    fetch: new ScriptedFetch().fn,
    clock: createManualClock(START),
    random: () => 0.5,
    timeouts: DEFAULT_TIMEOUTS,
    retry: DEFAULT_RETRY,
    log: new RequestLog(),
    profileOrigin: () => origin,
  });

  it('admits the profile’s own origin and refuses every other port, host spelling and scheme', () => {
    const pinned = deps('http://127.0.0.1:11434');
    expect(() => assertEgress(pinned, 'http://127.0.0.1:11434/v1/chat/completions', 'prv_X')).not.toThrow();
    for (const other of [
      'http://127.0.0.1:11435/v1/chat/completions',
      'http://localhost:11434/v1/chat/completions',
      'https://127.0.0.1:11434/v1/chat/completions',
      'http://192.168.1.20:11434/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions',
    ]) {
      expect(() => assertEgress(pinned, other, 'prv_X'), other).toThrow(EgressDeniedError);
    }
  });

  it('sends a local profile’s request to its own address only, with no key header when none was set', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([delta('hi'), finish('stop'), '[DONE]'])) });
    await addEndpoint(h, { name: 'hosted' });
    const local = await addLocal(h, 'ollama');

    const { error } = await collect(h.gateway.complete({ ...userMessage('x'), profileId: local.id }));
    expect(error).toBeUndefined();
    expect(h.net.calls).toHaveLength(1);
    expect(h.net.calls[0]?.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(h.net.headerOf(0, 'authorization')).toBeUndefined();
  });

  it('never carries a hosted profile’s key to a local server: the keys stay on their own profiles', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])) });
    await addEndpoint(h, { name: 'hosted' });
    const local = await addLocal(h, 'lmstudio');

    await collect(h.gateway.complete({ ...userMessage('x'), profileId: local.id }));
    expect(h.net.headerOf(0, 'authorization')).toBeUndefined();
    expect(JSON.stringify(h.net.calls)).not.toContain(KEY);
  });

  it('sends a key the writer set on the server as a bearer token to that server', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])) });
    const local = await addLocal(h, 'lmstudio', { apiKey: 'lm-studio-token-123456' });
    await collect(h.gateway.complete({ ...userMessage('x'), profileId: local.id }));
    expect(h.net.headerOf(0, 'authorization')).toBe('Bearer lm-studio-token-123456');
  });
});

describe('targetAddressSpace — Local Network Access', () => {
  it('declares the loopback address space where the browser supports it, and only on a local profile', async () => {
    const h = harness({
      net: new ScriptedFetch().push(
        () => sseResponse([finish('stop'), '[DONE]']),
        () => sseResponse([finish('stop'), '[DONE]']),
      ),
      supportsAddressSpace: () => true,
    });
    const hosted = await addEndpoint(h, { name: 'hosted' });
    const local = await addLocal(h, 'ollama');

    await collect(h.gateway.complete({ ...userMessage('x'), profileId: local.id }));
    await collect(h.gateway.complete({ ...userMessage('x'), profileId: hosted.id }));
    expect((h.net.calls[0]?.init as { targetAddressSpace?: string }).targetAddressSpace).toBe('loopback');
    expect('targetAddressSpace' in (h.net.calls[1]?.init ?? {})).toBe(false);
  });

  it('leaves the option out where the browser does not take it', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])), supportsAddressSpace: () => false });
    await addLocal(h, 'ollama');
    await collect(h.gateway.complete(userMessage('x')));
    expect('targetAddressSpace' in (h.net.calls[0]?.init ?? {})).toBe(false);
  });
});

describe('a local call that fails names the preset’s own fix', () => {
  const cases: readonly [string, string, string][] = [
    ['ollama', 'Ollama', 'OLLAMA_ORIGINS'],
    ['lmstudio', 'LM Studio', 'Enable CORS'],
    ['llamacpp', 'llama-server', '--cors-origins'],
  ];

  it.each(cases)('%s: a CORS refusal (the server answers a no-CORS request) says %s’s fix', async (preset, product, fix) => {
    const net = new ScriptedFetch().push(
      () => Promise.reject(failedToFetch()),
      () => opaque(),
    );
    const h = harness({ net });
    await addLocal(h, preset);

    const error = await failureOf(h);
    expect(error.kind).toBe('network');
    expect(error.message).toContain(product);
    expect(error.message).toContain(fix);
    // The reachability request carries no headers and no body: nothing of the manuscript or a key rides on it.
    expect(net.calls).toHaveLength(2);
    expect(net.calls[1]?.init).toMatchObject({ method: 'GET', mode: 'no-cors' });
    expect(net.calls[1]?.init.body).toBeUndefined();
    expect(net.calls[1]?.init.headers).toBeUndefined();
    // And it is final: a second try cannot change a browser's CORS answer.
    expect(error.permanent).toBe(true);
  });

  it('says nothing is listening, with the address, when neither the request nor a no-CORS probe gets through', async () => {
    const net = new ScriptedFetch().push(
      () => Promise.reject(failedToFetch()),
      () => Promise.reject(failedToFetch()),
    );
    const h = harness({ net });
    await addLocal(h, 'ollama');

    const error = await failureOf(h);
    expect(error.message).toBe(providerMessages.localRefused('Ollama', '127.0.0.1:11434'));
    expect(error.message).toContain('Is Ollama running?');
    expect(net.calls).toHaveLength(2);
  });

  it('recognises a refused connection by its own words, as Node and desktop shells give them, without the second request', async () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' }),
    });
    const net = new ScriptedFetch().push(() => Promise.reject(refused));
    const h = harness({ net });
    await addLocal(h, 'lmstudio');

    const error = await failureOf(h);
    expect(error.message).toContain('Nothing is listening on 127.0.0.1:1234');
    expect(net.calls).toHaveLength(1);
  });

  it('says the browser blocked access when the loopback permission is denied', async () => {
    const net = new ScriptedFetch().push(
      () => Promise.reject(failedToFetch()),
      () => Promise.reject(failedToFetch()),
    );
    const h = harness({ net, loopbackPermission: async () => 'denied' });
    await addLocal(h, 'ollama');

    const error = await failureOf(h);
    expect(error.message).toBe(providerMessages.localDenied('Ollama'));
    expect(error.message).toMatch(/site settings/);
  });

  it('says the browser blocked access when the rejection itself is a permission denial', async () => {
    const denied = Object.assign(new Error('Permission was denied for this request to access the `loopback` address space.'), {
      name: 'NotAllowedError',
    });
    const net = new ScriptedFetch().push(() => Promise.reject(denied));
    const h = harness({ net });
    await addLocal(h, 'llamacpp');

    expect((await failureOf(h)).message).toBe(providerMessages.localDenied('llama-server'));
    expect(net.calls).toHaveLength(1);
  });

  it('does not retry any of them: a failure is one attempt, not three with a backoff', async () => {
    const net = new ScriptedFetch().push(
      () => Promise.reject(failedToFetch()),
      () => opaque(),
    );
    const h = harness({ net });
    await addLocal(h, 'ollama');
    await failureOf(h);
    expect(h.gateway.requestLog.entries().map((entry) => entry.outcome)).toEqual(['failed']);
  });

  it('leaves a hosted profile’s failure as the generic network message', async () => {
    const net = new ScriptedFetch().push(() => Promise.reject(failedToFetch()));
    const h = harness({ net, retry: { maxRetries: 0 } });
    await addEndpoint(h);

    const error = await failureOf(h);
    expect(error.message).toBe(providerMessages.network('a.example', 'Failed to fetch'));
    expect(net.calls).toHaveLength(1);
  });

  it('keeps an abort as an abort: a cancelled local call is not blamed on CORS', async () => {
    const net = new ScriptedFetch().push(() => new Promise<Response>(() => undefined));
    const h = harness({ net });
    await addLocal(h, 'ollama');
    const controller = new AbortController();
    const run = collect(h.gateway.complete(userMessage('x'), controller.signal));
    await flush();
    controller.abort();
    const { chunks, error } = await run;
    expect(error).toBeUndefined();
    expect(chunks.at(-1)?.finishReason).toBe('error');
  });

  it('reads a 404 about a missing model as the model’s problem, not as a wrong address', async () => {
    const net = new ScriptedFetch().push(() => json(404, { error: { message: 'model "llama3.2" not found, try pulling it first' } }));
    const h = harness({ net });
    await addLocal(h, 'ollama');

    const error = await failureOf(h);
    expect(error.kind).toBe('provider');
    expect(error.message).toContain('not found, try pulling it first');
    expect(error.message).not.toContain('Most OpenAI-compatible bases end in /v1');
  });

  it('keeps the endpoint message for a 404 that is about the address', async () => {
    const net = new ScriptedFetch().push(() => json(404, { error: 'page not found' }));
    const h = harness({ net });
    await addLocal(h, 'ollama');
    expect((await failureOf(h)).kind).toBe('endpoint');
  });
});

describe('the longer deadlines of a local preset', () => {
  async function start(h: Harness): Promise<{ done: () => boolean; result: ReturnType<typeof collect> }> {
    let finished = false;
    const result = collect(h.gateway.complete(userMessage('x'))).finally(() => {
      finished = true;
    });
    await flush();
    return { done: () => finished, result };
  }
  const advance = async (h: Harness, ms: number): Promise<void> => {
    h.clock.advance(ms);
    await flush();
  };

  it('waits 180 s for the first token where a hosted profile gives up at 30 s', async () => {
    const hosted = harness({ net: new ScriptedFetch().push(() => openSse().response), retry: { maxRetries: 0 } });
    await addEndpoint(hosted);
    const local = harness({ net: new ScriptedFetch().push(() => openSse().response), retry: { maxRetries: 0 } });
    await addLocal(local, 'ollama');

    const a = await start(hosted);
    const b = await start(local);
    await advance(hosted, 30_000);
    await advance(local, 30_000);
    expect(a.done()).toBe(true);
    expect((await a.result).error).toMatchObject({ detail: 'no first token within 30s' });
    expect(b.done()).toBe(false);

    await advance(local, 149_999);
    expect(b.done()).toBe(false);
    await advance(local, 1);
    expect((await b.result).error).toMatchObject({ detail: 'no first token within 180s' });
  });

  it('waits 180 s for the headers too, since a model loads before the server answers', async () => {
    const net = new ScriptedFetch().push(() => new Promise<Response>(() => undefined));
    const h = harness({ net, retry: { maxRetries: 0 } });
    await addLocal(h, 'lmstudio');
    const run = await start(h);
    await advance(h, 179_999);
    expect(run.done()).toBe(false);
    await advance(h, 1);
    expect((await run.result).error).toMatchObject({ detail: 'no response within 180s' });
  });

  it('waits 120 s between chunks once output has started', async () => {
    const body = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => body.response), retry: { maxRetries: 0 } });
    await addLocal(h, 'llamacpp');
    const run = await start(h);
    body.event(delta('a'));
    await flush();
    await advance(h, 119_999);
    expect(run.done()).toBe(false);
    await advance(h, 1);
    expect((await run.result).error).toMatchObject({ detail: 'stream idle for 120s' });
  });

  it('lets the gateway’s own settings win over the preset’s', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => openSse().response), retry: { maxRetries: 0 }, timeouts: { firstTokenMs: 5_000 } });
    await addLocal(h, 'ollama');
    const run = await start(h);
    await advance(h, 5_000);
    expect((await run.result).error).toMatchObject({ detail: 'no first token within 5s' });
  });

  it('keeps the global defaults for every other provider', () => {
    expect(DEFAULT_TIMEOUTS).toEqual({ connectMs: 10_000, firstTokenMs: 30_000, idleMs: 60_000, totalMs: 300_000 });
  });
});

describe('the model list of a local server', () => {
  it('is read without a key, on the loopback origin', async () => {
    const net = new ScriptedFetch().push(() => json(200, { data: [{ id: 'llama3.2' }, { id: 'qwen3' }] }));
    const h = harness({ net });
    const local = await addLocal(h, 'ollama');

    const models = await h.gateway.listModels(local.id);
    expect(models.map((m) => m.id)).toEqual(['llama3.2', 'qwen3']);
    expect(net.calls[0]?.url).toBe('http://127.0.0.1:11434/v1/models');
    expect(net.headerOf(0, 'authorization')).toBeUndefined();
  });

  it('names the fix when the listing is blocked, as a chat call is', async () => {
    const net = new ScriptedFetch().push(
      () => Promise.reject(failedToFetch()),
      () => opaque(),
    );
    const h = harness({ net });
    const local = await addLocal(h, 'lmstudio');
    await expect(h.gateway.listModels(local.id)).rejects.toThrow(/Enable CORS/);
  });
});

describe('capabilities and the window of a local server', () => {
  it('claims no native tools and no images, so the agent speaks the JSON-in-text wire', async () => {
    const h = harness();
    const local = await addLocal(h, 'ollama');
    expect(h.gateway.modelCaps(local.id, 'anything-pulled')).toEqual({});
  });

  it('reports a conservative 4,096-token window until the server says otherwise, and the writer’s output cap stays theirs', async () => {
    const h = harness();
    const local = await addLocal(h, 'ollama', { maxOutputTokens: 1_000 });
    expect(h.gateway.modelLimits(local.id)).toMatchObject({ contextWindow: 4_096, maxOutputTokens: 1_000 });
  });

  it('takes the window the server’s own model list reports over the fallback', async () => {
    const net = new ScriptedFetch().push(() => json(200, { data: [{ id: 'llama3.2', context_length: 131_072 }] }));
    const h = harness({ net });
    const local = await addLocal(h, 'ollama');
    await h.gateway.listModels(local.id);
    expect(h.gateway.modelLimits(local.id, 'llama3.2').contextWindow).toBe(131_072);
    expect(h.gateway.modelLimits(local.id, 'unlisted').contextWindow).toBe(4_096);
  });
});
