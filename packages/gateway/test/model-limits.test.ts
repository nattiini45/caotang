/**
 * The limits and prices of a model, for the caller to fill context-assembly's model config (context-assembly §5,
 * provider-gateway §2 and §3). What a provider states is reported, what it does not state takes the documented
 * default, and nothing is guessed: a window the provider did not give is absent, not a number.
 */

import { describe, expect, it } from 'vitest';

import { estimateTokens as codexEstimate } from '@caotang/codex';

import { DEFAULT_MAX_OUTPUT_TOKENS, estimateTokens } from '../src/index.js';
import { parseModels } from '../src/adapters/models.js';
import { addEndpoint, harness, ScriptedFetch } from './helpers.js';

describe('one token estimator for the app (context-assembly §3)', () => {
  it('the gateway’s estimate is the codex estimate itself, not a copy of it', () => {
    // Identity, not equality: a second copy of `ceil(chars / 4)` would agree on every value and still be a second rule.
    expect(estimateTokens).toBe(codexEstimate);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('the wire reads what a provider states about a model (§3)', () => {
  it('reads the output cap, and a per-token price scaled to the profile’s unit of USD per 1,000 tokens', () => {
    const [model] = parseModels({
      data: [{ id: 'm', context_length: 32_000, max_completion_tokens: 4_000, pricing: { prompt: '0.000002', completion: '0.00001' } }],
    }) ?? [];

    expect(model).toMatchObject({ id: 'm', contextWindow: 32_000, maxOutputTokens: 4_000 });
    expect(model?.pricePer1k?.prompt).toBeCloseTo(0.002);
    expect(model?.pricePer1k?.completion).toBeCloseTo(0.01);
  });

  it('reads the output cap from OpenRouter’s own envelope, under top_provider', () => {
    expect(parseModels({ data: [{ id: 'm', top_provider: { max_completion_tokens: 2_048 } }] })).toEqual([
      { id: 'm', maxOutputTokens: 2_048 },
    ]);
  });

  it('leaves out what a provider does not state, so a bare id stays a bare id', () => {
    expect(parseModels({ data: [{ id: 'tiny' }] })).toEqual([{ id: 'tiny' }]);
  });

  it('takes no price from a list that gives one side only, a non-number, or a negative one', () => {
    const models = parseModels({
      data: [
        { id: 'one-side', pricing: { prompt: '0.1' } },
        { id: 'not-a-number', pricing: { prompt: 'free', completion: '1' } },
        { id: 'negative', pricing: { prompt: '-1', completion: '1' } },
      ],
    });

    expect(models).toEqual([{ id: 'one-side' }, { id: 'not-a-number' }, { id: 'negative' }]);
  });
});

describe('modelLimits (context-assembly §5)', () => {
  it('reports the documented default output cap, and no window, for a model the provider says nothing about', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(200, { data: [{ id: 'model-x' }] }));
    const h = harness({ net });
    const profile = await addEndpoint(h);
    await h.gateway.listModels(profile.id);

    const limits = h.gateway.modelLimits(profile.id);

    expect(limits).toEqual({ maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS });
    expect(limits).not.toHaveProperty('contextWindow');
    expect(limits).not.toHaveProperty('pricePer1k');
  });

  it('reports the window and the price the provider states for the profile’s model', async () => {
    const net = new ScriptedFetch().push(() =>
      jsonResponse(200, { data: [{ id: 'model-x', context_length: 8_192, pricing: { prompt: '0.000001', completion: '0.000002' } }] }),
    );
    const h = harness({ net });
    const profile = await addEndpoint(h);
    await h.gateway.listModels(profile.id);

    const limits = h.gateway.modelLimits(profile.id);

    expect(limits.contextWindow).toBe(8_192);
    expect(limits.pricePer1k?.prompt).toBeCloseTo(0.001);
    expect(limits.pricePer1k?.completion).toBeCloseTo(0.002);
    expect(limits.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it('the profile’s own output cap and price win over what the provider states', async () => {
    const net = new ScriptedFetch().push(() =>
      jsonResponse(200, { data: [{ id: 'model-x', max_completion_tokens: 8_000, pricing: { prompt: '0.000001', completion: '0.000002' } }] }),
    );
    const h = harness({ net });
    const profile = await addEndpoint(h, { maxOutputTokens: 1_000, pricePer1k: { prompt: 5, completion: 7 } });
    await h.gateway.listModels(profile.id);

    // The provider's own cap is still reported, as the model's: a request is sent with the profile's.
    expect(h.gateway.modelLimits(profile.id)).toEqual({ maxOutputTokens: 1_000, modelMaxOutputTokens: 8_000, pricePer1k: { prompt: 5, completion: 7 } });
  });

  it('reports the output cap the model advertises beside the cap a request is sent with', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(200, { data: [{ id: 'model-x', max_completion_tokens: 32_000 }] }));
    const h = harness({ net });
    const profile = await addEndpoint(h);
    await h.gateway.listModels(profile.id);

    const limits = h.gateway.modelLimits(profile.id);
    expect(limits.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(limits.modelMaxOutputTokens).toBe(32_000);
  });

  it('an Anthropic profile reports the preset row’s window before any listing, and the row’s price', async () => {
    const h = harness();
    const profile = await addEndpoint(h, { preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-5-5' });

    const limits = h.gateway.modelLimits(profile.id);

    expect(limits.contextWindow).toBe(1_000_000);
    expect(limits.pricePer1k).toEqual({ prompt: 0.002, completion: 0.01 });
    expect(limits.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS); // the row's 128K is informational: the profile's cap is sent
    expect(h.net.calls).toHaveLength(0);
  });

  it('keeps the row’s window when the Anthropic listing says nothing, and the listing wins when it states one', async () => {
    const net = new ScriptedFetch()
      .push(() => jsonResponse(200, { data: [{ id: 'claude-sonnet-5-5', max_input_tokens: null, max_tokens: 0 }] }))
      .push(() => jsonResponse(200, { data: [{ id: 'claude-sonnet-5-5', max_input_tokens: 200_000, max_tokens: 64_000 }] }));
    const h = harness({ net });
    const profile = await addEndpoint(h, { preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-5-5' });

    await h.gateway.listModels(profile.id);
    expect(h.gateway.modelLimits(profile.id).contextWindow).toBe(1_000_000);

    await h.gateway.listModels(profile.id);
    expect(h.gateway.modelLimits(profile.id).contextWindow).toBe(200_000);
  });

  it('an Anthropic id the table does not name has no window until the listing states one', async () => {
    const h = harness();
    const profile = await addEndpoint(h, { preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-future-9-9' });

    expect(h.gateway.modelLimits(profile.id)).not.toHaveProperty('contextWindow');
  });

  it('reports the window of the model it is asked about, not the profile’s default one', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(200, { data: [{ id: 'model-x', context_length: 8_192 }, { id: 'other', context_length: 4_096 }] }));
    const h = harness({ net });
    const profile = await addEndpoint(h);
    await h.gateway.listModels(profile.id);

    expect(h.gateway.modelLimits(profile.id, 'other').contextWindow).toBe(4_096);
    expect(h.gateway.modelLimits(profile.id).contextWindow).toBe(8_192);
  });

  it('guesses nothing before the provider has been listed: no window and no price, only the default cap', async () => {
    const h = harness();
    const profile = await addEndpoint(h);

    expect(h.gateway.modelLimits(profile.id)).toEqual({ maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS });
    expect(h.net.calls).toHaveLength(0);
  });

  it('reports the defaults when there is no profile at all, since then there is no request to limit', () => {
    expect(harness().gateway.modelLimits()).toEqual({ maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS });
  });

  it('reports the fixed list’s window for the mock profile once it has been listed, with no network', async () => {
    const h = harness();
    const mock = await h.profiles.create({ name: 'Offline', kind: 'mock' });
    await h.gateway.listModels(mock.id);

    expect(h.gateway.modelLimits(mock.id, 'mock/echo-1').contextWindow).toBe(128_000);
    expect(h.net.calls).toHaveLength(0);
  });
});
