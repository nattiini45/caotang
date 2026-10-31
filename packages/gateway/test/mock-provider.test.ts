/**
 * Mock provider tests — the headless-import requirement.
 *
 * "mock provider importable headless" means: importable in a plain Node process,
 * no DOM, no network, no clock. These tests run in the default `node` environment.
 */

import { describe, expect, it } from 'vitest';
import { createMockProvider, echo, estimateTokens, fail, stream, toolJson, type FailMode, type MockScript } from '../src/mock/index.js';
import { MOCK_BASE_URL, ProviderError, providerMessages, textOf, type ProviderErrorKind } from '../src/index.js';
import type { ChatChunk, ChatRequest } from '../src/types.js';
import { collect } from './helpers.js';

const req = (content: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content }],
  ...extra,
});

describe('mock provider', () => {
  it('answers via the default echo script', async () => {
    const p = createMockProvider();
    const res = await p.completeOnce(req('hello caotang'));
    expect(res).toEqual({ role: 'assistant', content: 'hello caotang' });
  });

  it('is deterministic: same request, same bytes', async () => {
    const a = await createMockProvider().completeOnce(req('repeat me'));
    const b = await createMockProvider().completeOnce(req('repeat me'));
    expect(a).toEqual(b);
  });

  it('reports usage as ceil(chars/4) per side', async () => {
    const p = createMockProvider();
    let usage = { promptTokens: 0, completionTokens: 0 };
    for await (const chunk of p.complete(req('abcdefgh'))) {
      if (chunk.usage) usage = chunk.usage;
    }
    expect(usage.promptTokens).toBe(estimateTokens('abcdefgh'));
    expect(usage.completionTokens).toBe(estimateTokens('abcdefgh'));
  });

  it('emits a finishReason on the terminal chunk', async () => {
    const p = createMockProvider();
    const seen: string[] = [];
    for await (const chunk of p.complete(req('hi'))) {
      if (chunk.finishReason) seen.push(chunk.finishReason);
    }
    expect(seen).toEqual(['stop']);
  });

  it('toolJson answers a structured-output request with a tool call', async () => {
    const p = createMockProvider();
    const res = await p.completeOnce(
      req('draft a scene', { responseFormat: { jsonSchemaHint: { type: 'object' } } }),
    );
    const parsed = JSON.parse(textOf(res.content)) as { tool: string };
    expect(parsed.tool).toBe('binder.create');
  });

  it('streams word-sized deltas', async () => {
    const p = createMockProvider({ scripts: [stream('one two three')] });
    const deltas: string[] = [];
    for await (const chunk of p.complete(req('go'))) {
      if (chunk.delta) deltas.push(chunk.delta);
    }
    expect(deltas.join('')).toBe('one two three');
    expect(deltas.length).toBe(3);
  });

  it('aborts mid-stream without a zombie request (§3)', async () => {
    const controller = new AbortController();
    const p = createMockProvider({ scripts: [stream('a b c d e f')] });
    const deltas: string[] = [];
    let finish: string | undefined;
    for await (const chunk of p.complete(req('go'), controller.signal)) {
      if (chunk.delta) deltas.push(chunk.delta);
      if (deltas.length === 2) controller.abort();
      if (chunk.finishReason) finish = chunk.finishReason;
    }
    expect(deltas.length).toBeLessThan(6);
    expect(finish).toBe('error');
  });

  it('records call history for eval assertions', async () => {
    const p = createMockProvider();
    await p.completeOnce(req('one'));
    await p.completeOnce(req('two'));
    expect(p.calls.map((c) => c.messages[0]?.content)).toEqual(['one', 'two']);
  });

  it('lists models without touching a network', async () => {
    const models = await createMockProvider().listModels('mock');
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.contextWindow).toBeGreaterThan(0);
  });

  it('exposes the shipped script library', () => {
    expect(typeof echo.match).toBe('function');
    expect(typeof toolJson.match).toBe('function');
  });
});

describe('mock provider — terminal chunk (§8 fix)', () => {
  it('ends an iterable script with one terminal chunk carrying finishReason and usage', async () => {
    const p = createMockProvider({ scripts: [stream('one two three')] });
    const chunks: ChatChunk[] = [];
    for await (const chunk of p.complete(req('go'))) chunks.push(chunk);

    const terminals = chunks.filter((c) => c.finishReason !== undefined);
    expect(terminals).toEqual([
      {
        finishReason: 'stop',
        usage: { promptTokens: estimateTokens('go'), completionTokens: estimateTokens('one two three') },
      },
    ]);
    expect(chunks.at(-1)).toBe(terminals[0]);
  });

  it('keeps a finish reason the script declares, and still attaches usage to it, without duplicating it', async () => {
    const script: MockScript = {
      match: () => true,
      async *respond(): AsyncIterable<ChatChunk> {
        yield { delta: 'cut ' };
        yield { delta: 'short', finishReason: 'length' };
      },
    };
    const p = createMockProvider({ scripts: [script] });
    const chunks: ChatChunk[] = [];
    for await (const chunk of p.complete(req('go'))) chunks.push(chunk);

    expect(chunks.filter((c) => c.finishReason !== undefined)).toEqual([
      { finishReason: 'length', usage: { promptTokens: estimateTokens('go'), completionTokens: estimateTokens('cut short') } },
    ]);
  });

  it('gives a non-iterable response the same terminal chunk', async () => {
    const p = createMockProvider({ scripts: [{ match: () => true, respond: () => ({ content: 'hello there' }) }] });
    const chunks: ChatChunk[] = [];
    for await (const chunk of p.complete(req('go'))) chunks.push(chunk);
    expect(chunks.at(-1)).toEqual({
      finishReason: 'stop',
      usage: { promptTokens: estimateTokens('go'), completionTokens: estimateTokens('hello there') },
    });
  });
});

describe('mock provider — abort usage (§3 fix)', () => {
  it('reports completion tokens for the deltas actually delivered, not for the whole script', async () => {
    const controller = new AbortController();
    const p = createMockProvider({ scripts: [stream('alpha beta gamma delta epsilon zeta')] });
    const deltas: string[] = [];
    let terminal: ChatChunk | undefined;
    for await (const chunk of p.complete(req('go'), controller.signal)) {
      if (chunk.delta) deltas.push(chunk.delta);
      if (deltas.length === 2) controller.abort();
      if (chunk.finishReason !== undefined) terminal = chunk;
    }

    const delivered = deltas.join('');
    expect(terminal).toEqual({
      finishReason: 'error',
      usage: { promptTokens: estimateTokens('go'), completionTokens: estimateTokens(delivered) },
    });
    expect(terminal?.usage?.completionTokens).toBeLessThan(estimateTokens('alpha beta gamma delta epsilon zeta'));
  });

  it('reports zero completion tokens when aborted before anything is delivered', async () => {
    const controller = new AbortController();
    controller.abort();
    const p = createMockProvider({ scripts: [stream('never delivered')] });
    const chunks: ChatChunk[] = [];
    for await (const chunk of p.complete(req('go'), controller.signal)) chunks.push(chunk);
    expect(chunks).toEqual([{ finishReason: 'error', usage: { promptTokens: estimateTokens('go'), completionTokens: 0 } }]);
  });
});

describe('mock provider — completeOnce surfaces an error finish (§3 fix)', () => {
  it('throws a provider error for an error finish instead of returning a normal message', async () => {
    const script: MockScript = { match: () => true, respond: () => ({ content: 'cut short', finishReason: 'error' }) };
    const p = createMockProvider({ scripts: [script] });
    const error = await p.completeOnce(req('go')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('provider');
  });

  it('throws the error kind a scripted failure names, not a generic one', async () => {
    const p = createMockProvider({ scripts: [fail('rate-limit')] });
    const error = await p.completeOnce(req('go')).catch((e: unknown) => e);
    expect((error as ProviderError).kind).toBe('rate_limit');
  });

  it('returns the message for a normal finish', async () => {
    const p = createMockProvider({ scripts: [stream('fine answer')] });
    await expect(p.completeOnce(req('go'))).resolves.toEqual({ role: 'assistant', content: 'fine answer' });
  });

  it('throws an AbortError when the caller aborted, which is what the caller asked for', async () => {
    const controller = new AbortController();
    const p = createMockProvider({ scripts: [stream('a b c')] });
    const pending = p.completeOnce(req('go'), controller.signal);
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('mock provider — determinism and the spec error scripts', () => {
  it('yields byte-identical chunk sequences for the same request', async () => {
    const collectAll = async (): Promise<ChatChunk[]> => {
      const out: ChatChunk[] = [];
      for await (const chunk of createMockProvider({ scripts: [stream('same every time')] }).complete(req('go'))) out.push(chunk);
      return out;
    };
    expect(JSON.stringify(await collectAll())).toBe(JSON.stringify(await collectAll()));
  });
});

describe('mock provider — fail(mode) raises the §4 error each spec mode names (§8)', () => {
  // The message is the gateway's own text for the kind, so a harness error path sees what a real failure shows.
  const cases: Array<[FailMode, ProviderErrorKind, string]> = [
    ['network', 'network', providerMessages.network(MOCK_BASE_URL, 'simulated')],
    ['auth', 'auth', providerMessages.auth(MOCK_BASE_URL)],
    ['rate-limit', 'rate_limit', providerMessages.rateLimit(MOCK_BASE_URL)],
    ['context-length', 'context_length', providerMessages.contextLength(1, 128_000)],
  ];

  it.each(cases)('fail(%s) raises kind %s with the gateway’s message, before any output', async (mode, kind, message) => {
    const p = createMockProvider({ scripts: [fail(mode)] });
    const { chunks, error } = await collect(p.complete(req('go')));
    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe(kind);
    expect((error as ProviderError).message).toBe(message);
  });
});

describe('mock provider — a scripted error is a ProviderError, as the gateway raises it (§4)', () => {
  it('raises before any delta, so partial text from a failing script never reaches the caller', async () => {
    const script: MockScript = { match: () => true, respond: () => ({ content: 'half an answer', error: { kind: 'network' } }) };
    const { chunks, error } = await collect(createMockProvider({ scripts: [script] }).complete(req('go')));
    expect(chunks).toEqual([]);
    expect((error as ProviderError).kind).toBe('network');
  });

  it('carries the status, detail, and Retry-After the script names', async () => {
    const script: MockScript = {
      match: () => true,
      respond: () => ({ content: '', error: { kind: 'rate_limit', status: 429, retryAfterMs: 7_000, detail: 'slow down' } }),
    };
    const { error } = await collect(createMockProvider({ scripts: [script] }).complete(req('go')));
    expect((error as ProviderError).status).toBe(429);
    expect((error as ProviderError).retryAfterMs).toBe(7_000);
    expect((error as ProviderError).detail).toBe('slow down');
  });

  it('words a provider failure with the status and excerpt the script gives', async () => {
    const script: MockScript = {
      match: () => true,
      respond: () => ({ content: '', error: { kind: 'provider', status: 503, detail: 'upstream down' } }),
    };
    const { error } = await collect(createMockProvider({ scripts: [script] }).complete(req('go')));
    expect((error as ProviderError).message).toBe(providerMessages.provider(MOCK_BASE_URL, 503, 'upstream down'));
  });

  it('ends an aborted stream with a terminal error chunk rather than raising, because the caller asked for the stop', async () => {
    const controller = new AbortController();
    controller.abort();
    const { chunks, error } = await collect(createMockProvider({ scripts: [fail('network')] }).complete(req('go'), controller.signal));
    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ finishReason: 'error', usage: { promptTokens: estimateTokens('go'), completionTokens: 0 } }]);
  });
});
