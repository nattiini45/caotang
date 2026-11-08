/**
 * Request parameters (provider-gateway §2, "Request parameters"): what the model rows say each model takes, and what a profile's
 * own `params` change about the body. No sampling default is sent; a temperature goes out only when the request or the profile
 * sets one and the caps allow it. The OpenAI rows carry what the live API was seen to accept on 2026-11-07.
 */

import { describe, expect, it } from 'vitest';
import { ProfileError, resolveRoute } from '../src/index.js';
import type { ChatRequest, NewProfile, RequestParams, ThinkingLevel, ToolDef } from '../src/types.js';
import { addEndpoint, collect, finish, harness, KEY, ScriptedFetch, sseResponse, userMessage } from './helpers.js';

const TOOL: ToolDef = {
  name: 'doc.read',
  description: 'Read a document',
  parameters: { type: 'object', properties: { doc: { type: 'string' }, selection: { type: 'object' } }, required: ['doc'] },
};

/** Sends one request through a fresh gateway and returns the body that went on the wire. */
async function bodyFor(profile: Partial<NewProfile>, req: Parameters<ReturnType<typeof harness>['gateway']['complete']>[0]) {
  const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])) });
  await addEndpoint(h, profile);
  await collect(h.gateway.complete(req));
  return { body: h.net.bodyOf(0) as Record<string, unknown>, url: h.net.calls[0]?.url, h };
}

const OPENAI: Partial<NewProfile> = { preset: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6.1-sol' };
const GENERIC: Partial<NewProfile> = { preset: 'generic', baseUrl: 'https://llm.example/v1', defaultModel: 'my-model' };

describe('the OpenAI rows on the Responses route', () => {
  it('never sends temperature or top_p, even when a caller asks for temperature 0', async () => {
    const { body, url } = await bodyFor({ ...OPENAI, temperature: 0.4 }, { ...userMessage('hi'), temperature: 0 });
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
  });

  it('declares every function tool with strict: false, so optional parameters stay optional', async () => {
    const { body } = await bodyFor(OPENAI, { ...userMessage('hi'), tools: [TOOL] });
    const tools = body.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: 'function', strict: false, parameters: TOOL.parameters });
  });

  it.each<[string, ThinkingLevel, string | undefined]>([
    ['gpt-6.1-sol', 'max', 'max'],
    ['gpt-6.1-sol', 'xhigh', 'xhigh'],
    ['gpt-6.1-sol', 'high', 'high'],
    ['gpt-6.1-sol', 'off', undefined], // the row lists no off: nothing is sent
    ['gpt-6-sol', 'off', 'none'],
    ['gpt-6-sol', 'max', 'max'],
    ['gpt-5.5', 'xhigh', 'xhigh'],
    ['gpt-5.5', 'max', undefined], // gpt-5.5 rejects max
  ])('sends %s at %s as %s', async (model, thinking, wire) => {
    const { body } = await bodyFor({ ...OPENAI, defaultModel: model }, { ...userMessage('hi'), thinking });
    if (wire === undefined) expect(body).not.toHaveProperty('reasoning');
    else expect(body.reasoning).toEqual({ effort: wire });
  });

  it('asks for a JSON object as a text format when the caller wants structured output', async () => {
    const { body } = await bodyFor(OPENAI, { ...userMessage('hi'), responseFormat: { jsonSchemaHint: { type: 'object' } } });
    expect(body.text).toEqual({ format: { type: 'json_object' } });
  });

  it('answers the format check from the row without a request', async () => {
    const h = harness();
    await addEndpoint(h, OPENAI);
    expect(await h.gateway.probeResponseFormat()).toBe(true);
    expect(h.net.calls).toHaveLength(0);
    expect(h.profiles.active()?.responseFormat?.supportsJsonObject).toBe(true);
  });

  it('prices gpt-6.1-sol from OpenAI’s list', () => {
    const h = harness();
    return addEndpoint(h, OPENAI).then(() => {
      expect(h.gateway.modelLimits(undefined, 'gpt-6.1-sol').pricePer1k).toEqual({ prompt: 0.002, completion: 0.01 });
    });
  });

  it('lets a profile send a temperature anyway', async () => {
    const { body } = await bodyFor({ ...OPENAI, temperature: 0.3, params: { temperature: true } }, userMessage('hi'));
    expect(body.temperature).toBe(0.3);
  });

  it('a flag-only profile lets a request’s own temperature through, and sends none by itself', async () => {
    // The SDK flag-only shape (params.temperature: true, no stored number): a request that asks for a
    // temperature sends one on this row that takes none, and a request that asks for none sends none.
    expect((await bodyFor({ ...OPENAI, params: { temperature: true } }, { ...userMessage('hi'), temperature: 0.5 })).body.temperature).toBe(0.5);
    expect((await bodyFor({ ...OPENAI, params: { temperature: true } }, userMessage('hi'))).body).not.toHaveProperty('temperature');
  });

  it('the profile’s own leave-out wins over its temperature flag — the flag alone still lifts the row’s denial', async () => {
    // The owner's precedence decision (provider-gateway §2, "Request parameters"): an explicit refusal is not
    // overridden by the same profile's allow flag, for the stored value and a request's own alike.
    const denied = { ...OPENAI, temperature: 0.3, params: { temperature: true, deny: ['temperature'] } };
    expect((await bodyFor(denied, { ...userMessage('hi'), temperature: 0.5 })).body).not.toHaveProperty('temperature');
    expect((await bodyFor({ ...OPENAI, temperature: 0.3, params: { temperature: true } }, userMessage('hi'))).body.temperature).toBe(0.3);
  });

  it('pins an endpoint at api.openai.com to these rows: a stored temperature stays off the wire until the profile overrides it', async () => {
    // A profile saved before request parameters — or written by the SDK — holds the temperature column and no
    // params flag, whichever preset it names; the host pin routes it here. The flag is the writer's own choice,
    // so the same stored value with it set does go out.
    const pinned: Partial<NewProfile> = { preset: 'generic', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6.1-sol' };
    const legacy = await bodyFor({ ...pinned, temperature: 0.7 }, { ...userMessage('hi'), temperature: 0 });
    expect(legacy.url).toBe('https://api.openai.com/v1/responses');
    expect(legacy.body).not.toHaveProperty('temperature');
    const overridden = await bodyFor({ ...pinned, temperature: 0.7, params: { temperature: true } }, userMessage('hi'));
    expect(overridden.body.temperature).toBe(0.7);
  });
});

describe('the Anthropic rows on the Messages route', () => {
  const ANTHROPIC: Partial<NewProfile> = { preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-haiku-5-5' };

  it('denies temperature and sends no tool strict flag', async () => {
    const { body } = await bodyFor({ ...ANTHROPIC, temperature: 0.5 }, { ...userMessage('hi'), temperature: 0, tools: [TOOL] });
    expect(body).not.toHaveProperty('temperature');
    expect((body.tools as Record<string, unknown>[])[0]).not.toHaveProperty('strict');
  });

  it('sends each level as its own effort name', async () => {
    const { body } = await bodyFor(ANTHROPIC, { ...userMessage('hi'), thinking: 'xhigh' });
    expect(body.output_config).toEqual({ effort: 'xhigh' });
  });

  it('sends a profile’s own wire value for a level', async () => {
    const { body } = await bodyFor({ ...ANTHROPIC, params: { effort: { low: 'low', max: 'high' } } }, { ...userMessage('hi'), thinking: 'max' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });
});

describe('a custom OpenAI-compatible endpoint', () => {
  it('sends no temperature unless the request or the profile sets one', async () => {
    expect((await bodyFor(GENERIC, userMessage('hi'))).body).not.toHaveProperty('temperature');
    expect((await bodyFor({ ...GENERIC, temperature: 0.4 }, userMessage('hi'))).body.temperature).toBe(0.4);
    expect((await bodyFor({ ...GENERIC, temperature: 0.4 }, { ...userMessage('hi'), temperature: 0 })).body.temperature).toBe(0);
  });

  it('never sends a temperature when the profile turns it off', async () => {
    const { body } = await bodyFor({ ...GENERIC, temperature: 0.4, params: { temperature: false } }, { ...userMessage('hi'), temperature: 0 });
    expect(body).not.toHaveProperty('temperature');
  });

  it('sends no strict flag by default, and the profile’s when it sets one', async () => {
    const plain = await bodyFor(GENERIC, { ...userMessage('hi'), tools: [TOOL] });
    expect(((plain.body.tools as Record<string, unknown>[])[0]?.function as Record<string, unknown>)).not.toHaveProperty('strict');
    const strict = await bodyFor({ ...GENERIC, params: { toolStrict: false } }, { ...userMessage('hi'), tools: [TOOL] });
    expect(((strict.body.tools as Record<string, unknown>[])[0]?.function as Record<string, unknown>).strict).toBe(false);
  });

  it('offers and sends the thinking levels the profile names, with their wire values', async () => {
    const params: RequestParams = { effort: { low: 'low', high: 'high', max: 'xhigh' } };
    const { body, h } = await bodyFor({ ...GENERIC, params }, { ...userMessage('hi'), thinking: 'max' });
    expect(body.reasoning_effort).toBe('xhigh');
    expect(h.gateway.modelCaps().effortLevels).toEqual(['low', 'high', 'max']);
    // A level the profile does not name is not sent.
    expect((await bodyFor({ ...GENERIC, params }, { ...userMessage('hi'), thinking: 'medium' })).body).not.toHaveProperty('reasoning_effort');
  });

  it('sends no thinking field when the profile names no levels', async () => {
    const { body, h } = await bodyFor({ ...GENERIC, params: { effort: {} } }, { ...userMessage('hi'), thinking: 'high' });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(h.gateway.modelCaps().effortLevels).toEqual([]);
  });

  it('leaves out the extra fields the profile denies', async () => {
    const { body } = await bodyFor({ ...GENERIC, params: { deny: ['stop', 'tools'] } }, { ...userMessage('hi'), stop: ['END'], tools: [TOOL] });
    expect(body).not.toHaveProperty('stop');
    expect(body).not.toHaveProperty('tools');
  });
});

describe('a denied effort field takes the whole thinking control off (provider-gateway §2)', () => {
  const DEEPSEEK: Partial<NewProfile> = { preset: 'deepseek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-pro' };
  const MOONSHOT: Partial<NewProfile> = { preset: 'moonshot', baseUrl: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k2.6' };
  const TOGETHER: Partial<NewProfile> = { preset: 'together', baseUrl: 'https://api.together.ai/v1', defaultModel: 'Qwen/Qwen3.5-9B' };
  const QWEN: Partial<NewProfile> = {
    preset: 'alibaba',
    fields: { workspaceId: 'ws', region: 'ap-southeast-1' },
    baseUrl: 'https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.7-plus',
  };
  const ANTHROPIC: Partial<NewProfile> = { preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-haiku-5-5' };

  // Each effort style and the request fields it writes: a deny naming any one of them takes the whole
  // control off the wire — no level is offered, so none is sent, and no member of the structure leaks.
  const CASES: readonly (readonly [string, Partial<NewProfile>, readonly string[]])[] = [
    ['reasoning_effort', { ...GENERIC, params: { effort: { high: 'high' } } }, ['reasoning_effort']],
    ['reasoning.effort', OPENAI, ['reasoning']],
    ['thinking.type', MOONSHOT, ['thinking']],
    ['thinking.type+effort', DEEPSEEK, ['thinking', 'reasoning_effort']],
    ['enable_thinking+budget', QWEN, ['enable_thinking', 'thinking_budget']],
    ['reasoning.enabled', TOGETHER, ['reasoning']],
    ['anthropic', ANTHROPIC, ['thinking', 'output_config']],
  ];

  it.each(CASES)('%s: denying any field it writes sends none of them and offers no level', async (style, profile, fields) => {
    for (const field of fields) {
      const { body, h } = await bodyFor({ ...profile, params: { ...(profile.params ?? {}), deny: [field] } }, { ...userMessage('hi'), thinking: 'high' });
      for (const written of fields) expect(body, `${style} with deny ${field}`).not.toHaveProperty(written);
      expect(h.gateway.modelCaps().effortLevels ?? [], `${style} with deny ${field}`).toEqual([]);
    }
  });

  it('a deny on one member of a composite style suppresses the whole generated structure', async () => {
    // thinking.type+effort writes two fields; denying either must not leave the other behind.
    for (const field of ['thinking', 'reasoning_effort']) {
      const { body } = await bodyFor({ ...DEEPSEEK, params: { deny: [field] } }, { ...userMessage('hi'), thinking: 'high' });
      expect(body, `deny ${field}`).not.toHaveProperty('thinking');
      expect(body, `deny ${field}`).not.toHaveProperty('reasoning_effort');
    }
    // enable_thinking+budget likewise: no toggle without its budget, no budget without its toggle.
    for (const field of ['enable_thinking', 'thinking_budget']) {
      const { body } = await bodyFor({ ...QWEN, params: { deny: [field] } }, { ...userMessage('hi'), thinking: 'high' });
      expect(body, `deny ${field}`).not.toHaveProperty('enable_thinking');
      expect(body, `deny ${field}`).not.toHaveProperty('thinking_budget');
    }
  });
});

describe('modelLimits settles the request’s own cap and budget (provider-gateway §3, "Effective output")', () => {
  const ALIBABA: Partial<NewProfile> = {
    preset: 'alibaba',
    fields: { workspaceId: 'ws', region: 'ap-southeast-1' },
    baseUrl: 'https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.7-plus',
  };
  const FLASH: Partial<NewProfile> = { ...ALIBABA, defaultModel: 'qwen3.8-flash' };

  interface Sent {
    readonly body: Record<string, unknown>;
    readonly h: ReturnType<typeof harness>;
  }

  /** Sends one request through a fresh gateway and keeps the harness, so the transmitted cap and the limits can be compared. */
  async function sent(profile: Partial<NewProfile>, req: Omit<ChatRequest, 'messages'>): Promise<Sent> {
    const { body, h } = await bodyFor(profile, { ...userMessage('hi'), ...req });
    return { body, h };
  }

  /** The cap reserveCall would reserve for this request: the request's own cap or the profile's, plus the thinking excess. */
  function reserved(h: ReturnType<typeof harness>, req: Omit<ChatRequest, 'messages'>): number {
    const limits = h.gateway.modelLimits(undefined, undefined, req.thinking, {
      maxOutputTokens: req.maxOutputTokens,
      reasoningBudget: req.reasoningBudget,
    });
    return (req.maxOutputTokens ?? limits.maxOutputTokens) + (limits.thinkingTokens ?? 0);
  }

  /** The cap the adapter put on the wire (`max_tokens` on the Chat route). */
  function transmitted(body: Record<string, unknown>): number {
    const cap = body['max_tokens'] ?? body['maxTokens'] ?? body['max_output_tokens'];
    if (typeof cap !== 'number') throw new Error('no output cap on the wire');
    return cap;
  }

  it('a budget route with a request-level cap reserves exactly the cap+budget that goes out', async () => {
    // qwen3.7-plus takes enable_thinking+budget and its row names no output ceiling, so the delta is the
    // budget itself and does not move with the base cap: parity held even before the request input existed.
    for (const maxOutputTokens of [undefined, 2_000, 20_000]) {
      const { body, h } = await sent(ALIBABA, { thinking: 'high', ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) });
      expect(reserved(h, { thinking: 'high', maxOutputTokens }), `cap ${maxOutputTokens}`).toBe(transmitted(body));
    }
  });

  it('a request-level reasoningBudget raises the transmitted cap on a budget route, and the reservation must see it', async () => {
    // 'low' stands for a 1,024 budget; the request asks for 60,000, which goes out as max_tokens 64,096.
    const { body, h } = await sent(ALIBABA, { thinking: 'low', reasoningBudget: 60_000 });
    expect(transmitted(body)).toBe(64_096);
    expect(reserved(h, { thinking: 'low', reasoningBudget: 60_000 })).toBe(64_096);
    // With no level asked the budget itself names the level, and the cap still goes out raised.
    const inferred = await sent(ALIBABA, { reasoningBudget: 60_000 });
    expect(transmitted(inferred.body)).toBe(64_096);
    expect(reserved(inferred.h, { reasoningBudget: 60_000 })).toBe(64_096);
  });

  it('an effort route keeps a request-level cap as sent: no lift, so the reservation adds nothing', async () => {
    // qwen3.8-flash is reasoning_effort: a cap the request sets is not the default, so nothing is lifted.
    for (const maxOutputTokens of [2_000, 20_000]) {
      const { body, h } = await sent(FLASH, { ...(maxOutputTokens === 2_000 ? {} : { thinking: 'high' }), maxOutputTokens });
      expect(transmitted(body)).toBe(maxOutputTokens);
      expect(reserved(h, { thinking: maxOutputTokens === 2_000 ? undefined : 'high', maxOutputTokens }), `cap ${maxOutputTokens}`).toBe(maxOutputTokens);
    }
  });

  it('a profile cap and a request cap settle together: the request’s wins, and nothing is added', async () => {
    const capped = { ...FLASH, maxOutputTokens: 5_000 } as Partial<NewProfile>;
    const { body, h } = await sent(capped, { maxOutputTokens: 2_000 });
    expect(transmitted(body)).toBe(2_000);
    expect(reserved(h, { maxOutputTokens: 2_000 })).toBe(2_000);
  });

  it('a custom endpoint with profile-chosen levels reserves the same cap the request transmits', async () => {
    const custom = { ...GENERIC, params: { effort: { high: 'high' } } } as Partial<NewProfile>;
    const { body, h } = await sent(custom, { thinking: 'high', maxOutputTokens: 20_000 });
    expect(transmitted(body)).toBe(20_000);
    expect(reserved(h, { thinking: 'high', maxOutputTokens: 20_000 })).toBe(20_000);
  });
});

describe('resolveRoute with a profile’s params', () => {
  it('keeps the row when the profile sets nothing', () => {
    const plain = resolveRoute({ preset: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'gpt-6.1-sol');
    expect(plain.caps.denylist).toEqual(['temperature', 'top_p']);
    expect(plain.caps.toolStrict).toBe(false);
  });

  it('moves temperature off and on the denylist and keeps the rest', () => {
    const on = resolveRoute({ preset: 'openai', baseUrl: 'https://api.openai.com/v1', params: { temperature: true, deny: ['stop'] } }, 'gpt-6.1-sol');
    expect(on.caps.denylist).toEqual(['top_p', 'stop']);
    const off = resolveRoute({ preset: 'generic', baseUrl: 'https://x.example/v1', params: { temperature: false } }, 'm');
    expect(off.caps.denylist).toEqual(['temperature']);
  });

  it('gives a custom endpoint the route’s own effort style when it turns thinking on', () => {
    expect(resolveRoute({ preset: 'generic', baseUrl: 'https://x.example/v1', params: { effort: { low: 'low' } } }, 'm').caps.effortStyle).toBe('reasoning_effort');
  });
});

describe('profile params in the store', () => {
  it('stores, shows and clears a profile’s params and temperature', async () => {
    const h = harness();
    const view = await addEndpoint(h, { ...GENERIC, temperature: 0.6, params: { temperature: true, toolStrict: false, effort: { low: 'low', max: ' xhigh ' }, deny: [' top_p ', 'top_p', ''] } });
    expect(view.params).toEqual({ temperature: true, toolStrict: false, effort: { low: 'low', max: 'xhigh' }, deny: ['top_p'] });
    const cleared = await h.profiles.update(view.id, { params: null, temperature: null });
    expect(cleared.params).toBeUndefined();
    expect(cleared.temperature).toBeUndefined();
    // An absent field keeps what is saved.
    const kept = await h.profiles.update(view.id, { params: { toolStrict: true } });
    expect((await h.profiles.update(kept.id, { name: 'renamed' })).params).toEqual({ toolStrict: true });
  });

  it('refuses a level that is not one, a wire value that is not a word, and a field name that is not one', async () => {
    const h = harness();
    const bad = (params: unknown) => h.profiles.create({ name: 'x', kind: 'endpoint', baseUrl: 'https://x.example/v1', apiKey: KEY, defaultModel: 'm', params: params as RequestParams });
    await expect(bad({ effort: { extreme: 'max' } })).rejects.toBeInstanceOf(ProfileError);
    await expect(bad({ effort: { max: 'max", "x": "y' } })).rejects.toMatchObject({ field: 'params' });
    await expect(bad({ deny: ['top p'] })).rejects.toMatchObject({ field: 'params' });
    await expect(bad({ temperature: 'yes' })).rejects.toMatchObject({ field: 'params' });
  });

  it('refuses malformed params with a ProfileError, not a TypeError', async () => {
    const h = harness();
    const bad = (params: unknown) => h.profiles.create({ name: 'x', kind: 'endpoint', baseUrl: 'https://x.example/v1', apiKey: KEY, defaultModel: 'm', params: params as RequestParams });
    const invalid = { code: 'invalid', field: 'params' };
    // SDK-shaped input the types cannot see: an array or other container for params itself — which used to read as
    // "nothing set" and silently clear the stored rules on update — plus a non-object effort map, non-string
    // members and a non-array deny.
    await expect(bad([])).rejects.toMatchObject(invalid);
    await expect(bad(['temperature'])).rejects.toMatchObject(invalid);
    await expect(bad('params')).rejects.toMatchObject(invalid);
    await expect(bad(42)).rejects.toMatchObject(invalid);
    await expect(bad({ effort: null })).rejects.toMatchObject(invalid);
    await expect(bad({ effort: 42 })).rejects.toMatchObject(invalid);
    await expect(bad({ effort: 'high' })).rejects.toMatchObject(invalid);
    await expect(bad({ effort: ['low'] })).rejects.toMatchObject(invalid);
    await expect(bad({ effort: { high: 5 } })).rejects.toMatchObject(invalid);
    await expect(bad({ effort: { high: null } })).rejects.toMatchObject(invalid);
    await expect(bad({ deny: 'top_p' })).rejects.toMatchObject(invalid);
    await expect(bad({ deny: null })).rejects.toMatchObject(invalid);
    await expect(bad({ deny: [5] })).rejects.toMatchObject(invalid);
    await expect(bad({ deny: ['top_p', {}] })).rejects.toMatchObject(invalid);
    // And the valid trims still stand: whitespace members are dropped, not refused.
    const view = await addEndpoint(h, { ...GENERIC, params: { effort: { high: ' high ' }, deny: [' top_p ', ''] } });
    expect(view.params).toEqual({ effort: { high: 'high' }, deny: ['top_p'] });
  });

  it('refuses a JSON-shaped effort member with a ProfileError, not a TypeError', async () => {
    const h = harness();
    const invalid = { code: 'invalid', field: 'params' };
    // `{ toString: null }` passes the non-string member check but cannot be stringified
    // for a message: the refusal must still be the params ProfileError, never a TypeError.
    const params = { effort: { high: { toString: null } } } as unknown as RequestParams;
    const create = h.profiles.create({ name: 'x', kind: 'endpoint', baseUrl: 'https://x.example/v1', apiKey: KEY, defaultModel: 'm', params });
    await expect(create).rejects.toBeInstanceOf(ProfileError);
    await expect(create).rejects.toMatchObject(invalid);
    const view = await addEndpoint(h, GENERIC);
    const update = h.profiles.update(view.id, { params });
    await expect(update).rejects.toBeInstanceOf(ProfileError);
    await expect(update).rejects.toMatchObject(invalid);
  });

  it('a refused params update leaves the stored rules untouched', async () => {
    const h = harness();
    const view = await addEndpoint(h, { ...GENERIC, params: { temperature: true, deny: ['top_p'] } });
    const patch = { params: [] as unknown as RequestParams };
    await expect(h.profiles.update(view.id, patch)).rejects.toMatchObject({ code: 'invalid', field: 'params' });
    expect(h.profiles.get(view.id)?.params).toEqual({ temperature: true, deny: ['top_p'] });
  });

  it('treats params with nothing set as no override', async () => {
    const h = harness();
    expect((await addEndpoint(h, { params: {} })).params).toBeUndefined();
  });
});
