# Provider gateway — BYOK model access spec (v1)

> Status: built. Scope: everything between the agent harness / editor and the provider's HTTP endpoint. The harness's tool-surface decisions live in [agent-harness.md](agent-harness.md); this file owns the *transport, config, accounting, and the mock contract*.

## 1. Responsibility & ownership

- **Owns:** provider profiles (kind/preset/URL/key/model), the adapter registry, HTTP client, streaming, retries/backoff, abort, token accounting, request/response log, mock provider.
- **Never:** sees tool names' meaning, binder state, or prompts' meaning. It transports messages; the harness owns prompt assembly. It is the *only* module that makes network calls (ARCHITECTURE §2.6).

## 2. Profiles (data shape)

```ts
interface ProviderProfile {
  id: string;                 // generated, stable
  name: string;               // "Anthropic direct", "OpenRouter main"
  kind: 'endpoint' | 'mock';  // endpoint = speaks over HTTP; mock = the no-key fixture
  preset?: string;            // the preset it was created under; 'generic' = hand-rolled endpoint
  baseUrl: string;            // https://api.anthropic.com — stored WITHOUT trailing slash; the route path appended at call time
  apiKey: string;             // stored via §7, in the sealed payload — never on this record
  defaultModel: string;
  temperature?: number;       // default 0.7
  maxOutputTokens?: number;   // default 4096; harness may override per call
  pricePer1k?: { prompt: number; completion: number };  // optional, USD; display-only
  isActive: boolean;          // exactly one profile active at a time
}
```

- **Multiple named profiles, one active.** Per-call model override is a parameter of `complete()` (harness chooses, e.g. cheap model for synopses), not a profile property.
- `settings` owns profile CRUD UI; the gateway owns validation. `baseUrl` is normalized on save and must be **https** — no loopback endpoints and no other scheme for provider profiles (local MCP servers are a different spec's concern).
- **Presets** (`packages/gateway/src/presets`): one row per shipped provider — its base URL, default/fast/vision models, auth header style, quirks, a per-model capability table (`ModelCaps`: native tools, images, JSON modes, thinking levels + how they map to wire fields, how reasoning replays) and a browser/CORS note. A preset may split models across adapters (`OpenCode`'s `claude-*` and two Qwen ids run on the Messages route, everything else on Chat). `keyOptional` is true only for `generic` and `opencode` — everywhere else a key is required. The live `/models` answer decides which model ids exist; the table supplies what a listing does not say.
- A `generic` profile is the hand-rolled escape hatch: custom https base URL, optional sealed headers, OpenAI-Chat route.

The shipped presets (the registry is the source of truth; this table is generated from it — capability rows as of 2026-10):

| Preset | Route | Browser CORS | Notes |
|---|---|---|---|
| anthropic | anthropic-messages | ok | `anthropic-dangerous-direct-browser-access` sent |
| openai | openai-responses | unknown | `store:false` sent |
| gemini | openai-chat | unknown | — |
| xai | openai-responses | unknown | `store:false` sent |
| muse | openai-responses | unknown | encrypted reasoning replay |
| mistral | openai-chat | unknown | — |
| cohere | openai-chat | unknown | no `/models` route — the table is the catalogue |
| deepseek | openai-chat | unknown | — |
| alibaba | openai-chat | unknown | workspace field builds the URL |
| tencent-hunyuan | openai-chat | unknown | region field builds the URL |
| byteplus-ark | openai-chat | unknown | — |
| moonshot | openai-chat | unknown | — |
| zhipu-zai | openai-chat | ok | — |
| minimax | openai-chat | unknown | — |
| xiaomi-mimo | openai-chat | unknown | — |
| nanogpt | openai-chat | unknown | keyless `/models` listing |
| openrouter | openai-chat | unknown | keyless `/models` listing |
| opencode | openai-chat | ok | key optional (free models); `claude-*` + two Qwen ids on Messages |
| perplexity | openai-chat | unknown | — |
| together | openai-chat | unknown | — |
| fireworks | openai-chat | unknown | — |
| deepinfra | openai-chat | unknown | keyless `/models` listing |
| groq | openai-chat | unknown | — |
| huggingface | openai-chat | unknown | keyless `/models` listing |
| cerebras | openai-chat | unknown | — |
| generic | openai-chat | unknown | custom URL + sealed headers; key optional |
| mock | — | ok | the deterministic fixture; no network |

A `keylessModels` flag means the provider's `/models` answers without a key — listing only; inference still needs one. `keyOptional` means inference itself is documented keyless, which holds only for `opencode`'s free models and `generic`.

## 3. Wire adapters

Three wire formats ship, one adapter each, behind `ProviderAdapter` (`src/adapters/`). The gateway resolves a profile+model to `{adapter, ctx}` — the preset's route, or the generic Chat route — and the adapter owns everything route-specific:

```ts
interface ProviderAdapter {
  completePath(model): string;                       // '/chat/completions' | '/responses' | '/messages'
  modelsPath(ctx): string | null;                    // null = no listing route; the capability table answers instead
  headers(ctx, secrets, purpose): Record<string,string>;  // auth + protocol headers; transport adds accept/content-type
  buildBody({req, ctx, temperature, maxTokens, jsonObject}): Record<string, unknown>;
  createStreamParser(ctx): StreamParser;             // per-call SSE dialect reader
  parseModels(json): ModelInfo[] | undefined;
}
```

- **openai-chat** — `{model, messages, max_tokens|max_completion_tokens, stream, stream_options}`; nested `function` tools; `reasoning_content`-style thinking deltas; `[DONE]` ends the stream.
- **openai-responses** — `{model, input items, instructions, max_output_tokens, stream}`; flat `function` tools; `function_call_output` items answer calls; reasoning items replay verbatim (encrypted content included, on routes that emit it). Shipped routes are *stateless*: `store: false` where documented (OpenAI, xAI) makes `previous_response_id` unusable, so full history is resent.
- **anthropic-messages** — `{model, messages, system, max_tokens, stream}`; `system` lifted out of the array; `tool_use`/`tool_result` blocks; signed `thinking` blocks replayed verbatim; named SSE events (`message_start`, `content_block_*`, `message_delta`, `message_stop`), with `error` events raised as provider failures post-200. `anthropic-version` is always sent; `anthropic-dangerous-direct-browser-access` is sent only by presets that opt in with the `browserAccess` quirk — Anthropic's own host rejects browser calls without it, and the other hosts serving this protocol never required it.

- **Normalized model** (`types.ts`): `ChatMessage` carries `toolCalls`/`toolCallId`/`isError`/`reasoning` alongside `content`; `ChatRequest` carries `tools`, `toolChoice`, `thinking` and `role`; `ChatChunk` carries `reasoningDelta`, terminal `toolCalls`/`reasoning`, and `finishReason` gains `'tool_calls'`. `ReasoningBlock.raw` is opaque — stored and replayed by the adapter, never interpreted above the seam.
- **Thinking:** `thinking: 'off'|'low'|'medium'|'high'|'max'` is mapped through the model's capability row (`effortStyle`, eight wire mappings in `adapters/effort.ts`). A level the row does not list is never sent — the UI only offers listed levels, the mapper is the second line.
- **SSE:** the parser yields `{event, data}` pairs (Anthropic and Responses name their events); `[DONE]`/termination is adapter-declared, not a transport rule.

## 4. Retries, errors, timeouts (contract, not vibes)

| Failure | Behavior | Error surfaced to harness |
|---|---|---|
| Network error / timeout | Retry up to **2** retries, exponential backoff 1s → 4s, jitter ±20%. **Stream started = no retry** (partial output already delivered). | `ProviderError('network', detail)` |
| HTTP 401/403 | No retry. | `ProviderError('auth', 'Key rejected by <host>. Check the profile in Settings.')` |
| HTTP 404 on endpoint | No retry. | `ProviderError('endpoint', …)` |
| HTTP 429 | Honor `Retry-After` if present, else backoff; up to 2 retries. | `ProviderError('rate_limit', …)` after retries exhausted |
| HTTP 5xx | Retry per network rule. | `ProviderError('provider', status + body excerpt ≤ 300 chars)` |
| 200 but malformed SSE | Fail the stream once with raw excerpt. | `ProviderError('protocol', excerpt)` |
| Post-200 provider error event | Same as a status error. | `ProviderError('provider', excerpt)` |
| Context length exceeded | **Not retried, not truncated silently.** | `ProviderError('context_length', 'Prompt ≈ <N> tokens exceeds model window (<M>). …')` |

- Error text follows the finding: **written for the model/user to act on** (names the corrective surface — Settings, activity log), never a bare code.
- Timeouts: connect 10s, first-token 30s, idle-between-chunks 60s, total request 5min (configurable in settings, defaults only).
- **Egress pinning:** every request's URL must equal the origin of the *resolved* profile — checked in `assertEgress` before a socket opens, and before any key is decrypted, so a refused request never touches key material, and one profile's key can never ride to another profile's endpoint. A named profile is reachable whether or not it is the active one (task roles run on their own profiles).
- Every request/response (including retries) lands in the **local request log** (§6), capped at 50 entries per session, inspectable UI. It stores no request bodies, headers or keys, and every error detail, log note and quoted provider excerpt passes through `redact` (`src/redact.ts`): every secret in the call's `secrets` list (the key, plus a generic profile's custom header values) is replaced wherever it appears, and anything shaped like a bearer token or an `sk-` key is replaced too.

## 5. Structured output

- Harness needs JSON for plans and verify steps. Contract: `responseFormat: {jsonSchemaHint}` → the adapter states it (a system message on Chat, `instructions` on Responses, a leading user message on Messages) and `response_format: {type:'json_object'}` is added **only** where the model's capability row allows it — for preset profiles the row answers; for a generic profile a one-shot probe call at save time answers, cached on the profile.
- Response side: harness owns parsing/validation (gateway stays dumb). Non-JSON return is a harness-side error with the raw text attached — gateway does not retry on content, only transport.
- **Native tools:** when the model's capability row says `tools`, the harness sends `ToolDef[]` natively (authoritative); otherwise the JSON-in-text protocol remains the fallback. Tool results come back as `role: 'tool'` messages keyed by call id; refusals and ask-backs keep travelling as user messages.

## 6. Token accounting

- `Usage` from each response chunk is accumulated **per agent turn and per calendar day**, stored locally: `usageLedger: {date, profileId, model, role, promptTokens, completionTokens, requests}`.
- `role` is the task role (`chat` | `drafting` | `background`) the request ran under, so cost is visible per role. Activity log shows per-turn totals (harness) and settings shows per-day totals (gateway ledger). This is local-only accounting; no quota enforcement beyond display (D4 below).

## 7. Key storage (v0.1 shape)

- Browser: keys in IndexedDB **outside** the project DB, encrypted at rest with AES-GCM via **non-extractable WebCrypto key**. Plaintext never enters `localStorage` and never syncs. **Threat model:** this protects against *casual* theft (dumped IndexedDB blobs, shared machines) — **not** against XSS in the app origin or a compromised device (origin JS can *use* the key while the app is open). No stronger primitive exists for a no-backend web app; the honest assumption is recorded here, and the desktop app on the roadmap upgrades to OS keychains. The MCP bearer-token vault (extensibility.md §3.6) reuses this exact store.
- The sealed payload is versioned: `{v: 2, apiKey, headers?}` carries a generic profile's sealed custom headers with the key; entries sealed before v2 (a bare key string) decode as `{apiKey}` unchanged.
- Never written to any file in the project artifact (project-format.md §2 forbids secrets there).
- Mock/dev: `MOCK` profile type needs no key.

## 8. Mock provider contract (test-critical)

The mock provider is a **deterministic, scriptable** implementation of `ProviderGateway` used by Vitest headless tests and Playwright runs (ARCHITECTURE §1.6).

```ts
interface MockScript {
  match: (req: ChatRequest) => boolean;    // picks the response for a request
  respond: (req: ChatRequest, callIndex?: number) => MockResponse | AsyncIterable<ChatChunk>;
}
// MockResponse adds toolCalls?: readonly ToolCall[] and reasoning?: string; finishReason covers 'tool_calls'.
```

- **Deterministic:** same script + same request = same response bytes. No clock, no randomness (temperature ignored). A `nativeCall(name, args)` script answers a `req.tools` request with a terminal `tool_calls` chunk carrying the call; the call's id is numbered by the request's position in the run, so replays stay byte-identical.
- **Scriptable:** `echo`, `toolJson` (canned JSON tool call), `stream(words)`, `fail(mode)`, `nativeCall` (native tool call + optional reasoning). `capsTools: true` reports `{ tools: true }` from `modelCaps`, so the harness's capability gate can be exercised without a provider.
- **Usage accounting:** fake token counts = `ceil(chars/4)` so ledger assertions work unchanged.
- **Streaming shape:** yields chunks with `await setImmediate` between them so consumers' async logic is exercised identically to real SSE.

## 9. CORS and the browser

The app calls providers straight from the page, so a preset's usefulness in the browser depends on its CORS answer. The registry records what the sweep found (`cors: 'ok'|'blocked'|'preflight-fails'|'unknown'` + a note); presets that cannot answer a browser request are shown disabled with the honest label *"Desktop app or hosted only"*. The sweep itself is `e2e/providers-cors.spec.ts` — a real Playwright page running a real preflight per preset — run on demand; see [providers-browser-cors.md](providers-browser-cors.md).

## 10. Decisions logged / assumptions

| # | Item | Status |
|---|---|---|
| D1 | Three adapters — Chat Completions, Responses, Messages — behind `ProviderAdapter` | Built; presets pick a route per provider, per model where a provider splits them. |
| D2 | `response_format` via capability rows on presets, probe-gated on generic | Rows answer for shipped presets; the generic profile keeps the save-time probe. |
| D3 | Keys: IndexedDB + AES-GCM non-extractable key | Built; the threat model is stated in §7. |
| D4 | Usage display-only, no quota enforcement | Display only: Caotang is free and BYOK, so there is no quota logic. `pricePer1k` per profile powers pre-approval cost estimates (context-assembly §5). |
