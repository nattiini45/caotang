import { describe, expect, it, vi } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { EgressDeniedError } from '../src/errors.js';
import { sumUsage } from '../src/ledger.js';
import { createMockProvider } from '../src/mock/mock-provider.js';
import { addEndpoint, collect, delta, finish, flush, harness, KEY, openSse, ScriptedFetch, sseResponse, userMessage } from './helpers.js';

function heldStreams(count: number) {
  const streams = Array.from({ length: count }, () => openSse());
  const ended = new Set<number>();
  const end = (index: number): void => {
    if (ended.has(index)) return;
    ended.add(index);
    streams[index]?.event(finish('stop'));
    streams[index]?.close();
  };
  return {
    net: new ScriptedFetch().push(...streams.map((stream) => () => stream.response)),
    end,
    close: () => { streams.forEach((_stream, index) => end(index)); },
  };
}

describe('shared gateway completion admission', () => {
  it('defaults mock profiles to eight overlapping calls without network traffic', async () => {
    const mock = createMockProvider();
    vi.spyOn(mock, 'complete').mockImplementation(async function* () { yield { delta: 'held' }; });
    const h = harness({ mock });
    await h.profiles.create({ name: 'Demo', kind: 'mock' });
    const iterators = Array.from({ length: 9 }, () => h.gateway.complete(userMessage('mock'))[Symbol.asyncIterator]());
    const first = iterators.slice(0, 8).map((iterator) => iterator.next());
    await Promise.all(first);
    let admitted = false;
    const ninth = iterators[8]!.next().then((chunk) => { admitted = true; return chunk; });
    await flush();
    expect(admitted).toBe(false);
    await iterators[0]!.return?.();
    expect((await ninth).value).toEqual({ delta: 'held' });
    await Promise.all(iterators.map((iterator) => iterator.return?.()));
    expect(h.net.calls).toHaveLength(0);
    expect(sumUsage(h.gateway.ledger.dayRows()).requests).toBe(9);
  });

  it('caps mixed streaming and collected endpoint calls at the default three', async () => {
    const held = heldStreams(4);
    const h = harness({ net: held.net });
    await addEndpoint(h);
    const calls = [
      collect(h.gateway.complete(userMessage('one'))),
      h.gateway.completeOnce(userMessage('two')),
      h.gateway.completeOnce(userMessage('three')),
      h.gateway.completeOnce(userMessage('four')),
    ];
    try {
      await flush();
      expect(h.net.calls).toHaveLength(3);
      held.end(0);
      await calls[0];
      await flush();
      expect(h.net.calls).toHaveLength(4);
    } finally {
      held.close();
      await Promise.all(calls);
    }
    expect(sumUsage(h.gateway.ledger.dayRows()).requests).toBe(4);
    for (let index = 0; index < 4; index += 1) expect(h.net.bodyOf(index)).not.toHaveProperty('maxConcurrentRequests');
    expect(h.clock.pending).toBe(0);
  });

  it('serves queued foreground calls first and keeps each priority in order', async () => {
    const held = openSse();
    const net = new ScriptedFetch().push(() => held.response);
    net.push(...Array.from({ length: 4 }, () => () => sseResponse([finish('stop'), '[DONE]'])));
    const h = harness({ net });
    await addEndpoint(h, { maxConcurrentRequests: 1 });
    const active = h.gateway.completeOnce({ ...userMessage('active'), role: 'background' });
    await flush();
    const pending = [
      h.gateway.completeOnce({ ...userMessage('b1'), role: 'background' }),
      h.gateway.completeOnce({ ...userMessage('b2'), role: 'background' }),
      h.gateway.completeOnce({ ...userMessage('f1'), role: 'chat' }),
      h.gateway.completeOnce({ ...userMessage('f2'), role: 'drafting' }),
    ];
    await flush();
    expect(net.calls).toHaveLength(1);
    held.event(finish('stop'));
    held.close();
    await Promise.all([active, ...pending]);
    expect(net.calls.map((_call, index) => net.bodyOf(index)['messages'])).toEqual(
      ['active', 'f1', 'f2', 'b1', 'b2'].map((content) => [{ role: 'user', content }]),
    );
    expect(sumUsage(h.gateway.ledger.dayRows()).requests).toBe(5);
  });

  it('cancels queued streams and completeOnce without a key reveal, send or accounting row', async () => {
    const held = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => held.response) });
    await addEndpoint(h, { maxConcurrentRequests: 1 });
    const reveal = vi.spyOn(h.keys, 'revealPayload');
    const active = h.gateway.completeOnce({ ...userMessage('active'), turnId: 'active' });
    await flush();
    const abort = new AbortController();
    const beforeSend = vi.fn();
    const stream = collect(h.gateway.complete({ ...userMessage('queued-stream'), turnId: 'queued' }, abort.signal, beforeSend));
    const once = h.gateway.completeOnce({ ...userMessage('queued-once'), turnId: 'queued' }, abort.signal);
    const cancelled = expect(once).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await cancelled;
    expect(await stream).toEqual({ chunks: [{ finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 } }] });
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(h.net.calls).toHaveLength(1);
    expect(h.gateway.requestLog.entries()).toEqual([]);
    expect(h.gateway.ledger.turnTotals('queued').requests).toBe(0);
    expect(beforeSend).not.toHaveBeenCalled();
    held.event(finish('stop'));
    held.close();
    await active;
    expect(h.clock.pending).toBe(0);
  });

  it('pauses new admission even on an exhausted 429, without blocking another profile', async () => {
    const net = new ScriptedFetch().push(
      () => new Response('Slow down', { status: 429, headers: { 'retry-after': '2' } }),
      () => sseResponse([finish('stop'), '[DONE]']),
      () => sseResponse([finish('stop'), '[DONE]']),
    );
    const h = harness({ net, retry: { maxRetries: 0 }, timeouts: { connectMs: 100, firstTokenMs: 100, idleMs: 100, totalMs: 100 } });
    const first = await addEndpoint(h, { maxConcurrentRequests: 1 });
    const second = await addEndpoint(h, { name: 'Another endpoint', maxConcurrentRequests: 1 });
    await expect(h.gateway.completeOnce({ ...userMessage('limited'), profileId: first.id })).rejects.toMatchObject({ kind: 'rate_limit' });
    const queued = h.gateway.completeOnce({ ...userMessage('queued'), profileId: first.id });
    await h.gateway.completeOnce({ ...userMessage('other'), profileId: second.id });
    expect(net.calls).toHaveLength(2);
    h.clock.advance(1_999);
    await flush();
    expect(net.calls).toHaveLength(2);
    h.clock.advance(1);
    await queued;
    expect(net.calls).toHaveLength(3);
    expect(sumUsage(h.gateway.ledger.dayRows()).requests).toBe(3);
    expect(h.clock.pending).toBe(0);
  });

  it('holds an admitted retry slot and counts only actual attempts', async () => {
    const net = new ScriptedFetch().push(
      () => new Response('Slow down', { status: 429, headers: { 'retry-after': '1' } }),
      () => sseResponse([finish('stop', { prompt_tokens: 5, completion_tokens: 2 }), '[DONE]']),
      () => sseResponse([finish('stop'), '[DONE]']),
    );
    const h = harness({ net });
    await addEndpoint(h, { maxConcurrentRequests: 1 });
    const active = h.gateway.completeOnce({ ...userMessage('background'), role: 'background', turnId: 'retry' });
    await flush();
    const queued = h.gateway.completeOnce({ ...userMessage('foreground'), role: 'chat', turnId: 'next' });
    await flush();
    expect(net.calls).toHaveLength(1);
    h.clock.advance(1_000);
    await Promise.all([active, queued]);
    expect(net.calls.map((_call, index) => net.bodyOf(index)['messages'])).toEqual(
      ['background', 'background', 'foreground'].map((content) => [{ role: 'user', content }]),
    );
    expect(h.gateway.ledger.turnTotals('retry')).toMatchObject({ requests: 2, promptTokens: 5, completionTokens: 2, unpricedRequests: 2 });
    expect(h.gateway.ledger.turnTotals('next').requests).toBe(1);
    expect(h.clock.pending).toBe(0);
  });

  it.each([false, true])('pauses at 429 headers while its body is stalled, even if cancelled: %s', async (cancel) => {
    const stalled = openSse();
    const net = new ScriptedFetch().push(
      () => new Response(stalled.response.body, { status: 429, headers: { 'retry-after': '2' } }),
      () => sseResponse([finish('stop'), '[DONE]']),
    );
    const h = harness({ net, retry: { maxRetries: 0 } });
    await addEndpoint(h, { maxConcurrentRequests: 2 });
    const abort = new AbortController();
    const active = collect(h.gateway.complete(userMessage('limited'), abort.signal));
    await flush();
    const queued = h.gateway.completeOnce(userMessage('queued'));
    await flush();
    expect(net.calls).toHaveLength(1);
    if (cancel) abort.abort();
    h.clock.advance(1_999);
    await flush();
    expect(net.calls).toHaveLength(1);
    h.clock.advance(1);
    await queued;
    expect(net.calls).toHaveLength(2);
    stalled.close();
    const result = await active;
    if (cancel) expect(result.chunks.at(-1)?.finishReason).toBe('error');
    else expect(result.error).toMatchObject({ kind: 'rate_limit' });
    expect(h.gateway.requestLog.entries().find((entry) => entry.outcome === (cancel ? 'cancelled' : 'failed'))?.status).toBe(429);
    expect(h.clock.pending).toBe(0);
  });

  it('selects one fallback delay for both header-time pause and the admitted retry', async () => {
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValue(1);
    const net = new ScriptedFetch().push(
      () => new Response('Slow down', { status: 429 }),
      () => sseResponse([finish('stop'), '[DONE]']),
    );
    const h = harness({ net, random, retry: { maxRetries: 1 } });
    await addEndpoint(h, { maxConcurrentRequests: 1 });
    const active = h.gateway.completeOnce(userMessage('retry'));
    await flush();
    h.clock.advance(799);
    await flush();
    expect(net.calls).toHaveLength(1);
    h.clock.advance(1);
    await active;
    expect(net.calls).toHaveLength(2);
    expect(random).toHaveBeenCalledTimes(1);
    expect(h.clock.pending).toBe(0);
  });

  it('keeps a dated Retry-After absolute when reading the error body takes time', async () => {
    const stalled = openSse();
    const net = new ScriptedFetch().push(
      () => new Response(stalled.response.body, { status: 429, headers: { 'retry-after': new Date(h.clock.now() + 2_000).toUTCString() } }),
      () => sseResponse([finish('stop'), '[DONE]']),
    );
    const h = harness({ net, retry: { maxRetries: 1 } });
    await addEndpoint(h, { maxConcurrentRequests: 1 });
    const active = h.gateway.completeOnce(userMessage('retry'));
    await flush();
    h.clock.advance(1_000);
    stalled.close();
    await flush();
    h.clock.advance(999);
    await flush();
    expect(net.calls).toHaveLength(1);
    h.clock.advance(1);
    await active;
    expect(net.calls).toHaveLength(2);
    expect(h.clock.pending).toBe(0);
  });

  it.each([
    { label: 'missing', header: undefined },
    { label: 'unreadable', header: 'not a delay' },
    { label: 'overflowing', header: '9'.repeat(400) },
  ])('shares the policy backoff for an exhausted 429 with a $label Retry-After', async ({ header }) => {
    const net = new ScriptedFetch().push(
      () => new Response('Slow down', { status: 429, headers: header === undefined ? {} : { 'retry-after': header } }),
      () => sseResponse([finish('stop'), '[DONE]']),
    );
    const h = harness({ net, retry: { maxRetries: 0 } });
    await addEndpoint(h);
    await expect(h.gateway.completeOnce(userMessage('limited'))).rejects.toMatchObject({ kind: 'rate_limit' });
    const next = h.gateway.completeOnce(userMessage('next'));
    h.clock.advance(999);
    await flush();
    expect(net.calls).toHaveLength(1);
    h.clock.advance(1);
    await next;
    expect(net.calls).toHaveLength(2);
    expect(h.clock.pending).toBe(0);
  });

  it('extends admission to the latest concurrent rate-limit deadline', async () => {
    let first!: (response: Response) => void;
    let second!: (response: Response) => void;
    const net = new ScriptedFetch().push(
      () => new Promise<Response>((resolve) => { first = resolve; }),
      () => new Promise<Response>((resolve) => { second = resolve; }),
      () => sseResponse([finish('stop'), '[DONE]']),
    );
    const h = harness({ net, retry: { maxRetries: 0 } });
    await addEndpoint(h, { maxConcurrentRequests: 2 });
    const active = [collect(h.gateway.complete(userMessage('one'))), collect(h.gateway.complete(userMessage('two')))];
    await flush();
    expect(net.calls).toHaveLength(2);
    const next = h.gateway.completeOnce(userMessage('queued'));
    first(new Response('Slow down', { status: 429, headers: { 'retry-after': '3' } }));
    await active[0];
    h.clock.advance(1_000);
    second(new Response('Slow down', { status: 429, headers: { 'retry-after': '5' } }));
    await active[1];
    h.clock.advance(4_999);
    await flush();
    expect(net.calls).toHaveLength(2);
    h.clock.advance(1);
    await next;
    expect(net.calls).toHaveLength(3);
    expect(h.clock.pending).toBe(0);
  });

  it('refuses a profile removed while queued without another send', async () => {
    const held = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => held.response) });
    const profile = await addEndpoint(h, { maxConcurrentRequests: 1 });
    const active = h.gateway.completeOnce(userMessage('active'));
    await flush();
    const queued = collect(h.gateway.complete(userMessage('queued')));
    await h.profiles.remove(profile.id);
    held.event(finish('stop'));
    held.close();
    await active;
    expect((await queued).error).toMatchObject({ code: 'not-found' });
    expect(h.net.calls).toHaveLength(1);
    expect(sumUsage(h.gateway.ledger.dayRows()).requests).toBe(1);
  });

  it('rechecks role permission after waiting, before credentials or dispatch', async () => {
    const held = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => held.response) });
    const profile = await addEndpoint(h, { maxConcurrentRequests: 1 });
    let allowed = true;
    const gateway = createGateway({ profiles: h.profiles, keys: h.keys, clock: h.clock, fetch: h.net.fn, roles: {
      resolve: () => ({ profileId: profile.id }),
      allowed: () => allowed ? [profile.id] : [],
    } });
    const reveal = vi.spyOn(h.keys, 'revealPayload');
    const active = gateway.completeOnce(userMessage('active'));
    await flush();
    const queued = collect(gateway.complete({ ...userMessage('queued'), role: 'chat' }));
    allowed = false;
    held.event(finish('stop'));
    held.close();
    await active;
    expect((await queued).error).toBeInstanceOf(EgressDeniedError);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(h.net.calls).toHaveLength(1);
    allowed = true;
    h.net.push(() => sseResponse([finish('stop'), '[DONE]']));
    await gateway.completeOnce({ ...userMessage('allowed again'), role: 'chat' });
    expect(h.net.calls).toHaveLength(2);
  });

  it('uses the admitted profile metadata rather than an old queued endpoint/model snapshot', async () => {
    const held = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => held.response, () => sseResponse([finish('stop'), '[DONE]'])) });
    const profile = await addEndpoint(h, { maxConcurrentRequests: 1 });
    const active = h.gateway.completeOnce(userMessage('active'));
    await flush();
    const queued = h.gateway.completeOnce(userMessage('queued'));
    await h.profiles.update(profile.id, { baseUrl: 'https://a.example/v2', defaultModel: 'new-model', apiKey: `${KEY}-new` });
    held.event(finish('stop'));
    held.close();
    await Promise.all([active, queued]);
    expect(h.net.calls[1]?.url).toBe('https://a.example/v2/chat/completions');
    expect(h.net.bodyOf(1)['model']).toBe('new-model');
    expect(h.net.headerOf(1, 'authorization')).toBe(`Bearer ${KEY}-new`);
  });

  it('releases an abandoned streaming slot and retains its partial accounting', async () => {
    const held = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => held.response, () => sseResponse([finish('stop'), '[DONE]'])) });
    await addEndpoint(h, { maxConcurrentRequests: 1 });
    const iterator = h.gateway.complete({ ...userMessage('partial'), turnId: 'partial' })[Symbol.asyncIterator]();
    const first = iterator.next();
    await flush();
    held.event(delta('hello'));
    expect((await first).value).toMatchObject({ delta: 'hello' });
    const next = h.gateway.completeOnce(userMessage('next'));
    await flush();
    expect(h.net.calls).toHaveLength(1);
    await iterator.return?.();
    await next;
    expect(h.net.calls).toHaveLength(2);
    expect(h.gateway.ledger.turnTotals('partial')).toMatchObject({ requests: 1, completionTokens: 2 });
    expect(h.clock.pending).toBe(0);
  });

  it.each(['abort', 'timeout'])('releases an active slot after %s so queued work can finish', async (reason) => {
    const held = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => held.response, () => sseResponse([finish('stop'), '[DONE]'])), timeouts: { firstTokenMs: 1_000 }, retry: { maxRetries: 0 } });
    await addEndpoint(h, { maxConcurrentRequests: 1 });
    const abort = new AbortController();
    const active = collect(h.gateway.complete({ ...userMessage('active'), turnId: 'active' }, abort.signal));
    await flush();
    const queued = h.gateway.completeOnce(userMessage('queued'));
    await flush();
    expect(h.net.calls).toHaveLength(1);
    if (reason === 'abort') abort.abort();
    else h.clock.advance(1_000);
    const result = await active;
    if (reason === 'abort') expect(result.chunks.at(-1)?.finishReason).toBe('error');
    else expect(result.error).toMatchObject({ kind: 'network', detail: 'no first token within 1s' });
    await queued;
    expect(h.net.calls).toHaveLength(2);
    expect(h.gateway.ledger.turnTotals('active').requests).toBe(1);
    expect(h.clock.pending).toBe(0);
  });
});
