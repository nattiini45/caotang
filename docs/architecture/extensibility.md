# Extensibility — MCP client, external tools & the exposed harness (v0.2+)

> Status: built.
> Cross-refs: tool registry + permission model = [agent-harness.md](agent-harness.md) §3/§4 · command bus + activity log = [command-bus.md](command-bus.md) §3/§4/§8 · settings schema = [ui-modules.md](ui-modules.md) §5 · key storage = [provider-gateway.md](provider-gateway.md) §7 · mock provider = provider-gateway.md §8 · project artifact no-secrets rule = [project-format.md](project-format.md) §2.

## 1. Placement (what ships when)

| Capability | Ships | Gate / rationale |
|---|---|---|
| **Minimal MCP client** — Streamable-HTTP-only, panel-first config, Tier-2 search-then-load | **v0.2** | registry stable; the Claude-connector shape (URL-based) is the market's most-used path |
| **stdio transport** (child-process servers) | desktop build (Tauri) | structurally impossible in a browser tab; desktop shell makes it trivial and keeps tool I/O local |
| **Caotang as an MCP server** (registry exposed outward) | **post-v0.2** | needs the registry stable and the app running as a host process (desktop); SDK/packaging mechanics in §9 |
| **Skills** (writer-owned instructions for the agent) | **built, in part** | **the open SKILL.md standard, in the project's `.agents/skills/` only (§10)**; no Caotang pack format; installs and edits are the writer's alone (§4 rule 7). `skill.read`, `allowed-tools` enforcement, personal skills and running scripts are not in this build |
| **OAuth auth variant** | documented, not built | browser-page OAuth 2.1 without a backend is unsolved in the surveyed hosts' docs — v0.2 ships `none` + `bearer`; the `oauth` variant is documented, not built, and joins on real user demand (§3.6) |

"Plugin system" remains a v0.1 non-goal (ARCHITECTURE §4) — this track does **not** reopen it: externals ride the harness's Tier-2 surface under harness permission rules, not a plugin API.

## 2. v0.1 seam obligations (the cheap-to-absorb contract)

Three obligations, each already satisfied or trivially additive:

1. **Registry metadata stays the exact MCP mirror** — `{ name, risk, undoable, response_token_cap, description }` ↔ MCP annotations; the mapping table is §7 of this file. An MCP→registry adapter is a *mapping*, not a redesign (the mirror was designed in).
2. **`ActivityEntry.source?: 'native' | 'mcp'`** is reserved in the command-bus §8 shape from day one (default `'native'`; externals tag `'mcp'`). One field, added before the client exists.
3. **The registry is the single tool-declaration seam.** Tools exist only as registry entries; Tier-1 loading, Tier-2 deferral, and the future MCP-server surface all attach at this one seam. No second tool-declaration path may ever appear (a second path is how gating and audit diverge).

## 3. The MCP client module (v0.2)

**Owns:** server configs (app-level settings), transport connections, discovery (`tools/list`), pin verification, the Tier-2 search index, external tool-call transport. **Never** sees provider profiles or keys (§4 rule 6); **never** mutates project state (externals go through the bus as `mcp.invoke`, §6).

### 3.1 Config storage — app settings, never project files

```ts
// AppSettings gains (ui-modules.md §5.1):
mcp: {
  enabled: boolean;                 // master switch, default false — deny-by-default (§4)
  servers: McpServerConfig[];       // ≤ 20 servers (save-time clamp)
}
```

Server config lives in **Caotang's own settings store** (same app-level class as provider profiles; never in `caotang.json`, never in project files). Rationale: Cursor's MCPoison (CVE-2025-54136) was delivered through a repo-committed `mcp.json` approved once in a shared config — config-as-app-settings makes that entire delivery channel structurally impossible. The project artifact's no-secrets/no-cross-project-leak rule (project-format §2) extends to server URLs/tokens.

### 3.2 Server config & runtime health

```ts
interface McpServerConfig {                       // persisted (app settings)
  key: string;                                    // "s_" + 10 chars Crockford base32; assigned once at connect, immutable, never reused (rug-pull defense + namespacing root)
  name: string;                                   // display label, user-editable ("Story Bible Tools")
  transport: 'http';                              // v0.2 enum has exactly this value; 'stdio' joins with the desktop transport (§1)
  url: string;                                    // Streamable-HTTP endpoint; validated at save (https or http://localhost*, no trailing slash)
  auth: { kind: 'none' } | { kind: 'bearer'; tokenRef: string } /* OAuth: documented, not built, §3.6 */;
  enabled: boolean;                               // default true after connect; disabled = excluded from discovery + search
  enabledTools?: string[];                        // tool names kept enabled; absent = all discovered tools enabled (§8)
  trustReads: boolean;                            // per-server "trusted for reads" opt-in; default false; toggle disabled until first tool-list review completed (§3.4 step 4a)
  pinnedTools: Record<string, ToolPin>;           // qualified tool name → content pin
  addedAt: string;                                // ISO-8601
}

interface ToolPin { hash: string; firstSeen: string; lastReviewedAt: string; }
// hash = SHA-256 over canonical JSON of { toolName, description, inputSchema, annotations } (assumption A4, §12):
// `annotations` carries the four hint keys the server advertises, and is absent when it advertises none

interface McpServerHealth {                       // runtime only — never persisted
  key: string;
  state: 'configured' | 'connected' | 'healthy';
  detail?: string;                                // human + model-facing failure reason
  toolsDiscovered?: number;
  pendingReview?: boolean;                        // true while an unreviewed pin/tool-list delta exists
}
```

**Three health states, not two** ("✓ Connected" while tools never reach the model is a recurring bug class in MCP hosts, e.g. Claude Code #8407/#2682/#1611):

| State | Meaning |
|---|---|
| `configured` | config exists; no successful `tools/list` this session (§12 D17) |
| `connected` | handshake succeeded; tool listing **not yet confirmed** |
| `healthy` | `tools/list` succeeded **and** every tool's pin verified (or first-connect review completed); tools are in the search index |

Any mid-session failure (network error, tool-list delta, pin mismatch, CORS) demotes the state and fills `detail` with the named corrective path. The settings server card renders the state as a colored dot + the detail line — connection and tool-availability are *different* signals, exactly because the market conflates them and users pay for it.

### 3.3 Transport (v0.2 = Streamable HTTP only)

- **Wire:** JSON-RPC 2.0 over Streamable HTTP against a **single endpoint**. **Revision negotiated, not pinned (§12 D17).** The client uses the SDK's `auto` mode (`packages/mcp-client/src/wire.ts`). It sends **`server/discover` first**. A server that offers the 2026-07-28 revision is connected on the stateless path: no session header and no `initialize`, and the connect sequence is **`tools/list` → tool calls**. A 2025-era server answers that probe with "method not found", and it is connected through the SDK's plain **`initialize`** handshake, with the `Mcp-Session-Id` header only if that server issues one. A server that speaks none of the revisions Caotang offers (2026-07-28, or a 2024 or 2025 revision) is refused, and the refusal names the revision the server answered with or the ones it supports, never a revision Caotang chose. The list is requested with `cacheMode: 'refresh'`, so a changed tool is seen. **The SDK loads on first connect, not with the app.** `packages/mcp-client/src/lazy-wire.ts` is the default wire: a proxy that does `await import('./wire.js')` (the one file that imports the SDK) on its first listing or call, so the first download carries none of it and a project with no server never fetches it. The error class and the CORS probe live in `wire-error.ts`, which has no SDK import, so `WireError` is one class however it is reached. The egress check on the server's own URL runs before the chunk is fetched, and a chunk that cannot be fetched is a `network` failure (`WireLoadError`): the server card says the connector did not load, the next connect tries the load again, and nothing is left half-built.
- **CORS is first-class UX, not a footnote:** a browser client only reaches servers that send CORS headers allowing the app origin — most servers don't by default. A reachable-but-blocked server surfaces as `configured` + detail: *"server reachable but refuses browser connections (CORS). The desktop app on the roadmap connects without this restriction."* Caotang does **not** ship a CORS proxy in v0.2 (decision — §12 D11: a proxy would make Caotang a server-side fetcher for arbitrary URLs, contradicting deny-by-default and adding an egress surface).
- **Timeouts:** `tools/list` 10 s, tool call 120 s total (config-exposed later; defaults only in v0.2). The 2025-era `initialize` handshake is bounded by the same 10 s as the listing it precedes (§12 D17; `client.connect` takes the listing's timeout). Tool results are atomic — no streaming, no partial results; a timeout is a failed call, full stop. The agent panel shows a spinner card with elapsed time + abort (gateway abort discipline; no zombie requests).
- **Result cap:** an external answer **over 8,000 tokens** (`EXTERNAL_RESULT_TOKEN_CAP`, `packages/mcp-client/src/invoke.ts`) is **refused**, and the refusal names the cap. It is never trimmed: a cut answer would be an answer the server did not give. The tool ran on the server, so the refusal says any effect it had is already in place. This is the external counterpart of the registry's `response_token_cap` on native reads.
- **No auto-retry for external calls.** Contrast provider-gateway §4 (2 retries): externals default non-idempotent — replaying an external call blindly can duplicate side effects. Retry is the harness ladder's job, visible to the user. (`annotations.idempotentHint`-gated single retry is a recorded option, not built — assumption A3.)

### 3.4 Connection flow & pin verification

```
connect(key):
  1. negotiate (§3.3): server/discover first. A 2026-07-28 server is connected statelessly; a
     2025-era server through its initialize handshake (bounded by the 10 s below)  → fail: state 'configured', detail names it
  1b. tools/list (timeout 10 s)                    → fail: state 'configured', detail names it
     (the 2026-07-28 stateless core has no initialize; the 2025-era handshake is §12 D17's)
  2. pin diff vs pinnedTools:
     a. first connect (no pins): tools listed; ALL effectiveRisk = write-confirm; settings suggests the
        "review tool list" card; trustReads toggle stays disabled until the review happens (§8)
     b. no changes: every pin verified → state 'healthy'; tools enter the Tier-2 search index
     c. any change (hash mismatch, added or removed tool): state 'connected' + pendingReview=true;
        ALL the server's tools demoted to write-confirm (even read-trusted ones) until the user
        reviews the delta card; pins update ONLY on explicit review — never silent adoption (§4)
  3. enabledTools filter applied (§8): disabled tools never enter the search index or any surface
```

**Mid-session tool-list delta** (a server re-advertising changed tools without reconnect): same as the 4c case — demote + notification card, tools demoted to confirm-until-reviewed. Caotang does not auto-sever (the gateway pattern's "default is hostile to surprise" is honored via re-approval, not by stranding a writer's session mid-turn); re-approval on change is the shipped defense.

**Re-list before each external call.** A cached listing could hide a change made after the last check, so the call path does not trust it. After the bus has validated a `mcp.invoke`, and after a write-confirm call has waited for the writer, the client lists the server again (`tools/list`, the same 10 s bound). The listing runs the same pin diff as step 2: a changed tool is refused with the pin-mismatch text and **no request is sent**, and the server card shows the change as `pendingReview`. A listing that cannot finish in its bound is a failed call, not a call made on the old listing.

### 3.5 Module API

```ts
interface McpClient {
  connect(key: string): Promise<McpServerHealth>;       // §3.4 flow; idempotent within a session
  disconnect(key: string): void;                        // teardown; its tools drop from the search index
  listTools(key: string): Promise<ExternalToolDescriptor[]>;
  callTool(key: string, toolName: string, args: object, signal?: AbortSignal): Promise<McpToolResult>;
  health(): McpServerHealth[];                          // settings panel + agent-panel data source
  onHealthChange?: (h: McpServerHealth) => void;
  onToolListChanged?: (key: string) => void;            // rug-pull detection → demotion card (§3.4 step 4c)
}

interface ExternalToolDescriptor {
  qualifiedName: string;          // `mcp__<serverKey>__<alias>` — the model-facing form; the alias is the tool's name when the model's rule takes it, else the alias rule below (namespacing at the boundary is the whole answer)
  serverKey: string;              // immutable (§3.2)
  toolName: string;               // as advertised
  description: string;            // VERBATIM from tools/list — untrusted text, never rewritten by Caotang (§4 rule 4)
  inputSchema: JsonSchema;        // verbatim; the validate half of mcp.invoke checks model args against this
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
                                  // self-declared, attacker-controlled — informs nothing by itself (§7)
  pin: ToolPin;
  effectiveRisk: 'write-confirm' | 'read-auto';   // per §7 inward table; NEVER 'write-auto'
  deferred: true;                 // Tier-2: full schema enters model context only after tool.search (§5)
}

interface McpToolResult { content: McpContent[]; isError: boolean; }   // verbatim MCP content blocks (text | image | resource, per the MCP content schema); untrusted input (§4)
type McpError = { code: 'unreachable' | 'pin_mismatch' | 'schema' | 'timeout' | 'server_error'; message: string };   // maps into the CommandError envelope (§6)
```

**Model-facing names: the alias rule.** The model's tool-name rule takes letters, digits, `_` and `-`, at most 64 characters. A server's tool name may hold anything else: Caotang's own MCP server names every tool with a dot (`project.overview`). Such a tool is not hidden from search: it keeps its own name for the server and gets an **alias** for the model. The **room** is 64 characters less the length of the `mcp__<serverKey>__` prefix (45 for a key of twelve characters). A tool's name the rule takes, and that fits the room, keeps its own name, and those names are placed first, so a changed name never takes one of them. Any other name becomes an alias in three steps, in this order: each character the rule does not take is replaced by `_` (a name with no characters at all becomes `tool`); the result is cut to the room less seven characters, and at least one; then `_` and the first six lowercase hex digits of SHA-256 of the tool's name, **as the server advertises it** and UTF-8 encoded, are appended. So the alias always fits the room, and `a.b` and `a_b` never share one. An alias still taken (by a name placed first, or by an earlier alias) is tried again with the next digest: that of `name#1`, then `name#2`, and so on, with the same cut. Sixteen digests are tried in all, the first being the name's own, and the first free alias is the one used, so two tools of one server never share a name. `qualifiedName` is `mcp__<serverKey>__<alias>`: the search index, the loaded set, the pins, the approval card and the activity row key by it. The descriptor carries both names, and `tools/call` sends the server's own `toolName` (§3.3), whichever name the caller gave. Pins are keyed by the qualified name, so a tool whose name changed under this rule reads as new on its first listing and waits for review (§3.4 step 2a). A tool that still cannot be given a name is hidden, and the health detail names it.

Client scope is **tools-only** in v0.2: MCP `resources` and `prompts` are out of scope (assumption A7 — scope discipline; revisit with real server-ecosystem evidence).

**2026-07-28 reconciliation note (client half):** for a 2026-07-28 server the connect flow above includes no `initialize` handshake and no `Mcp-Session-Id` header — the stateless-first revision removed both from the core. A 2025-era server is connected through its `initialize` handshake, and it keeps the session header only if it issues one (§3.3, §12 D17). Health-state triggers change accordingly (`configured` = no successful `tools/list` this session; `connected` survives as the demotion state for pin deltas; `healthy` = list + pin verification). The 2026-07-28 deterministic-order/cache-hint list rules make the §3.4 pin diff compare against a catalog servers promise stable across reconnects. Elicitation is a **server→client direction only** — a client-side `elicitInput` handler throws on 2026-07-28 connections; Caotang's v0.2 client never issues elicitation (user input for external calls comes from the plan/confirm cards, §4). See §12 D17.

### 3.6 Auth

v0.2 ships `none` + `bearer` (many local/remote servers take static tokens; bearer tokens stored AES-GCM in the provider-key store, provider-gateway §7 shape — same vault, never in the project artifact).

**The `oauth` variant is documented but not built, gated on real user demand.** The evidence:

- **What a spec-correct client must implement (2025-06-18 revision):** PKCE S256 (RFC 7636); **protected-resource metadata discovery first** (`/.well-known/oauth-protected-resource`, RFC 9728) → RFC 8414 AS metadata; the **`resource` parameter (RFC 8707) mandatory in both the authorization and token requests** (prevents token replay across servers); form-urlencoded token exchange. Per RFC 9728 §3.1 the well-known URI inserts **between the host and the path**, not after the full path (VS Code issue #275161 shows how easily this is got wrong), and a `WWW-Authenticate` `resource_metadata` URL must be absolute (VS Code issue #273655).
- **Spec-correct client checklist (implementation-ready, for the v0.2 client when OAuth joins):** (1) on 401 + `WWW-Authenticate`, parse `resource_metadata` if present — **absolute URL required** (the #273655 reporter's fix); (2) else RFC 9728 insertion **between host and path** (`https://host/.well-known/oauth-protected-resource/sub-path/mcp`); (3) GET protected-resource metadata → `authorization_servers[]`; (4) per AS, RFC 8414 discovery with the **same insertion rule** (`https://github.com/.well-known/oauth-authorization-server/login/oauth`); (5) PKCE S256; (6) `resource` in authorize + token requests; (7) token cache keyed on the **immutable server `key`/URL** (Caotang-side requirement; no upstream bug substantiates the name-keyed variant); (8) port-agnostic loopback matching for local flows (Claude Code precedent). **Conformance gate:** test against the TS SDK's simple Streamable-HTTP example with OAuth enabled before pointing at real servers (VS Code needed 5+ issues and a 2026 regression #319913 to converge — the process lesson: verify against the spec and the reference SDK, not against any one vendor's shipped behavior).
- **No surveyed host is a bare browser page.** claude.ai performs the token exchange **on Anthropic's backend** and holds tokens server-side (their connector OAuth lands on `claude.ai/api/mcp/*auth-callback`; even they ship OAuth regressions — claude-ai-mcp #5, #313). VS Code is a native app with OS-adjacent secure storage. Claude *Code* (terminal) uses loopback redirects with port-agnostic matching. `mcp-remote` exists precisely as a local proxy doing OAuth for hosts that can't. The no-backend-browser shape Caotang would have is the one every host engineered around.
- **Caotang's evidence-gated shape when demand appears:** public-client PKCE (no secret), redirect to Caotang's own origin, discovery per the order above, `resource` always sent, **refresh tokens in the AES-GCM vault with the browser-storage threat-model caveat stated on the server card** ("token stored in this browser — weaker than OS keychains"). `McpAuth` gains `{ kind: 'oauth'; … }` only then. The deny-by-default posture means nothing is blocked by OAuth's absence on day one.

## 4. Security posture — deny-by-default

Caotang is the worst-case MCP client: an agent with write access to a manuscript. The posture is **more conservative than every surveyed product on first use — deliberately**:

1. **Master off until first connect; each server is an explicit user action** (name/URL/auth + a plain-language warning at connect). Nothing is discovered, advertised, or callable without it.
2. **Every external tool call confirms per call, regardless of claimed annotations**; `effectiveRisk` never reaches `write-auto` (§7). `read-auto` promotion requires the per-server `trustReads` flag (set after inspecting the tool list, revocable) **and** `readOnlyHint: true` — annotations usable as an *opt-in trust grant*, never as a default (the Copilot readOnlyHint gate proves annotations carry weight; Cursor's CVE proves what trusting them costs).
3. **Anti-rug-pull trio, client-side, cheap:** tool **pinning** (SHA-256 over name+description+schema at connect; any change → "changed — review required", all tools demoted to confirm-until-reviewed), **immutable server keys** + config-as-app-settings (§3.1), **re-approval on change** (tool-list delta between sessions or mid-session → notification card, never silent adoption).
4. **Untrusted text rules:** tool *descriptions* are untrusted — rendered in full, verbatim, in the approval card (never truncated in the payload region, never summarized by Caotang — the Invariant PoC hid in "visually benign" review UIs); `tool.search` results excerpt descriptions to ≤ 200 chars, and the model-facing copy of a loaded tool's description is excerpted to the same 200 chars, to shrink the ambient poisoning surface while the full text still appears where it matters (the approval card). Tool *results* are untrusted input — a tool result may not cause a further tool call targeting native state without passing the normal permission gate (confused-deputy containment).
5. **Approval-card content contract (external calls):** full args JSON in monospace (no payload truncation — Cursor's confirmation dialog not showing full tool input is exactly the gap Invariant exploited), full tool description on the tool's first use and whenever its pin state is "changed", server name + trust state + risk badge always visible.
6. **Hard-deny extension (v0.2; extends command-bus §4):** the egress allowlist becomes *provider endpoints + user-connected MCP server URLs* (both user-configured; local-first promise intact — tool arguments may quote manuscript text and go only to servers the user connected, the same trust model as BYOK). Externals may never: see provider profiles or keys (no credential visibility across the seam), disable the bus gate, write outside project scope. v0.2 exposes no shell or filesystem externals, so a poisoned external's blast radius = what that single tool can touch + prompt-injection into the turn context — the confirm gate caps it.
7. **No agent-driven installs.** The agent may never install, enable, or configure an MCP server; installation is a human settings action, full stop. Cline's `llms-install.md` path (agent autonomously clones/installs/configures from the server's own README — confirmed in its marketplace FAQ as optional *agent guidance*) is rejected as the precise channel an attacker writes for. Applies to any future pack format too (§10).

## 5. Tier-2: search-then-load — the `tool.search` meta-tool

**Why Tier-2 exists (measured):** ~550–1,400 tokens per tool schema; three real servers ≈ 143k of a 200k window before the first prompt; past ~50 tools output quality degrades, past ~120 it collapses ("every major platform vendor has independently arrived at the same range" — Unblocked). The 5–12-tool band is thereby confirmed as the *durable* architecture, not a v0.1 shortcut. Externals never join Tier-1; they load on demand, Anthropic-Tool-Search style (reported 49k→28k token savings in Claude Code). The registry's own deferred rows (agent-harness §3, `load: "deferred"`) ride the same gateway: one index, two sources, one loaded set.

**Registry row (joins Tier-1 as the Tier-2 gateway when the client ships; provisional #18 — final numbering assigned at landing order alongside coherence.md §7's 15–17):**

| # | Tool | Risk | Params | Semantics / Effects | Undo | Errors (model-facing) |
|---|------|------|--------|---------------------|------|----------------------|
| 18* | `tool.search` | read | `query: string` (case-insensitive substring over qualified name, tool name, description), `server?: string` (server-key filter), `risk?: 'read' \| 'write'` (filters by effectiveRisk), `limit?: number` (default 8, max 20; empty query = first 8 in deterministic order) | Search the registry's deferred native rows, and connected, enabled, healthy servers' discovered tools. A query matches when every word of it is found in a native row's name, description or keywords, or in an external tool's qualified name, tool name or description. Deterministic result order: native rows in registry order first, then server connect order, then tool name (eval-stable); a `server` filter leaves the native rows out. **Effect:** surfaced tools' full descriptors (name, verbatim description or the excerpt, inputSchema) are added to the current turn's tool surface for subsequent calls in that turn, in a message after the system prompt and never in L0 (agent-harness §3), and a one-line "Tools loaded this turn" addendum names them (context-assembly §2). Results carry: a `source` (`native` or `external`), the registry name or the qualified name, server name (external only), **description excerpt ≤ 200 chars**, risk badge (a native row's `read`, else `write`; an external tool's effectiveRisk). | none (read) | No servers connected → result, not error ("no MCP servers connected — add one in Settings › MCP & tools"); no matches → result with hint (re-search with terms from the task); unhealthy server → its tools excluded, named in a note. |

**Loaded-set lifecycle (§12 A2):** per-turn. A tool used in a prior turn is still searchable (cheap) and re-loads on demand — ambient context stays low, consistent with the L6 conversation-memory discipline (older context recoverable via explicit tools, not carried). Calling an external tool that is *not* loaded this turn → model-facing refusal: "`<name>` is not loaded this turn — call `tool.search` first" (names the corrective tool, the harness error discipline). Hallucinated external names get the same envelope. **A native row is different (deferral is context, not trust):** a step that names a deferred native row the turn has not loaded is preflighted like any step, not refused, and when its params fail the refusal adds "Call `tool.search` with '<name>' to load its parameters." Loading an external tool is where its pin is bound (candidate hash); a native row is trusted code behind the same bus gate, so it needs no pin. The `tool.search` description is versioned (`descriptionVersion` 2, agent-harness §9).

**Refinements from the shipped Anthropic mechanics, which confirm the shape:**

1. **Per-server defer granularity is Anthropic's own recommended split** ("keep your three to five most-used tools always loaded, defer the rest"; `defer_loading: true` settable per-server for MCP connectors, overridable per-tool). Caotang's equivalent controls already exist as human state: per-tool `enabledTools[]` (§3.2) + the `tool.search` surface — the difference is toggles, not architecture.
2. **Qualified-name discipline is empirically load-bearing:** Claude Code shipped (and fixed) a real bug where search missed a tool selected by its bare name instead of the full `mcp__server__tool` form. The `mcp__<serverKey>__<toolName>` boundary form (§3.5) stands unqualified-name-free by design.
3. **Loaded-set scope, decided:** Anthropic's deferred tools enter context on discovery and *stay for the session*; Caotang's **per-turn** lifecycle is deliberately more conservative — ambient context stays low, at the cost of one extra `tool.search` per turn. Session-scoped loading is recorded as the alternative (with its own cost: discovery state must survive turns and the poisoning surface lingers); per-turn ships, revisit only with usage evidence that re-searching annoys.
4. **Search-quality guardrail from the third-party data:** Stacklok's optimizer-vs-search comparison reports tool-search accuracy degrading toward ~30% at *thousands* of tools (vendor-adjacent measurement, direction credible). Caotang's ≤ 20-server clamp (A8) plus per-tool enable filters keep catalogs small enough that substring search stays deterministic and adequate — no fuzzy/semantic search layer in v0.2.

Claude Code's shipping default (v2.1.7: MCP descriptions auto-defer when they exceed 10% of the context window) is noted as the ecosystem's operating point; Caotang's Tier-1 is the 13 callable v0.1 rows plus `tool.search`. The registry has grown to 32 rows (five of them the allowlisted bus primitives, agent-harness §3, and one the skills row, §10), and every wired extension row used to be declared on every request, so the extension rows ride Tier-2 with the externals (agent-harness §3). Settings › Agent has **Load every tool on every request** for a model that searches poorly.

## 6. Command-bus & undo integration

External tool calls route through the command bus — that is the whole point of the harness seam (uniform gating, audit, response shapes). New bus command (lands with the client; command-bus §9 note):

| Command | Params | agentRisk | undo | Notes |
|---|---|---|---|---|
| `mcp.invoke` | `{ serverKey, toolName, args: object, expectedPins?: string[] }` | per `effectiveRisk` (`read-auto` → auto; `write-confirm` → confirm) | **none** | Pipeline fit (command-bus §3): **validate** = model args against the pinned `inputSchema` (schema violations listed with JSON paths) + pin verification (mismatch → refusal, not a warning) → **permission gate** per risk → **apply** = `McpClient.callTool` (the only async boundary; awaited inside apply) → **postconditions** = result well-formed, `isError` surfaced → **activity log** with `source: 'mcp'`. `mutates: 'none'` — external systems are not project state; the bus still gates and audits the *agent action*. |

- **callId dedupe applies unchanged:** replays of the same callId within a turn return the cached result without re-execution — protective for side-effectful externals (command-bus §6).
- **Error envelope:** every external failure maps into the standard `CommandError` shape with model-facing text: unreachable → *"server '<name>' unreachable (health: configured). Check the URL in Settings › MCP & tools, or drop this step"*; pin mismatch → *"server changed since review — re-approve in Settings"*; schema violation → lists the offending paths; timeout/abort → *"external call timed out after 120 s — no partial results exist"*.
- **Undo semantics for mixed turns:** one agent turn = one undo group, even when it mixes native and external calls. Undo applies native compensations (meta sets, doc snapshots) and **flags external effects as not reversible** in the checkpoint row: "restores Caotang state; external side effects are not reversible" — the scope-explicit restore-confirmation discipline extended to externals. What the bus adds here: because bus turns snapshot manuscript state, any external call that *also* touched Caotang state via native tools in the same turn is still covered by the turn-level snapshot restore — externals get audit + gating, native state keeps real undo.
- **Activity log:** `ActivityEntry.source: 'native' | 'mcp'` per call (field reserved since v0.1, §2); external summaries read *"called Story Bible › search_lore (external)"* — human titles, uniform export.

## 7. Registry metadata ↔ MCP annotations (exact mapping; harness §10 obligation 1)

**Outward** (Caotang registry → annotations; used by the future MCP-server direction, §9; the metadata fields were designed as this mirror):

| Caotang `risk` | MCP annotations | Notes |
|---|---|---|
| `read` | `readOnlyHint: true`, `destructiveHint: false` | description stays verbatim |
| `write-auto` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` where idempotent by design (`meta.set`) | description carries "applies automatically within an approved turn" |
| `write-confirm` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` | description prefixed "Requires user confirmation" |
| hard-deny class (`never`) | **not exposed** — deletion/provider/scope tools never appear on any outward surface | the server-side gate re-checks regardless of caller (§9) |

`agent.plan` is protocol, not a registry member — never exposed either direction. The metadata field `undoable` and the response token cap have no annotation equivalent; they travel in the exposed description text ("returns ≤ N tokens; undo via Caotang's turn checkpoints" where true).

**Inward** (server-advertised tool → Caotang `effectiveRisk`):

| Server declares | `server.trustReads` | effectiveRisk | Rationale |
|---|---|---|---|
| anything | — | `write-confirm` | default; annotations are attacker-controlled text (§4) |
| `readOnlyHint: true` | `true` | `read-auto` | explicit, revocable user trust grant |
| `readOnlyHint: true` | `false` | `write-confirm` | untrusted by default |
| hint absent or `false` | `true` | `write-confirm` | missing hint = no promotion |

## 8. Config UX — panel-first

Caotang's users are writers, not developers; raw JSON as the primary config path is a *differentiator against* the code tools, not a compromise (every surveyed product lands on JSON-file or settings-panel; Claude Desktop's most-used path is URL-based connectors).

- **Settings › MCP & tools** (v0.2 section; ui-modules §5.2): master switch; server cards — name, URL, health dot (three states) + detail line, auth status, per-tool rows (tool name, risk badge, pin state, **per-tool enable/disable toggles** — Windsurf's validated granularity, engineered as real state, given Cline's toggle-persistence bugs), "trusted for reads" toggle (disabled until first review, §3.4 step 4a), Remove.
- **Raw JSON affordance = secondary:** export/import the server list as JSON in the section footer (power-user escape hatch, Windsurf's pattern).
- **Per-entry-tolerant parse:** importing JSON with one malformed entry rejects **that entry with a named error** and keeps the rest — Cursor's silent drop of an entire `mcp.json` over one wrong `"type"` value is the named anti-pattern.
- Same per-entry tolerance applies to the persisted config on load: a malformed server object is dropped with a load warning; a broken server config never blocks app settings from loading.
- **Per-tool enable/disable is persisted state** (`enabledTools?: string[]` on `McpServerConfig` — absent = all discovered tools enabled; Cline's toggles are the validated shape but its persistence bugs are the warning): disabled tools drop from discovery, the search index, and outward surfaces; toggling re-runs the pin check for newly enabled tools.

## 9. Caotang as an MCP server

Precedent-rich (Figma official, Blender official, multiple Obsidian community servers — the last being writers *already* driving a writing tool's store from Claude Code/Cursor, file-granular), technically cheap because the registry reuse is nearly free, and a real niche (agents that operate on story bibles). **Roadmap item, not a non-goal.**

- **Surface = the registry rows the server can answer, unchanged in name, description, schema and token cap** (the registry holds 32 rows; agent-harness §10). The server lists **7 read tools in every mode**, and with `--allow-writes` **14 more** (7 write-auto, 7 write-confirm). It does not list `skill.load` (the server is built with no skills, §10), the eight model-backed rows (it holds no provider key: `scene.draft`, `synopsis.fill`, `continuity.scan`, `coherence.review`, `shots.derive`, `prompt.draft`, `prompt.variant`, `dialogue.draft`), `agent.plan` (protocol), or `tool.search`. **`tool.search` is not on the server:** it searches the tool servers Caotang's own client connects to, and the server connects to none. The server also reports `tools.listChanged: false`, because its list is fixed when the project opens. One contract, two transports: in-app bus; out-of-app MCP. Names, params, semantics, token caps identical.
- **Annotation mapping outward** per §7; `risk` maps so external hosts' own approval UX (which every surveyed host has) substitutes for Caotang's plan cards — the central trade-off, accepted: plan cards and batched confirmation are an *in-app* affordance.
- **The desktop and the server check each other's folder save.** The desktop asks before it saves over a folder the server holds (`locked`). It also refuses a save when a document or codex file in the folder changed, was removed or was added since the desktop last loaded or saved it, and names each by title (`files`, command-bus §6). The server stops in the same way: a `caotang.json` another program changed or removed, or a document or codex file it changed, stops its writes until it restarts, and the stop names the file by title. Both read the folder's digests through the store's one retrying read (folder-digests.ts `digestOfFile`), so a brief hold by the other program is not read as a change.
- **Default posture: read-only server first.** Read tools only; write tools exist only behind an explicit per-project opt-in ("allow external agents to modify my project"), mirroring §4's deny-by-default. A read never changes the manuscript, codex or manifest, on either posture. The server reads `coherence.json` at open on either posture, without writing it: a corrupt file is not repaired by a read-only server, and a file it cannot read never stops it from starting. Only with writes allowed does `coherence.scan` append its run to `coherence.json`, and `coherence.setFindingStatus` persist `fixed`; the file is derived state, like `sessions.jsonl` (decisions.md). **Save guard:** `coherence.json` is outside the folder drift check, so an app write of findings never stops a manuscript write. Before the server writes it, it digests the file against the digest held since the last load or save. If another program wrote it meanwhile, the file on disk wins: the server reads it again and re-applies only its own additions (the runs it recorded, the findings it created that the disk lacks, and a finding it moved from open to fixed that the disk still has open). It never changes a disk-side dismissal, never reopens a finding, and never touches scene declarations or world rules (coherence.md §6.3). A disk file it cannot merge cleanly (unreadable, or from a newer Caotang) refuses the write: the refusal names `coherence.json` on stderr and in the session notices, and coherence writes stop until the server restarts. The digest check narrows the window in which two writers lose each other's work and does not close it, because the check and the write are two steps; the folder-lock race fix stays with the folder checks (#12). An app that already has the folder open does not show a server scan until the folder is opened again.
- **Hard-deny enforced server-side regardless of caller:** node deletion, provider-profile mutation, scope escape return structured errors no matter what the calling host allows — the bus gate is the same gate.
- **Undo for external writes** rides the same snapshot machinery (they are tool calls with a different `source` tag); Caotang's activity log records everything with `source: 'mcp'`.
- **Serving requires a host process** — the browser build cannot listen; the server direction needs a host process (same constraint as the stdio client transport, §1). The mechanics:
  - **Spec version: build against the MCP 2026-07-28 revision + TS SDK v2** (MIT, stable line; v1 fixes ≥6 months). The 2026-07-28 path is stateless-first: no `initialize`, no `Mcp-Session-Id`, so any request lands on any instance, and server-to-client requests are **Multi Round-Trip Requests** (`InputRequiredResult` + `requestState`; the client re-issues the original request). **The 2025-era path keeps state:** a host on the 2025 handshake opens a connection with `initialize`, and the server asks its questions on that connection (a write-confirm is an `elicitation/create` the host answers in a separate POST), which a fresh instance per request cannot receive. So the connection is kept in the process, under the `Mcp-Session-Id` the server returns (`packages/mcp-server/src/legacy-sessions.ts`), and each later request with that id goes to the same transport. The table is bounded: at most 16 connections; a connection idle for 30 minutes is closed; the least recently used idle one is evicted to make room; a connection with a POST still open (a confirmation waiting for a person) is never closed for room, and that wait ends at the server's own deadline of 60 seconds (`LEGACY_ROUND_TIMEOUT_MS`, set as `inputRequired.roundTimeoutMs` on the connection's `McpServer`, not on `createMcpHandler`, which has no such option; stdio and the 2026-07-28 path hold no place and keep the SDK default); and when every connection is busy, a new `initialize` is refused with `503`, a JSON-RPC `-32000` body that names the limit, the busy count and the wait, and a `Retry-After` header. The table holds the transport and the server, never project data.
  - **Hosting shape, as built:** the SDK's dual-era entry `createMcpHandler` (`legacy: 'stateless'`) behind a `node:http` listener bound to `127.0.0.1` at `/mcp` (`packages/mcp-server/src/server.ts`), with the 2025-era connections of the bullet above. **The server is its own process**, started as `caotang-mcp serve --project <dir>` from a source build, or by the `.mcpb` bundle over stdio. It is **not hosted in-process by the desktop shell**: that in-process hosting, and the sidecar as its alternative, are not built. The single-writer lock `.caotang-mcp.lock` makes the desktop app ask before it saves over a folder a server holds, and "Save anyway" overrides that question; a program that reads neither the lock nor the app's check can still write the folder (mcp-server README). The app's check covers more than the lock: a document, a codex file or `caotang.json` that another program changed since the app last loaded or saved the folder is a question that names the file, and nothing is written until the writer answers (the `files` and `changed` questions, lifecycle.ts saveFolder). A crash or restart costs a re-list, and the 2025-era connections end with the process (the README's known gaps).
  - **Localhost auth, as built: a bearer token on every request**, compared in constant time. It is minted at start (256 bits, printed once on stderr, never written to the project) or supplied as `CAOTANG_MCP_TOKEN` (at least 16 characters). The loopback bind and the `Host`/`Origin` checks are the boundary. OAuth on a loopback endpoint is pointless friction unless fronting an upstream IdP — not built.
  - **Write-confirm across the boundary:** the calling host's approval UX substitutes plan cards via elicitation/MRTR — Caotang's server returns `input_required` with `requestedSchema: {confirmed: boolean}` (+ optionally a short reason enum); the host renders its dialog; accept/decline/cancel returns with `requestState`. **On the 2025-era path:** the same question arrives as an `elicitation/create` on the host's connection, through the SDK's legacy shim, and the host's answer returns on the same connection, so a restart ends the confirmation with the connection (the answer meets `404` "Session not found", which says so) and nothing is written; the question waits 60 seconds, and the dialog text and the initialize instructions say so; at the deadline the SDK ends the round with an error result ("Fulfilling input required by 'tools/call' failed: Request timed out"), the handler is not entered again, nothing is written, the ledger holds nothing for that round, and the host's next call asks a new question; a host that did not declare elicitation is refused before anything is written, and a host with no session cannot be asked, so it is refused with the handshake and the stdio route named. **Hard rule from the TS SDK docs: elicitation forms never carry secrets or long private content** — answers land in the calling model's context like any tool result. Sensitive values stay behind the bearer boundary. **A confirmation does not survive a server restart:** the round key is random per process and nothing is persisted, so a `requestState` sealed by an earlier process is refused with the SDK's `-32602` "Invalid or expired requestState" (the same for an altered or expired one) and nothing is written; the change is asked for again. A durable key is deferred (issue #92) and would cover only the 2026-07-28 path.
  - **Packaging, as built:** the `.mcpb` format is cross-client (Claude Desktop, Claude Code, MCP for Windows, any implementing host). The bundle is built by `pnpm --filter @caotang/mcp-server run pack` with the pinned `@anthropic-ai/mcpb` 2.1.2 (exact) and checked against `manifest.json`, and **it is not signed**. It runs the server over **stdio**, so it has no network listener. Its "Allow changes" setting maps to `CAOTANG_MCP_ALLOW_WRITES`, and only the exact value `true` turns writes on. The documented `127.0.0.1` URL and token is the same server run from a source build (`node dist/caotang-mcp.mjs serve --project <dir>`). Neither is a desktop-hosted server (see the hosting bullet above).

## 10. Skills

**A skill is an Agent Skills folder** ([agentskills.io](https://agentskills.io/specification)): `SKILL.md` (YAML front matter and Markdown) and the files beside it, in the project at `.agents/skills/<name>/`. It is the writer's own reusable instruction to the agent ("draft in close third person, past tense"), the thing the intent box made them retype and the codex, which holds facts, cannot hold. There is **no Caotang pack format**: the folder is the one other agents (Claude Code, Codex, Copilot, Cursor) read, and it round-trips byte for byte. Only `.agents/skills/` is read; `.claude/skills` is not (one root, one rule: a second root can be added later without breaking anything, and a root cannot be taken away).

**Where it lives and how it is carried.** The files are plain bytes in `ProjectState.skills` (project-format.md §1): a folder load reads every file of every skill folder, a save writes only the files whose bytes changed and removes only files the writer removed, a `.caotang` bundle carries the dot-folder, and the folder-save check counts a skill file another program changed, naming the skill. The browser store keeps them on the project row. A folder over a cap is not taken, is named in a notice and is left on disk: **50 skills per project, 64 files per skill, 256 KB per file, 2 MB per skill** (`SKILL_LIMITS`, one list for a folder load, an import, a bundle import and the commands). A path that leaves the skill folder (absolute, a drive letter, a backslash, `..`, an empty segment, a control character) is refused everywhere, and a zip entry like it is a zip-slip refusal.

**The reader.** `@caotang/skills` reads the front matter with a small in-house YAML reader and no new dependency. It reads plain, quoted (one line or several), folded (`>`) and literal (`|`) scalars, block and flow lists, and a one-level `metadata:` map, which is what the public skills use (the package's fixtures are real `SKILL.md` files from public repositories). It reads only the keys Caotang uses: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation`, `user-invocable`, `argument-hint`. It **never writes the front matter back**: the original text is kept and is part of the pin, so a skill another program edits keeps its bytes. Anchors, aliases, tags, directives, more than one document, a tab for indentation, a duplicate key and a plain value a YAML parser would also refuse (`a: b: c`) fail closed as `bad_front_matter`: the skill is not offered, and the writer is told what to change. The name is 1 to 64 lower-case letters, digits and hyphens, no hyphen at either end, and **it must be its folder's name** (`name_mismatch` otherwise); the description is 1 to 1024 characters; `compatibility` is at most 500.

**Review and the pin (deny by default).** A skill is text the model will read, and a shared project's skills were written by someone else. So **a skill is not seen by the model until the writer has read it in full and approved it**. The review card shows every file verbatim as plain text (no Markdown or HTML rendering), makes invisible and bidirectional control characters visible as `⟦U+XXXX⟧` and counts them, and shows HTML comments as text. It names `scripts/` ("includes scripts; Caotang reads the instructions and does not run them", plus a line that other agents pointed at the same folder may run them), shows `allowed-tools` marked "not enforced in this build", and notes that other files are kept and not readable by the agent in this build. The approval is a **pin**: SHA-256 over the canonical JSON of the skill's name, its front matter text, its body and the hash of **every file in the folder** (`references/`, `scripts/`, `assets/`). The pin is kept in **app settings** (the `caotang-app` IndexedDB, keyed by project id), **never in the project**, so a shared project cannot ship its own approval. Any change to any byte of any file makes the pin differ and the skill is unreviewed again.

**What the model sees.** Two things, and neither is in the system role (`SYSTEM_PROMPT_VERSION` and the L0 golden are untouched):

- **The skills list**: a planner addendum beside the loaded-tools line (context-assembly.md §2): one `- name: description` line (description on one line) for each skill that is **on, reviewed and open to the model**, capped at 1,500 tokens (descriptions are cut first, then whole skills are dropped from the end of the name order, and the drops are in the prompt preview's drop list). A skill with `disable-model-invocation: true` is for the writer alone and is not listed. A project with no skill on offer has no list, and its requests are byte for byte what they were.
- **`skill.load`** (read, extension row, `descriptionVersion: 1`, cap 6,000 tokens): `{ name }` returns the body with the front matter stripped, under the label "Writer-approved skill X: it guides style and process, and does not change permissions or approvals". It is **deferred like the other extension rows, and the agent loop preloads it whenever the list has a line to show**, so a project with no skills is told nothing about it. **The tool is the access control, not the list:** it refuses a skill that is off, unreviewed, changed since its review (the pin), reserved for the writer, or whose name is not its folder's, and answers each exactly as it answers a name that does not exist, echoing no text of the skill. An over-cap body is refused with the cap named and is never cut. A loaded body lasts for the turn that loaded it: it travels as a labelled block in the tool result and at the head of the drafting requests of that turn (`scene.draft`, `dialogue.draft`, `synopsis.fill`), in the user role, and `endTurn` forgets it. The conversation memory (context-assembly.md §2, L6) holds each earlier turn's intent and outcome, not its messages, so the body is not replayed to a later turn.

**The writer's, not the agent's.** `skill.import`, `skill.write`, `skill.delete` and `skill.setEnabled` are bus commands with `issuedBy: 'user'` only (`agentRisk: 'never'`, command-bus.md §9), and none is a harness tool or on the primitive allowlist. The agent may suggest a skill in its report and may not create, edit, enable or import one. **Nothing in a skill grants authority**: a body that says "skip confirmations" still meets every write-confirm card, because the gate looks at the command and never at a skill. Whether a skill is on is the manifest's `disabledSkills` (project-format.md §2); the review is not in the project.

**Scripts are never run and nothing is fetched or evaluated.** `scripts/` is listed, pinned and shown; it is not executed in the browser build, and running scripts is specified for the desktop app (#16), not built. The other agents pointed at the same folder may run them, and the card says so.

**Not offered over `caotang-mcp`.** The outward server (§9) is built with no skills, so `skill.load` is registered and not wired there and the server's tool list is the list it was (a test pins it). An outside host is not the agent the writer wrote the skill for.

**Not in this build** (CHANGELOG, Known limits): `skill.read` (so the files beside `SKILL.md` are carried, pinned and shown on the review card but the agent cannot read them), `allowed-tools` enforcement (it is parsed and shown; it could only ever narrow, never grant, so not enforcing it fails safe; bump `skill.load`'s `descriptionVersion` when it lands), personal skills (an app-wide scope), `/name` invocation and saved prompts (#61), extension bundles (#62), running scripts (#16), and `.claude/skills`.

**Still true from the survey that came first.** No surveyed writing tool ships an agent skill store, and Obsidian's code-plugin ecosystem shows the cost Caotang's closed registry avoids (multi-week review, API breakage, a 2026 malicious-payload incident, a deprecation list that auto-disables known-broken versions). A skill is data the writer reads, not code that runs, and the **known-bad-version list → auto-disable with message** idea (Obsidian's `community-plugin-deprecation.json`) stays guidance, pairing with the ToolPin pinning of §3.2 and this section's pin.

## 11. Evals (headless — mock MCP server)

```ts
interface MockMcpScript {                       // provider-gateway §8 discipline applied to MCP
  listTools: ExternalToolDescriptor[];          // canned discovery (pin states settable)
  respond: (tool: string, args: object) => McpToolResult | McpError;
  fail?: (phase: 'handshake' | 'list' | 'call') => void;   // injected failures
}
```

Deterministic, scripted, no wall-clock. v0.2 suite additions:

1. **Pin lifecycle:** stable connect → `healthy`; changed description → "changed — review required" + demotion; first connect → all-confirm + review-card suggestion; trustReads disabled until review.
2. **`tool.search` determinism:** fixed servers → stable result order across runs; excerpt ≤ 200 chars asserted; empty-query browse mode; loaded-set per-turn (re-search required next turn).
3. **effectiveRisk matrix:** the §7 inward table over annotation × trustReads combinations.
4. **Approval-card assertions:** poisoning fixture (description contains an injection string) → rendered **verbatim** in the card *and* the call still requires confirmation; full args JSON displayed; no payload truncation.
5. **Mid-session tool-list delta:** demotion card, tools confirm-only until re-approval; no silent adoption (pins unchanged until review).
6. **No-auto-retry:** injected network failure → exactly one request on the wire, error envelope names the corrective path.
7. **Mixed-turn undo:** native compensations applied; checkpoint row carries the "external effects not reversible" scope note.
8. **Hard-deny audits:** no external surface exposes provider credentials (schema audit over all advertised tools + mcp.invoke params); a `mcp.invoke` attempt targeting provider mutation is refused.
9. **callId replay** on an external call returns the cached result, one wire request total.
10. **CORS surface:** reachable-but-blocked server → `configured` + the exact §3.3 detail message.

## 12. Decisions & assumptions

| # | Decision | Authority / rationale |
|---|---|---|
| D1 | Client placement: v0.2, Streamable-HTTP-only; stdio with the desktop build | Delegated. Rejected: MCP in v0.1 (registry band frozen; Principle 5); gateway-proxy-first architecture (weight). |
| D2 | Externals never join Tier-1; Tier-2 = search-then-load via `tool.search` | Delegated: measured token costs (550–1,400/tool; >50 degrades) confirm the band as durable architecture; Anthropic Tool Search precedent. |
| D3 | Externals = write-confirm minimum regardless of annotations; per-server "trusted for reads" opt-in promotes only readOnlyHint-declaring tools; **never write-auto** | Delegated. Rejected: trusting self-declared annotations by default (Cursor CVE-2025-54136 is the cost); per-tool auto-approve toggles at connect (Cline's most fragile surface). |
| D4 | External calls route through the command bus (gating + audit + uniform shapes); `undoable: false`; turn snapshot covers native-state side effects | Delegated (harness §10 obligation 3). Rejected: bypassing the bus (loses the whole seam); pretending external undo exists (semantically impossible without server cooperation). |
| D5 | Anti-rug-pull trio client-side: tool pinning + immutable server keys + re-approval on change | Delegated (MCP-Scan's pinning brought in-app; MCPoison structurally avoided by config-as-app-settings). Rejected: shipping a gateway (weight); auto-severing mid-session (strands the writer). |
| D6 | Descriptions and results are untrusted: full verbatim description in approval cards; ≤ 200-char excerpts in search results; results may not trigger native writes without the gate | Delegated. Rejected: UI cosmetics as defense (Invariant's reviews looked fine); truncating descriptions in approval cards (the payload region must be intact). |
| D7 | No agent-driven installs; MCP config lives in app settings, never project files | Delegated. Rejected: Cline's llms-install path (agent-executed setup = the attack channel); repo-committed mcp.json (MCPoison's vehicle). |
| D8 | Config UX panel-first; raw JSON secondary; per-entry-tolerant parse; three-state health | Delegated. Rejected: JSON-file-first (writers, not developers); two-state health (the market's connected-but-no-tools bug class). |
| D9 | Hard-deny extension for v0.2: egress allowlist = provider endpoints + connected MCP URLs; externals never see provider credentials, disable the gate, or leave project scope | Delegated. |
| D10 | `tool.search` excerpts descriptions at ≤ 200 chars | Delegated; shrinks ambient poisoning surface; full text still rendered where it matters (approval card). Eval-pinned; revisit with usage. |
| D11 | No bundled CORS proxy in v0.2 | Delegated. A proxy would make Caotang a server-side fetcher for arbitrary URLs — contradicts deny-by-default, adds an egress surface; the desktop build removes the constraint honestly instead. |
| D12 | Caotang-as-server: post-v0.2 roadmap item (not a non-goal), read-only-first, registry = server surface unchanged, hard-deny server-side, requires the desktop host process | Delegated. Rejected: none — precedent-rich (Figma/Blender/Obsidian), near-free via the metadata mirror. |
| D13 | Skills: no Caotang pack format; human-click installs regardless | **Resolved, 2026-10-22:** adopted as a phased v1 — the SKILL.md open standard in the project's `.agents/skills/` only, reviewed in full and pinned in app settings before the model sees it, a capped catalog plus `skill.load`, user-only `skill.*` commands, no scripts run, `allowed-tools` shown and not enforced, no exposure over `caotang-mcp`, no new YAML dependency (§10). `skill.read`, `allowed-tools` enforcement and personal skills wait for demand. Known-bad-version auto-disable stays guidance. |
| D14 | v0.1 seam obligations (metadata mirror exact; `ActivityEntry.source` reserved; registry = single declaration seam) | Delegated — harness §10 obligation 1 + the "cheap to absorb" directive. |
| D15 | Per-tool enable/disable is persisted server-config state (`enabledTools[]`), not a session checkbox | Delegated (Windsurf's validated granularity adopted; Cline's persistence bugs are the engineering warning). Disabled tools drop from discovery, search and outward surfaces. |
| A1 | Streamable-HTTP POST-only shape per the 2026-07-28 spec revision | **Decided (D17):** §3.3/§3.4 flows are written against 2026-07-28 semantics (no `initialize`, no session header) for 2026-07-28 servers; 2025-era servers take the negotiated `initialize` path. |
| A2 | Loaded-set lifecycle is per-turn | **Decided** — the shipped Anthropic mechanics confirm the Tier-2 contract; per-turn kept over Anthropic's session-scoped loading (ambient context low; one extra `tool.search` per turn); session-scoped recorded as the alternative (§5 refinement 3). |
| A3 | No auto-retry for external calls; idempotentHint-gated single retry is a recorded option, not built | Explicit; contrast provider-gateway §4 deliberately. |
| A4 | Pin hash = SHA-256 over canonical JSON `{toolName, description, inputSchema, annotations}`, where `annotations` holds the four hint keys (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) the server advertises, and is absent when it advertises none. A tool with no hints therefore hashes exactly as the original three-field rule did, and a changed hint is a change that needs review. | Explicit; implemented in `canonical.ts` and pinned by `pins.test.ts`; canonical-JSON serialization pinned in evals. |
| A5 | `tool.search` excerpting doesn't harm discovery | Explicit; eval-pinned; usage revisits. |
| A6 | v0.2 auth = none + bearer; OAuth documented, not built | Explicit — OAuth's spec-correct SPA shape is *documented with evidence* (§3.6); the variant joins only on real user demand. |
| A7 | Client scope = tools only (no resources/prompts) in v0.2 | Explicit scope discipline; revisit with server-ecosystem evidence. |
| A8 | ≤ 20 servers per install; ≤ 120 s tool-call timeout | Explicit clamps, raisable. |
| D16 | Caotang-as-server builds against MCP 2026-07-28 + TS SDK v2; its own process (not in-process in the desktop shell), loopback bearer, MRTR elicitation as the host's write-confirm channel; `.mcpb` (stdio) as the desktop packaging | **Resolved:** the 2026-07-28 stateless-first revision removes session affinity and stream-held elicitation — the two hard parts of hosting; secrets-never-in-elicitation-forms adopted as a hard rule; OAuth on loopback rejected (friction without an upstream IdP). A 2025-era host keeps a bounded connection so that it can answer a write-confirm (§9). |
| D17 | Client revision negotiated, not pinned: the SDK's `auto` mode sends `server/discover` first; a server that offers 2026-07-28 is connected on the stateless path (`tools/list` without an initialize handshake or session header); a 2025-era server, which answers the probe with "method not found", is connected through the SDK's plain `initialize` handshake, with the session header only if that server issues one; a server that speaks none of the revisions the client offers (2026-07-28, or a 2024 or 2025 revision) is refused, and the refusal names the server's revision, not one Caotang chose. Health-state triggers: `configured` = no successful list; `connected` = pin-delta demotion state. Elicitation is server→client only (a client-side `elicitInput` throws on 2026-07-28 connections — Caotang's client never issues it); deterministic list order is load-bearing for the §3.4 pin diff | **Delegated.** One negotiated client covers both server eras: a pin to 2026-07-28 would refuse every 2025-era server, and the pinned SDK (2.3.1) supports the legacy handshake under `auto`. The `initialize`-free language in §3.3 and §3.4 applies to the 2026-07-28 path; the 2025-era path is the `initialize` handshake described there. |
| D18 | Deferral is context, not trust: a deferred native row is preflighted like any step even when the turn has not loaded it, while an unloaded external tool is refused | Delegated. The one difference between the two sources: an external tool is untrusted and loading binds its pin; a native row is Caotang's own code behind the same bus gate, so refusing it would only cost a round trip. |
