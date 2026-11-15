import { describe, expect, it } from 'vitest';

import {
  backgroundEligibility,
  createAgentPorts,
  createAgentSession,
  createContextPort,
  createHarness,
  estimatedModelCalls,
  estimatedStepCalls,
  reviewCallBoundOk,
  reviewContextOf,
  type PlanOffer,
  type PlanOfferReview,
  type PlanStep,
} from '../../src/index.js';
import { makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import type { ReviewPlan } from '@caotang/coherence';

const review: PlanStep = { tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'A coherence review' };
const draft: PlanStep = { tool: 'scene.draft', params: { doc: 'The Landing', instruction: 'Open.', mode: 'draft' }, expect: 'A draft' };
const bound = { extractCalls: 2, verifyCallsAtMost: 1 };

describe('a coherence review is eligible only with its host costed approval', () => {
  it('refuses a review without metadata, and accepts it with a valid bound', () => {
    expect(backgroundEligibility([review]).eligible).toBe(false);
    expect(backgroundEligibility([review], [undefined]).eligible).toBe(false);
    expect(backgroundEligibility([review], [bound])).toEqual({ eligible: true });
    expect(backgroundEligibility([draft, review], [undefined, bound])).toEqual({ eligible: true });
  });

  it('refuses a malformed bound rather than falling back to an unrestricted review', () => {
    expect(backgroundEligibility([review], [{ extractCalls: 0, verifyCallsAtMost: 0 }]).eligible).toBe(false);
    expect(backgroundEligibility([review], [{ extractCalls: 1.5, verifyCallsAtMost: 0 }]).eligible).toBe(false);
    expect(reviewCallBoundOk({ extractCalls: 2, verifyCallsAtMost: 1 })).toBe(true);
    expect(reviewCallBoundOk({ extractCalls: 0, verifyCallsAtMost: 1 })).toBe(false);
    expect(reviewCallBoundOk(undefined)).toBe(false);
  });

  it('keeps the default estimate safe, and adds the approved bound only with metadata', () => {
    expect(estimatedStepCalls(review)).toBe(0);
    expect(estimatedModelCalls([review])).toBe(0);
    expect(estimatedModelCalls([draft, review])).toBe(1);
    expect(estimatedStepCalls(review, bound)).toBe(3);
    expect(estimatedModelCalls([draft, review], [undefined, bound])).toBe(4);
  });
});

describe('a costed review is offered below the draft threshold, including from submitPlan', () => {
  async function sessionOver(offer: (value: PlanOffer) => 'now' | 'background' | 'cancel', withReviewOffer: boolean) {
    const state = makeState();
    const harness = createHarness({
      state,
      ports: createAgentPorts(),
      coherence: { model: () => ({ model: 'fake', complete: async () => ({ content: '{"spans":[]}' }) }), review: reviewContextOf },
    });
    const gateway = await mockGateway([]);
    const offers: PlanOffer[] = [];
    const reviewOffer = (_step: PlanStep, plan: ReviewPlan): PlanOfferReview => ({
      stepIndex: 0,
      plan,
      callBound: { extractCalls: plan.estimate.extractCalls, verifyCallsAtMost: plan.estimate.verifyCallsAtMost },
      route: { profileId: 'p_MOCK000001', model: 'fake', label: 'Mock, fake' },
      scopeDocIds: plan.scopeDocIds,
      categories: plan.categories,
      maxFindings: plan.maxFindings,
      fingerprint: 'fp',
      cost: undefined,
      costUnknownReason: 'no price',
      scopeTitles: plan.documents.map((doc) => doc.title),
      exclusions: [],
    });
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state: harness.state }),
      decide: async () => ({ action: 'approve' }),
      beforeStage: async (value) => { offers.push(value); return offer(value); },
      ...(withReviewOffer ? { reviewOffer } : {}),
      maxModelCalls: 12,
    });
    return { session, offers };
  }

  it('offers a single costed review from submitPlan even below five calls', async () => {
    const { session, offers } = await sessionOver(() => 'background', true);
    const report = await session.submitPlan('Review the manuscript.', { steps: [review] });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.reviews).toHaveLength(1);
    expect(offers[0]?.estimatedCalls).toBeGreaterThan(0);
    expect(report.status).toBe('replied');
  });

  it('does not offer a review with no costed preview, and does not offer a draft-only plan from submitPlan', async () => {
    const noPreview = await sessionOver(() => 'background', false);
    await noPreview.session.submitPlan('Review the manuscript.', { steps: [review] });
    expect(noPreview.offers).toHaveLength(0);

    const draftOnly = await sessionOver(() => 'background', true);
    await draftOnly.session.submitPlan('Draft.', { steps: [draft] });
    expect(draftOnly.offers).toHaveLength(0);
  });
});

describe('a review reads the request’s one-request choices in its preview and its run', () => {
  async function runWith(overrides: { exclude: { kind: 'codex'; id: string }[] } | undefined, answer: 'now' | 'background') {
    const state = makeState();
    const elena = state.manifest.codex!.find((entry) => entry.name === 'Elena')!;
    elena.includePolicy = 'always';
    const requests: string[] = [];
    const harness = createHarness({
      state,
      ports: createAgentPorts(),
      coherence: {
        model: () => ({
          model: 'fake',
          complete: async (request) => {
            requests.push(request.system + request.user);
            return { content: '{"spans":[]}', usage: { promptTokens: 1, completionTokens: 1 } };
          },
        }),
        review: reviewContextOf,
      },
    });
    const gateway = await mockGateway([]);
    const offers: PlanOffer[] = [];
    const reviewOffer = (_step: PlanStep, plan: ReviewPlan): PlanOfferReview => ({
      stepIndex: 0,
      plan,
      callBound: { extractCalls: plan.estimate.extractCalls, verifyCallsAtMost: plan.estimate.verifyCallsAtMost },
      route: { profileId: 'p_MOCK000001', model: 'fake', label: 'Mock, fake' },
      scopeDocIds: plan.scopeDocIds,
      categories: plan.categories,
      maxFindings: plan.maxFindings,
      fingerprint: 'fp',
      cost: undefined,
      costUnknownReason: 'no price',
      scopeTitles: plan.documents.map((doc) => doc.title),
      exclusions: [],
    });
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state: harness.state }),
      decide: async () => ({ action: 'approve' }),
      beforeStage: async (value) => { offers.push(value); return answer; },
      reviewOffer,
      maxModelCalls: 12,
    });
    const step: PlanStep = { tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'A coherence review', ...(overrides === undefined ? {} : { contextOverrides: overrides }) };
    const report = await session.submitPlan('Review the manuscript.', { steps: [step] });
    return { requests, offers, report };
  }

  it('a request-excluded codex entry is absent from the offer preview and from the foreground run', async () => {
    const state = makeState();
    const elena = state.manifest.codex!.find((entry) => entry.name === 'Elena')!;
    const description = elena.description;
    expect(description.length).toBeGreaterThan(0);

    const included = await runWith(undefined, 'now');
    expect(included.requests.length).toBeGreaterThan(0);
    expect(included.requests.some((text) => text.includes(description))).toBe(true);

    const excluded = await runWith({ exclude: [{ kind: 'codex', id: elena.id }] }, 'now');
    expect(excluded.requests.length).toBeGreaterThan(0);
    for (const text of excluded.requests) expect(text).not.toContain(description);
    expect(excluded.report.status).not.toBe('failed');
  });

  it('the offer preview reads the same effective context as the queued run', async () => {
    const state = makeState();
    const elena = state.manifest.codex!.find((entry) => entry.name === 'Elena')!;
    const included = await runWith(undefined, 'background');
    expect(included.offers[0]?.reviews?.[0]?.plan.promptPreview).toContain(elena.description);
    const excluded = await runWith({ exclude: [{ kind: 'codex', id: elena.id }] }, 'background');
    expect(excluded.offers[0]?.reviews?.[0]?.plan.promptPreview).not.toContain(elena.description);
  });
});
