/**
 * The one module that talks to an untrusted server: the fetch every request goes through
 * (wire.ts). A server the writer connected can answer with a body of any size, and nothing
 * but this bound stops it spending the tab's memory before the 8k answer cap can refuse it
 * (extensibility.md §3.3, §4 rule 6).
 *
 * The bound is on one answer. An event stream is not one answer but a sequence of them: the SDK's
 * client reads a stream event by event, and a server that keeps a connection open carries every
 * notification for the life of that connection in one body, so the bytes of one stream add up far
 * past the budget of a single answer while every event in it stays small. A healthy server that
 * streams more than the budget over that life is not cut off for it.
 */

import { describe, expect, it } from 'vitest';

import { WireError, createStreamableHttpWire, type McpServerConfig, type WireDeps } from '../src/index.js';

const SERVER: McpServerConfig = {
  key: 's_AAAAAAAAAA',
  name: 'Example tools',
  transport: 'http',
  url: 'https://tools.example/mcp',
  auth: { kind: 'none' },
  enabled: true,
  trustReads: false,
  pinnedTools: {},
  addedAt: '2026-10-20T09:00:00.000Z',
};

/** The protocol revision the SDK's client and this test's server speak. */
const REVISION = '2026-07-28';

/**
 * A fetch that answers with a body of `bytes`, in many chunks. A server streams its answer, so
 * the bound has to hold across the stream and not just across one already-materialised buffer.
 */
function hugeFetch(bytes: number): WireDeps['fetch'] {
  const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (bytes <= 0) {
            controller.close();
            return;
          }
          bytes -= chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

function depsOf(fetchImpl: WireDeps['fetch']): WireDeps {
  return {
    resolveBearer: async () => undefined,
    fetch: fetchImpl,
    probe: async () => true,
  };
}

/**
 * The bytes of a run of notifications, each of them its own event. A server that keeps a
 * connection open streams notifications for the life of it, so one stream carries far more than
 * one answer's worth of bytes while every event in it is small.
 */
function notifications(bytes: number): Uint8Array {
  const event = `event: notification\ndata: ${'x'.repeat(64 * 1024)}\n\n`;
  return new TextEncoder().encode(event.repeat(Math.ceil(bytes / event.length)));
}

/** The bytes of one event, and of nothing else. */
function oneEvent(bytes: number): Uint8Array {
  return new TextEncoder().encode(`event: notification\ndata: ${'x'.repeat(bytes)}\n\n`);
}

/**
 * A server of the current revision that answers a request over an event stream, with the answer
 * behind `ahead` bytes of events. The SDK's client reads the stream event by event, so the answer
 * arrives after everything in front of it.
 *
 * The version probe is answered with one JSON body, the way a server of this revision answers it;
 * every request after it is answered with a stream, the way a server of the 2025 era answers one.
 */
function streamingServer(ahead: Uint8Array): WireDeps['fetch'] {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as { id?: string | number; method?: string };
    const meta = { 'io.modelcontextprotocol/serverInfo': { name: 'caotang-mcp-client-fixture', version: '0.0.0' } };
    if (request.method === 'server/discover') {
      const result = { supportedVersions: [REVISION], capabilities: { tools: {} }, resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: meta };
      return new Response(JSON.stringify({ result, jsonrpc: '2.0', id: request.id }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const result = { tools: [{ name: 'search_lore', description: 'Find a lore entry.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }], resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: meta };
    const answer = new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ result, jsonrpc: '2.0', id: request.id })}\n\n`);
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(ahead);
          return;
        }
        controller.enqueue(answer);
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

describe('a server answer is bounded before it is read', () => {
  it('refuses a listing whose body is over the budget, naming the size it refused', async () => {
    const wire = createStreamableHttpWire(SERVER, depsOf(hugeFetch(300 * 1024 * 1024)));
    const error = await wire.listTools({ timeoutMs: 5_000 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WireError);
    expect((error as WireError).kind).toBe('result');
    expect((error as WireError).message).toMatch(/over the .* budget/);
  });

  it('refuses a call result whose body is over the budget, and never parses it', async () => {
    const wire = createStreamableHttpWire(SERVER, depsOf(hugeFetch(200 * 1024 * 1024)));
    const error = await wire.callTool('search_lore', { query: 'x' }, { timeoutMs: 5_000 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WireError);
    expect((error as WireError).kind).toBe('result');
  });

  it('lets a small answer through unchanged', async () => {
    const wire = createStreamableHttpWire(SERVER, depsOf(hugeFetch(64 * 1024)));
    // A body well under the budget reaches the SDK to be read; the bound refuses only what is over it.
    const error = await wire.listTools({ timeoutMs: 5_000 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error === undefined || (error as WireError).kind !== 'result').toBe(true);
  });
});

describe('an event stream is bounded event by event, not as a whole', () => {
  it('is not cut when the stream carries more than the budget over the life of the connection', async () => {
    // Seventeen mebibytes of notifications, every one of them a small event, in front of the answer.
    const wire = createStreamableHttpWire(SERVER, depsOf(streamingServer(notifications(17 * 1024 * 1024))));
    try {
      const tools = await wire.listTools({ timeoutMs: 30_000 });
      expect(tools.map((tool) => tool.name)).toEqual(['search_lore']);
    } finally {
      await wire.close();
    }
  });

  it('is refused when one event of it is over the budget, and the refusal names the size', async () => {
    // One event of seventeen mebibytes: the whole answer is inside the budget, and the event is not.
    const wire = createStreamableHttpWire(SERVER, depsOf(streamingServer(oneEvent(17 * 1024 * 1024))));
    try {
      // The refusal tears the stream down, so the answer never arrives and the request runs out
      // of time. What the person is told is the refusal, not the wait.
      const error = await wire.listTools({ timeoutMs: 2_000 }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(WireError);
      expect((error as WireError).kind).toBe('result');
      expect((error as WireError).message).toMatch(/budget/);
    } finally {
      await wire.close();
    }
  }, 15_000);
});
