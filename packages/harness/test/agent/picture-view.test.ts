/**
 * `pictures.view` in the agent loop: an async read runs without a confirmation, and its image parts
 * follow the tool results in one user message on either planner wire (pictures.md §8.1).
 */

import { describe, expect, it } from 'vitest';

import { ok } from '@caotang/bus';
import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  type ChatRequest,
  type Gateway,
  type ImagePart,
} from '@caotang/gateway';
import { createMockProvider, userTextOf, type MockScript } from '@caotang/gateway/mock';

import { createAgentSession, createPictureOutbox, type AsyncToolPort, type PictureOutbox } from '../../src/index.js';
import { makeHarness } from '../fixtures.js';
import { answer, steps, transcript } from './scripts.js';

/** A well-formed image part: the gateway checks the signature, size and hash shape, not the hash's value. */
function image(caption: string): ImagePart {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes[19] = 1;
  bytes[23] = 1;
  return { type: 'image', mime: 'image/png', bytes, hash: '0'.repeat(64), size: bytes.length, caption };
}

/** The real gateway over a vision-capable mock, with native tools on only for the native-wire test. */
async function pictureGateway(scripts: readonly MockScript[], native: boolean): Promise<Gateway> {
  const clock = createManualClock(0);
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  return createGateway({ profiles, keys, clock, mock: createMockProvider({ scripts: [...scripts], capsTools: native, capsVision: true }) });
}

function viewPort(outbox: PictureOutbox, calls: string[]): AsyncToolPort {
  return async (params, context) => {
    const id = String((params['assetIds'] as unknown[])[0]);
    calls.push(id);
    outbox.deliver(context.turnId, [image(`caption for ${id}`)]);
    return ok({ data: { pictures: [{ id }] }, summary: `attached ${id}`, affected: [] });
  };
}

function imagePartsOf(request: ChatRequest | undefined): ImagePart[] {
  return (request?.messages ?? []).flatMap((message) =>
    typeof message.content === 'string' ? [] : message.content.filter((part): part is ImagePart => part.type === 'image'),
  );
}

describe('pictures.view in the agent loop', () => {
  it('runs two async reads without a card and sends their images once, in call order, after the JSON-wire results', async () => {
    const intent = 'Look at two pictures.';
    const outbox = createPictureOutbox();
    const calls: string[] = [];
    const harness = makeHarness({ asyncPorts: { 'pictures.view': viewPort(outbox, calls) } });
    const seen: ChatRequest[] = [];
    const gateway = await pictureGateway(
      [
        transcript(intent, [
          steps(
            { tool: 'pictures.view', params: { assetIds: ['a_0000000001'] }, expect: 'the first picture' },
            { tool: 'pictures.view', params: { assetIds: ['a_0000000002'] }, expect: 'the second picture' },
          ),
          answer('I can see both.'),
        ], seen),
      ],
      false,
    );
    let decisions = 0;
    const session = createAgentSession({
      harness,
      gateway,
      pictureOutbox: outbox,
      decide: async () => {
        decisions += 1;
        return { action: 'cancel' };
      },
      sessionId: 'picture-json',
    });

    const report = await session.submit(intent);
    expect(report.status).toBe('replied');
    expect(report.trace.map((row) => [row.tool, row.outcome])).toEqual([
      ['pictures.view', 'ok'],
      ['pictures.view', 'ok'],
    ]);
    expect(calls).toEqual(['a_0000000001', 'a_0000000002']);
    expect(decisions).toBe(0);

    const followUp = seen[1];
    const result = followUp?.messages.at(-2);
    const pictures = followUp?.messages.at(-1);
    expect(result?.role).toBe('user');
    expect(typeof result?.content).toBe('string');
    expect(pictures?.role).toBe('user');
    expect(Array.isArray(pictures?.content)).toBe(true);
    expect(imagePartsOf(followUp).map((part) => part.caption)).toEqual(['caption for a_0000000001', 'caption for a_0000000002']);
    expect(outbox.take(report.turnId)).toEqual([]);
  });

  it('puts the native tool result before one user image message, never on the tool message', async () => {
    const intent = 'Look at one picture.';
    const outbox = createPictureOutbox();
    const calls: string[] = [];
    const harness = makeHarness({ asyncPorts: { 'pictures.view': viewPort(outbox, calls) } });
    const script: MockScript = {
      match: (req) => (req.tools?.length ?? 0) > 0 && userTextOf(req).includes(`Request: ${intent}`),
      respond: (req) =>
        req.messages.some((message) => message.role === 'assistant')
          ? { content: 'I can see it.' }
          : {
              content: 'Looking.',
              toolCalls: [{ id: 'view-1', name: 'pictures.view', argumentsJson: JSON.stringify({ assetIds: ['a_0000000001'] }) }],
            },
    };
    const base = await pictureGateway([script], true);
    const seen: ChatRequest[] = [];
    const gateway: Gateway = {
      ...base,
      complete: (request, signal) => {
        seen.push(request);
        return base.complete(request, signal);
      },
    };
    let decisions = 0;
    const session = createAgentSession({
      harness,
      gateway,
      pictureOutbox: outbox,
      decide: async () => {
        decisions += 1;
        return { action: 'cancel' };
      },
      sessionId: 'picture-native',
    });

    const report = await session.submit(intent);
    expect(report.status).toBe('replied');
    expect(report.trace.map((row) => [row.tool, row.outcome])).toEqual([['pictures.view', 'ok']]);
    expect(decisions).toBe(0);

    const followUp = seen.filter((request) => (request.tools?.length ?? 0) > 0)[1];
    const result = followUp?.messages.at(-2);
    const pictures = followUp?.messages.at(-1);
    expect(result).toMatchObject({ role: 'tool', toolCallId: 'view-1' });
    expect(typeof result?.content).toBe('string');
    expect(pictures?.role).toBe('user');
    expect(Array.isArray(pictures?.content)).toBe(true);
    expect(imagePartsOf(followUp).map((part) => part.caption)).toEqual(['caption for a_0000000001']);
    expect(outbox.take(report.turnId)).toEqual([]);
  });

  it('drops an unflushed image when the writer stops the turn between reads', async () => {
    const intent = 'Stop between pictures.';
    const outbox = createPictureOutbox();
    const abort = new AbortController();
    let calls = 0;
    const port: AsyncToolPort = async (params, context) => {
      calls += 1;
      const id = String((params['assetIds'] as unknown[])[0]);
      outbox.deliver(context.turnId, [image(`caption for ${id}`)]);
      abort.abort();
      return ok({ data: { pictures: [{ id }] }, summary: `attached ${id}`, affected: [] });
    };
    const harness = makeHarness({ asyncPorts: { 'pictures.view': port } });
    const gateway = await pictureGateway(
      [
        transcript(intent, [
          steps(
            { tool: 'pictures.view', params: { assetIds: ['a_0000000001'] }, expect: 'the first picture' },
            { tool: 'pictures.view', params: { assetIds: ['a_0000000002'] }, expect: 'the second picture' },
          ),
        ]),
      ],
      false,
    );
    const session = createAgentSession({ harness, gateway, pictureOutbox: outbox, decide: async () => ({ action: 'cancel' }), sessionId: 'picture-stop' });

    const report = await session.submit(intent, { signal: abort.signal });
    expect(report.status).toBe('cancelled');
    expect(calls).toBe(1);
    expect(outbox.take(report.turnId)).toEqual([]);
  });

  it('lets an external caller use the async read but refuses its async write before the port runs', async () => {
    const outbox = createPictureOutbox();
    const reads: string[] = [];
    let writes = 0;
    const harness = makeHarness({
      asyncPorts: {
        'pictures.view': viewPort(outbox, reads),
        'pictures.import': async () => {
          writes += 1;
          return ok({ data: {}, summary: 'imported', affected: [] });
        },
      },
    });
    const read = await harness.callAsync(
      { name: 'pictures.view', callId: 'external-view', params: { assetIds: ['a_0000000001'] } },
      { turnId: 'external-pictures', source: 'mcp' },
    );
    expect(read.ok).toBe(true);
    expect(reads).toEqual(['a_0000000001']);
    expect(outbox.take('external-pictures').map((part) => part.caption)).toEqual(['caption for a_0000000001']);

    const write = await harness.callAsync(
      { name: 'pictures.import', callId: 'external-import', params: { stagingId: 'stg_ABCDEF0123' } },
      { turnId: 'external-pictures', source: 'mcp', permission: { confirmed: true } },
    );
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe('permission-denied');
    expect(writes).toBe(0);
  });
});
