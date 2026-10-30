# Provider gateway — BYOK model access spec (v1)

> Status: built. Scope: everything between the agent harness / editor and the provider's HTTP endpoint. The harness's tool-surface decisions live in [agent-harness.md](agent-harness.md); this file owns the *transport, config, accounting, and the mock contract*.

## 1. Responsibility & ownership

- **Owns:** provider profiles (kind/preset/URL/key/model), the adapter registry, HTTP client, streaming, retries/backoff, abort, token accounting, request/response log, mock provider, and the optional trace observer (§3.1).
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
  pricePer1k?: { prompt: number; completion: number };  // optional, USD; shown as an estimate, and read by a cost limit (agent-harness §7.1)
  isActive: boolean;          // exactly one profile active at a time
}
```

- **Multiple named profiles, one active.** Per-call model override is a parameter of `complete()` (harness chooses, e.g. cheap model for synopses), not a profile property.
- `settings` owns profile CRUD UI; the gateway owns validation. `baseUrl` is normalized on save and must be **https** — no other scheme and no loopback endpoints for provider profiles, except for the three local model presets below (local MCP servers are a different spec's concern).
- **Presets** (`packages/gateway/src/presets`): one row per shipped provider — its base URL, default/fast/vision models, auth header style, quirks, a per-model capability table (`ModelCaps`: native tools, images, JSON modes, thinking levels + how they map to wire fields, `thinkingShape` and `thinkingDisplay` for Messages routes, how reasoning replays) and a browser/CORS note. A preset may split models across adapters (`OpenCode`'s `claude-*` and two Qwen ids run on the Messages route, everything else on Chat). `keyOptional` is true only for `generic`, `opencode` and the three local servers — everywhere else a key is required. The live `/models` answer decides which model ids exist; the table supplies what a listing does not say.
- **Window and output cap.** A row may state `contextWindow` (the provider's documented window, in tokens) and `maxOutputTokens`. `modelLimits` takes the window from the live listing first and the row second; the model picker prints the row's. The output cap is informational — the profile's cap is what a request sends. `modelLimits` reports it as `modelMaxOutputTokens` (the listing first, the row second) beside the `maxOutputTokens` a request is sent with. The harness may raise one request's cap toward it: the planner's retry after a reply the provider cut at its output limit asks for twice the cap, never above `modelMaxOutputTokens`, and never when the model advertises none (agent-harness §2). The Claude rows state 1,000,000 and 128,000 from Anthropic's model overview (read 2026-10-20), and only for the four exact ids it names: a Claude id not on the page has no row and no window. Anthropic's `GET /v1/models` reports the window as `max_input_tokens` and the cap as `max_tokens`, each nullable; the Messages adapter reads both under the shared rule that a null, zero or absent number is not stated.
- A `generic` profile is the hand-rolled escape hatch: custom https base URL, optional sealed headers, OpenAI-Chat route.
- **Local model servers** (`ollama`, `lmstudio`, `llamacpp`; the preset's `local` block, `cors: 'local'`). A server on this computer, on the OpenAI-Chat route. Their base URL goes through `normalizeLocalBaseUrl` instead of `normalizeBaseUrl`: `http` or `https` to `localhost`, an address in `127.0.0.0/8` (each octet range-checked) or `[::1]`, judged from the parsed hostname with no DNS lookup. A LAN address, a `*.local` or `*.localhost` name, a look-alike such as `127.evil.example` and a URL with userinfo are refused, and the message says why: plain http is allowed only to this computer, so a key or manuscript is never sent unencrypted over a network. `normalizeBaseUrl`, the generic kind and every other preset stay https only. The gateway and the MCP client share one loopback predicate (`src/loopback.ts`); the MCP client also accepts `*.localhost` names, the local presets do not.
  - Defaults are `http://127.0.0.1:11434/v1` (Ollama), `http://127.0.0.1:1234/v1` (LM Studio) and `http://127.0.0.1:8080/v1` (llama-server), written as `127.0.0.1` so a hosts-file or IPv6 mapping cannot redirect them. The writer may edit the port or host within loopback. The egress pin compares the request origin with the profile's origin as for any endpoint.
  - The key is optional and sent only if the writer set one on that profile (LM Studio's token, `llama-server --api-key`); it is sealed like any key and never reused for another profile.
  - Capabilities are conservative, because they depend on the model the writer pulled: no native tools and no images, so the agent speaks the JSON-in-text wire, and a `*` row with a 4,096-token window, used only when the server's own `/models` listing reports none (assembly warns before it overruns instead of the server truncating silently). The profile's `maxOutputTokens` stays the writer's override.
  - Profiles and base URLs of local servers are a settings-UI change only: the agent and MCP have no command that creates or alters a profile or its base URL.
  - Not built: reading each server's own model details (Ollama's show, LM Studio's REST API, llama-server's props) to fill tools, vision and the window; Ollama's Messages route; servers on a LAN; local-to-cloud fallback chains (which must word the fallback as sending the text to the cloud provider).

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
| zhipu-zai | openai-chat | unknown | blocked in the 2026-10-26 sweep; the chat route answered a browser request on 2026-10-30 |
| minimax | openai-chat | unknown | — |
| xiaomi-mimo | openai-chat | unknown | — |
| nanogpt | openai-chat | unknown | keyless `/models` listing |
| openrouter | openai-chat | unknown | keyless `/models` listing |
| opencode | openai-chat | blocked | key optional (free models); `claude-*` + two Qwen ids on Messages; the chat routes refuse the browser preflight |
| perplexity | openai-chat | unknown | — |
| together | openai-chat | unknown | — |
| fireworks | openai-chat | unknown | — |
| deepinfra | openai-chat | unknown | keyless `/models` listing |
| groq | openai-chat | unknown | — |
| huggingface | openai-chat | unknown | keyless `/models` listing |
| cerebras | openai-chat | unknown | — |
| ollama | openai-chat | local | on this computer; `http://127.0.0.1:11434/v1`; key optional; needs `OLLAMA_ORIGINS` |
| lmstudio | openai-chat | local | on this computer; `http://127.0.0.1:1234/v1`; key optional; needs Enable CORS |
| llamacpp | openai-chat | local | on this computer; `http://127.0.0.1:8080/v1`; key optional; `--cors-origins` after `--tools`/`--agent` |
| generic | openai-chat | unknown | custom URL + sealed headers; key optional |
| mock | — | ok | the deterministic fixture; no network |

A `keylessModels` flag means the provider's `/models` answers without a key — listing only; inference still needs one. `keyOptional` means inference itself is documented keyless, which holds only for `opencode`'s free models, `generic`, and the local servers (which take a key only if the writer set one on the server).

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
- **anthropic-messages** — `{model, messages, system, max_tokens, stream}`; `system` lifted out of the array; `tool_use`/`tool_result` blocks; signed `thinking` blocks replayed verbatim; named SSE events (`message_start`, `content_block_*`, `message_delta`, `message_stop`), with `error` events raised as provider failures post-200. `anthropic-version` is always sent; `anthropic-dangerous-direct-browser-access` is sent only by presets that opt in with the `browserAccess` quirk — Anthropic's own host rejects browser calls without it, and no other shipped host has been observed to require it on this route. The opt-in is keyed to the preset while the enforcing host is the profile's own `baseUrl`, so the pairing holds only while the two still point at the same host.

- **Normalized model** (`types.ts`): `ChatMessage` carries `toolCalls`/`toolCallId`/`isError`/`reasoning` alongside `content`; `ChatRequest` carries `tools`, `toolChoice`, `thinking` and `role`; `ChatChunk` carries `reasoningDelta`, terminal `toolCalls`/`reasoning`, and `finishReason` gains `'tool_calls'`. `ReasoningBlock.raw` is opaque — stored and replayed by the adapter, never interpreted above the seam.
- **Thinking:** `thinking: 'off'|'low'|'medium'|'high'|'xhigh'|'max'` is mapped through the model's capability row (`effortStyle`, eight wire mappings in `adapters/effort.ts`). A level the row does not list is never sent — the UI only offers listed levels, the mapper is the second line. `xhigh` is sent as itself where the row lists it and as `high` on the `reasoning_effort` family. On a Messages route the row's `thinkingShape` says what is sent: `adaptive` (every Claude 5 row) writes `thinking: {type: 'adaptive', display: 'summarized'}` and `output_config.effort` and never `budget_tokens` (the old shape is a 400 there); `budget` (a Messages row that says nothing) writes `thinking: {type: 'enabled', budget_tokens}`. Thinking on drops `temperature` in either shape.
- **Effective output:** `chatSpec` settles the cap once per call (`effectiveOutput`) and every adapter sends that result. On a route whose thinking is a token budget (Messages `budget`, `enable_thinking+budget`), `max_tokens` is raised to the budget plus the profile's own cap, held to the row's documented output maximum; when that clamp would leave the budget at or above `max_tokens`, the budget is lowered (never below 1,024), and if even that does not fit thinking is left off, so no request is sent that the provider would reject. `ChatRequest.reasoningBudget` is the per-call budget: a number on the budget styles, and elsewhere the nearest listed level by a fixed table (`levelForBudget`); it is ignored beside `off`. The request log line records the cap that was sent, and Settings shows it in a "Max tokens" column (the format probe records its own 16).
- **SSE:** the parser yields `{event, data}` pairs (Anthropic and Responses name their events); `[DONE]`/termination is adapter-declared, not a transport rule.

### 3.1 Trace observer

`GatewayOptions.observe` (and `Gateway.setObserver`, which attaches or detaches it between calls) is told each provider call's lifecycle: `request` (after role routing, so the resolved profile, model and thinking level are known), `first-token`, `attempt` (each try, with its request-log outcome, so a retry is visible) and `response` (finish reason, the reply, the reasoning text, tool calls and replay blocks, usage, whether that usage is the provider's or the `ceil(chars/4)` estimate, and how many attempts it took). A mock profile emits the same events. `ChatRequest.callIndex` is attribution only, like `turnId`: it joins an event to the harness's records of the same call and changes nothing on the wire. A call that fails, or whose caller stops reading, still ends in a `response` carrying the error.

The observer is the one place a body leaves the gateway, so it has rules. Every string of an event passes `redact` with the call's own secrets (the key, and a generic profile's sealed header values) before the observer sees it, and an event carries no header. Every observer call is made inside a `try`, its type returns `void`, and a throw is swallowed: a call behaves the same with any observer, and with none it gathers nothing. Its one consumer is the in-tab agent trace (agent-harness §5.2), which keeps it in memory.

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
- Timeouts: connect 10s, first-token 30s, idle-between-chunks 60s, total request 5min (configurable in settings, defaults only). A preset may carry its own (`PresetDef.timeouts`, plumbed per call as `CallSpec.timeouts`, laid over the defaults and under the gateway's own settings). The local model servers use connect 180s, first-token 180s and idle 120s, because the server loads its model from disk before it answers and the browser's permission prompt waits inside the connect phase; the total stays 5min. Every other provider keeps the defaults.
- **Local model servers.** Browsers report a CORS refusal, a refused connection and a Local Network Access denial identically (a bare `TypeError`), so a failed call to one is told apart in the transport: Node and desktop shells name `ECONNREFUSED`; a permission error names itself; an opaque failure is checked with one bare no-cors GET (no headers, no body, no key) — if the server answers it, the browser blocked the real request on CORS; if not, the browser's `loopback-network` permission being `denied` makes it an access denial, and otherwise nothing is listening. Each becomes `ProviderError('network')` with the preset's own text — `OLLAMA_ORIGINS`, LM Studio's *Enable CORS*, llama-server's `--cors-origins`; "Nothing is listening on 127.0.0.1:11434. Is Ollama running?"; or a pointer to the browser's site settings — and is final (`permanent`: not retried). A 404 whose body names the model (a model not pulled) is a `provider` error with the server's words, not "no endpoint".
- **Egress pinning:** every request's URL must equal the origin of the *resolved* profile — checked in `assertEgress` before a socket opens, and before any key is decrypted, so a refused request never touches key material, and one profile's key can never ride to another profile's endpoint. A named profile is reachable whether or not it is the active one (task roles run on their own profiles).
- Every request/response (including retries) lands in the **local request log** (§6), capped at 50 entries per session, inspectable UI. It stores no request bodies, headers or keys (the trace observer of §3.1 does see bodies, and feeds only the in-tab trace, in memory), and every error detail, log note and quoted provider excerpt passes through `redact` (`src/redact.ts`): every secret in the call's `secrets` list (the key, plus a generic profile's custom header values) is replaced wherever it appears, and anything shaped like a bearer token or an `sk-` key is replaced too.

## 5. Structured output

- Harness needs JSON for plans and verify steps. Contract: `responseFormat: {jsonSchemaHint}` → the adapter states it (a system message on Chat, `instructions` on Responses, a leading user message on Messages) and `response_format: {type:'json_object'}` is added **only** where the model's capability row allows it — for preset profiles the row answers; for a generic profile a one-shot probe call at save time answers, cached on the profile.
- Response side: harness owns parsing/validation (gateway stays dumb). Non-JSON return is a harness-side error with the raw text attached — gateway does not retry on content, only transport.
- **Native tools:** when the model's capability row says `tools`, the harness sends `ToolDef[]` natively (authoritative); otherwise the JSON-in-text protocol remains the fallback. Tool results come back as `role: 'tool'` messages keyed by call id; refusals and ask-backs keep travelling as user messages.

## 6. Token accounting

- `Usage` from each response chunk is accumulated **per agent turn and per calendar day**, stored locally: `usageLedger: {date, profileId, model, role, promptTokens, completionTokens, requests}`.
- `role` is the task role (`chat` | `drafting` | `background`) the request ran under, so cost is visible per role. Activity log shows per-turn totals (harness) and settings shows per-day totals (gateway ledger). This is local-only accounting; Caotang sets no quota of its own, and the run limits a writer sets are enforced by the harness, not the gateway (D4 below, agent-harness §7.1).
- **Delegated agents** (agent-harness §2, "Delegate") are attributed beneath the turn. A `ChatRequest` and a `UsageAttribution` carry an optional `agentPath` (`<turn>/reader#1`), and the ledger's turn rows are keyed by it as well as by profile, model and role, so a turn's tokens can be split by the agent that made the request. A request carries the **parent turn's** `turnId`, so `turnTotals(turnId)` still sums the whole turn, children included. The day rows do not carry it. `agentPath` is display and ledger only; no gateway behaviour reads it, and it adds no network destination: an agent's requests go through the same profile, key and egress pin as the turn's own.
- **Background tasks** (agent-harness §2) stage under the `background` role, on the profile, model and thinking the role resolves to, with the task's id as the session name, so the ledger's rows for a task carry `role: background` and a turn id that names it, and the task's row in the panel shows their totals. Priority between the foreground and the background is cooperative: the task's runner makes one call at a time and waits before each while a foreground turn is busy. A call already in flight is not preempted, so it still counts against a rate-limited key. A gateway limiter that ranks foreground requests ahead of background ones is not built.

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
- **Cassettes:** a cassette is recorded model answers for one golden task (agent-harness §9), replayed through the mock as one script (`replayScript`, `packages/harness/src/agent/cassette.ts`). It is line-delimited JSON: a `header` record (`format: "caotang.trace/1"`, task, preset, model, `recordedAt`, and `synthetic: true` for an answer a person wrote), then one `exchange` per request, holding the request as sent (messages, tools, response format; tool-call ids numbered `call_<n>` by position), its `key` and the response. The key is the sha256 of the canonical JSON of the messages, the tools and the response format; it leaves out the model, the temperature, the turn id, the task role and every other knob, so re-pinning a model id breaks no cassette. A request is answered with the first unused exchange of its key. A request with no match fails the turn with a protocol error and is noted in `misses`: the message names the first message that changed, the character where it differs with the recorded and the new text around it, or the tool or format that changed, and the command that records again. A cassette is data, never code: the loader checks a size cap, every record's shape (an unknown record kind or field is refused), that each exchange's key is the key of its request, and that nothing in it has the shape of a credential; the writer scrubs the keys it is given and the shape of a key, then reads its own output back through the loader. Replay goes through the same gateway, loop, bus and confirm cards as live output. This module is the minimal, self-contained form of what the trace record format (#76) and the shared request key and cassette scripts (#82) will own; when they land their key and format replace these and the names here are the ones to absorb.

## 9. CORS and the browser

The app calls providers straight from the page, so a preset's usefulness in the browser depends on its CORS answer. The registry records what the sweep found (`cors: 'ok'|'blocked'|'preflight-fails'|'unknown'|'local'` + a note); presets that cannot answer a browser request are shown disabled with the honest label *"Desktop app or hosted only"*. The sweep itself is `e2e/providers-cors.spec.ts` — a real Playwright page running a real preflight per preset — run on demand; see [providers-browser-cors.md](providers-browser-cors.md).

The flag speaks for the **chat route**, the POST the agent sends (the route the default model takes, so OpenCode's Claude ids are asked on `/messages`): a preset a page cannot chat with is `blocked` however readable its model list is, and a preset flagged `ok` whose chat route the browser cannot read fails the sweep. The **models route** (the GET Settings makes when a profile is saved) is asked too, and judged apart: a provider can answer both preflights and still leave its 401 for one route without `Access-Control-Allow-Origin`, which the page then cannot read. A preset whose chat route reads but whose model list does not stays `ok` and is reported, not failed (the sweep's `cors-models-route` annotation). When the app meets that case it says what is true: *the browser did not let this page read the model list from the host (a mistyped key can look the same), chat may still work* (`providerMessages.modelListUnreadable`), not "could not reach the host, check your connection and base URL". Today that is Anthropic: its `GET /v1/models` rejection of a bad key carries no allow-origin header, while `POST /v1/messages` rejects with one.

A local model server (`cors: 'local'`) is not swept: whether the browser may call it is a setting on that server, which the preset names (`local.corsFix`). The Settings picker lists them in their own group, **On this computer**, with a setup note and the vendor's documentation link per product, and shows "Your text stays on this computer" only while the profile's address is a loopback literal. Chrome and Edge ship Local Network Access: a public https page that fetches `http://127.0.0.1` asks permission once. The transport passes `targetAddressSpace: 'loopback'` to `fetch` where the browser takes it (feature-detected; elsewhere it is left out), and the form explains the prompt before the first request. Firefox and Safari are unverified, and the UI promises nothing for Safari. All of this is verified against stub servers that imitate each product's CORS default (`e2e/providers-cors.spec.ts`), not against the real products; see [providers-browser-cors.md §4](providers-browser-cors.md). A self-hosted build with a stricter `connect-src` must admit `http://127.0.0.1:*`; the built app's `connect-src *` needs no change.

**Desktop shell (planned, not built).** The Tauri app on the roadmap (decisions.md, epic #16) is constrained before it exists. Keys never cross into the webview: the OS keychain is held by the native side and the webview gets put, delete and a presence check, never a read; without a keychain the WebCrypto vault above stays, with a visible notice, never plaintext. Provider calls are then made natively and attach the key by profile id. That call is not a general fetcher: https only, to the configured profiles' origins and connected MCP URLs, and never loopback, so local models are unchanged. Whether a CORS-blocked preset streams through it is proven in a spike before the label above changes.

## 10. Decisions logged / assumptions

| # | Item | Status |
|---|---|---|
| D1 | Three adapters — Chat Completions, Responses, Messages — behind `ProviderAdapter` | Built; presets pick a route per provider, per model where a provider splits them. |
| D2 | `response_format` via capability rows on presets, probe-gated on generic | Rows answer for shipped presets; the generic profile keeps the save-time probe. |
| D3 | Keys: IndexedDB + AES-GCM non-extractable key | Built; the threat model is stated in §7. |
| D4 | No quota of Caotang's own; writer-set run limits are enforced by the harness | Caotang is free and BYOK, so it has no quota logic. A cap the writer sets on their own key (calls, tokens, cost, steps, time) is not a quota: the harness reserves each call's worst case before it sends it (agent-harness §7.1), from this gateway's `modelLimits` and the request's prompt estimate, and the ledger stays what it was, a record. `pricePer1k` per profile powers pre-approval cost estimates (context-assembly §5) and the cost limit. |
