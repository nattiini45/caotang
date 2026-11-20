/**
 * A route's switch in the trace (agent-harness §5.2, provider-gateway §3.1 and §6): the call that took over reports it under its own
 * record, so an export says which provider answered and the fault that ended the attempt before it. A role with no fallbacks writes
 * the same records it always did, and nothing about a switch.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  type FetchLike,
} from '@caotang/gateway';

import { traceGateway, type TraceInput } from '../../src/index.js';

type RequestInput = Extract<TraceInput, { kind: 'model.request' }>;
type ResponseInput = Extract<TraceInput, { kind: 'model.response' }>;

const KEY = 'test-key';

const chunk = (part: object, finish: string | null, usage?: object): string =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: part, finish_reason: finish }], usage })}\n\n`;

const done = (text: string): Response =>
  new Response(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop', { prompt_tokens: 20, completion_tokens: 5 }) + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const limited = (): Response => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } });

/** Two profiles — a role's primary and the one the writer listed — and a gateway whose trace goes to `records`. */
async function routed(replies: (() => Response)[], fallbacks: boolean) {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const primary = await profiles.create({ name: 'First', kind: 'endpoint', baseUrl: 'https://a.example/v1', apiKey: KEY, defaultModel: 'model-a', isActive: true });
  const second = await profiles.create({ name: 'Second', kind: 'endpoint', baseUrl: 'https://b.example/v1', apiKey: KEY, defaultModel: 'model-b' });
  const records: TraceInput[] = [];
  const sink = { write: (record: TraceInput) => { records.push(record); } };
  const fetch = vi.fn<FetchLike>(async () => (replies.shift() ?? (() => done('extra')))());
  const gateway = createGateway({
    profiles,
    keys,
    clock: createManualClock(0),
    fetch,
    retry: { maxRetries: 0, delaysMs: [0], jitter: 0 },
    roles: {
      resolve: (role) => (role === 'chat' ? { profileId: primary.id, model: 'model-a', ...(fallbacks ? { fallbacks: [{ profileId: second.id }] } : {}) } : undefined),
      allowed: () => [primary.id, second.id],
    },
    observe: traceGateway(sink),
  });
  const text = await (async () => {
    let said = '';
    for await (const part of gateway.complete({ messages: [{ role: 'user', content: 'One request.' }], role: 'chat' })) said += part.delta ?? '';
    return said;
  })();
  return { records, text, primary: primary.id, second: second.id };
}

const responses = (records: readonly TraceInput[]): ResponseInput[] =>
  records.filter((record): record is ResponseInput => record.kind === 'model.response');

/** The request record of the call that answered: a request and its response share the gateway's call number. */
const requestOf = (records: readonly TraceInput[], callId: number | undefined): RequestInput | undefined =>
  records.find((record): record is RequestInput => record.kind === 'model.request' && record.callId === callId);

describe('a route’s switch in the agent trace (provider-gateway §6)', () => {
  it('records the switch under the call that answered, with the fault that ended the one before it', async () => {
    const { records, text, primary, second } = await routed([limited, () => done('from the fallback')], true);
    expect(text).toBe('from the fallback');
    const answered = responses(records).at(-1);
    // The switch landed in the answering call's own record, not one of its own: its call number is that call's number.
    expect(requestOf(records, answered?.callId)?.profileId).toBe(second);
    expect(answered?.fallbacks).toEqual([
      { from: { profileId: primary, model: 'model-a' }, to: { profileId: second, model: 'model-b' }, reason: 'rate_limit', at: expect.any(Number) },
    ]);
    // The primary's own record closed before the switch, so no record names a move it did not make.
    expect(responses(records)[0]?.fallbacks).toBeUndefined();
  });

  it('writes what it always did when the role lists no fallbacks', async () => {
    const { records } = await routed([() => done('answered at once')], false);
    expect(responses(records)).toHaveLength(1);
    expect(responses(records)[0]?.fallbacks).toBeUndefined();
  });
});
