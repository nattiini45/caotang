/**
 * `transmittedOutputCap` (provider-gateway §3, "Effective output"): the cap a request goes out with is the
 * request's own cap or the profile's, plus the thinking excess `modelLimits` settled for that same input —
 * never the base cap alone, so a reservation and a cut comparison judge what is on the wire.
 */

import { describe, expect, it } from 'vitest';

import { transmittedOutputCap } from '../../src/agent/output-cap.js';

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
