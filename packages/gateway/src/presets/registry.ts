/**
 * The preset registry — every shipped provider, one `PresetDef` each.
 *
 * The tables below transcribe each provider's own documentation: base URLs, default
 * model ids, per-model capabilities, effort encodings and prices. Where the docs are
 * silent the field is absent; where they disagree the conservative reading is taken.
 * Prices are written per 1,000 tokens (the profile unit) — a provider's "$x / $y per
 * 1M" lands here divided by 1,000.
 */

import { routeFor, type AdapterId, type RouteSpec } from '../adapters/types.js';
import type { ModelCaps, RequestParams, ThinkingLevel } from '../types.js';
import type { ModelRow, PresetDef } from './types.js';

/** Anthropic omits `temperature`, `top_p` and `top_k` on Claude 4.7 and later (400 on non-default values). */
const CLAUDE_DENY = ['temperature', 'top_p', 'top_k'] as const;
/** Moonshot: do not send sampling knobs at all. */
const MOONSHOT_DENY = ['temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty'] as const;
/**
 * DeepSeek's thinking-mode guide (read 2026-11-07): temperature, top_p and the penalties never error. In thinking mode
 * temperature and the penalties "will not trigger an error but will also have no effect" (top_p is clamped); with thinking off
 * temperature and top_p are honoured. Only the penalties stay denied, as they have no documented effect while thinking.
 */
const DEEPSEEK_DENY = ['presence_penalty', 'frequency_penalty'] as const;
/** Groq: `logprobs`, `logit_bias`, `top_logprobs` and `messages[].name` return 400. */
const GROQ_DENY = ['logprobs', 'logit_bias', 'top_logprobs', 'name'] as const;
/** xAI reasoning models reject these sampling fields. */
const XAI_DENY = ['presence_penalty', 'frequency_penalty', 'stop'] as const;
/** The Cohere compatibility layer rejects these fields outright. */
const COHERE_DENY = ['store', 'metadata', 'logit_bias', 'top_logprobs', 'n', 'modalities', 'prediction', 'audio', 'service_tier', 'parallel_tool_calls'] as const;
/**
 * Prompt caching on the Claude 5.x rows (provider-gateway §3): opt-in `cache_control` breakpoints, a 512-token minimum prefix,
 * and a 5-minute write at 1.25x the prompt price. The read multiplier differs per model (0.05x on Opus 5.5 and Sonnet 5.5,
 * 0.025x on Fable 5.1, 0.1x otherwise), so each row names its own. Anthropic's prompt-caching page, read 2026-10-30:
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */
const CLAUDE_CACHE = { cache: 'explicit', cacheMinTokens: 512, cacheWriteMultiplier: 1.25 } as const satisfies Partial<ModelCaps>;
/**
 * OpenAI's caching (provider-gateway §3), from its prompt-caching guide and price list, read 2026-10-30
 * (https://developers.openai.com/api/docs/guides/prompt-caching, https://developers.openai.com/api/docs/pricing): GPT-5.6 and
 * later take explicit `prompt_cache_breakpoint`s with implicit caching on, cache from 1,024 tokens and write at 1.25x; earlier
 * models cache by themselves, routed by `prompt_cache_key`, with no write charge.
 */
const OPENAI_EXPLICIT_CACHE = { cache: 'explicit', cacheMinTokens: 1_024, cacheWriteMultiplier: 1.25 } as const satisfies Partial<ModelCaps>;

/**
 * Sends xhigh and max under their own names where a row lists them; the effort family's default would send both as 'high'.
 * Only listed levels are ever sent, so one map serves every row. Docs per row: /workspace effort audit, read 2026-11-07.
 */
const OWN_NAMES = { xhigh: 'xhigh', max: 'max' } as const;

/**
 * DeepSeek on Chat Completions (docs and live API, 2026-11-07): `thinking.type` plus `reasoning_effort` low|high|max (medium and
 * xhigh are silent aliases of high, so not offered); Off is `thinking: {type: 'disabled'}`. Caching is automatic with no write
 * charge (kv_cache guide). No `toolStrict`: true is ignored off /beta and 400s on optional properties there.
 */
const DEEPSEEK_CAPS = {
  tools: true,
  jsonObject: true,
  effortStyle: 'thinking.type+effort',
  effortLevels: ['off', 'low', 'high', 'max'],
  effortWire: { max: 'max' },
  replayStyle: 'content-field',
  denylist: DEEPSEEK_DENY,
  cache: 'automatic',
} as const satisfies Partial<ModelCaps>;
/** Window and output cap from DeepSeek's pricing page and /models (1M / 384K), the same on every row. */
const DEEPSEEK_LIMITS = { contextWindow: 1_048_576, maxOutputTokens: 393_216 } as const;
/**
 * deepseek-flash prices (https://api-docs.deepseek.com/quick_start/pricing, read 2026-11-07): $0.30 / $1.20 per 1M at PEAK
 * (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri); every other hour is off-peak at half. Peak is the conservative price.
 */
const DEEPSEEK_FLASH = { caps: { ...DEEPSEEK_CAPS, vision: true, cacheReadMultiplier: 0.02 }, ...DEEPSEEK_LIMITS, pricePer1k: { prompt: 0.0003, completion: 0.0012 } } as const;

/**
 * What every OpenAI row takes on the Responses route, checked against the live API on 2026-11-07 (provider-gateway §2, "Request
 * parameters"). `temperature` and `top_p` are refused (400 "Unsupported parameter") at every effort except `none`, so they are
 * never sent. Tools go out with `strict: false`: an absent flag is `true` there, which makes every optional parameter required.
 * Each level is sent as its own name (`none` for off), so Max reaches the API as `max`, not `high`. `text.format: json_object`
 * is accepted.
 */
const OPENAI_CAPS = {
  tools: true,
  jsonObject: true,
  effortStyle: 'reasoning.effort',
  effortWire: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  replayStyle: 'items',
  toolStrict: false,
  denylist: ['temperature', 'top_p'],
} as const satisfies Partial<ModelCaps>;

/**
 * Anthropic 5-series rows share tools+vision+replay and the adaptive thinking shape (`thinking.type: 'adaptive'` + `output_config.effort`;
 * `enabled` with `budget_tokens` is a 400 on them); only the effort set and price differ.
 */
const CLAUDE_CAPS = {
  tools: true,
  vision: true,
  replayStyle: 'blocks',
  thinkingShape: 'adaptive',
  thinkingDisplay: 'summarized',
  denylist: CLAUDE_DENY,
  ...CLAUDE_CACHE,
} as const satisfies Partial<ModelCaps>;

/** OpenCode's thinking fields per route (the levels are per row): Chat sends reasoning_effort, Messages the adaptive pair. */
const OPENCODE_CHAT = { effortStyle: 'reasoning_effort', effortWire: OWN_NAMES } as const satisfies Partial<ModelCaps>;
const OPENCODE_MESSAGES = { effortStyle: 'anthropic', thinkingShape: 'adaptive' } as const satisfies Partial<ModelCaps>;

/**
 * A local server loads its model from disk before it answers, so the headers, the first token and the gaps between
 * chunks all wait longer than a hosted API's (provider-gateway §4). The total stays at the gateway's five minutes.
 */
const LOCAL_TIMEOUTS = { connectMs: 180_000, firstTokenMs: 180_000, idleMs: 120_000 } as const;

/**
 * What a local server's `/v1/models` does not report is its context window, and these servers often run with a small
 * one. The row states a conservative one, so assembly warns before it overruns rather than the server silently
 * truncating. The profile's output cap stays the writer's override.
 */
const LOCAL_WINDOW_FALLBACK = 4_096;

export const PRESETS: readonly PresetDef[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    adapter: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5-5',
    quirks: { browserAccess: true },
    cors: 'ok',
    corsNote: 'Browser calls are supported; the adapter sends anthropic-dangerous-direct-browser-access. As of 2026-10 a wrong key makes the model list unreadable to a page (saving says so), while chat reports it as a rejected key.',
    docsUrl: 'https://platform.claude.com/docs',
    models: [
      // Window and output cap: Anthropic's model overview, "Compare models" table (1M and 128K tokens for all four),
      // https://platform.claude.com/docs/en/about-claude/models/overview, read 2026-10-20. Exact ids only: a Claude id
      // not named here gets no row, and so no guessed window. The output cap is informational (the profile's is sent).
      // Sonnet 5.5 turns thinking "off" via thinking.type between_tools, which the
      // Messages adapter does not emit — so Off is not offered on it.
      { pattern: 'claude-sonnet-5-5', caps: { ...CLAUDE_CAPS, cacheReadMultiplier: 0.05, effortStyle: 'anthropic', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricePer1k: { prompt: 0.002, completion: 0.01 } },
      // Opus 5.5 cannot turn thinking off.
      { pattern: 'claude-opus-5-5', caps: { ...CLAUDE_CAPS, cacheReadMultiplier: 0.05, effortStyle: 'anthropic', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricePer1k: { prompt: 0.004, completion: 0.02 } },
      // Haiku 5.5 accepts thinking.type disabled only with an effort at or below high; Off is sent alone, so max stays selectable.
      { pattern: 'claude-haiku-5-5', caps: { ...CLAUDE_CAPS, cacheReadMultiplier: 0.1, effortStyle: 'anthropic', effortLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] }, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      // Fable 5.1 cannot turn thinking off.
      { pattern: 'claude-fable-5-1', caps: { ...CLAUDE_CAPS, cacheReadMultiplier: 0.025, effortStyle: 'anthropic', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6-sol',
    // `store` defaults true on Responses; store:false is sent. Stateless resend,
    // since previous_response_id is unusable against non-stored responses.
    quirks: { store: true, stateless: true },
    cors: 'unknown',
    docsUrl: 'https://developers.openai.com/api/docs',
    models: [
      // Prices: OpenAI's price list, Standard tier, short context, read 2026-11-07 (https://developers.openai.com/api/docs/pricing):
      // gpt-6.1-sol $2 / $10, gpt-6-astra $10 / $50, gpt-6-luna $0.10 / $0.50 per 1M tokens. gpt-6-sol and gpt-5.5 are not listed there.
      { pattern: 'gpt-6-sol', caps: { ...OPENAI_EXPLICIT_CACHE, ...OPENAI_CAPS, cacheReadMultiplier: 0.1, vision: true, effortLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] } },
      { pattern: 'gpt-6-luna', caps: { ...OPENAI_EXPLICIT_CACHE, ...OPENAI_CAPS, cacheReadMultiplier: 0.1, effortLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] }, pricePer1k: { prompt: 0.0001, completion: 0.0005 } },
      // gpt-6-astra rejects none (400); functions work only on Responses, which is this route.
      { pattern: 'gpt-6-astra', caps: { ...OPENAI_EXPLICIT_CACHE, ...OPENAI_CAPS, cacheReadMultiplier: 0.1, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, pricePer1k: { prompt: 0.01, completion: 0.05 } },
      // gpt-6.1-sol: no none, no minimal; functions only on Responses.
      { pattern: 'gpt-6.1-sol', caps: { ...OPENAI_EXPLICIT_CACHE, ...OPENAI_CAPS, cacheReadMultiplier: 0.05, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, pricePer1k: { prompt: 0.002, completion: 0.01 } },
      // gpt-5.5 rejects max; it caches by itself.
      { pattern: 'gpt-5.5', caps: { ...OPENAI_CAPS, cache: 'automatic', cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1, effortLevels: ['off', 'low', 'medium', 'high', 'xhigh'] } },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini (OpenAI-compatible)',
    adapter: 'openai-chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.8-flash',
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    models: [
      // Gemini 3 models cannot disable thinking and take no `max`; minimal errors on
      // 3.8-flash, so the offered ladder starts at low.
      { pattern: 'gemini-3.8-flash', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'] }, pricePer1k: { prompt: 0.00075, completion: 0.00375 } },
      { pattern: 'gemini-4-argon', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'] }, pricePer1k: { prompt: 0.002, completion: 0.01 } },
      // The lite models take minimal..high; `minimal` is a level our scale does not
      // carry (it is not Off), so the offered ladder starts at low.
      { pattern: 'gemini-3.5-flash-lite', caps: { effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'] } },
      { pattern: 'gemini-3.6-flash', caps: { effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'] } },
      { pattern: 'gemini-3.1-pro-preview', caps: { effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'] } },
    ],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    adapter: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.7',
    // store defaults true (30-day retention); stateless resend because
    // previous_response_id cannot reference a non-stored response.
    quirks: { store: true, stateless: true },
    cors: 'unknown',
    docsUrl: 'https://docs.x.ai/docs',
    models: [
      // Reasoning cannot be disabled on grok-4.4 and later; presence/frequency/stop are rejected. 4.6 and 4.7 take xhigh; 4.5 tops at high.
      { pattern: 'grok-4.7', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'xhigh'], effortWire: OWN_NAMES, replayStyle: 'items', denylist: XAI_DENY }, contextWindow: 500_000, pricePer1k: { prompt: 0.002, completion: 0.006 } },
      { pattern: 'grok-4.6', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'xhigh'], effortWire: OWN_NAMES, replayStyle: 'items', denylist: XAI_DENY } },
      { pattern: 'grok-4.5', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'items', denylist: XAI_DENY } },
      // grok-4.3 takes `none` ("no reasoning at all") through high. TODO: xhigh is on its model page only; verify live before offering.
      { pattern: 'grok-4.3', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['off', 'low', 'medium', 'high'], replayStyle: 'items', denylist: XAI_DENY }, contextWindow: 1_000_000 },
    ],
  },
  {
    id: 'muse',
    name: 'Meta Muse',
    adapter: 'openai-responses',
    baseUrl: 'https://api.meta.ai/v1',
    defaultModel: 'muse-spark-1.3',
    // Reasoning continues across turns via encrypted_content replay.
    quirks: { includeEncryptedReasoning: true, stateless: true },
    cors: 'unknown',
    docsUrl: 'https://dev.meta.ai/docs',
    models: [
      { pattern: 'muse-spark-1.3', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], effortWire: OWN_NAMES, replayStyle: 'items' }, pricePer1k: { prompt: 0.00125, completion: 0.00425 } },
      { pattern: 'muse-wonder-1.0', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], effortWire: OWN_NAMES, replayStyle: 'items' } },
      // `max` is documented on muse-spark-1.3 and muse-wonder-1.0 only; every Muse model takes xhigh, none returns 400.
      { pattern: 'muse-spark-1.2', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'xhigh'], effortWire: OWN_NAMES, replayStyle: 'items' } },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    adapter: 'openai-chat',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-medium-3-5',
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://docs.mistral.ai',
    models: [
      // reasoning_effort is documented only on Medium 3.5 and Small: `none` and `high`.
      { pattern: 'mistral-medium-3-5', caps: { tools: true, jsonObject: true, jsonSchema: true, effortStyle: 'reasoning_effort', effortLevels: ['off', 'high'], replayStyle: 'text' } },
      { pattern: 'mistral-small-latest', caps: { tools: true, jsonObject: true, jsonSchema: true, effortStyle: 'reasoning_effort', effortLevels: ['off', 'high'], replayStyle: 'text' } },
      { pattern: 'mistral-large-2512', caps: { tools: true, vision: true, jsonObject: true, jsonSchema: true }, pricePer1k: { prompt: 0.0005, completion: 0.0015 } },
      // The reasoning page's per-model table: Large 4 takes low|medium|high; the hosted GLM 5.3 pair takes low|high|max (no none).
      { pattern: 'mistral-large-4-0', caps: { effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'] } },
      { pattern: 'zai-glm-5-3', caps: { effortStyle: 'reasoning_effort', effortLevels: ['low', 'high', 'max'], effortWire: OWN_NAMES } },
      { pattern: 'zai-glm-5-3-flash', caps: { effortStyle: 'reasoning_effort', effortLevels: ['low', 'high', 'max'], effortWire: OWN_NAMES } },
      { pattern: 'ministral-14b-2512', caps: { vision: true } },
      { pattern: 'ministral-8b-2512', caps: { vision: true } },
      { pattern: 'ministral-3b-2512', caps: { vision: true } },
    ],
  },
  {
    id: 'cohere',
    name: 'Cohere',
    adapter: 'openai-chat',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    defaultModel: 'command-a-plus-05-2026',
    // The compatibility layer documents no /models route (native v1/models is a
    // different shape): the table is the catalogue.
    noModelsRoute: true,
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://docs.cohere.com/docs/compatibility-api',
    models: [
      // TODO: a third party says A+ takes reasoning_effort none|high; Cohere's own docs don't. Verify live before offering.
      { pattern: 'command-a-plus-05-2026', caps: { tools: true, vision: false, denylist: COHERE_DENY }, contextWindow: 128_000 },
      // The only model the reasoning guide names; the compat route's effort accepts
      // `none` and `high` only, so the ladder is just Off and High.
      { pattern: 'command-a-reasoning-08-2025', caps: { tools: true, vision: false, effortStyle: 'reasoning_effort', effortLevels: ['off', 'high'], denylist: COHERE_DENY } },
      { pattern: 'command-a-03-2025', caps: { tools: true, vision: false, denylist: COHERE_DENY } },
      { pattern: 'command-a-translate-08-2025', caps: { vision: false, denylist: COHERE_DENY } },
      { pattern: 'command-a-vision-07-2025', caps: { vision: false, denylist: COHERE_DENY } }, // image input is native v2 only
      { pattern: 'command-r7b-12-2024', caps: { tools: true, vision: false, denylist: COHERE_DENY } },
      { pattern: 'command-r-08-2024', caps: { tools: true, vision: false, denylist: COHERE_DENY } },
      { pattern: 'command-r-plus-08-2024', caps: { tools: true, vision: false, denylist: COHERE_DENY } },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    adapter: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://api-docs.deepseek.com',
    models: [
      { pattern: 'deepseek-flash', ...DEEPSEEK_FLASH },
      // v4-pro is text-only (the API drops images silently). Peak prices $1.32 / $3.96 per 1M; off-peak is half; cache reads 1/30.
      { pattern: 'deepseek-v4-pro', caps: { ...DEEPSEEK_CAPS, cacheReadMultiplier: 0.0333 }, ...DEEPSEEK_LIMITS, pricePer1k: { prompt: 0.00132, completion: 0.00396 } },
      // Retired names, served by and billed as deepseek-flash.
      { pattern: 'deepseek-v4-flash', ...DEEPSEEK_FLASH },
      { pattern: 'deepseek-v4-flash-vision-exp', ...DEEPSEEK_FLASH },
    ],
  },
  {
    id: 'alibaba',
    name: 'Alibaba Cloud Model Studio (Qwen)',
    adapter: 'openai-chat',
    // The base is workspace- and region-bound: `{workspaceId}.{region}.maas.aliyuncs.com`.
    baseUrl: 'https://{workspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1',
    baseUrlFor: (fields) => `https://${fields.workspaceId}.${fields.region ?? 'ap-southeast-1'}.maas.aliyuncs.com/compatible-mode/v1`,
    defaultModel: 'qwen3.7-plus',
    fields: [
      { key: 'workspaceId', label: 'Workspace ID', required: true },
      {
        key: 'region',
        label: 'Region',
        defaultValue: 'ap-southeast-1',
        options: [
          { value: 'ap-southeast-1', label: 'Singapore (ap-southeast-1)' },
          { value: 'cn-beijing', label: 'China (cn-beijing)' },
          { value: 'cn-hongkong', label: 'Hong Kong (cn-hongkong)' },
          { value: 'ap-northeast-1', label: 'Japan (ap-northeast-1)' },
          { value: 'eu-central-1', label: 'Germany (eu-central-1)' },
          { value: 'us-east-1', label: 'US (us-east-1)' },
        ],
      },
    ],
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio',
    models: [
      // All four are hybrid: enable_thinking:false turns thinking off. Thinking models must stream, which the adapter always does.
      { pattern: 'qwen3.7-plus', caps: { tools: true, vision: true, effortStyle: 'enable_thinking+budget', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field', streamRequired: true } },
      // qwen3.8-max and -flash take reasoning_effort low|medium|xhigh (high and max map to xhigh); none turns thinking off.
      { pattern: 'qwen3.8-max', caps: { vision: true, effortStyle: 'reasoning_effort', effortLevels: ['off', 'low', 'medium', 'xhigh'], effortWire: OWN_NAMES, replayStyle: 'content-field', streamRequired: true } },
      { pattern: 'qwen3.8-flash', caps: { effortStyle: 'reasoning_effort', effortLevels: ['off', 'low', 'medium', 'xhigh'], effortWire: OWN_NAMES, replayStyle: 'content-field', streamRequired: true } },
      { pattern: 'qwen3.7-flash', caps: { tools: true, vision: true, effortStyle: 'enable_thinking+budget', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field', streamRequired: true } },
    ],
  },
  {
    id: 'tencent-hunyuan',
    name: 'Tencent Hunyuan (TokenHub)',
    adapter: 'openai-chat',
    baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
    baseUrlFor: (fields) =>
      ({
        'intl-sg': 'https://tokenhub-intl.tencentcloudmaas.com/v1',
        guangzhou: 'https://tokenhub.tencentcloudmaas.com/v1',
        us: 'https://tokenhub-us.tencentcloudmaas.com/v1',
        cn: 'https://tokenhub.tencentmaas.com/v1',
      })[fields.region ?? 'intl-sg'] ?? 'https://tokenhub-intl.tencentcloudmaas.com/v1',
    defaultModel: 'hy3',
    fields: [
      {
        key: 'region',
        label: 'Site',
        defaultValue: 'intl-sg',
        options: [
          { value: 'intl-sg', label: 'International (Singapore)' },
          { value: 'guangzhou', label: 'China (Guangzhou)' },
          { value: 'us', label: 'United States' },
          { value: 'cn', label: 'Mainland China' },
        ],
      },
    ],
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://intl.cloud.tencent.com/document/product/1300',
    models: [
      // thinking disabled is documented for both; reasoning_effort is low|high on hy3 and high only on hy4-preview. Both are
      // text-only on every route.
      { pattern: 'hy3', caps: { tools: true, effortStyle: 'thinking.type+effort', effortLevels: ['off', 'low', 'high'], replayStyle: 'content-field' }, contextWindow: 256_000, maxOutputTokens: 128_000 },
      { pattern: 'hy4-preview', caps: { tools: true, effortStyle: 'thinking.type+effort', effortLevels: ['off', 'high'], replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
    ],
  },
  {
    id: 'byteplus-ark',
    name: 'BytePlus ModelArk',
    adapter: 'openai-chat',
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    defaultModel: 'seed-2-0-lite-260428',
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://docs.byteplus.com/en/docs/ModelArk',
    models: [
      // Seed 2.0 Lite is omni-modal per the vendor page; this snapshot's function
      // calling is not confirmed (the tool list names -260228).
      { pattern: 'seed-2-0-lite-260428', caps: { vision: true, effortStyle: 'thinking.type+effort', effortLevels: ['off', 'low', 'medium', 'high'], replayStyle: 'content-field' } },
      { pattern: 'seed-2-0-lite-260228', caps: { tools: true, vision: true, jsonSchema: true, effortStyle: 'thinking.type+effort', effortLevels: ['off', 'low', 'medium', 'high'], replayStyle: 'content-field' } },
      { pattern: 'seed-2-0-pro-260328', caps: { tools: true, vision: true, effortStyle: 'thinking.type+effort', effortLevels: ['off', 'low', 'medium', 'high'], replayStyle: 'content-field' } },
      { pattern: 'seed-2-0-mini-260215', caps: { tools: true, effortStyle: 'thinking.type+effort', effortLevels: ['off', 'low', 'medium', 'high'], replayStyle: 'content-field' } },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI (Kimi)',
    adapter: 'openai-chat',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://platform.kimi.ai/docs',
    models: [
      // kimi-k3 cannot turn thinking off; medium is unsupported (high); max is its default.
      { pattern: 'kimi-k3', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'high', 'max'], effortWire: OWN_NAMES, replayStyle: 'content-field', denylist: MOONSHOT_DENY }, contextWindow: 1_048_576, pricePer1k: { prompt: 0.003, completion: 0.015 } },
      // kimi-k2.6's thinking is enabled/disabled only (no reasoning_effort): On and Off.
      { pattern: 'kimi-k2.6', caps: { vision: true, effortStyle: 'thinking.type', effortLevels: ['off', 'high'], replayStyle: 'content-field', denylist: MOONSHOT_DENY }, contextWindow: 262_144, pricePer1k: { prompt: 0.00095, completion: 0.004 } },
      // kimi-k2.7-code thinks unconditionally (Off errors): no control is offered.
      { pattern: 'kimi-k2.7-code', caps: { tools: true, vision: true, replayStyle: 'content-field', denylist: MOONSHOT_DENY }, contextWindow: 262_144, pricePer1k: { prompt: 0.00095, completion: 0.004 } },
      { pattern: 'kimi-k2.7-code-highspeed', caps: { tools: true, vision: true, replayStyle: 'content-field', denylist: MOONSHOT_DENY }, contextWindow: 262_144, pricePer1k: { prompt: 0.0019, completion: 0.008 } },
    ],
  },
  {
    id: 'zhipu-zai',
    name: 'Z.ai (GLM)',
    adapter: 'openai-chat',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5.3',
    quirks: {},
    // The BYOK base is the general paas/v4 host; Coding Plan bases are excluded.
    // The 2026-10-26 sweep found the chat route refusing the preflight; on 2026-10-30 it answered a browser POST (401 without a key),
    // so it is no longer blocked. Z.ai documents no browser access, so it is 'unknown', not 'ok'.
    cors: 'unknown',
    docsUrl: 'https://docs.z.ai',
    models: [
      // glm-5.3 family cannot disable thinking; it takes low|high|max (max is the default), anything else errors.
      { pattern: 'glm-5.3', caps: { tools: true, effortStyle: 'thinking.type+effort', effortLevels: ['low', 'high', 'max'], effortWire: OWN_NAMES, replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricePer1k: { prompt: 0.0014, completion: 0.0044 } },
      { pattern: 'glm-5.3-flash', caps: { tools: true, vision: true, effortStyle: 'thinking.type+effort', effortLevels: ['low', 'high', 'max'], effortWire: OWN_NAMES, replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricePer1k: { prompt: 0.00015, completion: 0.0005 } },
      { pattern: 'glm-5.3-flashx', caps: { tools: true, vision: true, effortStyle: 'thinking.type+effort', effortLevels: ['low', 'high', 'max'], effortWire: OWN_NAMES, replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricePer1k: { prompt: 0.00037, completion: 0.00125 } },
      // glm-5.2: Off is thinking disabled; low and medium act as high, xhigh as max, so Off, High and Max.
      { pattern: 'glm-5.2', caps: { tools: true, effortStyle: 'thinking.type+effort', effortLevels: ['off', 'high', 'max'], effortWire: OWN_NAMES, replayStyle: 'content-field' }, contextWindow: 200_000 },
      // glm-5.1, glm-5, glm-4.6 and glm-4.7: thinking enabled|disabled only (reasoning_effort is 5.2+): On and Off.
      { pattern: 'glm-5.1', caps: { tools: true, effortStyle: 'thinking.type', effortLevels: ['off', 'high'], replayStyle: 'content-field' }, contextWindow: 200_000 },
      { pattern: 'glm-5', caps: { tools: true, effortStyle: 'thinking.type', effortLevels: ['off', 'high'], replayStyle: 'content-field' }, contextWindow: 200_000, pricePer1k: { prompt: 0.001, completion: 0.0032 } },
      { pattern: 'glm-4.6', caps: { tools: true, effortStyle: 'thinking.type', effortLevels: ['off', 'high'], replayStyle: 'content-field' }, contextWindow: 200_000 },
      { pattern: 'glm-4.7', caps: { tools: true, effortStyle: 'thinking.type', effortLevels: ['off', 'high'], replayStyle: 'content-field' }, contextWindow: 200_000, pricePer1k: { prompt: 0.0006, completion: 0.0022 } },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    adapter: 'openai-chat',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M3',
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://platform.minimax.io/docs',
    models: [
      // M3 takes thinking adaptive|disabled on the Chat route (reasoning_effort is ignored). `reasoning_split` is
      // not sent (no quirk for it), so thinking arrives as <think> tags in content.
      { pattern: 'MiniMax-M3', caps: { tools: true, vision: true, effortStyle: 'thinking.type', effortLevels: ['off', 'high'], effortWire: { high: 'adaptive' }, replayStyle: 'think-tags' }, contextWindow: 1_000_000, pricePer1k: { prompt: 0.0003, completion: 0.0012 } },
      // M3.1-Flash-Preview is subscription-gated (M Plan); Off returns 400; low..max with max the default.
      // TODO: the docs now name `MiniMax-M3.1-Flash`; verify the preview id still answers.
      { pattern: 'MiniMax-M3.1-Flash-Preview', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], effortWire: OWN_NAMES, replayStyle: 'think-tags' }, contextWindow: 1_000_000 },
    ],
  },
  {
    id: 'xiaomi-mimo',
    name: 'Xiaomi MiMo',
    adapter: 'openai-chat',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.6-pro',
    // Official examples send `api-key`; Bearer is also accepted. Chat takes
    // `max_completion_tokens` (max_tokens is not in its parameter table).
    quirks: { auth: 'api-key', maxTokensField: 'max_completion_tokens' },
    cors: 'unknown',
    docsUrl: 'https://mimo.mi.com/docs/en-US',
    models: [
      // Chat thinking is enabled|disabled with no levels: On and Off.
      { pattern: 'mimo-v2.6-pro', caps: { tools: true, vision: true, effortStyle: 'thinking.type', effortLevels: ['off', 'high'], replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 131_072 },
      { pattern: 'mimo-v2.6-flash', caps: { tools: true, vision: true, effortStyle: 'thinking.type', effortLevels: ['off', 'high'], replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 131_072 },
      { pattern: 'mimo-v2.6-pro-ultraspeed', caps: { tools: true, vision: true, effortStyle: 'thinking.type', effortLevels: ['off', 'high'], replayStyle: 'content-field' } },
    ],
  },
  {
    id: 'nanogpt',
    name: 'NanoGPT',
    adapter: 'openai-chat',
    baseUrl: 'https://api.nano-gpt.com/api/v1',
    defaultModel: 'x-ai/grok-4.7',
    keylessModels: true,
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://docs.nano-gpt.com',
    models: [
      // `reasoning_effort` in the body takes none..max, checked per model against the live catalog's `reasoning_efforts`.
      // Reasoning returns in a `reasoning` field, which no replay style writes — text.
      { pattern: 'x-ai/grok-4.7', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high', 'xhigh'], effortWire: OWN_NAMES, replayStyle: 'text' } },
      { pattern: 'google/gemini-3.8-flash', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'text' } },
      // deepseek-v4-flash lists none, high and max.
      { pattern: 'deepseek/deepseek-v4-flash', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['off', 'high', 'max'], effortWire: OWN_NAMES, replayStyle: 'text' } },
      // kimi-k3 lists low, high and max (no medium).
      { pattern: 'moonshotai/kimi-k3', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'high', 'max'], effortWire: OWN_NAMES, replayStyle: 'text' } },
      // claude-opus-5.5 rejects `none` (always-reasoning) and lists low..max.
      { pattern: 'anthropic/claude-opus-5.5', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], effortWire: OWN_NAMES, replayStyle: 'text' } },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    adapter: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'x-ai/grok-4.7',
    keylessModels: true,
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://openrouter.ai/docs',
    models: [
      // Effort is nested reasoning.effort even on the Chat route. `reasoning` fields
      // have no replay style — text. All rows have image input per the live catalog.
      // Levels are each row's `reasoning.supported_efforts` in the live catalog; grok-4.7 and claude-opus-5.5 are
      // reasoning-mandatory (none rejected), and grok-4.7 tops out at xhigh.
      { pattern: 'x-ai/grok-4.7', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'xhigh'], effortWire: OWN_NAMES, replayStyle: 'text' } },
      { pattern: 'openai/gpt-6-sol', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], effortWire: OWN_NAMES, replayStyle: 'text' } },
      { pattern: 'deepseek/deepseek-v4.1-flash', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['off', 'low', 'high', 'max'], effortWire: OWN_NAMES, replayStyle: 'text' } },
      { pattern: 'anthropic/claude-opus-5.5', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], effortWire: OWN_NAMES, replayStyle: 'text' } },
      // gemini-3.8-flash tops out at high.
      { pattern: 'google/gemini-3.8-flash', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'text' } },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    adapter: 'openai-chat',
    // Family B serves chat, responses, messages and /models under one base.
    baseUrl: 'https://opencode.ai/inference/v1',
    defaultModel: 'claude-sonnet-5-5',
    // Free chat models work without a key; paid models need it.
    keyOptional: true,
    keylessModels: true,
    quirks: {
      // OpenCode routes by model family: Claude and two Qwen ids live on the Messages
      // route; qwen3.8-max is deliberately a Chat id, so no broad `qwen*` glob.
      modelRoutes: {
        'claude-*': 'anthropic-messages',
        'qwen3.8-flash': 'anthropic-messages',
        'qwen3.7-plus': 'anthropic-messages',
      },
      // The docs ask clients to send their own user agent.
      extraHeaders: { 'user-agent': 'caotang' },
    },
    // The chat and Messages routes answer a preflight with 404 (only GET /models is allowed), so the page cannot call them (sweep, 2026-10-26).
    cors: 'blocked',
    corsNote: 'The inference host refuses the browser preflight on its chat routes (only the model list is allowed), so a web page cannot chat with it. `user-agent` is a forbidden header in the browser — it is sent only where fetch allows it (desktop/hosted).',
    docsUrl: 'https://opencode.ai/docs',
    // Vision and tools are documented on no route: every row is text-only (vision: false). Thinking levels are each model's
    // `capabilities.reasoning` in OpenCode's live catalog (GET /inference/v1/models, read 2026-11-07; `toggle` = Off). Messages-route
    // rows take the Anthropic adaptive shape; Chat rows take reasoning_effort.
    models: [
      { pattern: 'claude-sonnet-5-5', caps: { vision: false, ...OPENCODE_MESSAGES, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      { pattern: 'claude-haiku-5-5', caps: { vision: false, ...OPENCODE_MESSAGES, effortLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] } },
      { pattern: 'claude-opus-5-5', caps: { vision: false, ...OPENCODE_MESSAGES, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      { pattern: 'claude-fable-5-1', caps: { vision: false, ...OPENCODE_MESSAGES, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      { pattern: 'qwen3.8-flash', caps: { vision: false, ...OPENCODE_MESSAGES, effortLevels: ['off', 'low', 'medium', 'xhigh'] } },
      // TODO: qwen3.7-plus is missing from the live catalog (likely retired); verify or remove.
      { pattern: 'qwen3.7-plus', caps: { vision: false } },
      { pattern: 'qwen3.8-max', caps: { vision: false, ...OPENCODE_CHAT, effortLevels: ['off', 'low', 'medium', 'xhigh'] } },
      { pattern: 'kimi-k3', caps: { vision: false, ...OPENCODE_CHAT, effortLevels: ['off', 'low', 'high', 'max'] } },
      { pattern: 'glm-5.3', caps: { vision: false, ...OPENCODE_CHAT, effortLevels: ['low', 'high', 'max'] } },
      { pattern: 'deepseek-v4-pro', caps: { vision: false, ...OPENCODE_CHAT, effortLevels: ['off', 'high', 'max'] } },
      // minimax-m2.7 reasons but the catalog lists no controls.
      { pattern: 'minimax-m2.7', caps: { vision: false } },
      { pattern: 'mistral-large-4', caps: { vision: false, ...OPENCODE_CHAT, effortLevels: ['off', 'high'] } },
      // TODO: the catalog lists none for gpt-6-sol and gpt-5.5, but Zen has rejected none on a GPT path (OpenCode #41323);
      // verify live before offering Off on the GPT rows.
      { pattern: 'gpt-6-sol', caps: { vision: false, ...OPENCODE_CHAT, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      { pattern: 'gpt-6-astra', caps: { vision: false, ...OPENCODE_CHAT, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      { pattern: 'gpt-6.1-sol', caps: { vision: false, ...OPENCODE_CHAT, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      { pattern: 'gpt-5.5', caps: { vision: false, ...OPENCODE_CHAT, effortLevels: ['low', 'medium', 'high', 'xhigh'] } },
      { pattern: 'grok-4.7', caps: { vision: false, ...OPENCODE_CHAT, effortLevels: ['low', 'medium', 'high', 'xhigh'] } },
      { pattern: 'muse-spark-1.3', caps: { vision: false, ...OPENCODE_CHAT, effortLevels: ['low', 'medium', 'high', 'xhigh'] } },
    ],
  },
  {
    id: 'perplexity',
    name: 'Perplexity (Router)',
    adapter: 'openai-chat',
    baseUrl: 'https://api.perplexity.ai/router/v1',
    defaultModel: 'perplexity/kimi-k3',
    quirks: { maxTokensField: 'max_completion_tokens' },
    cors: 'unknown',
    docsUrl: 'https://docs.perplexity.ai/docs',
    models: [
      // The Router accepts response_format json_schema (always strict) or json_object.
      // `max` is reported for kimi-k3 only; per-model acceptance of `none` is
      // undocumented, so Off stays hidden. TODO: per-model levels are undocumented (upstream Kimi K3 and GLM-5.3 take
      // low|high|max); verify live before changing these rows.
      { pattern: 'perplexity/kimi-k3', caps: { tools: true, jsonSchema: true, jsonObject: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'text' } },
      { pattern: 'perplexity/glm-5.3-flash', caps: { tools: true, jsonSchema: true, jsonObject: true, replayStyle: 'text' } },
      { pattern: 'perplexity/glm-5.3', caps: { tools: true, jsonSchema: true, jsonObject: true, replayStyle: 'text' } },
      { pattern: 'perplexity/nemotron-3-ultra-550b-a55b', caps: { tools: true, jsonSchema: true, jsonObject: true, replayStyle: 'text' } },
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    adapter: 'openai-chat',
    baseUrl: 'https://api.together.ai/v1',
    defaultModel: 'moonshotai/Kimi-K3',
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://docs.together.ai',
    models: [
      // Hybrid models toggle with reasoning:{enabled}; the per-level reasoning_effort
      // field exists too, but one effortStyle is picked per row — the documented Off
      // path wins, so the toggle is offered (On/Off). TODO: a third party says the disable toggle is ignored on Kimi-K3,
      // GLM-5.2 and MiniMax-M3; verify live.
      { pattern: 'moonshotai/Kimi-K3', caps: { tools: true, vision: true, effortStyle: 'reasoning.enabled', effortLevels: ['off', 'high'], replayStyle: 'content-field' } },
      { pattern: 'deepseek-ai/DeepSeek-V4-Pro-0813', caps: { tools: true, effortStyle: 'reasoning.enabled', effortLevels: ['off', 'high'], replayStyle: 'text' } },
      { pattern: 'zai-org/GLM-5.2', caps: { tools: true, effortStyle: 'reasoning.enabled', effortLevels: ['off', 'high'], replayStyle: 'content-field' } },
      // gpt-oss-120b takes reasoning_effort low/medium/high and cannot turn off.
      { pattern: 'openai/gpt-oss-120b', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'text' } },
      // Both are hybrid and toggle with reasoning:{enabled}.
      { pattern: 'MiniMaxAI/MiniMax-M3', caps: { vision: true, effortStyle: 'reasoning.enabled', effortLevels: ['off', 'high'], replayStyle: 'content-field' } },
      { pattern: 'Qwen/Qwen3.5-9B', caps: { vision: true, effortStyle: 'reasoning.enabled', effortLevels: ['off', 'high'] } },
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    adapter: 'openai-chat',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/kimi-k3',
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://docs.fireworks.ai',
    models: [
      // Levels from the chat reference's per-model reasoning_effort map: kimi-k3 takes none, low, high and max (its default;
      // medium and xhigh are aliases). Reasoning returns as reasoning_content (some models use <think> tags — content-field
      // is the documented one).
      { pattern: 'accounts/fireworks/models/kimi-k3', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['off', 'low', 'high', 'max'], effortWire: OWN_NAMES, replayStyle: 'content-field' }, contextWindow: 1_048_576 },
      // TODO: GLM 5.3 is not in Fireworks' map (third parties: thinking-only, none 400s); verify live, likely low|high|max.
      { pattern: 'accounts/fireworks/models/glm-5p3-flash', caps: { tools: true, vision: true, replayStyle: 'content-field' } },
      { pattern: 'accounts/fireworks/models/glm-5p3', caps: { tools: true, vision: false, replayStyle: 'content-field' } },
      // minimax-m3 takes `adaptive` (on) and `none`; glm-4p7 is on/off only (levels have no effect).
      { pattern: 'accounts/fireworks/models/minimax-m3', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['off', 'high'], effortWire: { high: 'adaptive' }, replayStyle: 'content-field' } },
      // TODO: kimi-k2-thinking is not in the map; verify live.
      { pattern: 'accounts/fireworks/models/kimi-k2-thinking', caps: { tools: true, replayStyle: 'content-field' } },
      { pattern: 'accounts/fireworks/models/glm-4p7', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['off', 'high'], replayStyle: 'content-field' } },
    ],
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    adapter: 'openai-chat',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    defaultModel: 'google/gemini-2.5-pro',
    keylessModels: true,
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://docs.deepinfra.com',
    models: [
      // Effort is documented per model only where the reasoning guide or a provider
      // blog post names it; gemini-2.5-pro's tiers are unverified, so none are offered.
      { pattern: 'google/gemini-2.5-pro', caps: { tools: true, replayStyle: 'content-field' } },
      { pattern: 'Qwen/Qwen3-VL-235B-A22B-Instruct', caps: { tools: true, vision: true, replayStyle: 'content-field' } },
      { pattern: 'anthropic/claude-haiku-4-5', caps: { tools: true, replayStyle: 'content-field' } },
      // GLM-5.3 cannot turn off (per DeepInfra's blog); medium remaps, so low/high/max.
      { pattern: 'zai-org/GLM-5.3', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'high', 'max'], effortWire: OWN_NAMES, replayStyle: 'content-field' } },
      // Kimi-K3 always thinks — no Off; max is its default.
      { pattern: 'moonshotai/Kimi-K3', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'high', 'max'], effortWire: OWN_NAMES, replayStyle: 'content-field' } },
      // The reasoning guide documents `none` with this exact model. TODO: its tiers (and so max under its own name) follow
      // upstream DeepSeek only; verify live before sending max as 'max'.
      { pattern: 'deepseek-ai/DeepSeek-V4-Flash-0731', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['off', 'low', 'high', 'max'], replayStyle: 'content-field' } },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    adapter: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    quirks: { maxTokensField: 'max_completion_tokens' },
    cors: 'unknown',
    docsUrl: 'https://console.groq.com/docs',
    models: [
      // gpt-oss rejects `none` (400) and has no max. Reasoning lands in `reasoning`.
      { pattern: 'openai/gpt-oss-120b', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'text', denylist: GROQ_DENY } },
      { pattern: 'openai/gpt-oss-20b', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'text', denylist: GROQ_DENY } },
      // qwen3.8-27b is the only vision model (Preview); raw reasoning_format is the
      // default, so thinking arrives as <think> tags.
      { pattern: 'qwen/qwen3.8-27b', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['off', 'low', 'medium', 'high'], replayStyle: 'think-tags', denylist: GROQ_DENY } },
      // minimax-m2.7 is enterprise-gated; no effort values are documented.
      { pattern: 'minimaxai/minimax-m2.7', caps: { tools: true, denylist: GROQ_DENY } },
      { pattern: 'openai/gpt-oss-safeguard-20b', caps: { denylist: GROQ_DENY } },
    ],
  },
  {
    id: 'huggingface',
    name: 'Hugging Face Inference Providers',
    adapter: 'openai-chat',
    baseUrl: 'https://router.huggingface.co/v1',
    defaultModel: 'openai/gpt-oss-120b',
    keylessModels: true,
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://huggingface.co/docs/inference-providers',
    models: [
      { pattern: 'openai/gpt-oss-120b', caps: { tools: true, vision: false, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'] } },
      // Qwen3.8-27B hides High on the router (its top tier is xhigh) — low/medium only. TODO: Groq/Cerebras backends take
      // none..high (high = xhigh); verify per backend before offering Off and High.
      { pattern: 'Qwen/Qwen3.8-27B', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium'] } },
      // TODO: the router's backend decides what is accepted; GLM-5.3-Flash takes low|high|max upstream, so verify max live.
      { pattern: 'zai-org/GLM-5.3-Flash', caps: { vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'high', 'max'] } },
      // DeepSeek-V4.1-Flash takes an integer 1–100 effort scale nothing maps to.
      { pattern: 'deepseek-ai/DeepSeek-V4.1-Flash', caps: { vision: true } },
      { pattern: 'CohereLabs/command-a-plus-05-2026-w4a4', caps: { vision: true } },
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras Inference',
    adapter: 'openai-chat',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'gpt-oss-120b',
    quirks: {},
    cors: 'unknown',
    docsUrl: 'https://inference-docs.cerebras.ai',
    models: [
      // gpt-oss-120b cannot turn thinking off and takes no max.
      { pattern: 'gpt-oss-120b', caps: { tools: true, vision: false, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'] } },
      // qwen-3.8-27b documents `none` for Off.
      { pattern: 'qwen-3.8-27b', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['off', 'low', 'medium', 'high'] } },
    ],
  },
  {
    // The three local presets share a shape: a server on this computer, `http` to a literal loopback address, no key unless
    // the writer set one on the server, and conservative capabilities — no native tools and no images — so the agent
    // speaks the JSON-in-text wire. They differ in the default port and in the one setting that lets a page call them.
    id: 'ollama',
    name: 'Ollama',
    adapter: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.2',
    keyOptional: true,
    keylessModels: true,
    quirks: {},
    cors: 'local',
    docsUrl: 'https://docs.ollama.com/faq',
    local: {
      product: 'Ollama',
      corsFix: 'Start Ollama with OLLAMA_ORIGINS set to this app’s address (for caotang.app: OLLAMA_ORIGINS=https://caotang.app) and restart it.',
      setup:
        'Install Ollama, pull a model (ollama pull llama3.2) and leave it running. Ollama starts with a small context window: raise it with OLLAMA_CONTEXT_LENGTH if replies lose the start of your scene.',
    },
    timeouts: LOCAL_TIMEOUTS,
    models: [{ pattern: '*', caps: {}, contextWindow: LOCAL_WINDOW_FALLBACK }],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    adapter: 'openai-chat',
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    keyOptional: true,
    keylessModels: true,
    quirks: {},
    cors: 'local',
    docsUrl: 'https://lmstudio.ai/docs/developer/core/server',
    local: {
      product: 'LM Studio',
      corsFix: 'Turn on Enable CORS in LM Studio’s server settings (or start the server with lms server start --cors).',
      setup:
        'In LM Studio, load a model and start the local server, with Enable CORS on. The context length is set when the model loads: raise it there if replies lose the start of your scene.',
    },
    timeouts: LOCAL_TIMEOUTS,
    models: [{ pattern: '*', caps: {}, contextWindow: LOCAL_WINDOW_FALLBACK }],
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp (llama-server)',
    adapter: 'openai-chat',
    baseUrl: 'http://127.0.0.1:8080/v1',
    defaultModel: 'default',
    keyOptional: true,
    keylessModels: true,
    quirks: {},
    cors: 'local',
    docsUrl: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
    local: {
      product: 'llama-server',
      corsFix: 'Start llama-server with --cors-origins set to this app’s address (for caotang.app: --cors-origins https://caotang.app); a server started with --tools or --agent only admits localhost pages.',
      setup:
        'Start llama-server with a model (llama-server -m model.gguf --port 8080); it serves that one model whatever name you enter. Set its context window with -c (--ctx-size) if replies lose the start of your scene.',
    },
    timeouts: LOCAL_TIMEOUTS,
    models: [{ pattern: '*', caps: {}, contextWindow: LOCAL_WINDOW_FALLBACK }],
  },
  {
    // A hand-rolled endpoint: the person types the base URL. Caps stay conservative —
    // tools and json_object are enabled so the §5 probe and the caller decide what
    // actually goes on the wire.
    id: 'generic',
    name: 'OpenAI-compatible endpoint',
    adapter: 'openai-chat',
    baseUrl: '',
    defaultModel: '',
    keyOptional: true,
    keylessModels: true,
    quirks: {},
    cors: 'unknown',
    corsNote: 'Reachability depends on the endpoint’s own CORS policy.',
    models: [{ pattern: '*', caps: { tools: true, jsonObject: true } }],
  },
  {
    // The local seam for tests and demos. Kind `mock` routes to the mock provider
    // before route resolution ever consults this row; it exists so `presetFor` has a
    // complete answer for every id the registry owns.
    id: 'mock',
    name: 'Demo (mock)',
    adapter: 'openai-chat',
    baseUrl: 'mock://caotang',
    defaultModel: 'mock/echo-1',
    keyOptional: true,
    quirks: {},
    cors: 'ok',
    models: [],
  },
];

const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

/** The preset an id names, or undefined. `generic` answers for an absent id. */
export function presetFor(id: string | undefined): PresetDef | undefined {
  return BY_ID.get(id ?? 'generic');
}

/**
 * The capability row a (preset, model) pair resolves to: an exact id match wins,
 * then the first matching glob, then the preset's `'*'` default row.
 */
export function modelRowFor(preset: PresetDef, model: string): ModelRow | undefined {
  let globRow: ModelRow | undefined;
  let defaultRow: ModelRow | undefined;
  for (const row of preset.models) {
    if (row.pattern === '*') defaultRow ??= row;
    else if (row.pattern.endsWith('*')) {
      if (model.startsWith(row.pattern.slice(0, -1))) globRow ??= row;
    } else if (row.pattern === model) return row;
  }
  return globRow ?? defaultRow;
}

/** The thinking levels in display order. */
const LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The effort style a route speaks when a profile turns thinking on for a row that names none. */
const DEFAULT_STYLE: Readonly<Record<AdapterId, string>> = {
  'openai-chat': 'reasoning_effort',
  'openai-responses': 'reasoning.effort',
  'anthropic-messages': 'anthropic',
};

/**
 * A row's caps with a profile's own request parameters laid over them (provider-gateway §2, "Request parameters"). Each set field
 * wins for this profile; an absent one keeps the row's. A temperature allowed here leaves the denylist; one refused joins it.
 */
export function withParams(caps: ModelCaps, params: RequestParams | undefined, adapter: AdapterId): ModelCaps {
  if (params === undefined) return caps;
  const deny = new Set([...(caps.denylist ?? []), ...(params.deny ?? [])]);
  if (params.temperature === true) deny.delete('temperature');
  if (params.temperature === false) deny.add('temperature');
  const out: { -readonly [K in keyof ModelCaps]: ModelCaps[K] } = { ...caps };
  if (deny.size > 0) out.denylist = [...deny];
  else delete out.denylist;
  if (params.toolStrict !== undefined) out.toolStrict = params.toolStrict;
  if (params.effort !== undefined) {
    const effort = params.effort;
    out.effortLevels = LEVELS.filter((level) => (effort[level] ?? '') !== '');
    out.effortWire = effort;
    out.effortStyle = caps.effortStyle ?? DEFAULT_STYLE[adapter];
  }
  return out;
}

/**
 * What a (profile-ish, model) pair speaks: the preset's adapter (overridden by its
 * `modelRoutes`), its quirks, and the matched model row's caps with the profile's own
 * request parameters over them. A base URL at api.openai.com or api.anthropic.com
 * answers with that host's preset. Otherwise no known preset — an endpoint
 * profile older than the registry, or one whose `preset` names nothing — falls back to
 * the generic OpenAI-Chat route with empty caps.
 */
export function resolveRoute(
  profile: { readonly preset?: string; readonly baseUrl: string; readonly params?: RequestParams },
  model: string,
): RouteSpec {
  let host = '';
  try {
    host = new URL(profile.baseUrl).hostname;
  } catch {
    // not a URL: no pin
  }
  // First-party hosts take their own preset whatever the profile names (provider-gateway §2): OpenAI's newer models
  // refuse function tools with reasoning on Chat Completions, and Anthropic's chat endpoint is a compatibility layer.
  const id = host === 'api.openai.com' ? 'openai' : host === 'api.anthropic.com' ? 'anthropic' : profile.preset;
  const preset = BY_ID.get(id ?? '');
  if (preset === undefined) return { adapter: 'openai-chat', quirks: {}, caps: withParams({}, profile.params, 'openai-chat') };
  const row = modelRowFor(preset, model);
  const adapter = routeFor(preset.quirks, model, preset.adapter);
  return {
    adapter,
    quirks: preset.quirks,
    caps: withParams(row?.caps ?? {}, profile.params, adapter),
    ...(row?.maxOutputTokens === undefined ? {} : { modelMaxOutput: row.maxOutputTokens }),
  };
}
