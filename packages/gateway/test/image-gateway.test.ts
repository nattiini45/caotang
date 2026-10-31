/**
 * Image parts through the gateway (provider-gateway §3): the vision gate refuses before anything is sent and
 * before a key is opened, the bytes ride the wire and nowhere else, and the request log, the ledger and every
 * error carry hashes, sizes and counts only.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  EgressDeniedError,
  ProviderError,
  imagePartsOf,
  textOf,
  usageFor,
  type ChatMessage,
  type ChatRequest,
} from '../src/index.js';
import { createMockProvider } from '../src/mock/index.js';
import { addEndpoint, collect, delta, deltasOf, finish, harness, KEY, ScriptedFetch, sseResponse, type Harness } from './helpers.js';
import { MARKER_BASE64, base64, imagePart, marked, pngBytes, sha256Of } from './image-fixtures.js';

const PIXELS = marked(1024, 1024);
const ENCODED = base64(PIXELS);
const PART = imagePart(PIXELS, 'image/png', 'the lighthouse');
const withImage = (text = 'What is in this picture?'): ChatRequest => ({
  messages: [{ role: 'user', content: [{ type: 'text', text }, PART] }],
});

/** A vision-capable model on a Chat route, and one on the Messages route. */
const mistral = (h: Harness) => addEndpoint(h, { preset: 'mistral', baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'ministral-3b-2512' });
const claude = (h: Harness) => addEndpoint(h, { preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-5-5' });

/** Everything the gateway keeps after a call, as one string a base64 form could be found in. */
const keptBy = (h: Harness): string => JSON.stringify({ log: h.gateway.requestLog.entries(), ledger: h.gateway.ledger.snapshot() });

const OK = [delta('A lighthouse at dusk.'), finish('stop')];

describe('the vision gate', () => {
  it('refuses an image for a model whose capability row has no vision, in words with the remedy', async () => {
    const h = harness();
    await addEndpoint(h);
    const { error, chunks } = await collect(h.gateway.complete(withImage()));
    expect(error).toBeInstanceOf(EgressDeniedError);
    const message = (error as Error).message;
    expect(message).toContain('“model-x” does not accept images');
    expect(message).toContain('Choose a vision-capable model in Settings');
    expect(chunks).toEqual([]);
  });

  it('sends nothing and opens no key when it refuses', async () => {
    const h = harness();
    await addEndpoint(h);
    const reveal = vi.spyOn(h.keys, 'revealPayload');
    const { error } = await collect(h.gateway.complete(withImage()));
    expect(error).toBeInstanceOf(EgressDeniedError);
    expect(h.net.calls).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
    // A refused request is not a request: nothing is logged and nothing is counted.
    expect(h.gateway.requestLog.entries()).toEqual([]);
    expect(h.gateway.ledger.snapshot()).toEqual({ days: [], turns: [] });
  });

  it('shows the writer neither the key, the bytes, nor their base64 form in the refusal', async () => {
    const h = harness();
    await addEndpoint(h);
    const { error } = await collect(h.gateway.complete(withImage()));
    const surfaces = JSON.stringify({ message: (error as Error).message, stack: (error as Error).stack });
    expect(surfaces).not.toContain(KEY);
    expect(surfaces).not.toContain(ENCODED);
    expect(surfaces).not.toContain(MARKER_BASE64);
    expect(surfaces).not.toContain('data:image');
  });

  it('refuses a malformed part and an image on an assistant message the same way, before any request', async () => {
    const h = harness();
    await mistral(h);
    const reveal = vi.spyOn(h.keys, 'revealPayload');
    const wrongMime = { ...PART, mime: 'image/jpeg' as const };
    const assistant: ChatMessage = { role: 'assistant', content: [PART] };
    for (const request of [
      { messages: [{ role: 'user' as const, content: [wrongMime] }] },
      { messages: [{ role: 'user' as const, content: 'x' }, assistant] },
    ]) {
      const { error } = await collect(h.gateway.complete(request));
      expect(error).toBeInstanceOf(EgressDeniedError);
      expect((error as Error).message).not.toContain(ENCODED);
    }
    expect(h.net.calls).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('refuses over the route’s count before sending, on a vision-capable model', async () => {
    const h = harness();
    await mistral(h);
    const tiny = imagePart(pngBytes(8, 8));
    const eleven = (): ChatMessage => ({ role: 'user', content: Array.from({ length: 11 }, () => tiny) });
    const { error } = await collect(h.gateway.complete({ messages: [eleven(), eleven()] }));
    expect(error).toBeInstanceOf(EgressDeniedError);
    expect((error as Error).message).toContain('22 images, over this route\'s cap of 20');
    expect(h.net.calls).toHaveLength(0);
  });

  it('lets a request with no image through a model that has no vision', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse(OK)) });
    await addEndpoint(h);
    const { error, chunks } = await collect(h.gateway.complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'parts, no image' }] }] }));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('A lighthouse at dusk.');
  });
});

describe('an image on the wire, and only there', () => {
  it('goes out on a Chat route as a data URL, and the log and ledger hold none of it', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse(OK)) });
    await mistral(h);
    const { error, chunks } = await collect(h.gateway.complete({ ...withImage(), turnId: 'turn-1' }));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('A lighthouse at dusk.');

    const sent = h.net.bodyOf(0) as { messages: { content: { type: string; image_url?: { url: string } }[] }[] };
    expect(sent.messages[0]?.content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${ENCODED}` } });
    expect(keptBy(h)).not.toContain(ENCODED);
    expect(keptBy(h)).not.toContain(MARKER_BASE64);
    expect(keptBy(h)).not.toContain(KEY);
    expect(h.gateway.requestLog.entries()).toHaveLength(1);
  });

  it('goes out on the Messages route as a base64 source block', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1400, output_tokens: 1 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A lighthouse.' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ];
    const h = harness({
      net: new ScriptedFetch().push(
        () => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ),
    });
    await claude(h);
    const { error, chunks } = await collect(h.gateway.complete(withImage()));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('A lighthouse.');
    const sent = h.net.bodyOf(0) as { messages: { content: unknown[] }[] };
    expect(sent.messages[0]?.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: ENCODED } });
    expect(keptBy(h)).not.toContain(ENCODED);
  });

  it('is estimated, when the provider reports no usage, at the text plus the image’s formula for the route', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse(OK)) });
    const profile = await mistral(h);
    await collect(h.gateway.complete({ ...withImage(), turnId: 'turn-1' }));
    const [row] = h.gateway.ledger.dayRows();
    const request = withImage();
    // 1024 x 1024 on a Chat route: 85 + 170 x 2 x 2.
    expect(row?.promptTokens).toBe(usageFor(request.messages, '', 'openai-chat').promptTokens);
    expect(row?.promptTokens).toBe(Math.ceil('What is in this picture?'.length / 4) + 765);
    expect(row?.profileId).toBe(profile.id);
    // An estimate, never the base64 read as text, which would have been over 100,000 tokens.
    expect(row?.promptTokens).toBeLessThan(2000);
    expect(h.gateway.ledger.turnTotals('turn-1').promptTokens).toBe(row?.promptTokens);
  });

  it('records the provider’s own usage when it reports one', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([delta('ok'), finish('stop', { prompt_tokens: 1234, completion_tokens: 5 })])) });
    await mistral(h);
    await collect(h.gateway.complete(withImage()));
    expect(h.gateway.ledger.dayRows()[0]).toMatchObject({ promptTokens: 1234, completionTokens: 5, requests: 1 });
  });

  it('scrubs the image from an error when the provider echoes the request body back', async () => {
    const echo = (): Response =>
      new Response(JSON.stringify({ error: { message: `bad request: image data:image/png;base64,${ENCODED} was rejected` } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    const h = harness({ net: new ScriptedFetch().push(echo), retry: { maxRetries: 0 } });
    await mistral(h);
    const { error } = await collect(h.gateway.complete(withImage()));
    expect(error).toBeInstanceOf(ProviderError);
    const err = error as ProviderError;
    const surfaces = JSON.stringify({ message: err.message, detail: err.detail, stack: err.stack });
    expect(surfaces).not.toContain(ENCODED);
    expect(surfaces).not.toContain(MARKER_BASE64);
    // The echo reached the error, and the scrubber is what removed the image from it.
    expect(surfaces).toContain('[redacted]');
    expect(keptBy(h)).not.toContain(MARKER_BASE64);
  });

  it('scrubs an echo of the image from a stream error as well', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([{ error: { message: `cannot read ${ENCODED}` } }])), retry: { maxRetries: 0 } });
    await mistral(h);
    const { error } = await collect(h.gateway.complete(withImage()));
    expect(error).toBeInstanceOf(ProviderError);
    const surfaces = JSON.stringify({ message: (error as Error).message, detail: (error as ProviderError).detail });
    expect(surfaces).not.toContain(MARKER_BASE64);
    expect(surfaces).toContain('[redacted]');
    expect(keptBy(h)).not.toContain(MARKER_BASE64);
  });

  it('keeps the bytes out of console output', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'debug')];
    try {
      const h = harness({ net: new ScriptedFetch().push(() => sseResponse(OK)) });
      await mistral(h);
      await collect(h.gateway.complete(withImage()));
      const refused = harness();
      await addEndpoint(refused);
      await collect(refused.gateway.complete(withImage()));
      for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(MARKER_BASE64);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('the mock provider and an image', () => {
  const vision = (reply: string) =>
    createMockProvider({
      capsVision: true,
      scripts: [{ match: (req) => req.messages.some((m) => imagePartsOf(m.content).length > 0), respond: () => ({ content: reply }) }],
    });

  async function mockHarness(mock: ReturnType<typeof createMockProvider>): Promise<Harness> {
    const h = harness({ mock });
    await h.profiles.create({ name: 'Offline', kind: 'mock' });
    return h;
  }

  it('answers a scripted reply to an image on a profile whose row says vision', async () => {
    const mock = vision('A lighthouse at dusk.');
    const h = await mockHarness(mock);
    const { error, chunks } = await collect(h.gateway.complete({ ...withImage(), turnId: 'turn-1' }));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('A lighthouse at dusk.');
    expect(chunks.at(-1)?.finishReason).toBe('stop');
    expect(imagePartsOf(mock.calls[0]?.messages[0]?.content ?? '')).toHaveLength(1);

    const [row] = h.gateway.ledger.dayRows();
    expect(row?.promptTokens).toBe(usageFor(withImage().messages, '').promptTokens);
    expect(row?.promptTokens).toBeGreaterThan(Math.ceil('What is in this picture?'.length / 4));
    expect(keptBy(h)).not.toContain(MARKER_BASE64);
  });

  it('echoes an image as its placeholder, never its bytes', async () => {
    const h = await mockHarness(createMockProvider({ capsVision: true }));
    const { chunks } = await collect(h.gateway.complete(withImage('Describe it.')));
    const text = deltasOf(chunks);
    expect(text).toBe(`Describe it.\n\n[image 1: image/png, 96 B, sha256:${sha256Of(PIXELS).slice(0, 8)}…, “the lighthouse”]`);
    expect(text).not.toContain(MARKER_BASE64);
    expect(textOf(withImage('Describe it.').messages[0]?.content ?? '')).toBe(text);
  });

  it('refuses the same request on a mock that has no vision, with nothing answered or counted', async () => {
    const mock = createMockProvider();
    const h = await mockHarness(mock);
    const { error, chunks } = await collect(h.gateway.complete(withImage()));
    expect(error).toBeInstanceOf(EgressDeniedError);
    expect((error as Error).message).toContain('does not accept images');
    expect(chunks).toEqual([]);
    expect(mock.calls).toHaveLength(0);
    expect(h.gateway.ledger.snapshot()).toEqual({ days: [], turns: [] });
  });

  it('reports vision only when asked to, through the gateway’s own capability read', async () => {
    const withVision = await mockHarness(createMockProvider({ capsVision: true }));
    const without = await mockHarness(createMockProvider());
    expect(withVision.gateway.modelCaps().vision).toBe(true);
    expect(without.gateway.modelCaps().vision).toBeUndefined();
  });
});
