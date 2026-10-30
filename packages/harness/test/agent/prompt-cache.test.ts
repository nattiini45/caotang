/**
 * The harness's part of prompt caching (agent-harness §5, "Prompt cache"; provider-gateway §3; issue #86): the planner's
 * native tool list keeps one order through a turn and a tool loaded mid-turn is appended; the turn report says what the calls
 * read from the provider's cache and names a likely cause for a planner call that missed it; and a batch's forecast prices a
 * prefix an earlier call of the batch already sent at the model's read multiplier.
 */

import { describe, expect, it } from 'vitest';

import type { ChatChunk, ChatRequest, Gateway, Usage } from '@caotang/gateway';
import { userTextOf, type MockScript } from '@caotang/gateway/mock';
import type { PromptPreview } from '@caotang/context';

import {
  CACHE_MISS_CAUSES,
  CacheWatch,
  PLANNER_SYSTEM_PREFIX,
  createAgentPorts,
  createAgentSession,
  createContextPort,
  forecastReads,
  mergePreviews,
  stableToolOrder,
  type Harness,
} from '../../src/index.js';
import { makeHarness } from '../fixtures.js';
import { mockGateway } from './gateway.js';

const COHERENCE_SCAN = { scope: { mode: 'full' } };
const INTENT = 'Scan the manuscript for continuity problems.';

const isNativePlanner = (req: ChatRequest): boolean => {
  const first = req.messages[0];
  return (req.tools?.length ?? 0) > 0 && first?.role === 'system' && first.content.startsWith(PLANNER_SYSTEM_PREFIX);
};
const namesOf = (request: ChatRequest | undefined): string[] => (request?.tools ?? []).map((tool) => tool.name);

/** A native planner that searches, calls what it loaded, and answers. */
function scripts(): MockScript[] {
  const replies = [
    { calls: [{ id: 'call_s', name: 'tool.search', args: { query: 'coherence scan' } }] },
    { calls: [{ id: 'call_c', name: 'coherence.scan', args: COHERENCE_SCAN }] },
    { content: 'The scan is done.' },
  ];
  return [
    {
      match: (req) => isNativePlanner(req) && userTextOf(req).includes(`Request: ${INTENT}`),
      respond: (req) => {
        const reply = replies[Math.min(req.messages.filter((message) => message.role === 'assistant').length, replies.length - 1)];
        return {
          content: reply?.content ?? '',
          ...(reply?.calls === undefined ? {} : { toolCalls: reply.calls.map((call) => ({ id: call.id, name: call.name, argumentsJson: JSON.stringify(call.args) })) }),
        };
      },
    },
  ];
}

/**
 * A session on the native wire whose gateway reports a cache breakdown: the nth call's usage carries `usages[n]`'s cached and
 * written counts, as a provider that caches would.
 */
async function session(usages: readonly Partial<Usage>[]) {
  const seen: ChatRequest[] = [];
  const base = await mockGateway(scripts());
  const gateway: Gateway = {
    ...base,
    modelCaps: () => ({ tools: true }),
    complete: (req, signal) => {
      const index = seen.length;
      seen.push(req);
      const breakdown = usages[index] ?? {};
      return (async function* (): AsyncGenerator<ChatChunk> {
        for await (const chunk of base.complete(req, signal)) {
          yield chunk.usage === undefined ? chunk : { ...chunk, usage: { ...chunk.usage, ...breakdown } };
        }
      })();
    },
  };
  const harness: Harness = makeHarness({ ports: createAgentPorts() });
  const agent = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state: () => harness.state }),
    decide: async () => ({ action: 'approve' }),
    sessionId: 'cache',
  });
  return { agent, seen };
}

describe('the planner’s tool list within a turn', () => {
  it('keeps the first order and appends a tool tool.search loaded, so the earlier declarations are a stable prefix', async () => {
    const { agent, seen } = await session([]);
    await agent.submit(INTENT);
    const [first, second, third] = seen.filter(isNativePlanner).map(namesOf);
    expect(first).not.toContain('coherence.scan');
    expect(second?.slice(0, first?.length)).toEqual(first);
    expect(second?.slice(first?.length)).toEqual(['coherence.scan']);
    expect(third).toEqual(second);
  });

  it('stableToolOrder appends new tools and drops ones no longer offered, never re-sorting', () => {
    const tool = (name: string) => ({ name });
    expect(stableToolOrder(undefined, [tool('b'), tool('a')]).map((t) => t.name)).toEqual(['b', 'a']);
    expect(stableToolOrder([tool('b'), tool('a')], [tool('a'), tool('c'), tool('b')]).map((t) => t.name)).toEqual(['b', 'a', 'c']);
    expect(stableToolOrder([tool('b'), tool('a')], [tool('a')]).map((t) => t.name)).toEqual(['a']);
  });
});

describe('the turn report’s cache line', () => {
  it('sums the cache counts and names the tool load as the cause of the miss it made', async () => {
    // Call 1 writes the prefix; call 2 follows the tool load and reads nothing; call 3 reads it again.
    const { agent } = await session([{ cacheWritePromptTokens: 100 }, { cachedPromptTokens: 0, cacheWritePromptTokens: 120 }, { cachedPromptTokens: 90 }]);
    const report = await agent.submit(INTENT);
    expect(report.cache?.cachedPromptTokens).toBe(90);
    expect(report.cache?.cacheWritePromptTokens).toBe(220);
    expect(report.cache?.promptTokens).toBeGreaterThan(0);
    expect(report.cache?.misses).toEqual([{ call: 2, cause: CACHE_MISS_CAUSES.tools }]);
  });

  it('is absent when no call reported a cache breakdown', async () => {
    const { agent } = await session([]);
    expect((await agent.submit(INTENT)).cache).toBeUndefined();
  });

  it('names a model switch, a thinking change, or the provider letting the entry go', () => {
    const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({ messages: [], model: 'm', ...over });
    const missOn = (next: ChatRequest): string | undefined => {
      const watch = new CacheWatch();
      watch.record(1, request(), { promptTokens: 2000, completionTokens: 1, cacheWritePromptTokens: 2000 }, true);
      watch.record(2, next, { promptTokens: 2100, completionTokens: 1, cachedPromptTokens: 0 }, true);
      return watch.report()?.misses[0]?.cause;
    };
    expect(missOn(request({ model: 'other' }))).toBe(CACHE_MISS_CAUSES.model);
    expect(missOn(request({ thinking: 'high' }))).toBe(CACHE_MISS_CAUSES.thinking);
    expect(missOn(request())).toBe(CACHE_MISS_CAUSES.provider);
  });

  it('does not call a cold first call, or a drafting call, a miss', () => {
    const watch = new CacheWatch();
    watch.record(1, { messages: [] }, { promptTokens: 10, completionTokens: 1, cachedPromptTokens: 0 }, true);
    watch.record(2, { messages: [] }, { promptTokens: 10, completionTokens: 1, cachedPromptTokens: 0 }, false);
    expect(watch.report()?.misses).toEqual([]);
  });
});

describe('the batch forecast', () => {
  const preview = (key: string, promptTokens: number): PromptPreview => ({
    payload: [],
    promptTokens,
    completionTokens: 100,
    layers: [],
    codex: { included: [], dropped: [] },
    storySoFar: { included: [], omittedOlder: 0 },
    cache: { prefixTokens: 1_000, readMultiplier: 0.1, key },
    cost: { promptUsd: promptTokens * 0.001, completionUsd: 0.1, totalUsd: promptTokens * 0.001 + 0.1 },
  });

  it('prices a prefix an earlier call of the batch sent at the read multiplier, and the first call in full', () => {
    const [first, second, other] = forecastReads([preview('a', 2_000), preview('a', 2_000), preview('b', 2_000)]);
    expect(first?.promptUsd).toBeCloseTo(2);
    expect(first?.cachedTokens).toBeUndefined();
    expect(second?.promptUsd).toBeCloseTo(2 - 1_000 * 0.001 * 0.9);
    expect(second?.cachedTokens).toBe(1_000);
    expect(other?.promptUsd).toBeCloseTo(2);
    const merged = mergePreviews([preview('a', 2_000), preview('a', 2_000)]);
    expect(merged?.cost?.cachedTokens).toBe(1_000);
    expect(merged?.cost?.totalUsd).toBeCloseTo(4.2 - 0.9);
  });
});
