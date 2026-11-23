/**
 * The native egress rule — provider-gateway.md §9, desktop.md. The port the desktop app fetches through is only as safe as
 * this check: a request that passes here is one the host sends, and the allowlist is the only thing between a page and an
 * arbitrary address, so every refusal is asserted by kind rather than by "it throws".
 */

import { describe, expect, it } from 'vitest';
import {
  attachKeys,
  checkNativeEgress,
  createSecretScrubber,
  handleIds,
  keyHandle,
  NATIVE_EGRESS_LIMITS,
  nativeEgressTargets,
  normalizeOrigin,
  pumpResponse,
  redactSecrets,
} from '../src/index.js';

const ORIGINS = nativeEgressTargets([
  { origin: 'https://api.example.com' },
  { origin: 'https://models.example.org:8443' },
]);
const KEY = 'prv_ABCDEFGHJK';
const KEYED = nativeEgressTargets([{ origin: 'https://api.example.com', keys: [KEY] }]);

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
    expect([...ORIGINS.keys()].sort()).toEqual(['https://api.example.com', 'https://models.example.org:8443']);
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

  it('ignores entries that are not a bare origin', () => {
    const targets = nativeEgressTargets([
      { origin: 'https://api.example.com' },
      { origin: 'https://api.example.com/v1' },
      { origin: 'http://api.example.com' },
      { origin: 'https://user:secret@api.example.com' },
      42,
      null,
      'https://evil.example',
    ]);
    expect([...targets.keys()]).toEqual(['https://api.example.com']);
  });

  it('takes a local server on plain http and refuses one that is not this computer', () => {
    const targets = nativeEgressTargets([
      { origin: 'http://127.0.0.1:8787', local: true },
      { origin: 'http://localhost:8787', local: true },
      { origin: 'http://api.example.com', local: true },
      { origin: 'https://127.0.0.1:8787' },
    ]);
    expect([...targets.keys()].sort()).toEqual(['http://127.0.0.1:8787', 'http://localhost:8787']);
    for (const target of targets.values()) expect(target.local).toBe(true);
  });

  it('takes the key ids an entry names, and drops the ones that are not ids', () => {
    const targets = nativeEgressTargets([{ origin: 'https://api.example.com', keys: [KEY, 'mcp:abc-1', '', 7, 'bad id'] }]);
    expect([...targets.get('https://api.example.com')!.keys]).toEqual([KEY, 'mcp:abc-1']);
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
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(refusal(request({ method }))).toBeUndefined();
    }
    // A listing is the one GET this port carries, and a GET carries no body.
    expect(refusal(request({ method: 'GET', body: undefined }))).toBeUndefined();
  });

  it('refuses a request with no body when the method carries one', () => {
    expect(refusal(request({ body: undefined }))).toBeUndefined();
  });

  it('refuses a GET that carries a body, rather than letting the network stack refuse it', () => {
    // The stack errors on it, and an error there reaches the page as a dead network instead of the malformed request it is.
    expect(refusal(request({ method: 'GET', body: '{"model":"m"}' }))).toBe('invalid');
    expect(refusal(request({ method: 'GET', body: undefined }))).toBeUndefined();
  });
});

describe('a request the host refuses', () => {
  it('denies an address the writer never configured', () => {
    expect(refusal(request({ url: 'https://evil.example/v1/chat/completions' }))).toBe('denied');
    // The same host on another port is another origin, so a port is not a detail.
    expect(refusal(request({ url: 'https://api.example.com:8443/v1' }))).toBe('denied');
  });

  it('denies this computer unless the entry is a local server', () => {
    // A provider entry never names this computer: `nativeEgressTargets` drops it, so no allowlist can let a model call in.
    const dropped = nativeEgressTargets([{ origin: 'https://127.0.0.1:11434' }, { origin: 'https://localhost:1234' }]);
    expect(dropped.size).toBe(0);
    expect(refusal(request({ url: 'https://127.0.0.1:11434/v1/models' }), dropped)).toBe('denied');

    // A local entry may be, and then plain http to that literal is the only thing it adds.
    const local = nativeEgressTargets([{ origin: 'http://127.0.0.1:8787', local: true, keys: ['mcp:one'] }]);
    const allowed = checkNativeEgress(local, request({ url: 'http://127.0.0.1:8787/mcp', headers: { accept: 'application/json' }, body: undefined }));
    expect(allowed.ok).toBe(true);
    expect(refusal(request({ url: 'http://127.0.0.1:8790/mcp' }), local)).toBe('invalid');
    // A local entry is not a licence to reach another machine's port on this one's behalf.
    const elsewhere = checkNativeEgress(local, { url: 'http://127.0.0.1:8787/mcp', method: 'GET', headers: {} });
    expect(elsewhere.ok).toBe(true);
  });

  it('denies an IPv4-mapped spelling of this computer, which reaches the same address', () => {
    // A parsed URL writes every one of these as `[::ffff:7f00:1]`, the mapped form of 127.0.0.1: judged by its text alone it
    // would look like a public host, and the allowlist would be the only thing left between a page and this machine.
    const mapped = nativeEgressOrigins(['https://[::ffff:127.0.0.1]:11434', 'https://[::ffff:127.9.9.9]:11434']);
    expect(mapped.size).toBe(0);
    for (const url of ['https://[::ffff:127.0.0.1]:11434/v1', 'https://[0:0:0:0:0:ffff:127.0.0.1]:11434/v1', 'https://[::ffff:127.255.0.1]/v1']) {
      expect(refusal(request({ url }), mapped)).toBe('denied');
    }
    // An address that only shares the `::ffff:` prefix is still a public host.
    expect(refusal(request({ url: 'https://[::ffff:8.8.8.8]/v1' }))).toBe('denied');
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

describe('a key the request names', () => {
  const keyed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => request({
    headers: { authorization: `Bearer ${keyHandle(KEY)}` },
    ...overrides,
  });

  it('is a handle in the request and an id the check reads, once', () => {
    expect(handleIds(`Bearer ${keyHandle(KEY)} and ${keyHandle(KEY)}`)).toEqual([KEY]);
    expect(handleIds('nothing here')).toEqual([]);
    const checked = checkNativeEgress(KEYED, keyed());
    expect(checked.ok && checked.request.keys).toEqual([KEY]);
  });

  it('is read out of the URL too, because a provider may put it there', () => {
    const checked = checkNativeEgress(KEYED, request({ url: `https://api.example.com/v1/chat?key=${keyHandle(KEY)}`, method: 'GET', headers: {} }));
    expect(checked.ok && checked.request.keys).toEqual([KEY]);
  });

  it('refuses a key at an address that key was not configured for', () => {
    const other = nativeEgressTargets([{ origin: 'https://api.example.com', keys: ['mcp:somewhere-else'] }]);
    expect(refusal(keyed(), other)).toBe('denied');
    // The same handle at a second address is that address's key or no key at all.
    const twoHosts = nativeEgressTargets([{ origin: 'https://api.example.com', keys: [KEY] }, { origin: 'https://models.example.org:8443' }]);
    expect(refusal(keyed({ url: 'https://models.example.org:8443/v1/chat' }), twoHosts)).toBe('denied');
  });
});

describe('redactSecrets', () => {
  it('takes every secret out of a header value or a reason phrase, and leaves the rest as it came', () => {
    expect(redactSecrets('Bearer sk-live-1', ['sk-live-1'])).toBe('Bearer [redacted]');
    expect(redactSecrets('sk-a and sk-b', ['sk-a', 'sk-b'])).toBe('[redacted] and [redacted]');
    expect(redactSecrets('nothing here', [])).toBe('nothing here');
    // A provider that percent-encodes a key in a header echoes it encoded, and that is a secret of the call too.
    expect(redactSecrets('key=a%2Bb', ['a+b', 'a%2Bb'])).toBe('key=[redacted]');
  });
});

describe('a secret in an answer', () => {
  const SECRET = 'sk-live-0123456789abcdef';
  const collected = (): { seen: string[]; scrubber: ReturnType<typeof createSecretScrubber> } => {
    const seen: string[] = [];
    const scrubber = createSecretScrubber([SECRET], (bytes) => seen.push(new TextDecoder().decode(bytes)));
    return { seen, scrubber };
  };

  it('never leaves in a chunk, even when the provider’s answer is split through it', () => {
    const { seen, scrubber } = collected();
    for (const part of ['{"error":"bad key sk-live-0', '123456789abcdef"}']) {
      scrubber.write(new TextEncoder().encode(part));
    }
    scrubber.end();
    expect(seen.join('')).toBe('{"error":"bad key [redacted]"}');
  });

  it('passes an answer with no secret through as it came', () => {
    const { seen, scrubber } = collected();
    for (const part of ['data: one\n\n', 'data: two\n\n']) scrubber.write(new TextEncoder().encode(part));
    scrubber.end();
    expect(seen.join('')).toBe('data: one\n\ndata: two\n\n');
  });

  it('is not the answer when nothing was attached: the sink is the one it was given', () => {
    const seen: string[] = [];
    const sink = (bytes: Uint8Array): void => { seen.push(new TextDecoder().decode(bytes)); };
    const scrubber = createSecretScrubber([], sink);
    expect(scrubber).toEqual({ write: sink, end: expect.any(Function) });
    scrubber.write(new TextEncoder().encode('anything'));
    expect(seen).toEqual(['anything']);
  });

  it('holds back only what could still begin a secret, so a stream still arrives as it is written', () => {
    const { seen, scrubber } = collected();
    scrubber.write(new TextEncoder().encode('0123456789'.repeat(4)));
    // The first write releases everything but the last secret-length-minus-one bytes.
    expect(seen.join('').length).toBe(40 - (SECRET.length - 1));
    scrubber.end();
    expect(seen.join('').length).toBe(40);
  });
});

describe('attaching a key to the request that named it', () => {
  const SECRET = 'sk-live-0123456789abcdef';
  const named = (overrides: Record<string, unknown> = {}) => ({
    url: 'https://api.example.com/v1/chat/completions',
    headers: { authorization: `Bearer ${keyHandle(KEY)}`, 'x-other': 'kept' },
    keys: [KEY],
    ...overrides,
  });

  it('puts the secret where the handle stood in a header, and leaves every other header alone', () => {
    const attached = attachKeys(named(), new Map([[KEY, SECRET]]));
    expect(attached.headers).toEqual({ authorization: `Bearer ${SECRET}`, 'x-other': 'kept' });
    expect(attached.url).toBe('https://api.example.com/v1/chat/completions');
    expect(attached.values).toEqual([SECRET]);
  });

  it('percent-encodes a secret that stood in a URL, and leaves the rest of the address as it was', () => {
    const handle = keyHandle(KEY);
    const attached = attachKeys(named({ url: `https://api.example.com/v1/models?key=${handle}&page=2`, keys: [KEY] }), new Map([[KEY, 'a+b/c=']]));
    expect(attached.url).toBe('https://api.example.com/v1/models?key=a%2Bb%2Fc%3D&page=2');
    // A header is not a URL: the same secret goes in it as it is.
    expect(attached.headers.authorization).toBe('Bearer a+b/c=');
    // Both forms are secrets of this call, because a provider echoes back the encoded one it read from the query.
    expect(attached.values).toEqual(['a+b/c=', 'a%2Bb%2Fc%3D']);
  });

  it('scrubs the encoded form a provider echoes from the URL, and the raw form it may put anywhere else', () => {
    const attached = attachKeys(named({ url: `https://api.example.com/v1/models?key=${keyHandle(KEY)}`, keys: [KEY] }), new Map([[KEY, 'a+b/c=']]));
    const seen: string[] = [];
    const scrubber = createSecretScrubber(attached.values, (bytes) => seen.push(new TextDecoder().decode(bytes)));
    scrubber.write(new TextEncoder().encode('{"url":"?key=a%2Bb%2Fc%3D","hint":"a+b/c="}'));
    scrubber.end();
    expect(seen.join('')).toBe('{"url":"?key=[redacted]","hint":"[redacted]"}');
  });

  it('attaches nothing for a key the caller does not hold, and names only what it did attach', () => {
    const attached = attachKeys(named({ keys: [KEY, 'mcp:missing'] }), new Map([[KEY, SECRET]]));
    expect(attached.values).toEqual([SECRET]);
    expect(attached.headers.authorization).toBe(`Bearer ${SECRET}`);
  });
});
