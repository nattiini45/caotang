import { expect, test } from '@playwright/test';
import { emptyCoherenceFile } from '../../packages/coherence/src/index.js';
import type { ChatMessage, ChatRequest, ModelLimits, ProfileView, ProviderGateway } from '../../packages/gateway/src/index.js';

import { reviewCostOf } from '../../packages/harness/src/index.js';

import { gatewayCoherenceModel, planCoherenceReview, runCoherenceReview } from '../../apps/desktop/src/app/coherence-review.js';
import { IDS, project } from './fixtures.js';

/** A gateway that answers one-shot requests from a script. Only `completeOnce` is used by the review. */
function scriptedGateway(replies: readonly (string | Error)[]): { gateway: ProviderGateway; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let next = 0;
  const gateway = {
    async completeOnce(request: ChatRequest): Promise<ChatMessage> {
      requests.push(request);
      const reply = replies[Math.min(next, replies.length - 1)];
      next += 1;
      if (reply instanceof Error) throw reply;
      return { role: 'assistant', content: reply ?? '{"spans":[]}' };
    },
  } as unknown as ProviderGateway;
  return { gateway, requests };
}

const PROFILE = {
  id: 'pr_TESTPROFIL',
  name: 'Test provider',
  kind: 'endpoint',
  endpoint: 'https://example.invalid/v1',
  defaultModel: 'test-model',
  hasKey: true,
} as unknown as ProfileView;

test.describe('the model review adapter and its two steps (coherence.md §5.3, §7 tool 16)', () => {
  test('the gateway answers the review through the active profile, asks for the schema, and reports token estimates', async () => {
    const { gateway, requests } = scriptedGateway(['{"spans":[]}']);
    const model = gatewayCoherenceModel(gateway, PROFILE);
    expect(model.model).toBe('test-model');
    const reply = await model.complete({ system: 'Find spans.', user: 'Scene text.', jsonSchemaHint: { type: 'object' } });
    expect(reply.content).toBe('{"spans":[]}');
    expect(reply.usage?.promptTokens).toBeGreaterThan(0);
    expect(requests[0]?.usageTurnId).toMatch(/^review-/);
    expect(requests[0]?.turnId).toBeUndefined();
    expect(requests[0]).toMatchObject({
      profileId: PROFILE.id,
      responseFormat: { jsonSchemaHint: { type: 'object' } },
      messages: [
        { role: 'system', content: 'Find spans.' },
        { role: 'user', content: 'Scene text.' },
      ],
    });
  });

  test('an agent review keeps the parent turn id while separate standalone reviews get separate ids', async () => {
    const { gateway, requests } = scriptedGateway(['{"spans":[]}']);
    const model = gatewayCoherenceModel(gateway, PROFILE);
    const request = { system: 'Find spans.', user: 'Scene.', jsonSchemaHint: { type: 'object' } };
    await model.complete({ ...request, turnId: 'parent', sessionId: 'session' });
    await model.complete(request);
    await model.complete(request);
    await gatewayCoherenceModel(gateway, PROFILE).complete(request);
    expect(requests[0]).toMatchObject({ turnId: 'parent', sessionId: 'session' });
    expect(requests[0]?.usageTurnId).toBeUndefined();
    expect(requests[1]?.usageTurnId).toBe(requests[2]?.usageTurnId);
    expect(requests[3]?.usageTurnId).not.toBe(requests[1]?.usageTurnId);
  });

  test('a plan names the documents it reads and the calls it expects, and reads nothing until it is approved', () => {
    const state = project();
    const plan = planCoherenceReview(state, emptyCoherenceFile(), { scope: { mode: 'doc', docIds: [IDS.sceneA] }, maxFindings: 10 });
    expect(plan.scopeDocIds).toEqual([IDS.sceneA]);
    expect(plan.documents.map((doc) => doc.title)).toEqual(['Scene A']);
    expect(plan.estimate.extractCalls).toBe(1);
    expect(plan.estimate.totalTokensAtMost).toBeGreaterThan(0);
    expect(plan.maxFindings).toBe(10);
    expect(plan.promptPreview.length).toBeGreaterThan(0);
  });

  test('an approved run gives each document one extraction call, and records the run as a model run with its scope', async () => {
    const state = project();
    const plan = planCoherenceReview(state, emptyCoherenceFile(), { scope: { mode: 'full' }, maxFindings: 50 });
    const { gateway, requests } = scriptedGateway(['{"spans":[]}']);
    const result = await runCoherenceReview({
      state,
      file: emptyCoherenceFile(),
      plan,
      model: gatewayCoherenceModel(gateway, PROFILE),
      maxFindings: 50,
      now: new Date('2026-10-08T09:00:00.000Z'),
    });
    expect(requests).toHaveLength(plan.scopeDocIds.length);
    expect(new Set(requests.map((request) => request.usageTurnId)).size).toBe(1);
    expect(result.status).toBe('complete');
    expect(result.run).toMatchObject({ kind: 'llm', status: 'complete', model: 'test-model' });
    expect(result.run.scope.docIds).toEqual([...plan.scopeDocIds].sort());
    expect(result.run.tokens?.promptTokens).toBeGreaterThan(0);
    expect(result.file.runs).toHaveLength(1);
  });

  test('a provider that fails part way keeps what it had, marks the run partial, and leaves the documents due again', async () => {
    const state = project();
    const plan = planCoherenceReview(state, emptyCoherenceFile(), { scope: { mode: 'full' }, maxFindings: 50 });
    const { gateway } = scriptedGateway(['{"spans":[]}', new Error('the provider is busy')]);
    const result = await runCoherenceReview({
      state,
      file: emptyCoherenceFile(),
      plan,
      model: gatewayCoherenceModel(gateway, PROFILE),
      maxFindings: 50,
    });
    expect(result.status).toBe('partial');
    expect(result.run.status).toBe('partial');
    expect(result.notes.join(' ')).toContain('the provider is busy');
    // A partial run does not advance review state, so the next changed scan still includes every document.
    expect(result.file.reviewState).toEqual({});
  });

  test('an estimated cost is shown only when the profile carries a price, and is a display figure', () => {
    // The one cost entry point: reviewCostOf reads the model's limits, and the card and the Findings tab both reach it through those limits.
    const state = project();
    const plan = planCoherenceReview(state, emptyCoherenceFile(), { scope: { mode: 'full' }, maxFindings: 50 });
    const limitsOf = (pricePer1k?: { prompt: number; completion: number }): ModelLimits => ({
      maxOutputTokens: 1000,
      ...(pricePer1k === undefined ? {} : { pricePer1k }),
    });
    expect(reviewCostOf(plan, limitsOf())).toBeUndefined();
    const cost = reviewCostOf(plan, limitsOf({ prompt: 0.01, completion: 0.03 }));
    expect(cost?.totalUsd).toBeGreaterThan(0);
    // The figure is its two parts added: the prompt's estimate and the reply's output bound, each at its own price.
    expect(cost?.totalUsd).toBeCloseTo((cost?.promptUsd ?? 0) + (cost?.completionUsd ?? 0), 10);
  });
});
