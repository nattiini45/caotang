/**
 * The native egress rule — provider-gateway.md §9, desktop.md. The port the desktop app fetches through is only as safe as
 * this check: a request that passes here is one the host sends, and the allowlist is the only thing between a page and an
 * arbitrary address, so every refusal is asserted by kind rather than by "it throws".
 */

import { describe, expect, it } from 'vitest';
import {
  checkNativeEgress,
  NATIVE_EGRESS_LIMITS,
  nativeEgressOrigins,
  normalizeOrigin,
  pumpResponse,
} from '../src/index.js';

const ORIGINS = nativeEgressOrigins(['https://api.example.com', 'https://models.example.org:8443']);

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  url: 'https://api.example.com/v1/chat/completions',
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
  body: '{"model":"m"}',
  ...overrides,
});

const refusal = (candidate: unknown, origins = ORIGINS): string | undefined => {
  const checked = checkNativeEgress(origins, candidate);
  return checked.ok ? undefined : checked.refusal;
};

describe('the origins a host may reach', () => {
  it('keeps bare https origins and a port that is part of one', () => {
    expect([...ORIGINS].sort()).toEqual(['https://api.example.com', 'https://models.example.org:8443']);
  });

  it('drops a base URL, a credential, another scheme and this computer', () => {
    expect(normalizeOrigin('https://api.example.com/v1')).toBeUndefined();
    expect(normalizeOrigin('https://user:secret@api.example.com')).toBeUndefined();
    expect(normalizeOrigin('http://api.example.com')).toBeUndefined();
    expect(normalizeOrigin('file:///etc/passwd')).toBeUndefined();
    expect(normalizeOrigin('not a url')).toBeUndefined();
    expect(normalizeOrigin('https://127.0.0.1:1234')).toBeUndefined();
    expect(normalizeOrigin('https://localhost')).toBeUndefined();
    expect(normalizeOrigin('https://model.localhost')).toBeUndefined();
  });

  it('ignores entries that are not strings', () => {
    expect([...nativeEgressOrigins(['https://api.example.com', 42, null, { origin: 'https://evil.example' }])])
      .toEqual(['https://api.example.com']);
  });
});

describe('a request the host may make', () => {
  it('passes when its origin is configured, with its method, headers and body intact', () => {
    const checked = checkNativeEgress(ORIGINS, request());
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.request.url).toBe('https://api.example.com/v1/chat/completions');
    expect(checked.request.method).toBe('POST');
    expect(checked.request.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-test' });
    expect(checked.request.body).toBe('{"model":"m"}');
  });

  it('lower-cases header names, so the same header cannot arrive twice under two spellings', () => {
    const checked = checkNativeEgress(ORIGINS, request({ headers: { 'X-Api-Key': 'k' } }));
    expect(checked.ok && checked.request.headers).toEqual({ 'x-api-key': 'k' });
  });

  it('accepts the methods a model call, a listing and an MCP session use', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(refusal(request({ method }))).toBeUndefined();
    }
  });

  it('refuses a request with no body when the method carries one', () => {
    expect(refusal(request({ body: undefined }))).toBeUndefined();
  });
});

describe('a request the host refuses', () => {
  it('denies an address the writer never configured', () => {
    expect(refusal(request({ url: 'https://evil.example/v1/chat/completions' }))).toBe('denied');
    // The same host on another port is another origin, so a port is not a detail.
    expect(refusal(request({ url: 'https://api.example.com:8443/v1' }))).toBe('denied');
  });

  it('denies this computer, whatever the allowlist says', () => {
    const local = nativeEgressOrigins(['https://127.0.0.1:11434', 'https://localhost:1234']);
    expect(local.size).toBe(0);
    expect(refusal(request({ url: 'https://127.0.0.1:11434/v1/models' }), local)).toBe('denied');
  });

  it('calls a non-https address invalid rather than merely unconfigured', () => {
    expect(refusal(request({ url: 'http://api.example.com/v1/models', method: 'GET' }))).toBe('invalid');
    expect(refusal(request({ url: 'file:///etc/passwd', method: 'GET' }))).toBe('invalid');
    expect(refusal(request({ url: 'https://user:secret@api.example.com/v1' }))).toBe('invalid');
  });

  it('refuses a method it never sends', () => {
    expect(refusal(request({ method: 'CONNECT' }))).toBe('invalid');
    expect(refusal(request({ method: 'get' }))).toBe('invalid');
    expect(refusal(request({ method: undefined }))).toBe('invalid');
  });

  it('refuses a header that names the connection rather than the request', () => {
    for (const name of ['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'Proxy-Authorization']) {
      expect(refusal(request({ headers: { [name]: 'x' } }))).toBe('invalid');
    }
  });

  it('refuses a header name that is not a token and a value that carries a line break', () => {
    expect(refusal(request({ headers: { 'bad name': 'x' } }))).toBe('invalid');
    expect(refusal(request({ headers: { 'x-note': 'a\r\nhost: evil.example' } }))).toBe('invalid');
    expect(refusal(request({ headers: { 'x-note': 'a\nb' } }))).toBe('invalid');
  });

  it('refuses a request whose parts are the wrong shape', () => {
    expect(refusal(null)).toBe('invalid');
    expect(refusal('https://api.example.com')).toBe('invalid');
    expect(refusal(request({ url: undefined }))).toBe('invalid');
    expect(refusal(request({ headers: ['content-type: application/json'] }))).toBe('invalid');
    expect(refusal(request({ headers: { 'x-note': 42 } }))).toBe('invalid');
    expect(refusal(request({ body: { json: true } }))).toBe('invalid');
  });

  it('refuses a request past the port limits', () => {
    const many = Object.fromEntries(Array.from({ length: NATIVE_EGRESS_LIMITS.maxHeaders + 1 }, (_, index) => [`x-${index}`, 'v']));
    expect(refusal(request({ headers: many }))).toBe('too-large');
    const wide = { 'x-note': 'x'.repeat(NATIVE_EGRESS_LIMITS.maxHeaderBytes + 1) };
    expect(refusal(request({ headers: wide }))).toBe('too-large');
    const long = 'x'.repeat(NATIVE_EGRESS_LIMITS.maxBodyBytes + 1);
    expect(refusal(request({ body: long }))).toBe('too-large');
  });

  it('measures the body cap in bytes, not characters', () => {
    const twoByte = 'é'.repeat(Math.floor(NATIVE_EGRESS_LIMITS.maxBodyBytes / 2) + 1);
    expect(refusal(request({ body: twoByte }))).toBe('too-large');
    const oneByteShort = 'x'.repeat(NATIVE_EGRESS_LIMITS.maxBodyBytes);
    expect(refusal(request({ body: oneByteShort }))).toBeUndefined();
  });
});

describe('a streamed answer', () => {
  const body = (...parts: string[]): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  }));

  it('hands each chunk on as it arrives, in order, and ends when the body does', async () => {
    const seen: string[] = [];
    const outcome = await pumpResponse(body('data: one\n\n', 'data: two\n\n'), (bytes) => seen.push(new TextDecoder().decode(bytes)));
    expect(outcome).toBe('ended');
    expect(seen).toEqual(['data: one\n\n', 'data: two\n\n']);
  });

  it('says a bodyless answer ended, so a 204 is not a failure', async () => {
    const outcome = await pumpResponse(new Response(null, { status: 204 }), () => { throw new Error('no bytes expected'); });
    expect(outcome).toBe('ended');
  });

  it('stops a body past the cap, without handing on the chunk that passed it', async () => {
    const limits = { ...NATIVE_EGRESS_LIMITS, maxResponseBytes: 8 };
    const seen: string[] = [];
    const outcome = await pumpResponse(body('1234', '5678', '9abc'), (bytes) => seen.push(new TextDecoder().decode(bytes)), limits);
    expect(outcome).toBe('too-large');
    expect(seen).toEqual(['1234', '5678']);
  });

  it('reports a body that breaks part-way, keeping what arrived before it', async () => {
    const seen: string[] = [];
    const broken = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: one\n\n')); },
      // The failure follows the chunk, as a dropped connection does: the reader gets what arrived, then the error.
      pull(controller) { controller.error(new Error('connection reset')); },
    }));
    const outcome = await pumpResponse(broken, (bytes) => seen.push(new TextDecoder().decode(bytes)));
    expect(outcome).toBe('unavailable');
    expect(seen).toEqual(['data: one\n\n']);
  });
});
