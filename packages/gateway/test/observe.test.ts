/**
 * The trace observer ([agent-harness §5.2](docs/architecture/agent-harness.md)): the gateway tells one hook about each provider call,
 * with the secrets scrubbed, and a hook that fails changes nothing about the call.
 */

import { describe, expect, it } from 'vitest';
import type { ProviderError} from '../src/index.js';
import { createGateway, type GatewayTraceEvent } from '../src/index.js';
import { addEndpoint, collect, delta, deltasOf, finish, flush, harness, KEY, ScriptedFetch, sseResponse, userMessage, type Harness } from './helpers.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const typesOf = (events: readonly GatewayTraceEvent[]): string[] => events.map((e) => e.type);

function watched(options: Parameters<typeof harness>[0] = {}): { h: Harness; events: GatewayTraceEvent[] } {
  const events: GatewayTraceEvent[] = [];
  return { h: harness({ ...options, observe: (event) => events.push(event) }), events };
}

describe('a mock profile', () => {
  it('reports request, first token, attempt and response, with the usage marked as an estimate', async () => {
    const { h, events } = watched();
    await h.profiles.create({ name: 'Demo', kind: 'mock' });

    const { chunks } = await collect(h.gateway.complete({ ...userMessage('hello'), turnId: 't1', callIndex: 2, role: 'chat' }));

    expect(deltasOf(chunks)).toBe('hello');
    expect(typesOf(events)).toEqual(['request', 'first-token', 'attempt', 'response']);
    const [request, , attempt, response] = events;
    expect(request).toMatchObject({ type: 'request', id: 1, model: expect.any(String), req: { turnId: 't1', callIndex: 2 } });
    expect(attempt).toMatchObject({ type: 'attempt', attempt: 0, outcome: 'ok' });
    expect(response).toMatchObject({ type: 'response', finishReason: 'stop', content: 'hello', usageSource: 'estimate', attempts: 1 });
  });

  it('numbers each call, so the events of two calls can be told apart', async () => {
    const { h, events } = watched();
    await h.profiles.create({ name: 'Demo', kind: 'mock' });
    await collect(h.gateway.complete(userMessage('a')));
    await collect(h.gateway.complete(userMessage('b')));
    expect(events.filter((e) => e.type === 'request').map((e) => e.id)).toEqual([1, 2]);
  });

  it('reports the thinking level a role routed the request to, because the request is told after routing', async () => {
    const events: GatewayTraceEvent[] = [];
    const base = harness();
    const profile = await base.profiles.create({ name: 'Demo', kind: 'mock' });
    const gateway = createGateway({
      profiles: base.profiles,
      keys: base.keys,
      clock: base.clock,
      roles: { resolve: () => ({ profileId: profile.id, thinking: 'high' }), allowed: () => [profile.id] },
      observe: (event) => events.push(event),
    });
    await collect(gateway.complete({ ...userMessage('x'), role: 'background' }));
    expect(events[0]).toMatchObject({ type: 'request', profileId: profile.id, req: { thinking: 'high' } });
  });

  it('reports nothing for a request that never resolved to a profile', async () => {
    const { h, events } = watched();
    await h.profiles.create({ name: 'Demo', kind: 'mock' });
    const { error } = await collect(h.gateway.complete({ ...userMessage('x'), profileId: 'missing' }));
    expect(error).toBeDefined();
    expect(events).toEqual([]);
  });
});

describe('an endpoint profile', () => {
  it('reports each attempt of a retried call, then the response with the provider usage', async () => {
    const net = new ScriptedFetch().push(
      () => jsonResponse(500, 'boom'),
      () => sseResponse([delta('ok'), finish('stop', { prompt_tokens: 11, completion_tokens: 3 }), '[DONE]']),
    );
    const { h, events } = watched({ net });
    await addEndpoint(h);

    const run = collect(h.gateway.complete(userMessage('x')));
    await flush();
    h.clock.advance(1_000);
    await run;

    expect(typesOf(events)).toEqual(['request', 'attempt', 'first-token', 'attempt', 'response']);
    expect(events.filter((e) => e.type === 'attempt')).toMatchObject([
      { attempt: 0, outcome: 'retrying', status: 500, errorKind: 'provider' },
      { attempt: 1, outcome: 'ok', status: 200 },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'response', finishReason: 'stop', content: 'ok', attempts: 2, usageSource: 'provider', usage: { promptTokens: 11, completionTokens: 3 } });
  });

  it('marks the usage as an estimate when the provider reported none', async () => {
    const net = new ScriptedFetch().push(() => sseResponse([delta('abcdefgh'), finish('stop'), '[DONE]']));
    const { h, events } = watched({ net });
    await addEndpoint(h);
    await collect(h.gateway.complete(userMessage('x')));
    expect(events.at(-1)).toMatchObject({ type: 'response', usageSource: 'estimate', usage: { completionTokens: 2 } });
  });

  it('reports a call that failed for good as a response with the error, after its request', async () => {
    const { h, events } = watched({ net: new ScriptedFetch().push(() => jsonResponse(401, 'no')), retry: { maxRetries: 0 } });
    await addEndpoint(h);
    const { error } = await collect(h.gateway.complete(userMessage('x')));
    expect((error as ProviderError).kind).toBe('auth');
    expect(typesOf(events)).toEqual(['request', 'attempt', 'response']);
    expect(events.at(-1)).toMatchObject({ type: 'response', finishReason: 'error', error: { kind: 'auth' } });
  });

  it('reports a caller that stops reading as a response, so the call is never left open', async () => {
    const net = new ScriptedFetch().push(() => sseResponse([delta('part'), delta('ial'), finish('stop'), '[DONE]']));
    const { h, events } = watched({ net });
    await addEndpoint(h);
    for await (const chunk of h.gateway.complete(userMessage('x'))) {
      if (chunk.delta !== undefined) break;
    }
    expect(events.at(-1)).toMatchObject({ type: 'response', finishReason: 'error', error: { kind: 'abandoned' } });
  });
});

describe('a key in what the provider says', () => {
  it('never reaches an event, not in an error body, not in the request, not in a reply', async () => {
    const net = new ScriptedFetch().push(
      () => jsonResponse(500, `upstream echoed ${KEY}`),
      () => sseResponse([delta(`here is ${KEY} and Bearer sk-someone-elses-token-99999`), finish('stop'), '[DONE]']),
    );
    const { h, events } = watched({ net });
    await addEndpoint(h);

    const run = collect(h.gateway.complete({ messages: [{ role: 'user', content: `my key is ${KEY}` }] }));
    await flush();
    h.clock.advance(1_000);
    await run;

    const text = JSON.stringify(events);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('CAOTANG-SECRET');
    expect(text).not.toContain('someone-elses-token');
    expect(text).toContain('[redacted]');
  });

  it('is scrubbed from the error of a call that failed, as the request log is', async () => {
    const { h, events } = watched({ net: new ScriptedFetch().push(() => jsonResponse(400, `bad ${KEY}`)), retry: { maxRetries: 0 } });
    await addEndpoint(h);
    await collect(h.gateway.complete(userMessage('x')));
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it('is scrubbed for a sealed header value too', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(500, 'proxy rejected proxy-secret-hunter2'));
    const { h, events } = watched({ net, retry: { maxRetries: 0 } });
    await addEndpoint(h, { customHeaders: { 'x-proxy-secret': 'proxy-secret-hunter2' } });
    await collect(h.gateway.complete({ messages: [{ role: 'user', content: 'send proxy-secret-hunter2' }] }));
    expect(JSON.stringify(events)).not.toContain('proxy-secret-hunter2');
  });
});

describe('an observer that throws', () => {
  const throwing = (): void => {
    throw new Error('observer broke');
  };

  async function run(observe: ((event: GatewayTraceEvent) => void) | undefined) {
    const net = new ScriptedFetch().push(
      () => jsonResponse(500, 'boom'),
      () => sseResponse([delta('hi'), finish('stop', { prompt_tokens: 5, completion_tokens: 1 }), '[DONE]']),
    );
    const h = harness({ net, ...(observe === undefined ? {} : { observe }) });
    const profile = await addEndpoint(h);
    const pending = collect(h.gateway.complete({ ...userMessage('x'), turnId: 't', role: 'chat' }));
    await flush();
    h.clock.advance(1_000);
    const result = await pending;
    // profile ids are minted at random, so they are named by what they are
    const anon = (value: unknown): string => JSON.stringify(value).split(profile.id).join('<profile>');
    return { chunks: result.chunks, error: result.error, ledger: anon(h.gateway.ledger.snapshot()), log: anon(h.gateway.requestLog.entries()) };
  }

  it('leaves the stream, the ledger and the request log as they are without one', async () => {
    const plain = await run(undefined);
    const broken = await run(throwing);
    expect(broken.error).toBeUndefined();
    expect(broken.chunks).toEqual(plain.chunks);
    expect(broken.ledger).toEqual(plain.ledger);
    expect(broken.log).toEqual(plain.log);
  });

  it('does the same on the mock path', async () => {
    const h = harness({ observe: throwing });
    await h.profiles.create({ name: 'Demo', kind: 'mock' });
    const { chunks, error } = await collect(h.gateway.complete(userMessage('hello')));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('hello');
  });
});

describe('attaching and detaching the observer', () => {
  it('takes effect from the next call, and a detached gateway gathers nothing', async () => {
    const h = harness();
    await h.profiles.create({ name: 'Demo', kind: 'mock' });
    const events: GatewayTraceEvent[] = [];
    await collect(h.gateway.complete(userMessage('before')));
    h.gateway.setObserver((event) => events.push(event));
    await collect(h.gateway.complete(userMessage('during')));
    const told = events.length;
    h.gateway.setObserver(undefined);
    await collect(h.gateway.complete(userMessage('after')));
    expect(told).toBeGreaterThan(0);
    expect(events).toHaveLength(told);
    expect(JSON.stringify(events)).toContain('during');
    expect(JSON.stringify(events)).not.toContain('before');
  });
});
