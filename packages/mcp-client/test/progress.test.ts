/**
 * A long external call (extensibility §3.3): the server reports progress, the idle limit is 120 s and each report starts it again, no
 * call runs past 10 minutes whatever it reports, and a call the writer stops ends cancelled, with the server told. These run on the
 * SDK's own wire against the in-process server, with the clock faked, so the limits are the real ones.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CALL_MAX_TOTAL_MS,
  CALL_TIMEOUT_MS,
  McpFailure,
  cancelledText,
  createMcpClient,
  createMcpTransport,
  timeoutText,
  totalTimeoutText,
  type McpClient,
  type WireProgress,
} from '../src/index.js';
import { FIXED_NOW, serverFor, startInProcessServer, textResult, type FixtureCall, type FixtureState, type InProcessServer } from './support.js';

const KEY = 's_AAAAAAAAAA';
const TOOLS = [
  { name: 'slow_search', description: 'Search the shelf.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'slow_write', description: 'Write a note.', inputSchema: { type: 'object' } },
];

const fixtures: InProcessServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (fixtures.length > 0) await fixtures.pop()?.close();
});

/** A server with no modern revision answers the 2026 probe with "method not found"; every other request goes to the fixture. */
function legacyOnly(server: InProcessServer): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const parsed = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as { id?: unknown; method?: unknown } | null;
    if (parsed?.method === 'server/discover') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32601, message: 'Method not found' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return server.fetch(input, init);
  };
}

/** Waits on the faked clock, or until the caller has gone. */
function sleep(ms: number, call: FixtureCall): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    call.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

/** A connected, reviewed client over a server whose `slow_search` runs `respond`. The clock is faked after the connection, which needs none. */
async function opened(respond: FixtureState['respond'], revisions?: readonly string[]): Promise<{ client: McpClient; server: InProcessServer }> {
  const server = startInProcessServer({ tools: TOOLS.map((tool) => ({ ...tool })), respond }, revisions === undefined ? {} : { revisions });
  fixtures.push(server);
  const client = createMcpClient({
    settings: { enabled: true, servers: [serverFor(KEY)] },
    fetch: revisions === undefined ? server.fetch : legacyOnly(server),
    probe: async () => false,
    now: () => FIXED_NOW,
  });
  await client.connect(KEY);
  client.approveReview(KEY, client.review(KEY)?.fingerprint ?? '');
  vi.useFakeTimers();
  return { client, server };
}

/** Runs a call to its end on the faked clock, advancing it in steps so the timers fire in order. */
async function settle<T>(promise: Promise<T>, seconds: number): Promise<T | McpFailure> {
  const outcome = promise.catch((error: unknown) => error as McpFailure);
  await vi.advanceTimersByTimeAsync(seconds * 1000);
  return outcome;
}

describe('progress and the idle limit', () => {
  it('lets a call run past 120 s while the server reports every 50 s, and hands each report on', async () => {
    const { client } = await opened(async (_name, _args, call) => {
      for (let step = 1; step <= 5; step += 1) {
        await sleep(50_000, call);
        await call.progress({ progress: step, total: 5, message: `chapter ${step} of 5` });
      }
      return textResult('done');
    });
    const reports: WireProgress[] = [];
    const result = await settle(createMcpTransport(client).callTool(KEY, 'slow_search', {}, { onProgress: (report) => reports.push(report) }), 300);
    expect(result).toEqual({ content: [{ type: 'text', text: 'done' }], isError: false });
    expect(reports).toEqual([1, 2, 3, 4, 5].map((step) => ({ progress: step, total: 5, message: `chapter ${step} of 5` })));
  });

  it('fails a call that says nothing at 120 s, with the idle limit’s message, and leaves the server healthy', async () => {
    const { client } = await opened(async (_name, _args, call) => {
      await sleep(10 * 60_000, call);
      return textResult('late');
    });
    const failure = await settle(createMcpTransport(client).callTool(KEY, 'slow_search', {}), CALL_TIMEOUT_MS / 1000 + 1);
    expect(failure).toBeInstanceOf(McpFailure);
    expect((failure as McpFailure).error).toEqual({ code: 'timeout', message: timeoutText(CALL_TIMEOUT_MS) });
    expect((failure as McpFailure).error.message).toBe('external call timed out after 120 s — no partial results exist');
    expect(client.healthOf(KEY)?.state).toBe('healthy');
  });

  it('fails a call that reported once and then went quiet 120 s after the report, not 120 s after it began', async () => {
    const { client } = await opened(async (_name, _args, call) => {
      await sleep(100_000, call);
      await call.progress({ progress: 1 });
      await sleep(10 * 60_000, call);
      return textResult('late');
    });
    let settled = false;
    const outcome = createMcpTransport(client).callTool(KEY, 'slow_search', {}).catch((error: unknown) => error as McpFailure);
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(settled).toBe(true);
    expect(((await outcome) as McpFailure).error.message).toBe(timeoutText(CALL_TIMEOUT_MS));
  });
});

describe('the wall-clock cap', () => {
  it('fails a call that reports for ever at exactly 10 minutes, and the message names the cap', async () => {
    const { client } = await opened(async (_name, _args, call) => {
      for (let step = 1; !call.signal.aborted; step += 1) {
        await sleep(50_000, call);
        await call.progress({ progress: step });
      }
      return textResult('never');
    });
    const reports: WireProgress[] = [];
    let settled = false;
    const outcome = createMcpTransport(client)
      .callTool(KEY, 'slow_search', {}, { onProgress: (report) => reports.push(report) })
      .catch((error: unknown) => error as McpFailure);
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(CALL_MAX_TOTAL_MS - 1_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(true);
    const failure = (await outcome) as McpFailure;
    expect(failure).toBeInstanceOf(McpFailure);
    expect(failure.error).toEqual({ code: 'timeout', message: totalTimeoutText(CALL_MAX_TOTAL_MS) });
    expect(failure.error.message).toContain('600 s');
    expect(reports.length).toBeGreaterThanOrEqual(11);
  });

  it('is exact when the last report came just before the cap, not the cap plus an idle limit', async () => {
    const { client } = await opened(async (_name, _args, call) => {
      for (const wait of [100, 100, 100, 100, 100, 99]) {
        await sleep(wait * 1000, call);
        await call.progress({ progress: wait });
      }
      await sleep(10 * 60_000, call);
      return textResult('never');
    });
    let settled = false;
    const outcome = createMcpTransport(client).callTool(KEY, 'slow_search', {}).catch((error: unknown) => error as McpFailure);
    void outcome.then(() => (settled = true));
    // The last report is at 599 s, which would start a new 120 s idle limit that ends at 719 s. Only the cap can end the call at 600 s.
    await vi.advanceTimersByTimeAsync(CALL_MAX_TOTAL_MS - 2_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe(true);
    expect(((await outcome) as McpFailure).error.message).toBe(totalTimeoutText(CALL_MAX_TOTAL_MS));
  });
});

describe('a call the writer stops', () => {
  it('ends cancelled, with a message that does not claim a timeout or a clean result, and the server sees the request go', async () => {
    let serverSawAbort = false;
    const { client } = await opened(async (_name, _args, call) => {
      await sleep(60_000, call);
      serverSawAbort = call.signal.aborted;
      return textResult('too late');
    });
    const controller = new AbortController();
    const outcome = createMcpTransport(client)
      .callTool(KEY, 'slow_search', {}, { signal: controller.signal })
      .catch((error: unknown) => error as McpFailure);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    const failure = await outcome;
    expect(failure).toBeInstanceOf(McpFailure);
    expect((failure as McpFailure).error).toEqual({ code: 'cancelled', message: cancelledText() });
    expect((failure as McpFailure).error.message).toContain('may already have done part of the work');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(serverSawAbort).toBe(true);
    expect(client.healthOf(KEY)?.state).toBe('healthy');
  });

  it('tells a 2025-era server with notifications/cancelled', async () => {
    const { client, server } = await opened(async (_name, _args, call) => {
      await sleep(60_000, call);
      return textResult('too late');
    }, ['2025-06-18']);
    const controller = new AbortController();
    const outcome = createMcpTransport(client)
      .callTool(KEY, 'slow_search', {}, { signal: controller.signal })
      .catch((error: unknown) => error as McpFailure);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(((await outcome) as McpFailure).error.code).toBe('cancelled');
    expect(server.posts.map((post) => post.method)).toContain('notifications/cancelled');
  });
});
