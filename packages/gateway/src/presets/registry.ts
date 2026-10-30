/**
 * The preset registry — every shipped provider, one `PresetDef` each.
 *
 * The tables below transcribe each provider's own documentation: base URLs, default
 * model ids, per-model capabilities, effort encodings and prices. Where the docs are
 * silent the field is absent; where they disagree the conservative reading is taken.
 * Prices are written per 1,000 tokens (the profile unit) — a provider's "$x / $y per
 * 1M" lands here divided by 1,000.
 */

import { routeFor, type RouteSpec } from '../adapters/types.js';
import type { ModelCaps } from '../types.js';
import type { ModelRow, PresetDef } from './types.js';

/** Anthropic omits `temperature`, `top_p` and `top_k` on Claude 4.7 and later (400 on non-default values). */
const CLAUDE_DENY = ['temperature', 'top_p', 'top_k'] as const;
/** Moonshot: do not send sampling knobs at all. */
const MOONSHOT_DENY = ['temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty'] as const;
/** DeepSeek: "do not send temperature or the penalty fields". */
const DEEPSEEK_DENY = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'] as const;
/** Groq: `logprobs`, `logit_bias`, `top_logprobs` and `messages[].name` return 400. */
const GROQ_DENY = ['logprobs', 'logit_bias', 'top_logprobs', 'name'] as const;
/** xAI reasoning models reject these sampling fields. */
const XAI_DENY = ['presence_penalty', 'frequency_penalty', 'stop'] as const;
/** The Cohere compatibility layer rejects these fields outright. */
const COHERE_DENY = ['store', 'metadata', 'logit_bias', 'top_logprobs', 'n', 'modalities', 'prediction', 'audio', 'service_tier', 'parallel_tool_calls'] as const;
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
} as const satisfies Partial<ModelCaps>;

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
      { pattern: 'claude-sonnet-5-5', caps: { ...CLAUDE_CAPS, effortStyle: 'anthropic', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricePer1k: { prompt: 0.002, completion: 0.01 } },
      // Opus 5.5 cannot turn thinking off.
      { pattern: 'claude-opus-5-5', caps: { ...CLAUDE_CAPS, effortStyle: 'anthropic', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricePer1k: { prompt: 0.004, completion: 0.02 } },
      // Haiku 5.5 accepts thinking.type disabled only with an effort at or below high; Off is sent alone, so max stays selectable.
      { pattern: 'claude-haiku-5-5', caps: { ...CLAUDE_CAPS, effortStyle: 'anthropic', effortLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] }, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      // Fable 5.1 cannot turn thinking off.
      { pattern: 'claude-fable-5-1', caps: { ...CLAUDE_CAPS, effortStyle: 'anthropic', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
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
      { pattern: 'gpt-6-sol', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'items' } },
      { pattern: 'gpt-6-luna', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'items' } },
      // gpt-6-astra rejects none (400); functions work only on Responses, which is this route.
      { pattern: 'gpt-6-astra', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'items' } },
      // gpt-6.1-sol: no none, no minimal; functions only on Responses.
      { pattern: 'gpt-6.1-sol', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'items' } },
      { pattern: 'gpt-5.5', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['off', 'low', 'medium', 'high'], replayStyle: 'items' } },
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
      // Reasoning cannot be disabled on grok-4.x; presence/frequency/stop are rejected.
      { pattern: 'grok-4.7', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'items', denylist: XAI_DENY }, contextWindow: 500_000, pricePer1k: { prompt: 0.002, completion: 0.006 } },
      { pattern: 'grok-4.6', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'items', denylist: XAI_DENY } },
      { pattern: 'grok-4.5', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'items', denylist: XAI_DENY } },
      // grok-4.3's docs list none..xhigh but leave `none` undefined — Off stays hidden.
      { pattern: 'grok-4.3', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'items', denylist: XAI_DENY }, contextWindow: 1_000_000 },
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
      { pattern: 'muse-spark-1.3', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'items' }, pricePer1k: { prompt: 0.00125, completion: 0.00425 } },
      { pattern: 'muse-wonder-1.0', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'items' } },
      // `max` is documented on muse-spark-1.3 and muse-wonder-1.0 only.
      { pattern: 'muse-spark-1.2', caps: { tools: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'items' } },
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
      {
        pattern: 'deepseek-flash',
        caps: {
          tools: true, vision: true, jsonObject: true,
          effortStyle: 'thinking.type+effort', effortLevels: ['off', 'low', 'medium', 'high', 'max'],
          replayStyle: 'content-field', denylist: DEEPSEEK_DENY,
        },
        contextWindow: 1_048_576, maxOutputTokens: 393_216,
      },
      // v4-pro is text-only; its `low` mapping is disputed, so it is not offered.
      { pattern: 'deepseek-v4-pro', caps: { tools: true, jsonObject: true, effortStyle: 'thinking.type+effort', effortLevels: ['off', 'high', 'max'], replayStyle: 'content-field', denylist: DEEPSEEK_DENY } },
      // Aliases the provider routes to deepseek-flash.
      { pattern: 'deepseek-v4-flash', caps: { tools: true, vision: true, jsonObject: true, effortStyle: 'thinking.type+effort', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field', denylist: DEEPSEEK_DENY } },
      { pattern: 'deepseek-v4-flash-vision-exp', caps: { tools: true, vision: true, jsonObject: true, effortStyle: 'thinking.type+effort', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field', denylist: DEEPSEEK_DENY } },
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
      // enable_thinking:false is not valid on qwen3.7-plus — no Off. Thinking models
      // must stream, which the adapter always does.
      { pattern: 'qwen3.7-plus', caps: { tools: true, vision: true, effortStyle: 'enable_thinking+budget', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'content-field', streamRequired: true } },
      // thinking_budget on qwen3.8-max is disputed; its own `max_effort` scale is the chat-route control.
      { pattern: 'qwen3.8-max', caps: { vision: true, effortStyle: 'max_effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'content-field', streamRequired: true } },
      // Off on qwen3.8-flash is marked "verify per model" — hidden until checked.
      { pattern: 'qwen3.8-flash', caps: { effortStyle: 'enable_thinking+budget', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'content-field', streamRequired: true } },
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
      // Off and Max are not documented on the Chat route — hidden. Both models are
      // text-only on every route.
      { pattern: 'hy3', caps: { tools: true, effortStyle: 'thinking.type+effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'content-field' }, contextWindow: 256_000, maxOutputTokens: 128_000 },
      { pattern: 'hy4-preview', caps: { tools: true, effortStyle: 'thinking.type+effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
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
      // kimi-k3 cannot turn thinking off; medium is unsupported (high).
      { pattern: 'kimi-k3', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'high', 'max'], replayStyle: 'content-field', denylist: MOONSHOT_DENY }, contextWindow: 1_048_576, pricePer1k: { prompt: 0.003, completion: 0.015 } },
      // kimi-k2.6's thinking is enabled/disabled only; every On level sends enabled.
      { pattern: 'kimi-k2.6', caps: { vision: true, effortStyle: 'thinking.type', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field', denylist: MOONSHOT_DENY }, contextWindow: 262_144, pricePer1k: { prompt: 0.00095, completion: 0.004 } },
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
      // glm-5.3 family cannot disable thinking; medium is unsupported (send high).
      { pattern: 'glm-5.3', caps: { tools: true, effortStyle: 'thinking.type+effort', effortLevels: ['low', 'high', 'max'], replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricePer1k: { prompt: 0.0014, completion: 0.0044 } },
      { pattern: 'glm-5.3-flash', caps: { tools: true, vision: true, effortStyle: 'thinking.type+effort', effortLevels: ['low', 'high', 'max'], replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricePer1k: { prompt: 0.00015, completion: 0.0005 } },
      { pattern: 'glm-5.3-flashx', caps: { tools: true, vision: true, effortStyle: 'thinking.type+effort', effortLevels: ['low', 'high', 'max'], replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricePer1k: { prompt: 0.00037, completion: 0.00125 } },
      // glm-5.2 accepts reasoning_effort none and thinking disabled for Off.
      { pattern: 'glm-5.2', caps: { tools: true, effortStyle: 'thinking.type+effort', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field' }, contextWindow: 200_000 },
      // glm-5.1, glm-5 and glm-4.6: Off is thinking disabled; every On level sends enabled.
      { pattern: 'glm-5.1', caps: { tools: true, effortStyle: 'thinking.type', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field' }, contextWindow: 200_000 },
      { pattern: 'glm-5', caps: { tools: true, effortStyle: 'thinking.type', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field' }, contextWindow: 200_000, pricePer1k: { prompt: 0.001, completion: 0.0032 } },
      { pattern: 'glm-4.6', caps: { tools: true, effortStyle: 'thinking.type', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field' }, contextWindow: 200_000 },
      // glm-4.7's Off is unverified — hidden until tested.
      { pattern: 'glm-4.7', caps: { tools: true, effortStyle: 'thinking.type', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'content-field' }, contextWindow: 200_000, pricePer1k: { prompt: 0.0006, completion: 0.0022 } },
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
      // M3 takes thinking adaptive|disabled on the Chat route. `reasoning_split` is
      // not sent (no quirk for it), so thinking arrives as <think> tags in content.
      { pattern: 'MiniMax-M3', caps: { tools: true, vision: true, effortStyle: 'thinking.type', effortLevels: ['off', 'high'], replayStyle: 'think-tags' }, contextWindow: 1_000_000, pricePer1k: { prompt: 0.0003, completion: 0.0012 } },
      // M3.1-Flash-Preview is subscription-gated (M Plan); Off returns 400.
      { pattern: 'MiniMax-M3.1-Flash-Preview', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'think-tags' }, contextWindow: 1_000_000 },
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
      // Chat thinking is enabled|disabled with no levels; every On level sends enabled.
      { pattern: 'mimo-v2.6-pro', caps: { tools: true, vision: true, effortStyle: 'thinking.type', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 131_072 },
      { pattern: 'mimo-v2.6-flash', caps: { tools: true, vision: true, effortStyle: 'thinking.type', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field' }, contextWindow: 1_000_000, maxOutputTokens: 131_072 },
      { pattern: 'mimo-v2.6-pro-ultraspeed', caps: { tools: true, vision: true, effortStyle: 'thinking.type', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'content-field' } },
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
      // `max` travels as a `:reasoning-effort/max` suffix on the model id, which this
      // route cannot express — the top flat level offered here is `high`.
      // Reasoning returns in a `reasoning` field, which no replay style writes — text.
      { pattern: 'x-ai/grok-4.7', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'text' } },
      { pattern: 'google/gemini-3.8-flash', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'text' } },
      // deepseek-v4-flash lists `none`; its low/medium are not offered.
      { pattern: 'deepseek/deepseek-v4-flash', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['off', 'high'], replayStyle: 'text' } },
      // kimi-k3 lists no medium; its max is suffix-only.
      { pattern: 'moonshotai/kimi-k3', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'high'], replayStyle: 'text' } },
      // claude-opus-5.5 rejects `none` (always-reasoning).
      { pattern: 'anthropic/claude-opus-5.5', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['high'], replayStyle: 'text' } },
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
      // grok-4.7 is reasoning-mandatory (none rejected); its top listed tier is xhigh,
      // which this wire value cannot express — max offered, sent as the style maps it.
      { pattern: 'x-ai/grok-4.7', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'text' } },
      { pattern: 'openai/gpt-6-sol', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['off', 'low', 'medium', 'high', 'max'], replayStyle: 'text' } },
      { pattern: 'deepseek/deepseek-v4.1-flash', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'high', 'max'], replayStyle: 'text' } },
      { pattern: 'anthropic/claude-opus-5.5', caps: { tools: true, vision: true, effortStyle: 'reasoning.effort', effortLevels: ['low', 'medium', 'high', 'max'], replayStyle: 'text' } },
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
    // Vision, tools and thinking parameters are documented on no route: every row is
    // text-only (vision: false) and nothing else is claimed.
    models: [
      { pattern: 'claude-sonnet-5-5', caps: { vision: false } },
      { pattern: 'claude-haiku-5-5', caps: { vision: false } },
      { pattern: 'claude-opus-5-5', caps: { vision: false } },
      { pattern: 'claude-fable-5-1', caps: { vision: false } },
      { pattern: 'qwen3.8-flash', caps: { vision: false } },
      { pattern: 'qwen3.7-plus', caps: { vision: false } },
      { pattern: 'qwen3.8-max', caps: { vision: false } },
      { pattern: 'kimi-k3', caps: { vision: false } },
      { pattern: 'glm-5.3', caps: { vision: false } },
      { pattern: 'deepseek-v4-pro', caps: { vision: false } },
      { pattern: 'minimax-m2.7', caps: { vision: false } },
      { pattern: 'mistral-large-4', caps: { vision: false } },
      { pattern: 'gpt-6-sol', caps: { vision: false } },
      { pattern: 'gpt-6-astra', caps: { vision: false } },
      { pattern: 'gpt-6.1-sol', caps: { vision: false } },
      { pattern: 'gpt-5.5', caps: { vision: false } },
      { pattern: 'grok-4.7', caps: { vision: false } },
      { pattern: 'muse-spark-1.3', caps: { vision: false } },
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
      // undocumented, so Off stays hidden.
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
      // path wins, so the toggle is offered (On/Off).
      { pattern: 'moonshotai/Kimi-K3', caps: { tools: true, vision: true, effortStyle: 'reasoning.enabled', effortLevels: ['off', 'high'], replayStyle: 'content-field' } },
      { pattern: 'deepseek-ai/DeepSeek-V4-Pro-0813', caps: { tools: true, effortStyle: 'reasoning.enabled', effortLevels: ['off', 'high'], replayStyle: 'text' } },
      { pattern: 'zai-org/GLM-5.2', caps: { tools: true, effortStyle: 'reasoning.enabled', effortLevels: ['off', 'high'], replayStyle: 'content-field' } },
      // gpt-oss-120b takes reasoning_effort low/medium/high and cannot turn off.
      { pattern: 'openai/gpt-oss-120b', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'], replayStyle: 'text' } },
      { pattern: 'MiniMaxAI/MiniMax-M3', caps: { vision: true, replayStyle: 'content-field' } },
      { pattern: 'Qwen/Qwen3.5-9B', caps: { vision: true } },
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
      // kimi-k3 reasons at max by default; its per-tier acceptance is unconfirmed, so
      // no effort levels are offered. Reasoning returns as reasoning_content (some
      // models use <think> tags — content-field is the documented one).
      { pattern: 'accounts/fireworks/models/kimi-k3', caps: { tools: true, vision: true, replayStyle: 'content-field' }, contextWindow: 1_048_576 },
      { pattern: 'accounts/fireworks/models/glm-5p3-flash', caps: { tools: true, vision: true, replayStyle: 'content-field' } },
      { pattern: 'accounts/fireworks/models/glm-5p3', caps: { tools: true, vision: false, replayStyle: 'content-field' } },
      { pattern: 'accounts/fireworks/models/minimax-m3', caps: { tools: true, replayStyle: 'content-field' } },
      { pattern: 'accounts/fireworks/models/kimi-k2-thinking', caps: { tools: true, replayStyle: 'content-field' } },
      { pattern: 'accounts/fireworks/models/glm-4p7', caps: { tools: true, replayStyle: 'content-field' } },
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
      { pattern: 'zai-org/GLM-5.3', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'high', 'max'], replayStyle: 'content-field' } },
      // Kimi-K3 always thinks — no Off.
      { pattern: 'moonshotai/Kimi-K3', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'high', 'max'], replayStyle: 'content-field' } },
      { pattern: 'deepseek-ai/DeepSeek-V4-Flash-0731', caps: { tools: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'high', 'max'], replayStyle: 'content-field' } },
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
      // Qwen3.8-27B hides High on the router (its top tier is xhigh) — low/medium only.
      { pattern: 'Qwen/Qwen3.8-27B', caps: { tools: true, vision: true, effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium'] } },
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

/**
 * What a (profile-ish, model) pair speaks: the preset's adapter (overridden by its
 * `modelRoutes`), its quirks, and the matched model row's caps. No known preset — an
 * endpoint profile older than the registry, or one whose `preset` names nothing —
 * falls back to the generic OpenAI-Chat route with empty caps.
 */
export function resolveRoute(profile: { readonly preset?: string; readonly baseUrl: string }, model: string): RouteSpec {
  if (profile.preset === undefined) return { adapter: 'openai-chat', quirks: {}, caps: {} };
  const preset = presetFor(profile.preset);
  if (preset === undefined) return { adapter: 'openai-chat', quirks: {}, caps: {} };
  const row = modelRowFor(preset, model);
  return {
    adapter: routeFor(preset.quirks, model, preset.adapter),
    quirks: preset.quirks,
    caps: row?.caps ?? {},
    ...(row?.maxOutputTokens === undefined ? {} : { modelMaxOutput: row.maxOutputTokens }),
  };
}
