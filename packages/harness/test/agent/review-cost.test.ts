/**
 * The coherence review's plan card shows what the review is estimated to cost when the profile is priced (coherence.md §5.3,
 * context-assembly §5), and shows no cost when it is not. The prompt side is the plan's own token estimate at the prompt price;
 * the reply side is the output cap of each call the plan makes, at the reply price.
 */

import { describe, expect, it } from 'vitest';

import type { ReviewPlan } from '@caotang/coherence';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type Gateway, type ThinkingLevel } from '@caotang/gateway';
import { createMockProvider, type MockScript } from '@caotang/gateway/mock';
import type { ProjectState } from '@caotang/store';

import { reviewCostAt, reviewCostOf, stagedOf } from '../../src/agent/cards.js';
import { createAgentPorts, createAgentSession, createContextPort, createHarness, type AgentEvent, type PendingCard } from '../../src/index.js';
import { STORM, clock, makeState } from '../fixtures.js';
import { steps, transcript } from './scripts.js';

const INTENT = 'Check the storm for contradictions.';

/** A gateway whose one mock profile carries `price` (or none), with the scripts answering. */
async function gatewayWith(scripts: readonly MockScript[], price?: { prompt: number; completion: number }): Promise<Gateway> {
  const manual = createManualClock(0);
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  await profiles.create({ name: 'Mock', kind: 'mock', isActive: true, ...(price === undefined ? {} : { pricePer1k: price }) });
  return createGateway({ profiles, keys, clock: manual, mock: createMockProvider({ scripts: [...scripts] }) });
}

/** The review's plan, as far as the cost reads it. */
function planOf(extractCalls: number, verifyCallsAtMost: number, totalTokensAtMost: number): ReviewPlan {
  return {
    estimate: { extractCalls, extractTokens: totalTokensAtMost, verifyCallsAtMost, verifyTokensAtMost: 0, totalTokensAtMost },
  } as unknown as ReviewPlan;
}

/** One agent turn that plans a review of the storm, then cancels the card it shows, so the review never runs. */
async function reviewCard(gateway: Gateway, state: ProjectState, profileId?: string, thinking?: ThinkingLevel): Promise<PendingCard[]> {
  const model = { model: 'mock-review', complete: async () => ({ content: '{}' }) };
  const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now, coherence: { model: () => model } });
  const pending: PendingCard[] = [];
  const events: AgentEvent[] = [];
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state }),
    decide: async (card) => {
      pending.push(card);
      return { action: 'cancel' };
    },
    emit: (event) => events.push(event),
    sessionId: 'review-cost',
    ...(profileId === undefined ? {} : { profileId }),
    ...(thinking === undefined ? {} : { thinking }),
  });
  await session.submit(INTENT);
  return pending;
}

const REVIEW_STEP = steps({ tool: 'coherence.review', params: { scope: { mode: 'doc', docIds: [STORM] } }, expect: 'the storm is reviewed' });

describe('reviewCostOf (coherence.md §5.3)', () => {
  it('is undefined when the model has no price, so an unpriced profile shows no cost', () => {
    expect(reviewCostOf(planOf(2, 1, 150), { maxOutputTokens: 1000 })).toBeUndefined();
    expect(reviewCostOf(planOf(2, 1, 150), undefined)).toBeUndefined();
  });

  it('prices the plan’s prompt tokens at the prompt price, and each call’s output cap at the reply price', () => {
    // 150 prompt tokens at 2 per 1,000 is 0.3. Three calls (two extractions, one verification) reply up to 1,000 tokens each,
    // so 3,000 reply tokens at 4 per 1,000 is 12.
    expect(reviewCostOf(planOf(2, 1, 150), { pricePer1k: { prompt: 2, completion: 4 }, maxOutputTokens: 1000 })).toEqual({
      promptUsd: 0.3,
      completionUsd: 12,
      totalUsd: 12.3,
    });
  });

  it('uses the default output cap when the model names none', () => {
    const cost = reviewCostOf(planOf(1, 0, 1000), { pricePer1k: { prompt: 1, completion: 1 } });
    expect(cost?.completionUsd).toBeCloseTo((4_096 / 1000) * 1, 10);
  });
});

describe('the review’s cost with a thinking level (provider-gateway §3)', () => {
  it('adds the thinking tokens to each call’s reply bound and says so', () => {
    // Three calls reply up to 1,000 + 2,000 thinking tokens each: 9,000 reply tokens at 4 per 1,000 is 36.
    const cost = reviewCostOf(planOf(2, 1, 150), { pricePer1k: { prompt: 2, completion: 4 }, maxOutputTokens: 1000, thinkingTokens: 2000 });
    expect(cost).toEqual({ promptUsd: 0.3, completionUsd: 36, totalUsd: 36.3, includesThinking: true });
  });

  it('leaves the figure and the label alone without thinking tokens', () => {
    const cost = reviewCostOf(planOf(2, 1, 150), { pricePer1k: { prompt: 2, completion: 4 }, maxOutputTokens: 1000 });
    expect(cost).not.toHaveProperty('includesThinking');
  });

  it('reads the level from the gateway’s limits for the profile and model, so a set level costs more than none', async () => {
    const gateway = await gatewayWith([]);
    const profile = await gateway.profiles.create({
      name: 'Claude',
      kind: 'endpoint',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test-0123456789abcdef',
      preset: 'anthropic',
      defaultModel: 'claude-sonnet-5-5',
      maxOutputTokens: 2000,
      pricePer1k: { prompt: 1, completion: 1 },
    });
    const plan = planOf(1, 0, 1000);
    const plain = reviewCostAt(plan, gateway, profile.id);
    const high = reviewCostAt(plan, gateway, profile.id, undefined, 'high');
    expect(plain?.completionUsd).toBeCloseTo(2);
    expect(plain).not.toHaveProperty('includesThinking');
    // Adaptive row: the level's nominal 16,384 thinking tokens ride on the 2,000 output cap.
    expect(high?.completionUsd).toBeCloseTo(18.384);
    expect(high?.includesThinking).toBe(true);
    // A level the row does not list adds nothing.
    expect(reviewCostAt(plan, gateway, profile.id, undefined, 'off')).not.toHaveProperty('includesThinking');
  });
});

describe('stagedOf and the cost of a staged review', () => {
  it('keeps the including-thinking label through the staged proposal', () => {
    expect(stagedOf({ cost: { promptUsd: 1, completionUsd: 2, totalUsd: 3, includesThinking: true } }).cost).toEqual({
      promptUsd: 1,
      completionUsd: 2,
      totalUsd: 3,
      includesThinking: true,
    });
  });

  it('reads a well-formed cost from a staged proposal, and ignores one that is not three numbers', () => {
    expect(stagedOf({ cost: { promptUsd: 1, completionUsd: 2, totalUsd: 3 } }).cost).toEqual({ promptUsd: 1, completionUsd: 2, totalUsd: 3 });
    expect(stagedOf({ cost: { promptUsd: 1, totalUsd: 3 } }).cost).toBeUndefined();
    expect(stagedOf({ cost: 'about three dollars' }).cost).toBeUndefined();
    expect(stagedOf({ cut: false }).cost).toBeUndefined();
  });
});

describe('the review’s plan card through the agent (coherence.md §5.3)', () => {
  it('shows the review’s cost on its card when the profile is priced', async () => {
    const pending = await reviewCard(await gatewayWith([transcript(INTENT, [REVIEW_STEP])], { prompt: 1, completion: 2 }), makeState());
    const step = pending[0]?.card.steps[0];
    expect(step?.tool).toBe('coherence.review');
    expect(step?.cost).toBeDefined();
    const estimate = (step?.preview as { estimate: { extractCalls: number; verifyCallsAtMost: number; totalTokensAtMost: number } }).estimate;
    const calls = estimate.extractCalls + estimate.verifyCallsAtMost;
    expect(step?.cost?.promptUsd).toBeCloseTo((estimate.totalTokensAtMost / 1000) * 1, 10);
    expect(step?.cost?.completionUsd).toBeCloseTo((calls * 4_096 / 1000) * 2, 10);
    expect(step?.cost?.totalUsd).toBeCloseTo((step?.cost?.promptUsd ?? 0) + (step?.cost?.completionUsd ?? 0), 10);
  });

  it('shows on its card the cost reviewCostAt reads for the session’s profile, which the Findings tab reads too', async () => {
    // Two profiles at two prices. The session runs on the second, which is not the active one, so a card that read the active
    // profile's limits would show a different figure from reviewCostAt's.
    const gateway = await gatewayWith([transcript(INTENT, [REVIEW_STEP])], { prompt: 1, completion: 2 });
    const active = gateway.profiles.list().find((profile) => profile.isActive);
    const second = await gateway.profiles.create({ name: 'Second mock', kind: 'mock', pricePer1k: { prompt: 3, completion: 5 } });
    const pending = await reviewCard(gateway, makeState(), second.id);
    const step = pending[0]?.card.steps[0];
    expect(step?.tool).toBe('coherence.review');
    const plan = step?.preview as ReviewPlan;
    expect(step?.cost).toEqual(reviewCostAt(plan, gateway, second.id));
    expect(step?.cost?.totalUsd).not.toBeCloseTo(reviewCostAt(plan, gateway, active?.id)?.totalUsd ?? 0, 10);
  });

  it('shows a cost that includes thinking on the card when the session runs at a thinking level', async () => {
    const gateway = await gatewayWith([transcript(INTENT, [REVIEW_STEP])], { prompt: 1, completion: 2 });
    // The mock profile lists no levels, so the limits are stood in for: a session at 'high' gets 1,000 thinking tokens per call.
    const asked: unknown[] = [];
    const limits: Gateway = {
      ...gateway,
      modelLimits: (profileId, model, thinking) => {
        asked.push(thinking);
        const base = gateway.modelLimits(profileId, model);
        return thinking === 'high' ? { ...base, thinkingTokens: 1000 } : base;
      },
    };
    const pending = await reviewCard(limits, makeState(), undefined, 'high');
    const step = pending[0]?.card.steps[0];
    expect(asked).toContain('high');
    expect(step?.cost?.includesThinking).toBe(true);
    const estimate = (step?.preview as { estimate: { extractCalls: number; verifyCallsAtMost: number } }).estimate;
    const calls = estimate.extractCalls + estimate.verifyCallsAtMost;
    expect(step?.cost?.completionUsd).toBeCloseTo(((calls * (4_096 + 1000)) / 1000) * 2, 10);
  });

  it('shows no cost on the card when the profile has no price', async () => {
    const pending = await reviewCard(await gatewayWith([transcript(INTENT, [REVIEW_STEP])]), makeState());
    expect(pending[0]?.card.steps[0]?.tool).toBe('coherence.review');
    expect(pending[0]?.card.steps[0]?.cost).toBeUndefined();
  });
});
