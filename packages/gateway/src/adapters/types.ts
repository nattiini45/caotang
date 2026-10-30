/**
 * The adapter seam — provider-gateway §3's "one adapter per wire format" made structural.
 *
 * Three wire formats ship: `openai-chat` (Chat Completions), `openai-responses`
 * (Responses), and `anthropic-messages` (Messages). An adapter owns everything
 * route-specific about one call: the endpoint path, the auth and protocol headers, the
 * request body, and the reading of the SSE stream. Everything above the seam —
 * profiles, retries, timeouts, egress, redaction, the ledger — is transport or gateway
 * and speaks only the normalised types in `types.ts`.
 *
 * The split of what goes where is fixed:
 *  - **adapter**: path, headers, body, stream dialect, `/models` envelope;
 *  - **preset** (`presets/`): which adapter a provider uses, per model where the provider
 *    routes differ, plus the quirks and capability rows the adapter honours;
 *  - **transport**: fetch, deadlines, retry, abort, egress, redaction.
 */

import type { SseEvent } from '../sse.js';
import type { CacheSettings } from './cache.js';
import type { EffectiveOutput } from './effort.js';
import type {
  ChatRequest,
  FinishReason,
  ModelCaps,
  ModelInfo,
  ReasoningBlock,
  ToolCall,
  Usage,
} from '../types.js';

export type AdapterId = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/**
 * How a thinking level becomes wire fields. The styles the shipped presets need:
 *  - `reasoning_effort` — `{reasoning_effort: level}` (OpenAI Chat and most compatibles);
 *  - `reasoning.effort` — `{reasoning: {effort: level}}` (Alibaba compatible mode, Responses);
 *  - `thinking.type` — `{thinking: {type: 'enabled'|'disabled'|'adaptive'}}` (DeepSeek, BytePlus Messages);
 *  - `thinking.type+effort` — `{thinking: {type}, reasoning_effort}` (Z.ai Messages route);
 *  - `enable_thinking+budget` — `{enable_thinking: bool, thinking_budget}` (Alibaba native, MiniMax);
 *  - `reasoning.enabled` — `{reasoning: {enabled: bool}}` (Perplexity);
 *  - `anthropic` — Messages `thinking` + `output_config.effort` (Anthropic adapter);
 *  - `max_effort` — `{max_effort: level}` (Qwen3.8-max on the Chat route).
 */
export type EffortStyle =
  | 'reasoning_effort'
  | 'reasoning.effort'
  | 'thinking.type'
  | 'thinking.type+effort'
  | 'enable_thinking+budget'
  | 'reasoning.enabled'
  | 'anthropic'
  | 'max_effort';

/**
 * How an assistant message's reasoning is replayed on the next request:
 *  - `text` — the reasoning is not separately replayed; its text folded into content if at all;
 *  - `content-field` — a message-level field (e.g. `reasoning_content`) carries the text back;
 *  - `think-tags` — `<think>…</think>` inside the content string;
 *  - `items` — Responses reasoning/function-call items (incl. `encrypted_content` on Muse);
 *  - `blocks` — Anthropic content-array blocks, signature and all.
 */
export type ReplayStyle = 'text' | 'content-field' | 'think-tags' | 'items' | 'blocks';

/**
 * Per-preset flags a route needs beyond the capability rows. Every field defaults to
 * the safe/common behaviour when absent.
 */
export interface QuirkFlags {
  /** How the API key reaches the endpoint. Default 'bearer'. */
  readonly auth?: 'bearer' | 'x-api-key' | 'api-key';
  /** A protocol version header the route requires, e.g. Anthropic's `anthropic-version`. */
  readonly versionHeaders?: Record<string, string>;
  /** Send `anthropic-dangerous-direct-browser-access: true` (Anthropic browser calls). */
  readonly browserAccess?: boolean;
  /** Send `store: false` on Responses routes that document it. */
  readonly store?: boolean;
  /** Responses: resend full history instead of `previous_response_id` chaining. */
  readonly stateless?: boolean;
  /** Responses: request `include: ['reasoning.encrypted_content']` for replayable reasoning. */
  readonly includeEncryptedReasoning?: boolean;
  /** The output-cap field name. Default 'max_tokens' on chat routes. */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  /** Static headers the preset always sends (rare; prefer named flags above). */
  readonly extraHeaders?: Record<string, string>;
  /** The model->route map, for providers whose models split across adapters (OpenCode). */
  readonly modelRoutes?: Readonly<Record<string, AdapterId>>;
}

/** What one preset says about a call: its adapter, quirks, and the resolved model's caps. */
export interface RouteSpec {
  readonly adapter: AdapterId;
  readonly quirks: QuirkFlags;
  readonly caps: ModelCaps;
  /** The matched row's documented output cap, when published: the ceiling a raised `max_tokens` is held to. */
  readonly modelMaxOutput?: number;
}

/** Secrets revealed for this one call. Values land in `CallSpec.secrets` for redaction. */
export interface CallSecrets {
  readonly apiKey?: string;
  /** Custom sealed headers on a generic profile — name and value. */
  readonly headers?: readonly { readonly name: string; readonly value: string }[];
}

/** The resolved context an adapter builds a request against. */
export interface AdapterContext {
  readonly baseUrl: string;
  readonly model: string;
  readonly quirks: QuirkFlags;
  readonly caps: ModelCaps;
  /** The matched row's documented output cap, when published: the ceiling a raised `max_tokens` is held to. */
  readonly modelMaxOutput?: number;
  /** Extra fields the preset contributed (Alibaba workspace/region already folded into baseUrl). */
}

/** What `buildBody` needs beyond the request itself. */
export interface BodyInput {
  readonly req: ChatRequest;
  readonly ctx: AdapterContext;
  /** temperature after profile/request resolution and denylist filtering */
  readonly temperature?: number;
  /** the output cap and thinking settled for this call (`effectiveOutput`): adapters send these, they do not recompute them */
  readonly effective: EffectiveOutput;
  /** whether the route may send `response_format: {type:'json_object'}` for this call */
  readonly jsonObject: boolean;
  /** How this call caches its prompt prefix; absent means it sends no cache field (adapters/cache.ts). */
  readonly cache?: CacheSettings;
}

/**
 * One piece of a stream, as one SSE event contributes it. The transport folds pieces
 * into `ChatChunk`s; `error` and `done` are control, the rest are content.
 */
export interface StreamPiece {
  readonly text?: string;
  readonly reasoning?: string;
  readonly usage?: Usage;
  readonly finish?: FinishReason;
  /** An in-band provider error after HTTP 200 — the transport raises it as `provider`. */
  readonly error?: string;
  /** The event could not be parsed — the transport raises it as `protocol`. */
  readonly malformed?: string;
  /** The adapter declares the stream complete (`[DONE]`, `message_stop`, …). */
  readonly done?: boolean;
}

/**
 * The per-call state machine that reads one route's SSE dialect. A fresh parser per
 * stream; `finish` returns the assembled terminal fields once the stream ends.
 */
export interface StreamParser {
  /** Consumes one SSE event; returns the pieces it produced. */
  push(event: SseEvent): StreamPiece[];
  /** Stream ended: the tool calls and replay blocks assembled across the stream. */
  finish(): { toolCalls?: ToolCall[]; reasoning?: ReasoningBlock[] };
}

/**
 * One wire format. `completePath` may depend on the model (per-model route maps);
 * `modelsPath` is null when the preset has no listing route — the gateway then answers
 * from the capability table instead of making a request.
 */
export interface ProviderAdapter {
  readonly id: AdapterId;
  /** The completion path joined to the profile's base URL. */
  completePath(model: string): string;
  /** The model-listing path joined to the base URL, or null when the route has none. */
  modelsPath(ctx: AdapterContext): string | null;
  /**
   * Every header for a request except `accept`/`content-type` (transport sets those) —
   * auth, protocol versions, preset headers. `secrets.apiKey` may be absent on
   * keyOptional presets and generic profiles.
   */
  headers(ctx: AdapterContext, secrets: CallSecrets, purpose: 'complete' | 'models'): Record<string, string>;
  /** The POST body for a completion, stream mode set by the adapter. */
  buildBody(input: BodyInput): Record<string, unknown>;
  /** A fresh parser for one streamed completion. */
  createStreamParser(ctx: AdapterContext): StreamParser;
  /** The model list from a `/models` body; undefined when the envelope is not this route's. */
  parseModels(json: unknown): ModelInfo[] | undefined;
}

/** The model->route lookup for presets that split models across adapters (OpenCode). */
export function routeFor(quirks: QuirkFlags, model: string, fallback: AdapterId): AdapterId {
  const routes = quirks.modelRoutes;
  if (routes === undefined) return fallback;
  for (const pattern of Object.keys(routes)) {
    if (pattern.endsWith('*') ? model.startsWith(pattern.slice(0, -1)) : model === pattern) {
      return routes[pattern] ?? fallback;
    }
  }
  return fallback;
}
