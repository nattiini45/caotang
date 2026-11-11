import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/index.js';
import { addEndpoint, flush, harness, KEY, ScriptedFetch } from './helpers.js';

describe('structured probe failure metadata', () => {
  it.each([
    { error: { message: 'The key was rejected.' } },
    { error: 'The key was rejected.' },
    { message: 'The key was rejected.' },
  ])('extracts the provider’s own JSON message without translating it: %j', async (body) => {
    const h = harness({ net: new ScriptedFetch().push(() => Response.json(body, { status: 401 })) });
    const profile = await addEndpoint(h);
    const error = await h.gateway.listModels(profile.id).catch((error: unknown) => error);
    expect(error).toMatchObject({ kind: 'auth', providerReply: 'The key was rejected.' });
  });

  it.each([400, 401, 403, 404, 429, 500])('keeps a bounded, redacted provider reply separate on HTTP %s', async (status) => {
    const net = new ScriptedFetch().push(() => new Response(`The provider rejected ${KEY}. ${'detail '.repeat(80)}`, { status }));
    const h = harness({ net, retry: { maxRetries: 0 } });
    const profile = await addEndpoint(h);
    const error = await h.gateway.listModels(profile.id).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ProviderError);
    const failure = error as ProviderError;
    expect(failure.providerReply).toContain('The provider rejected');
    expect(failure.providerReply).not.toContain(KEY);
    expect(failure.providerReply!.length).toBeLessThanOrEqual(300);
    expect(failure.reason).toBeUndefined();
  });

  it('redacts secrets after extracting a JSON error message', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => Response.json({ error: { message: `Rejected ${KEY}.` } }, { status: 401 })) });
    const profile = await addEndpoint(h);
    const error = await h.gateway.listModels(profile.id).catch((error: unknown) => error);
    expect((error as ProviderError).providerReply).toContain('Rejected');
    expect((error as ProviderError).providerReply).not.toContain(KEY);
  });

  it('identifies a model-list connection timeout without parsing its message', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => new Promise<Response>(() => {})), retry: { maxRetries: 0 }, timeouts: { connectMs: 10 } });
    const profile = await addEndpoint(h);
    const result = h.gateway.listModels(profile.id).catch((error: unknown) => error);
    await flush();
    expect(h.net.calls).toHaveLength(1);
    h.clock.advance(10);
    const error = await result;
    expect(error).toMatchObject({ kind: 'network', reason: 'timeout', providerReply: undefined });
  });

  it('identifies a model-list body deadline and cancels the reader', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); },
      cancel() { cancelled = true; },
    });
    const h = harness({ net: new ScriptedFetch().push(() => new Response(body)), retry: { maxRetries: 0 }, timeouts: { totalMs: 10 } });
    const profile = await addEndpoint(h);
    const result = h.gateway.listModels(profile.id).catch((error: unknown) => error);
    await flush();
    h.clock.advance(10);
    expect(await result).toMatchObject({ kind: 'network', reason: 'timeout', providerReply: undefined });
    expect(cancelled).toBe(true);
  });

  it('marks an unreadable model route independently of an unreachable host or timeout', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => { throw new TypeError('Failed to fetch'); }), retry: { maxRetries: 0 } });
    const profile = await addEndpoint(h, { preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-5-5' });
    const error = await h.gateway.listModels(profile.id).catch((error: unknown) => error);
    expect(error).toMatchObject({ kind: 'network', reason: 'model-list-unreadable', providerReply: undefined });
  });
});
