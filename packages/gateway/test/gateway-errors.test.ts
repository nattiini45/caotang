/**
 * The §4 error table, and the retry and timeout behaviour that goes with it. Time is
 * advanced explicitly, so each backoff and deadline is asserted to the millisecond.
 */

import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/index.js';
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
  userMessage,
  type Harness,
} from './helpers.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** The OpenAI chunk shape for one tool-call fragment. */
const toolCall = (name: string, args: string): unknown => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: args } }] },
      finish_reason: null,
    },
  ],
});

/** Advances the clock and lets the gateway react. */
async function step(h: Harness, ms: number): Promise<void> {
  h.clock.advance(ms);
  await flush();
}

/** Tracks whether a stream has finished, so a test can assert it is still waiting. */
function track<T>(promise: Promise<T>): { done: () => boolean; result: Promise<T> } {
  let finished = false;
  const result = promise.finally(() => {
    finished = true;
  });
  return { done: () => finished, result };
}

describe('the §4 error table, without retry', () => {
  it('raises auth on 401, once, with the spec message and no retry', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(401, { error: 'bad key' }));
    const h = harness({ net });
    await addEndpoint(h);

    const { error } = await collect(h.gateway.complete(userMessage('x')));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('auth');
    expect((error as ProviderError).message).toBe('Key rejected by a.example. Check the profile in Settings.');
    expect(net.calls).toHaveLength(1);
  });

  it('raises auth on 403 too', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => jsonResponse(403, 'forbidden')) });
    await addEndpoint(h);
    expect(((await collect(h.gateway.complete(userMessage('x')))).error as ProviderError).kind).toBe('auth');
  });

  it('raises endpoint on 404, naming the path and the base, with no retry', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(404, 'not found'));
    const h = harness({ net });
    await addEndpoint(h);

    const { error } = await collect(h.gateway.complete(userMessage('x')));
    expect((error as ProviderError).kind).toBe('endpoint');
    expect((error as ProviderError).message).toBe(
      'No /chat/completions at https://a.example/v1. Most OpenAI-compatible bases end in /v1.',
    );
    expect(net.calls).toHaveLength(1);
  });

  it('raises context_length on a 400 that names the window, with the prompt size the provider reported', async () => {
    const message =
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130500 tokens. Please reduce the length of the messages.";
    const net = new ScriptedFetch().push(() => jsonResponse(400, { error: { message, code: 'context_length_exceeded' } }));
    const h = harness({ net });
    await addEndpoint(h);

    const { error } = await collect(h.gateway.complete(userMessage('x')));
    expect((error as ProviderError).kind).toBe('context_length');
    expect((error as ProviderError).message).toBe(
      'Prompt ≈ 130500 tokens exceeds model window (128000). Reduce context: see activity log token budget.',
    );
    expect(net.calls).toHaveLength(1);
  });

  it('falls back to the local estimate when a context error does not state the sizes', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => jsonResponse(400, 'context window exceeded')) });
    await addEndpoint(h);
    const { error } = await collect(h.gateway.complete(userMessage('x'.repeat(4_000))));
    expect((error as ProviderError).kind).toBe('context_length');
    expect((error as ProviderError).message).toMatch(/Prompt ≈ 1000 tokens exceeds model window \(unknown\)/);
  });

  it('raises provider with the status and a bounded excerpt for any other 4xx, without retry', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(422, 'x'.repeat(2_000)));
    const h = harness({ net });
    await addEndpoint(h);

    const { error } = await collect(h.gateway.complete(userMessage('x')));
    const err = error as ProviderError;
    expect(err.kind).toBe('provider');
    expect(err.status).toBe(422);
    expect(err.message.startsWith('a.example returned HTTP 422: ')).toBe(true);
    expect(err.detail!.length).toBeLessThanOrEqual(300);
    expect(net.calls).toHaveLength(1);
  });

  it('raises protocol on a 200 whose stream is not SSE JSON, with the raw excerpt, once', async () => {
    const net = new ScriptedFetch().push(() => sseResponse(['{not json']));
    const h = harness({ net });
    await addEndpoint(h);

    const { error } = await collect(h.gateway.complete(userMessage('x')));
    expect((error as ProviderError).kind).toBe('protocol');
    expect((error as ProviderError).message).toBe('a.example sent a response Caotang could not read: {not json');
    expect(net.calls).toHaveLength(1);
  });

  it.each([
    ['a plain JSON completion that ignored stream: true', 'application/json', JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'a whole answer' } }] })],
    ['a proxy’s HTML page', 'text/html', '<html><body>Sign in to continue</body></html>'],
  ])('raises protocol once, with no retry, on a 200 that is %s', async (_label, contentType, body) => {
    const net = new ScriptedFetch().push(() => new Response(body, { status: 200, headers: { 'content-type': contentType } }));
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    expect(run.done()).toBe(true);

    const { error } = await run.result;
    expect((error as ProviderError).kind).toBe('protocol');
    expect((error as ProviderError).detail).toBe(body);
    expect(net.calls).toHaveLength(1);
  });

  it('bounds the protocol excerpt to 300 characters of the body that arrived', async () => {
    const net = new ScriptedFetch().push(() => new Response('x'.repeat(5_000), { status: 200, headers: { 'content-type': 'text/plain' } }));
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    expect(run.done()).toBe(true);
    const { error } = await run.result;
    expect((error as ProviderError).kind).toBe('protocol');
    expect((error as ProviderError).detail).toBe('x'.repeat(300));
    expect(net.calls).toHaveLength(1);
  });

  it('says the body was empty when a 200 arrives with nothing in it', async () => {
    const net = new ScriptedFetch().push(() => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    expect(run.done()).toBe(true);
    const { error } = await run.result;
    expect((error as ProviderError).kind).toBe('protocol');
    expect((error as ProviderError).message).toBe('a.example sent a response Caotang could not read: the response was empty');
    expect(net.calls).toHaveLength(1);
  });

  it('raises provider when a 200 stream carries an in-stream error object, and does not retry it', async () => {
    const net = new ScriptedFetch().push(() => sseResponse([{ error: { message: 'upstream timed out' } }]));
    const h = harness({ net });
    await addEndpoint(h);

    const { error } = await collect(h.gateway.complete(userMessage('x')));
    expect((error as ProviderError).kind).toBe('provider');
    expect((error as ProviderError).message).toBe('a.example reported an error: upstream timed out');
    expect(net.calls).toHaveLength(1);
  });

  it('raises protocol when the stream ends mid-event after output has been delivered', async () => {
    const body = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => body.response) });
    await addEndpoint(h);
    const run = collect(h.gateway.complete(userMessage('x')));
    await flush();
    body.event(delta('part'));
    body.raw('data: {"choices":[{"del');
    body.close();
    const { chunks, error } = await run;
    expect(chunks.map((c) => c.delta)).toEqual(['part']);
    expect((error as ProviderError).kind).toBe('protocol');
  });
});

describe('retry (§4): 5xx, 429, and transport failures', () => {
  it('retries a 5xx with 1s then 4s backoff, and succeeds on the third attempt', async () => {
    const net = new ScriptedFetch().push(
      () => jsonResponse(500, 'boom'),
      () => jsonResponse(502, 'bad gateway'),
      () => sseResponse([delta('ok'), finish('stop'), '[DONE]']),
    );
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    expect(net.calls).toHaveLength(1);

    await step(h, 999);
    expect(net.calls).toHaveLength(1);
    await step(h, 1);
    expect(net.calls).toHaveLength(2);

    await step(h, 3_999);
    expect(net.calls).toHaveLength(2);
    await step(h, 1);
    expect(net.calls).toHaveLength(3);

    const { chunks, error } = await run.result;
    expect(error).toBeUndefined();
    expect(chunks.map((c) => c.delta).filter(Boolean)).toEqual(['ok']);
  });

  it('gives up after two retries with the provider error, naming the status', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(500, 'one'), () => jsonResponse(500, 'two'), () => jsonResponse(500, 'three'));
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    await step(h, 1_000);
    await step(h, 4_000);
    const { error } = await run.result;

    expect(net.calls).toHaveLength(3);
    expect((error as ProviderError).kind).toBe('provider');
    expect((error as ProviderError).status).toBe(500);
    expect((error as ProviderError).message).toBe('a.example returned HTTP 500: three');
  });

  it('honours Retry-After exactly, in place of the backoff', async () => {
    const net = new ScriptedFetch().push(
      () => jsonResponse(429, { error: 'slow down' }, { 'retry-after': '7' }),
      () => sseResponse([delta('ok'), finish('stop'), '[DONE]']),
    );
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    await step(h, 6_999);
    expect(net.calls).toHaveLength(1);
    await step(h, 1);
    expect(net.calls).toHaveLength(2);

    const { error } = await run.result;
    expect(error).toBeUndefined();
  });

  it('raises rate_limit after the retries are spent on 429s without a Retry-After', async () => {
    const net = new ScriptedFetch().push(
      () => jsonResponse(429, 'slow'),
      () => jsonResponse(429, 'slow'),
      () => jsonResponse(429, 'slow'),
    );
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    await step(h, 1_000);
    await step(h, 4_000);
    const { error } = await run.result;
    expect((error as ProviderError).kind).toBe('rate_limit');
    expect(net.calls).toHaveLength(3);
  });

  it('does not wait out a Retry-After that would overrun the five-minute budget, and fails at once', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(429, 'slow', { 'retry-after': '600' }));
    const h = harness({ net });
    await addEndpoint(h);

    const { error } = await collect(h.gateway.complete(userMessage('x')));
    expect((error as ProviderError).kind).toBe('rate_limit');
    expect((error as ProviderError).retryAfterMs).toBe(600_000);
    expect(net.calls).toHaveLength(1);
  });

  it('retries a transport failure before any output, because the caller has seen nothing', async () => {
    const net = new ScriptedFetch().push(
      () => {
        throw new TypeError('fetch failed');
      },
      () => sseResponse([delta('ok'), finish('stop'), '[DONE]']),
    );
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    expect(net.calls).toHaveLength(1);
    await step(h, 1_000);
    const { chunks, error } = await run.result;
    expect(error).toBeUndefined();
    expect(chunks.map((c) => c.delta).filter(Boolean)).toEqual(['ok']);
  });

  it('retries a stream that drops before its first token', async () => {
    const first = openSse();
    const net = new ScriptedFetch().push(() => first.response, () => sseResponse([delta('ok'), finish('stop'), '[DONE]']));
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    first.fail(new Error('socket reset'));
    await flush();
    await step(h, 1_000);
    const { chunks, error } = await run.result;
    expect(error).toBeUndefined();
    expect(chunks.map((c) => c.delta).filter(Boolean)).toEqual(['ok']);
  });

  it('starts a retried stream with a fresh parser, so a dropped tool call is not stitched onto the retry', async () => {
    const body = openSse();
    const net = new ScriptedFetch().push(
      () => body.response,
      () => sseResponse([toolCall('binder.create', '{"title":"A new scene"}'), finish('tool_calls'), '[DONE]']),
    );
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    // The first attempt carries half a tool call and then the connection drops.
    body.event(toolCall('binder.create', '{"title":"A'));
    body.close();
    await flush();
    await step(h, 1_000);
    const { chunks, error } = await run.result;

    expect(error).toBeUndefined();
    expect(net.calls).toHaveLength(2);
    const terminal = chunks.find((c) => c.finishReason !== undefined);
    expect(terminal?.toolCalls).toEqual([{ id: 'call_1', name: 'binder.create', argumentsJson: '{"title":"A new scene"}' }]);
  });

  it('never retries once a token has reached the caller, and reports the drop as a network error', async () => {
    const body = openSse();
    const net = new ScriptedFetch().push(() => body.response);
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    body.event(delta('partial answer'));
    await flush();
    body.fail(new Error('connection reset'));
    const { chunks, error } = await run.result;

    expect(chunks.map((c) => c.delta)).toEqual(['partial answer']);
    expect((error as ProviderError).kind).toBe('network');
    expect(net.calls).toHaveLength(1);
  });

  it('reports a stream that closes with no finish and no [DONE] as a network error once output has flowed', async () => {
    const body = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => body.response) });
    await addEndpoint(h);

    const run = collect(h.gateway.complete(userMessage('x')));
    await flush();
    body.event(delta('cut short'));
    body.close();
    const { chunks, error } = await run;
    expect(chunks.map((c) => c.delta)).toEqual(['cut short']);
    expect((error as ProviderError).kind).toBe('network');
    expect((error as ProviderError).detail).toBe('the stream ended before the response finished');
  });
});

describe('timeouts (§4): connect 10s, first token 30s, idle 60s, total 5 min', () => {
  it('fails the connect at 10 seconds when no response headers arrive', async () => {
    const net = new ScriptedFetch().push(() => new Promise<Response>(() => undefined));
    const h = harness({ net, retry: { maxRetries: 0 } });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    await step(h, 9_999);
    expect(run.done()).toBe(false);
    await step(h, 1);
    const { error } = await run.result;
    expect((error as ProviderError).kind).toBe('network');
    expect((error as ProviderError).detail).toBe('no response within 10s');
  });

  it('cancels the body read when the whole-request deadline fires, so the socket is not left pulling', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start() {
        // a body that never ends
      },
      cancel() {
        cancelled = true;
      },
    });
    const net = new ScriptedFetch().push(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    const h = harness({ net, timeouts: { totalMs: 1_000 }, retry: { maxRetries: 0 } });
    const profile = await addEndpoint(h);

    const run = track(h.gateway.listModels(profile.id).catch((e: unknown) => e));
    await flush();
    await step(h, 1_000);
    const error = await run.result;

    expect((error as ProviderError).kind).toBe('network');
    expect(cancelled).toBe(true);
  });

  it('fails the first token at 30 seconds from the start of the attempt, not 30 after headers', async () => {
    const body = openSse();
    const net = new ScriptedFetch().push(() => body.response);
    const h = harness({ net, retry: { maxRetries: 0 } });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    await step(h, 10_000);
    expect(run.done()).toBe(false);
    await step(h, 19_999);
    expect(run.done()).toBe(false);
    await step(h, 1);
    const { error } = await run.result;
    expect((error as ProviderError).detail).toBe('no first token within 30s');
  });

  it('fails an idle stream 60 seconds after its last chunk, and keeps what it delivered', async () => {
    const body = openSse();
    const net = new ScriptedFetch().push(() => body.response);
    const h = harness({ net, retry: { maxRetries: 0 } });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    body.event(delta('a'));
    await flush();
    await step(h, 59_999);
    expect(run.done()).toBe(false);
    await step(h, 1);
    const { chunks, error } = await run.result;
    expect(chunks.map((c) => c.delta)).toEqual(['a']);
    expect((error as ProviderError).detail).toBe('stream idle for 60s');
  });

  it('does not time out a reasoning model that streams its thinking for longer than 30 seconds before any content', async () => {
    const body = openSse();
    const net = new ScriptedFetch().push(() => body.response);
    const h = harness({ net, retry: { maxRetries: 0 } });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    // Reasoning events every 20 seconds: past the 30-second first-token window, inside the 60-second idle window.
    for (let i = 0; i < 4; i += 1) {
      body.event({ choices: [{ delta: { reasoning: 'thinking' }, finish_reason: null }] });
      await flush();
      await step(h, 20_000);
    }
    body.event(delta('answer'));
    body.event(finish('stop'));
    body.raw('data: [DONE]\n\n');
    const { chunks, error } = await run.result;
    expect(error).toBeUndefined();
    expect(chunks.map((c) => c.delta).filter(Boolean)).toEqual(['answer']);
  });

  it('keeps a live stream alive past the first token, and caps the whole request at five minutes', async () => {
    const body = openSse();
    const net = new ScriptedFetch().push(() => body.response);
    const h = harness({ net, retry: { maxRetries: 0 } });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    for (let i = 0; i < 6; i += 1) {
      body.event(delta(`w${i} `));
      await flush();
      await step(h, 50_000);
    }
    const { chunks, error } = await run.result;
    expect(chunks.filter((c) => c.delta)).toHaveLength(6);
    expect((error as ProviderError).detail).toBe('request exceeded 5 minutes');
    expect(net.calls).toHaveLength(1);
  });

  it('gives each retry its own connect window, so a slow first attempt does not starve the second', async () => {
    const net = new ScriptedFetch().push(
      () => new Promise<Response>(() => undefined),
      () => sseResponse([delta('ok'), finish('stop'), '[DONE]']),
    );
    const h = harness({ net });
    await addEndpoint(h);

    const run = track(collect(h.gateway.complete(userMessage('x'))));
    await flush();
    await step(h, 10_000);
    expect(net.calls).toHaveLength(1);
    await step(h, 1_000);
    expect(net.calls).toHaveLength(2);
    const { chunks, error } = await run.result;
    expect(error).toBeUndefined();
    expect(chunks.map((c) => c.delta).filter(Boolean)).toEqual(['ok']);
  });
});

describe('the key never reaches the caller through an error (§4 key-leak)', () => {
  it('scrubs the key when a provider echoes it back in an error body', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(500, { error: `Incorrect API key provided: ${KEY}` }));
    const h = harness({ net, retry: { maxRetries: 0 } });
    await addEndpoint(h);

    const { error } = await collect(h.gateway.complete(userMessage('x')));
    const err = error as ProviderError;
    expect(err.message).not.toContain(KEY);
    expect(err.detail).not.toContain(KEY);
    expect(err.message).toContain('[redacted]');
  });
});
