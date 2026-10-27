/**
 * A slow external call through `mcp.invoke` on the mock wire (extensibility §3.3, §6): the server’s progress is cleaned to plain text and handed
 * to the caller, a call the caller cancels or that runs past a limit ends as a failure that says the server may already have acted (unless the
 * tool is a trusted read), and the activity row says the same. The mock holds a slow call to the limits the real wire does.
 */

import type { ApplyContext } from '@caotang/bus';
import { describe, expect, it } from 'vitest';

import {
  PROGRESS_MESSAGE_CAP,
  applyMcpInvoke,
  cleanProgress,
  cleanProgressMessage,
  createLoadedTools,
  createMcpClient,
  createMcpTransport,
  createMockWireFactory,
  prepareInvoke,
  type McpCallOptions,
  type McpInvokeNormalized,
  type MockMcpScript,
  type WireProgress,
} from '../src/index.js';
import { STORY_KEY, echoScript, qualified, storyTools } from './fixtures.js';
import { FIXED_NOW, serverFor } from './support.js';

describe('a server’s progress, cleaned', () => {
  it('keeps plain text and numbers, and drops what is not usable', () => {
    expect(cleanProgress({ progress: 2, total: 5, message: 'Reading chapter 2' })).toEqual({ progress: 2, total: 5, message: 'Reading chapter 2' });
    expect(cleanProgress({ progress: 2 })).toEqual({ progress: 2 });
    expect(cleanProgress({ progress: 'two' })).toBeUndefined();
    expect(cleanProgress({ progress: Number.NaN })).toBeUndefined();
    expect(cleanProgress({ progress: -1 })).toBeUndefined();
    expect(cleanProgress({ progress: 1, total: 0, message: '   ' })).toEqual({ progress: 1 });
    expect(cleanProgress({ progress: 1, total: Number.POSITIVE_INFINITY })).toEqual({ progress: 1 });
  });

  it('cuts a message to 200 characters, ellipsis included, and never in the middle of a character', () => {
    const long = cleanProgressMessage('a'.repeat(500));
    expect(Array.from(long)).toHaveLength(PROGRESS_MESSAGE_CAP);
    expect(long.endsWith('…')).toBe(true);
    const emoji = cleanProgressMessage('😀'.repeat(300));
    expect(Array.from(emoji)).toHaveLength(PROGRESS_MESSAGE_CAP);
    expect(emoji.includes('�')).toBe(false);
    expect(cleanProgressMessage('b'.repeat(200))).toBe('b'.repeat(200));
  });

  it('turns control and direction-changing characters into a space, so a message is one line of plain text', () => {
    expect(cleanProgressMessage('line one\nline two\t\u0007done')).toBe('line one line two done');
    expect(cleanProgressMessage('‮evil‬ text')).toBe('evil text');
    expect(cleanProgressMessage('\n\n  start')).toBe('start');
  });
});

type Report = Parameters<ApplyContext['report']>[0];

/** A story server whose `lore_lookup` (a trusted read) and `lore_update` (a write) both run `slow`, and a client over it with the given limits. */
async function invocation(tool: 'lore_lookup' | 'lore_update', slow: NonNullable<MockMcpScript['run']>, limits: { callTimeoutMs?: number; callMaxTotalMs?: number } = {}) {
  const server = serverFor(STORY_KEY, 'Story Bible', { url: 'https://story.fixture.test/mcp' });
  const client = createMcpClient({
    settings: { enabled: true, servers: [server] },
    wire: createMockWireFactory({ [STORY_KEY]: { ...echoScript(storyTools()), run: slow } }),
    now: () => FIXED_NOW,
    ...limits,
  });
  await client.connect(STORY_KEY);
  client.approveReview(STORY_KEY, client.review(STORY_KEY)?.fingerprint ?? '');
  client.setTrustReads(STORY_KEY, true);
  const loaded = createLoadedTools();
  loaded.beginTurn('turn-1');
  loaded.load([qualified(STORY_KEY, tool)]);
  const args = tool === 'lore_lookup' ? { name: 'Mara' } : { entry: 'Mara', text: 'A note.' };
  const prepared = prepareInvoke({ client, loaded }, { serverKey: STORY_KEY, toolName: tool, args });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const reports: Report[] = [];
  const run = (callOptions?: McpCallOptions) =>
    applyMcpInvoke(
      { client, loaded, transport: createMcpTransport(client), ...(callOptions === undefined ? {} : { callOptions: () => callOptions }) },
      prepared.value as McpInvokeNormalized,
      { report: (report) => reports.push(report) },
    );
  return { run, reports };
}

describe('a slow call through mcp.invoke', () => {
  it('hands the caller each report, cleaned, while the call runs', async () => {
    const seen: WireProgress[] = [];
    const { run } = await invocation('lore_lookup', async (_tool, _args, call) => {
      call.progress({ progress: 1, total: 3, message: 'one\ntwo' });
      await call.wait(5);
      return { content: [{ type: 'text', text: 'found' }], isError: false };
    });
    const outcome = await run({ onProgress: (report) => seen.push(report) });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([{ progress: 1, total: 3, message: 'one two' }]);
  });

  it('lets a call run past the idle limit while the server reports, and fails one that goes quiet', async () => {
    const reporting = await invocation(
      'lore_lookup',
      async (_tool, _args, call) => {
        for (let step = 0; step < 6; step += 1) {
          await call.wait(20);
          call.progress({ progress: step });
        }
        return { content: [{ type: 'text', text: 'found' }], isError: false };
      },
      { callTimeoutMs: 50 },
    );
    expect((await reporting.run()).ok).toBe(true);
    const quiet = await invocation('lore_lookup', (_tool, _args, call) => call.wait(500).then(() => ({ content: [], isError: false })), { callTimeoutMs: 50 });
    const outcome = await quiet.run();
    if (outcome.ok) throw new Error('a quiet call must time out');
    expect(outcome.error.message).toContain('external call timed out after 0.05 s — no partial results exist');
  });

  it('ends a write the caller cancelled as a failure that may have acted, in the row, the message and the details', async () => {
    const controller = new AbortController();
    const { run, reports } = await invocation('lore_update', async (_tool, _args, call) => {
      setTimeout(() => controller.abort(), 5);
      await call.wait(60_000);
      return { content: [], isError: false };
    });
    const outcome = await run({ signal: controller.signal });
    if (outcome.ok) throw new Error('a cancelled call must not succeed');
    expect(outcome.error.code).toBe('io-error');
    expect(outcome.error.message).toBe('external call cancelled before the server answered — the server may already have done part of the work');
    expect(outcome.error.details).toMatchObject({ mayHaveActed: true });
    expect(reports.at(-1)?.summary).toBe('called Story Bible › lore_update (external) — cancelled before the server answered; the server may already have done part of the work');
  });

  it('does not say a trusted read may have acted when it is cancelled', async () => {
    const controller = new AbortController();
    const { run, reports } = await invocation('lore_lookup', async (_tool, _args, call) => {
      setTimeout(() => controller.abort(), 5);
      await call.wait(60_000);
      return { content: [], isError: false };
    });
    const outcome = await run({ signal: controller.signal });
    if (outcome.ok) throw new Error('a cancelled call must not succeed');
    expect(outcome.error.details?.mayHaveActed).toBeUndefined();
    expect(reports.at(-1)?.summary).toBe('called Story Bible › lore_lookup (external) — cancelled before the server answered');
  });

  it('records a write that timed out as timed out and possibly acted, never as a result', async () => {
    const { run, reports } = await invocation('lore_update', (_tool, _args, call) => call.wait(500).then(() => ({ content: [], isError: false })), { callTimeoutMs: 40 });
    const outcome = await run();
    if (outcome.ok) throw new Error('a timed-out call must not succeed');
    expect(outcome.error.message).toBe('external call timed out after 0.04 s — no partial results exist. The server may already have done part of the work, and Caotang cannot undo it');
    expect(outcome.error.details).toMatchObject({ mayHaveActed: true });
    expect(reports.at(-1)?.summary).toBe('called Story Bible › lore_update (external) — timed out; the server may already have done part of the work');
  });

  it('names the wall-clock cap for a call that kept reporting past it', async () => {
    const { run } = await invocation(
      'lore_lookup',
      async (_tool, _args, call) => {
        for (;;) {
          await call.wait(10);
          call.progress({ progress: 1 });
        }
      },
      { callTimeoutMs: 1_000, callMaxTotalMs: 60 },
    );
    const outcome = await run();
    if (outcome.ok) throw new Error('a call past its cap must not succeed');
    expect(outcome.error.message).toBe('external call stopped after 0.06 s, the longest any call may run even while the server reports progress — no partial results exist');
  });
});
