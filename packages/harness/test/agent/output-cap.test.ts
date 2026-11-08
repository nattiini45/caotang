/**
 * `transmittedOutputCap` (provider-gateway §3, "Effective output"): the cap a request goes out with is the
 * request's own cap or the profile's, plus the thinking excess `modelLimits` settled for that same input —
 * never the base cap alone, so a reservation and a cut comparison judge what is on the wire.
 */

import { describe, expect, it } from 'vitest';

import { requestCapFor, transmittedOutputCap } from '../../src/agent/output-cap.js';

const LIMITS = { maxOutputTokens: 4_096, thinkingTokens: 12_288 } as const;

describe('transmittedOutputCap', () => {
  it('is the base cap plus the thinking excess when the request names no cap', () => {
    expect(transmittedOutputCap(LIMITS)).toBe(16_384);
    expect(transmittedOutputCap(LIMITS, undefined)).toBe(16_384);
  });

  it('is the request’s own cap plus the excess settled for it', () => {
    // A raised retry cap: the settlement for it carries no lift, so the excess is absent.
    expect(transmittedOutputCap({ maxOutputTokens: 4_096 }, 32_768)).toBe(32_768);
    // A budget route keeps its delta whatever the base cap: 2,000 + 16,384 thinking.
    expect(transmittedOutputCap({ maxOutputTokens: 2_000, thinkingTokens: 16_384 }, 2_000)).toBe(18_384);
  });
});

describe('requestCapFor', () => {
  /** A budget route's settlement: the request cap plus a 16,384 budget, held to a 24,000 model maximum. */
  const budgetRoute = (cap: number): number => Math.min(cap + 16_384, 24_000);

  it('asks an effort route for the target itself: a set cap is sent as it is', () => {
    expect(requestCapFor(32_768, (cap) => cap)).toBe(32_768);
  });

  it('takes the budget off the target on a budget route, so the budget is counted once on the wire', () => {
    expect(requestCapFor(20_480, budgetRoute)).toBe(4_096);
    expect(budgetRoute(requestCapFor(20_480, budgetRoute))).toBe(20_480);
  });

  it('finds the largest request cap that stays within the target where the model maximum clamps the sum', () => {
    // Every cap from 7,616 up reaches the 24,000 maximum; the largest within a 24,000 target is the target itself.
    expect(requestCapFor(24_000, budgetRoute)).toBe(24_000);
    expect(budgetRoute(requestCapFor(23_000, budgetRoute))).toBe(23_000);
  });
});
