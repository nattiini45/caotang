# Self-hostable sync server — authentication and live-push skeleton

Status: the server package is standalone. Optional D1 accounts and quota accounting extend the authentication/live-push skeleton; encrypted object storage, project sync and a sign-in interface are not implemented. The local browser app does not import it or make server requests.

## Boundary

`@caotang/sync-server` exports a module Worker and an `AccountHub` Durable Object class. The deployment supplies an `ASSETS` fetch binding, an `ACCOUNT_HUBS` namespace, `PUBLIC_ORIGIN`, `ALLOWED_GITHUB_LOGINS`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `SESSION_SECRET`. No deployment name, account, domain or credential is embedded in the package. `PUBLIC_ORIGIN` is an HTTPS origin without a path. `SESSION_SECRET` must contain at least 32 UTF-8 bytes of random secret material. Empty or malformed authentication configuration fails closed; health and static assets do not depend on it.

Serve static assets without authentication. Run the Worker first only for `/v1/*` and `/healthz`; the API does not redirect unauthenticated requests. Keep the app's CSP and direct provider/MCP egress unchanged. The server adds no provider relay and performs no key derivation, decryption or project mutation. A deployer is responsible for HTTPS, asset response headers and configuration; a Worker binding is not an authorization mechanism for public requests.

## Routes

| Route | Contract |
|---|---|
| `GET /healthz` | `200` with `{"ok":true}`; no authentication. |
| `GET /v1/auth/github` | Starts GitHub OAuth with random state and PKCE S256, binding both to a ten-minute signed HttpOnly cookie. |
| `GET /v1/auth/github/callback` | Verifies the browser cookie and state, exchanges the one-use code with the verifier, fetches the GitHub identity, checks the allowlist and mints an eight-hour signed session. Redirects only to the configured origin root. Clears the temporary cookie on success or failure. |
| `GET /v1/session` | Returns the authenticated GitHub identity, or `401`. The identity is not an encryption key or a persisted account record. |
| `POST /v1/auth/logout` | Requires the configured `Origin`, expires the browser session cookie and returns `204`. Revocation of other devices is future account work. |
| `GET /v1/live` | Requires a valid session, the configured `Origin` and a WebSocket upgrade. Routes to a hub keyed by verified GitHub id, never a client-supplied id. |
| `POST /v1/live/ping` | Requires a valid session and the configured `Origin`. Sends the content-free `{"type":"ping"}` notification to live sockets in that identity's hub. This is a connectivity proof, not a manifest commit. |

All API responses are `Cache-Control: no-store`, including errors and redirects. Cookies use the `__Host-` prefix, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax` and an explicit lifetime; no Domain is set. HMAC verification binds the cookie purpose and origin and rejects malformed, expired or tampered tokens. Session requests recheck the login allowlist, so removing a login refuses subsequent API calls. OAuth tokens are used only to fetch identity and are never returned to the client or retained. No route logs a code, token, cookie, secret, identity response or raw request URL.

GitHub is the only fixed outbound authentication destination. Redirects are not followed; failed, malformed or unavailable provider responses produce sanitized errors rather than response bodies. OAuth scopes do not request repository or email access. CSRF checks require an exact Origin on every mutating API route and every WebSocket handshake; CORS is not opened. Unknown authenticated API routes return `404`, and methods not in the table return `405` where the route exists. A signed-out protected route returns `401`, not an authentication redirect.

## Live-push lifetime

The hub accepts sockets through the hibernation API. An automatic application-level `ping`/`pong` pair avoids waking it for ordinary heartbeats; browser protocol ping/pong also remains available. Clients cannot publish arbitrary socket messages: unexpected messages close the connection. A socket attachment carries its session expiry and, for opt-in presence, a random browser-profile identifier and connection time. Expired sockets are closed before a notification is sent, and the next connection must authenticate again. Logout clears this browser's cookie but cannot retroactively revoke another device's signed session or an already-open socket; persistent revocation belongs to the account layer.

### Optional browser-profile presence

`GET /v1/live?presence=<uuid>` opts into presence; the value must be one canonical UUID v4 (case-insensitive), with no duplicate parameter. It is a client-generated random browser-profile label, not authentication, a hardware fingerprint or proof that two profiles are different physical devices. Tabs sharing a profile count once. No profile identifier, hardware label, login or activity payload is sent to peers. The verified account still selects the hub. Missing presence preserves the original protocol, including no unsolicited socket messages and the exact HTTP ping broadcast.

An opted-in socket receives `{"type":"presence","peers":0,"change":"snapshot"}` after joining. `peers` counts distinct currently live, opted-in profiles in this account other than the recipient's own. Joining or leaving the first or last socket of another profile emits the current recipient-specific count with `change` set to `joined` or `left`; another tab on an existing profile does not announce a new device. A `snapshot` updates the count without an announcement. Closing, erroring, rejected messages and expiry remove a socket before counts are published. State comes from hibernation attachments, not an in-memory roster.

`POST /v1/live/ping?presence=<uuid>` retains the original content-free ping broadcast and also emits `change:"activity"` only to other profiles when the supplied profile has a live socket. Self-pings and legacy pings never imply another profile's activity. Invalid presence parameters return `400`, and the usual session and exact-Origin guards remain mandatory.

Presence clients send the literal `ping` at least every 20 seconds. The runtime's automatic-response timestamp renews their 60-second liveness lease without waking the object. A Durable Object alarm, at most 30 seconds apart while opted-in sockets exist, closes expired sessions or leases and publishes removals. The alarm is deleted when no presence socket remains; legacy sockets retain their original lifetime. An abruptly lost network can remain visible until that bounded lease expires. Presence is transient connectivity, never a save, sync, authorization or durable revocation signal.

Deploy the class as a SQLite-backed Durable Object. A local runtime test must exercise the real `101` upgrade, not replace the namespace with a fake. It must prove that two identities cannot receive one another's ping, that cross-origin/unauthenticated handshakes fail, and that OAuth's state, PKCE, cookie attributes and failure paths are checked. Provider requests are mocked; tests must never contact GitHub or need real credentials.

## Optional durable accounts

`AUTHENTICATION_MODE=accounts` selects the authoritative `ACCOUNT_DB` D1 binding. The default remains the existing allowlist mode. Missing D1 configuration, a database error, an uninvited identity or a disabled account never falls back to `ALLOWED_GITHUB_LOGINS`. Health and static assets remain independent. Deployers apply the package's ordered D1 migrations before selecting account mode.

Invitations bind to a verified GitHub numeric identity when the operator issues them; the login is only a bounded display label, not authorization. The operator resolves the selected login to its numeric identity through GitHub, then uses the package's validated SQL planner to grant or revoke it through their own D1 administration permissions. There is no public administration route, public signup, invite bearer token or additional stored OAuth token. An unclaimed invitation stays pending until claimed or revoked. Granting a revoked invitation is an explicit operator action, not an OAuth side effect.

The registry has typed pending/claimed/revoked invitation states and active/disabled accounts. A fresh verified OAuth callback claims a pending invitation and creates exactly one opaque account in one D1 batch transaction; concurrent callbacks are idempotent. A claimed invitation remains attached to its immutable numeric identity across a login rename or reuse. Revoking it disables its account and increments the session revision atomically. Regranting preserves the account id and quota, re-enables access and advances the revision; it never revives old sessions.

Account-mode cookies include the mode, account id and session revision as well as the existing purpose/origin/expiry claims. Every protected HTTP call revalidates the numeric-identity mapping, admission and revision on D1's primary; no cross-request authorization cache or read-replica lag is accepted. Legacy allowlist cookies cannot authorize account mode; switching back also requires a fresh allowlist sign-in. This cutover changes no local project data. Database errors return a sanitized `503`, not raw SQL or an authentication fallback.

`GET /v1/account` returns only this session's opaque id and `{ limitBytes, usedBytes, reservedBytes }` usage. It accepts no caller account selector. `POST /v1/auth/logout-all` in account mode advances that account's revision and clears the current cookie; its Origin requirement is unchanged. Existing allowlist routes and response shapes remain compatible; these account-only routes are not exposed in allowlist mode. The existing logout remains local to this browser.

Account-mode live hubs are named only from the verified persisted account id. Every incoming application message, notification RPC and handshake checks the current account/revision before acting. Application heartbeat auto-responses are disabled in this mode so they cannot bypass revocation. A best-effort thirty-second alarm closes expired/revoked idle sockets; it is scheduled only while open sockets exist and cancelled after the last closes. The alarm is not a hard real-time guarantee. Failure to validate D1 closes rather than authorizes a socket. Allowlist-mode heartbeat behavior is unchanged.

## Quota accounting seam

`QuotaStore` is an exported server-only D1 module, not a public upload route. Deployers select the byte allowance when granting an invitation; the generic package embeds no instance limit. The account's encoded payload bytes, including padding and retained versions, count; D1's registry/index overhead is not payload usage. Reservations count against the allowance before an upload begins. Current read-only account routes consume the usage view; the following encrypted-storage implementation must consume the mutation interface before it can claim end-to-end enforcement.

The lifecycle is `reserved → writing → committed`, with cancellation/reconciliation to terminal `released` only after an uncommitted write is safely settled. The `(account id, operation id)` idempotency key binds the immutable object key, size, session revision and lease deadline. Retrying cannot charge twice or repurpose a key; object keys and operation ids are bounded opaque identifiers. One atomic SQL operation admits a reservation only for an active account/revision with sufficient capacity. Concurrent reservations cannot oversubscribe and counters cannot become negative.

Before any object side effect, the writer changes the lease to writing and rechecks its identity/revision/deadline. Commit charges exactly the reserved encoded length once and remains charged for retained data. No method in this slice frees committed retained bytes; future collection needs its own reachability proof. A reservation that never began writing may be cancelled safely. A write that began is never refunded merely because time elapsed or a client reports failure.

The caller configures a finite write lease and bounded sweep interval. Each due, failed or revoked uncommitted operation is reconciled through a trusted writer adapter that settles/aborts that operation, confirms the object is not committed/reachable, removes any unreferenced result, and confirms absence before releasing its charge. An old writer cannot resume after that settlement. This is a storage-adapter obligation: D1 does not make an external object write atomic. Without that proof, retain the charge and retry every sweep. Log only the opaque account id and deferred object count, never object names, bodies, URLs or raw adapter errors. Test release within the configured healthy-storage bound and on the first sweep after an unavailable adapter recovers.

The current package has no R2 writer or production reconciliation schedule. Its local D1 tests use a deterministic fake uploader through the same settlement seam. The storage slice must wire the actual writer and scheduled sweep, prove the cross-system crash/race behavior, and document the outage exception before accepting real payloads. Neither a successful sign-in nor these accounting tests claim that objects or history are already stored or that a service is launch-ready.

The agreed test seams are verified OAuth/HTTP through actual workerd and local D1, the exported account/operator interface, and `QuotaStore` with real local D1 and a fake uploader. Cover identity rename/reuse, concurrent claims/reservations, session cutover/revocation including existing sockets, quota boundaries, idempotency, retained charges and failed/recovered reconciliation. The browser dependency boundary remains a repository guard.

## Not yet built

This package stores no manuscripts and is not a complete sync service. Encrypted blob and manifest APIs, the real quota writer/reconciler, client sync, merge/history, encryption setup and public-service hardening need their own contracts and tests. Its exports do not select a deployment or alter the browser app.
