/**
 * Provider gateway types — [provider-gateway.md §2–§3](docs/architecture/provider-gateway.md).
 *
 * These are the contract, transcribed. If a shape here disagrees with the spec,
 * the spec wins and this file is the bug.
 *
 * Three fields are additions the spec does not name, each forced by a rule it does state:
 *  - `ProviderProfile.kind` — the MOCK profile type that the brief and §8 require. A
 *    `baseUrl` alone cannot tell a mock from a real endpoint without sniffing strings.
 *  - `ChatRequest.turnId` — §6 accounts usage per agent turn, and the gateway cannot
 *    attribute a request to a turn unless the harness says which turn it belongs to.
 *  - the attribution argument of `ProviderGateway.accountTokens` — §3 names the hook
 *    but not the keys a ledger row needs (`profileId`, `model`).
 */

/**
 * §2 — `endpoint` is a real HTTPS transport target (its preset names the route);
 * `mock` is the no-key fixture (baseUrl `mock://caotang`). `'openai-compatible'` was
 * the pre-preset name for `endpoint`; persisted records are migrated on read.
 */
export type ProfileKind = 'endpoint' | 'mock';
/** The retired kind name, still found in persisted records written before presets. */
export type LegacyProfileKind = 'openai-compatible';

/**
 * §2's data shape. The spec stores `apiKey` via §7, and that is how this file reads
 * it: the key is an input to create and update, and the record that survives is a
 * `ProfileView`, which has no key on it. Nothing serialises this object.
 */
export interface ProviderProfile {
  /** generated, stable — never derived from the name */
  id: string;
  /** "OpenRouter main", "Local LM Studio" */
  name: string;
  /** the transport this profile speaks */
  kind: ProfileKind;
  /** the preset id this profile was created from; a hand-rolled endpoint stores 'generic' */
  preset?: string;
  /** the preset's extra fields the base URL was derived from (workspace, region) */
  fields?: Readonly<Record<string, string>>;
  /** stored WITHOUT trailing slash; the endpoint path appended at call time */
  baseUrl: string;
  /** stored via §7 (AES-GCM, non-extractable). Never persisted in plaintext. */
  apiKey: string;
  defaultModel: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** optional, USD; powers context-assembly cost estimates (display-only) */
  pricePer1k?: { prompt: number; completion: number };
  /** prompt caching for this profile's requests; absent means on, with the provider's default lifetime */
  promptCache?: CachePolicy;
  /** exactly one profile is active whenever any profile exists */
  isActive: boolean;
}

/** §5 — the one-shot `response_format` probe, cached on the profile. */
export interface ResponseFormatProbe {
  /** whether the endpoint accepted `response_format: {type: 'json_object'}` */
  supportsJsonObject: boolean;
  /** epoch ms of the probe */
  probedAt: number;
}

/** What the settings UI and the activity log may see: a profile without its key. */
export interface ProfileView extends Omit<ProviderProfile, 'apiKey'> {
  /** whether a key is stored for this profile. The key itself is never on a view. */
  hasKey: boolean;
  /** absent until the probe has run for this endpoint */
  responseFormat?: ResponseFormatProbe;
}

/** Input to `ProfileStore.create`. Omitted optional fields take the kind's defaults. */
export interface NewProfile {
  name: string;
  kind: ProfileKind;
  /** the preset this profile is created under; `endpoint` profiles default to `generic` */
  preset?: string;
  /** the preset's base URL when omitted; required when the preset has none (`generic`) */
  baseUrl?: string;
  /** required for `endpoint` unless the preset marks keys optional; ignored for `mock` */
  apiKey?: string;
  /** the preset's default model when omitted */
  defaultModel?: string;
  /** the preset's extra fields a templated base URL is built from (workspace id, region) */
  fields?: Readonly<Record<string, string>>;
  /** extra request headers, sealed with the key; `generic` profiles only. Values never appear on a view. */
  customHeaders?: Readonly<Record<string, string>>;
  temperature?: number;
  maxOutputTokens?: number;
  pricePer1k?: { prompt: number; completion: number };
  /** prompt caching for the profile's requests; absent means on, with the provider's default lifetime */
  promptCache?: CachePolicy;
  /** activates the new profile; without it, the first profile ever created is active */
  isActive?: boolean;
}

/** Input to `ProfileStore.update`. `kind` and `id` are fixed for a profile's life. */
export interface ProfilePatch {
  name?: string;
  baseUrl?: string;
  /** replaces the stored key; an empty string clears it (key-optional presets only) */
  apiKey?: string;
  /** replaces the preset fields; a templated base URL is rebuilt from them when `baseUrl` is not given */
  fields?: Readonly<Record<string, string>>;
  /** replaces the sealed custom headers (`generic` only); `null` clears them, absent keeps them */
  customHeaders?: Readonly<Record<string, string>> | null;
  defaultModel?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** A new price replaces the saved one. `null` clears it, so the profile is unpriced again; an absent field keeps the saved price. */
  pricePer1k?: { prompt: number; completion: number } | null;
  /** A new caching policy replaces the saved one; an absent field keeps it. */
  promptCache?: CachePolicy;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** The finish reasons a caller sees. 'tool_calls' means the reply is a request to run tools, not an answer. */
export type FinishReason = 'stop' | 'length' | 'error' | 'tool_calls';

/** The normalised thinking levels. A model's capability row says which of these it can be sent. */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The task roles requests are attributed to — provider-gateway §6 records usage per role. */
export type TaskRole = 'chat' | 'drafting' | 'background';

/** A tool the model may call, declared in each route's own wire shape by the adapter. */
export interface ToolDef {
  /** The name the model calls it by: the harness name for natives, the qualified name for external tools. */
  name: string;
  description: string;
  /** The parameters' JSON Schema, passed to the wire verbatim. */
  parameters: unknown;
}

/** A tool call the model asked for, normalised. A tool result answers one call by its `id`. */
export interface ToolCall {
  /** The provider-assigned call id. Result messages are keyed by it. */
  id: string;
  name: string;
  /** The arguments as one JSON string, exactly as the wire sent them. */
  argumentsJson: string;
}

/**
 * One reasoning block the model produced, opaque to everything above the adapter. The
 * adapter replays it verbatim on tool turns: `raw` carries whatever the route needs
 * back — Anthropic's signed thinking block, a Responses reasoning item, a chat route's
 * `reasoning_content` string. Nothing outside the adapter inspects `raw`.
 */
export interface ReasoningBlock {
  /** The display text, when the route exposes any (a summary, or the thinking itself). */
  text: string;
  /** The provider's own structure for this block. Stored and replayed; never interpreted. */
  raw?: unknown;
}

/**
 * One ordered piece of a message's text (provider-gateway §3, "Prompt caching"). A part marked `cacheBoundary` says that
 * everything up to and including it is a prefix worth caching: the adapters that cache place a breakpoint there, and the
 * ones that do not join the parts and ignore the mark.
 */
export interface ContentPart {
  readonly text: string;
  /** Everything up to and including this part is a prefix worth caching. When several parts are marked, the last one is the boundary. */
  readonly cacheBoundary?: boolean;
}

export interface ChatMessage {
  role: ChatRole;
  /** Always set. When `parts` are given it is their texts joined with a blank line, and an adapter that ignores parts sends it. */
  content: string;
  /** Optional ordered parts of `content`; adapters that cache place breakpoints from their marks. Absent means `content` is one part. */
  parts?: readonly ContentPart[];
  /** assistant only: the calls it asked for. May accompany empty content on a tools-only reply. */
  toolCalls?: readonly ToolCall[];
  /** tool role only: the call this message answers. */
  toolCallId?: string;
  /** tool role only: the result is an error payload (`is_error` on the wire). */
  isError?: boolean;
  /** assistant only: reasoning blocks the adapter replays verbatim on tool turns. */
  reasoning?: readonly ReasoningBlock[];
}

/**
 * What one call used. `promptTokens` is every input token the provider billed, cache reads and writes included (Anthropic
 * reports those outside its `input_tokens`; the adapter adds them back), and `completionTokens` every output token, reasoning
 * included. The breakdown fields are subsets of those two, present only when the provider reported them (issue #78, step 2).
 */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** The part of `promptTokens` served from the provider's prompt cache. */
  cachedPromptTokens?: number;
  /** The part of `promptTokens` written to the provider's prompt cache on this call. */
  cacheWritePromptTokens?: number;
  /** The part of `completionTokens` spent on reasoning. */
  reasoningTokens?: number;
}

/**
 * Whether a request asks the provider to cache its prompt prefix (provider-gateway §3, "Prompt caching"). `auto` places
 * breakpoints where the model's capability row says the route takes them; `off` sends no cache field at all.
 */
export interface CachePolicy {
  readonly mode: 'off' | 'auto';
  /** How long Anthropic keeps a cached prefix: 5 minutes (the default) or an hour, which costs more to write. Ignored elsewhere. */
  readonly ttl?: '5m' | '1h';
}

export interface ChatChunk {
  delta?: string;
  /** Reasoning/thinking text as it streams. Shown collapsed in the agent panel; replayed via terminal `reasoning`. */
  reasoningDelta?: string;
  finishReason?: FinishReason;
  usage?: Usage;
  /** On the terminal chunk: the calls the model asked for this reply. */
  toolCalls?: readonly ToolCall[];
  /** On the terminal chunk: the reasoning blocks to replay verbatim on the next request. */
  reasoning?: readonly ReasoningBlock[];
}

/**
 * One model as the provider's `/models` answer describes it. Each field is present only when the provider
 * says it: a provider that reports nothing gives a bare `{ id }`, and the caller gets the documented defaults
 * from {@link ModelLimits} instead.
 */
export interface ModelInfo {
  id: string;
  /** The context window in tokens, under whichever name the provider uses for it (wire.ts). */
  contextWindow?: number;
  /** The output cap the provider advertises, in tokens. Informational: requests send the profile's cap (provider-gateway §2). */
  maxOutputTokens?: number;
  /** The provider's price, in USD per 1,000 tokens (the profile's unit, §2). Read from a per-token price list. */
  pricePer1k?: { prompt: number; completion: number };
}

/**
 * A model's limits and prices, as the caller fills context-assembly's model config from them
 * (context-assembly §5). Each field is what the gateway will actually use for the model. A field the
 * provider did not say and the profile does not set is absent, and the card shows no number for it.
 */
export interface ModelLimits {
  /** The context window in tokens, when the provider reported one. Absent means unknown: no window check is made. */
  readonly contextWindow?: number;
  /** The output cap a request is sent with: the profile's, else the documented default (provider-gateway §2). */
  readonly maxOutputTokens: number;
  /**
   * The output cap the model itself advertises, when the provider's listing or the preset's row says one. Requests are not sent with
   * it; the harness may raise one retry's cap toward it when a reply was cut at `maxOutputTokens` (provider-gateway §2).
   */
  readonly modelMaxOutputTokens?: number;
  /**
   * The thinking tokens one call may add to the reply at the level asked for: the effective budget on a budget route, the
   * level's nominal share on an adaptive one. Absent when no level was asked for or the row lists none. Display-only.
   */
  readonly thinkingTokens?: number;
  /** The price in USD per 1,000 tokens: the profile's, else the provider's. Display-only (provider-gateway §6, D4). */
  readonly pricePer1k?: { readonly prompt: number; readonly completion: number };
  /**
   * How the model's prompt cache prices a reused prefix, for the forecast: present only when the profile's caching is on and
   * the row says the route caches and names a read multiplier. Display-only.
   */
  readonly cache?: { readonly readMultiplier: number; readonly writeMultiplier?: number; readonly minTokens?: number };
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** overrides profile.defaultModel */
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  stop?: string[];
  /** see §5 — schema-in-system-message, plus json_object only after the probe */
  responseFormat?: 'text' | { jsonSchemaHint: object };
  /**
   * Tools the model may call this turn (native function calling). Absent or empty means
   * the caller is in JSON-in-text mode: the schema hint above is the whole protocol.
   */
  tools?: readonly ToolDef[];
  /** 'auto' lets the model choose; 'none' forbids calls. Default 'auto' when tools are present. */
  toolChoice?: 'auto' | 'none';
  /** The normalised thinking level for this call. The adapter maps it through the model's capability row. */
  thinking?: ThinkingLevel;
  /**
   * A thinking budget in tokens. Sent as a number only where the row's style takes one; elsewhere mapped to the
   * nearest listed level by `levelForBudget`. Ignored when `thinking` is 'off'.
   */
  reasoningBudget?: number;
  /** default: the profile that resolved for the request's role, else the active profile */
  profileId?: string;
  /** Prompt caching for this call. Default: the profile's policy, else `auto`. */
  cache?: CachePolicy;
  /** the agent turn this request belongs to; keys the per-turn ledger row (§6) */
  turnId?: string;
  /** the task role this request runs under; recorded on the ledger row (§6) */
  role?: TaskRole;
  /**
   * Finer attribution inside a turn: which delegated agent made the call (`turn-3/reader#1`). Display and ledger only, it
   * carries no semantics, and `turnId` stays the parent turn's, so the turn's totals sum its children.
   */
  agentPath?: string;
  /**
   * Which model request of its turn this is (1-based, a delegated agent's calls counted too). Attribution only: it joins a
   * gateway trace event to the harness records of the same call (agent-harness §5.2) and changes nothing on the wire.
   */
  callIndex?: number;
}

/**
 * A model's capabilities, from the preset's capability table (merged with whatever the
 * live model list reported). Every field the table does not state is absent, and the
 * caller treats absent as "not supported".
 */
export interface ModelCaps {
  /** The route can carry native tool declarations for this model. */
  readonly tools?: boolean;
  /** The model accepts image input. */
  readonly vision?: boolean;
  /** `response_format: {type: 'json_schema'}` is accepted. */
  readonly jsonSchema?: boolean;
  /** `response_format: {type: 'json_object'}` is accepted. */
  readonly jsonObject?: boolean;
  /** The effort levels the model can be sent, in display order. Absent = no thinking control. */
  readonly effortLevels?: readonly ThinkingLevel[];
  /** Whether the route answers the thinking level off, low..max, or cannot turn thinking off. */
  readonly effortStyle?: string;
  /** How the model's reasoning is replayed on tool turns (the adapter reads this). */
  readonly replayStyle?: string;
  /**
   * How a Messages-route model takes thinking: 'adaptive' = `thinking.type: 'adaptive'` + `output_config.effort`
   * (no budget_tokens); 'budget' = `thinking.type: 'enabled'` + `budget_tokens`. Absent on a Messages row = 'budget'.
   */
  readonly thinkingShape?: 'adaptive' | 'budget';
  /** Whether the route returns readable thinking text when asked (`display: 'summarized'`). */
  readonly thinkingDisplay?: 'summarized' | 'omitted';
  /** The route requires streaming when thinking is enabled. */
  readonly streamRequired?: boolean;
  /** Request fields this route rejects and the adapter must omit (e.g. 'temperature'). */
  readonly denylist?: readonly string[];
  /**
   * How the route caches a prompt prefix for this model (provider-gateway §3, "Prompt caching"): `explicit` takes breakpoints
   * the adapter places (Anthropic `cache_control`, OpenAI Responses `prompt_cache_breakpoint`); `automatic` caches on its own
   * and the adapter only keeps the prefix stable (and sends a `prompt_cache_key` on OpenAI Responses); absent or `none` sends
   * no cache field, so the body is what it was before caching existed.
   */
  readonly cache?: 'explicit' | 'automatic' | 'none';
  /** The smallest prefix the provider caches, in tokens. A breakpoint before a shorter prefix is not sent. */
  readonly cacheMinTokens?: number;
  /** A cache read's price against the prompt price, for the forecast (0.1 = a tenth). */
  readonly cacheReadMultiplier?: number;
  /** A cache write's price against the prompt price at the default lifetime, for the forecast. */
  readonly cacheWriteMultiplier?: number;
}

/** Who a unit of usage is attributed to. `at` defaults to the gateway clock. */
export interface UsageAttribution {
  profileId: string;
  model: string;
  turnId?: string;
  /** the delegated agent inside the turn that made the request, when one did (§6) */
  agentPath?: string;
  /** the task role the usage ran under, for per-role accounting (§6) */
  role?: TaskRole;
  at?: number;
}

/**
 * §6's task-role routing, injected by the app. A request that names a `role` and no `profileId` resolves through
 * `resolve`: the answer is the profile it sends through, with the model and thinking level the request defaults to
 * (its own fields win). `allowed` answers the role-referenced profile set: the profile `resolve` named must be in
 * it, or the request is refused before any key is revealed. An absent resolver leaves the `profileId`-or-active
 * rule unchanged.
 */
export interface RoleResolver {
  resolve(role: TaskRole): { profileId: string; model?: string; thinking?: ThinkingLevel } | undefined;
  allowed(role: TaskRole): readonly string[];
}

export interface ProviderGateway {
  complete(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
  completeOnce(req: ChatRequest, signal?: AbortSignal): Promise<ChatMessage>;
  listModels(profileId: string): Promise<ModelInfo[]>;
  /**
   * §3's internal accounting hook. Gateway-originated requests are accounted by the
   * gateway itself; this is for usage the harness observes outside `complete`, and it
   * counts as one request unless the caller says otherwise by never calling it twice.
   */
  accountTokens(usage: Usage, by: UsageAttribution): void;
}
