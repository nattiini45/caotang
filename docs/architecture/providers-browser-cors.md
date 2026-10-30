# Providers in the browser — CORS and the real-key round

> Status: built. The companion to [provider-gateway.md](provider-gateway.md): what the browser can reach, what it cannot, and how the real-key round is run. Caotang calls providers straight from the page, so a preset is only as useful as its CORS answer.

## 1. The constraint

A `fetch` from `caotang.app` (or a self-hosted origin) is a cross-origin browser request: the provider's response must carry `Access-Control-Allow-Origin` covering the app's origin, and request headers beyond the CORS-safelisted set (`Authorization`, `x-api-key`, `anthropic-version`, …) trigger a **preflight** that the provider must also answer. A provider that never answers the preflight cannot be reached from a web page at all — no app code can change that.

## 2. The support sweep

`e2e/providers-cors.spec.ts` is the sweep. It runs in the Playwright browser (a real page, a real preflight) and, for every registered preset, makes the two requests the app makes from a page, each with the headers a real call carries (the adapter the default model routes to, a placeholder credential, a JSON body on the POST) so the browser runs the preflight those headers demand:

1. the **chat route** — `POST {baseUrl}{complete path}`, what the agent sends. This decides the registry's `cors` field;
2. the **models route** — `GET {baseUrl}{models path}`, what Settings sends when a profile is saved. A preset with no listing route (`noModelsRoute`) is not asked.

Each result is `ok` (2xx readable), `http-error` (a non-2xx status the page could read, the normal answer to a placeholder key), `blocked` (the browser withheld the answer) or `error` (timeout); the report is the `cors-sweep` JSON attachment of the test run. For a `blocked` result the report also says why, from a Node-side `OPTIONS` carrying the page's origin and the request's headers: a **refused preflight** (no `Access-Control-Allow-Origin`, or the method not allowed) which no key can change, or a preflight that passed while the answer itself carried no allow-origin header (a placeholder key's rejection can do that where a real key's answer would read). That diagnosis is for the maintainer; the verdict is the browser's.

What the sweep asserts:

- `cors: 'ok'` — the chat route is readable, or the row is stale and the sweep fails. If the models route is not readable while chat is, the row stands and the test records a `cors-models-route` annotation naming both results. (Anthropic since 2026-10-26: `GET /v1/models` answers a bad key's 401 with no `Access-Control-Allow-Origin`, `POST /v1/messages` answers its 401 with one. The app then says the model list could not be read from the browser and chat may still work; see provider-gateway §9.)
- `cors: 'blocked'` — the chat route really is blocked, so the disabled badge is the truth. The model list may be readable; it does not make the preset usable.
- `cors: 'unknown'` — recorded only.

A key does not appear anywhere in this: a refused preflight fails before auth is consulted, and one that passes yields a 401/200 the sweep can read either way. What a keyless sweep cannot tell is whether a *valid* key's answer reads where the placeholder's does not (the Anthropic list is the live example, and Cerebras' and BytePlus' chat routes read as blocked for the same reason); the real-key round (§3) runs in Node and does not answer it, so that case is a manual check in a browser with a key. Run the sweep with:

```sh
pnpm exec playwright test e2e/providers-cors.spec.ts
```

The registry's `cors` field records the swept answer; presets that cannot answer a browser request are shown disabled in Settings as **"Desktop app or hosted only"** rather than pretending to work. The local model presets (`cors: 'local'`) are not swept: they are on this computer, and §4 covers them.

## 3. The real-key round

Preflights prove reachability, not that a provider actually answers a real account. `e2e/provider-smoke.spec.ts` is the credential check — env-gated, skipped silently without its variables, and run only locally or by a maintainer's manual dispatch in CI, never on a pull request.

```sh
CAOTANG_SMOKE_ANTHROPIC=sk-ant-... CAOTANG_SMOKE_OPENAI=sk-... pnpm exec playwright test e2e/provider-smoke.spec.ts
```

One `CAOTANG_SMOKE_<PRESET>` variable per provider, named by preset id uppercased with `-` as `_` (`CAOTANG_SMOKE_OPENROUTER`, `CAOTANG_SMOKE_ZHIPU_ZAI`, …); an empty value counts as unset. `CAOTANG_ONLY_PRESETS="anthropic deepseek"` (ids separated by spaces or commas, lowercase letters, digits and hyphens only; anything else is refused) limits the round to those presets. The spec runs in the Node worker, so it tests credentials and wire formats, not CORS. `CAOTANG_E2E_NO_SERVER=1` makes `playwright.config.ts` start no web server, which this spec does not need. For each preset with a key, the round checks, in order:

1. **Model list** — `GET {baseUrl}/models` answers with the key in the preset's auth header and the parsed list is non-empty; a preset with no listing route passes on its table.
2. **Streamed completion** — a one-line prompt streams to `stop` on the preset's default model and writes text.
3. **Native tools** — on models whose capability row claims `tools`: a one-line prompt with a `lookup` tool declared comes back with at least one tool call. The result is not sent back.
4. **Thinking** — on models whose row lists effort levels: every level but `off` is sent and accepted with a reply (a 400 naming the effort field is a row bug, not a provider quirk — fix the table). On Anthropic's `low`, a streamed reply must also be logged as accepted and return a readable thinking summary.
5. **Key redaction** — the request log shows the calls, and the key appears in no log entry.

Reasoning replay, JSON mode and vision are not checked here.

Keys live only in `caotang.env` (gitignored), the shell, or the `provider-smoke` environment's secrets. The spec never prints them; a local failure prints the provider and the stage, never the credential.

### In CI

`.github/workflows/provider-smoke.yml` runs the same spec by manual dispatch only, on `main`, from the `provider-smoke` environment's secrets (one `CAOTANG_SMOKE_<PRESET>` secret per provider, set on the one step that runs the spec):

```sh
gh workflow run provider-smoke.yml -f presets="anthropic deepseek"   # blank presets = every preset with a secret
```

With no secret set the spec skips and the run is green. Under GitHub Actions a failure names only the preset, the stage and the HTTP status, never a response body or model text, because a provider's error body can echo part of a key that Actions does not mask; each preset appends its stage table (pass, fail, not claimed, not reached) to the job summary. The workflow has no pull-request, push, schedule or workflow-run trigger, uploads nothing, and is never a required check. A guard test (`test/provider-smoke.test.ts`) holds that shape.

## 4. Local model servers

Ollama, LM Studio and llama.cpp's `llama-server` are presets that may use `http` to a literal loopback address (provider-gateway §2). A web page calling them is cross-origin, and two things decide whether it works.

**The server's CORS setting.** The registry names the fix per product (`PresetDef.local.corsFix`), and a failed call shows it:

| Product | Default for a web page on another origin | Fix |
|---|---|---|
| Ollama (`http://127.0.0.1:11434/v1`) | Admits `localhost`, `127.0.0.1` and `0.0.0.0` origins and the `app://`, `file://`, `tauri://` and `vscode-webview://` schemes; a deployed web origin is refused. | Start it with `OLLAMA_ORIGINS` set to the app's address (for caotang.app: `OLLAMA_ORIGINS=https://caotang.app`). |
| LM Studio (`http://127.0.0.1:1234/v1`) | **Enable CORS** is off. | Turn it on in the server settings, or `lms server start --cors`. An optional API token ("Require Authentication") is sent as the key. |
| llama-server (`http://127.0.0.1:8080/v1`) | Reflects any `Origin`; with `--tools` or `--agent` it admits localhost pages only. | `--cors-origins` with the app's address. A key set with `--api-key` is sent as the key. |

These defaults are transcribed from the vendors' documentation as of 2026-10 and are not re-read from the products here.

**The browser's permission.** Chrome and Edge ship Local Network Access: a public https page that fetches a loopback address asks the person once ("connect to apps on your device"; a separate `loopback-network` permission in newer versions). The transport passes `targetAddressSpace: 'loopback'` where `fetch` takes it. A denial looks like any other failed fetch, so the transport tells the three failures apart (provider-gateway §4) and names the matching fix. Whether Firefox and Safari ask, or block, has not been checked: **Firefox is unverified and Safari is unverified**, and the app makes no promise for Safari. The built app's `connect-src *` admits loopback; a self-hosted policy must allow `http://127.0.0.1:*`.

**What is tested.** `e2e/providers-cors.spec.ts` starts a stub server per product (`e2e/local-stub.ts`) that imitates the table above, and drives a real Chromium page against it: the refused save names the product's own fix, the configured one saves, the key header is absent when none is set, and a stopped server is reported as not running. Unit tests in `packages/gateway/test/local-models.test.ts` script the browser-shaped errors. This proves the wiring and the wording, not the real products' behaviour. The stub models a deployed origin (it refuses a web origin Ollama would only admit if configured), because the page under test is itself served from loopback.

**Still to check by hand,** and to record in the pull request whatever the result: Chrome (the Local Network Access prompt), Firefox and Safari against real Ollama with `OLLAMA_ORIGINS=https://caotang.app`, LM Studio with CORS on, and llama-server with defaults.

## 5. What the round does not cover

- Reading each local server's own model details (context window, tool support) is not built, so the local presets stay on conservative capabilities.
- Rate limits, quota exhaustion, and regional endpoint variants are live-account checks, not the sweep's.
- Only the default model's route is swept: a preset that sends some models down another route (OpenCode's Claude ids) is asked on the default model's route.
- A provider that passes the sweep can still fail a real account — the row's `cors` field says what the sweep found, not a guarantee.
