# Self-hostable sync server — authentication, live push and encrypted object storage

Status: the server package is standalone. Optional D1 accounts and quota accounting extend the authentication/live-push skeleton, and account mode with an R2 binding serves the encrypted blob and manifest API. Client sync, merge/history and a sign-in interface are not implemented. The local browser app does not import it or make server requests.

## Boundary

`@caotang/sync-server` exports a module Worker and an `AccountHub` Durable Object class. The deployment supplies an `ASSETS` fetch binding, an `ACCOUNT_HUBS` namespace, `PUBLIC_ORIGIN`, `ALLOWED_GITHUB_LOGINS`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `SESSION_SECRET`. Account mode adds the `ACCOUNT_DB` D1 binding; encrypted object storage adds the `PROJECT_STORE` R2 bucket binding. No deployment name, account, domain or credential is embedded in the package. `PUBLIC_ORIGIN` is an HTTPS origin without a path. `SESSION_SECRET` must contain at least 32 UTF-8 bytes of random secret material. Empty or malformed authentication configuration fails closed; health and static assets do not depend on it.

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
| `GET /v1/projects/{id}/blobs` | Account mode with `PROJECT_STORE`: the live object names, ETags and sizes. See [Encrypted object storage](#encrypted-object-storage). |
| `GET /v1/projects/{id}/blobs/{name}` | Account mode with `PROJECT_STORE`: the object's bytes and ETag, or `404`. |
| `PUT /v1/projects/{id}/blobs/{name}` | Account mode with `PROJECT_STORE`: create or replace under an ETag precondition, quota-charged. |
| `DELETE /v1/projects/{id}/blobs/{name}` | Account mode with `PROJECT_STORE`: soft delete, `204`. |

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

**Status.** The Worker implements this section: it reads `AUTHENTICATION_MODE` and the `ACCOUNT_DB` binding, claims invitations at the callback, revalidates every protected call, serves `GET /v1/account` and `POST /v1/auth/logout-all`, and checks revocation in the hub. The operator side is the validated SQL planner. D1 provisioning and migration application are outside this package; the quota writer is the object storage section below.

`AUTHENTICATION_MODE=accounts` selects the authoritative `ACCOUNT_DB` D1 binding. The default remains the existing allowlist mode. Missing D1 configuration, a database error, an uninvited identity or a disabled account never falls back to `ALLOWED_GITHUB_LOGINS`. Health and static assets remain independent. Deployers apply the package's ordered D1 migrations before selecting account mode.

Invitations bind to a verified GitHub numeric identity when the operator issues them; the login is only a bounded display label, not authorization. The operator resolves the selected login to its numeric identity through GitHub, then uses the package's validated SQL planner to grant or revoke it through their own D1 administration permissions. There is no public administration route, public signup, invite bearer token or additional stored OAuth token. An unclaimed invitation stays pending until claimed or revoked. Granting a revoked invitation is an explicit operator action, not an OAuth side effect.

The registry has typed pending/claimed/revoked invitation states and active/disabled accounts. A fresh verified OAuth callback claims a pending invitation and creates exactly one opaque account in one D1 batch transaction; concurrent callbacks are idempotent. A claimed invitation remains attached to its immutable numeric identity across a login rename or reuse. Revoking it disables its account and increments the session revision atomically. Regranting preserves the account id and quota, re-enables access and advances the revision; it never revives old sessions.

Account-mode cookies include the mode, account id and session revision as well as the existing purpose/origin/expiry claims. Every protected HTTP call revalidates the numeric-identity mapping, admission and revision on D1's primary; no cross-request authorization cache or read-replica lag is accepted. Legacy allowlist cookies cannot authorize account mode; switching back also requires a fresh allowlist sign-in. This cutover changes no local project data. Database errors return a sanitized `503`, not raw SQL or an authentication fallback.

`GET /v1/account` returns only this session's opaque id and `{ limitBytes, usedBytes, reservedBytes }` usage. It accepts no caller account selector. `POST /v1/auth/logout-all` in account mode advances that account's revision and clears the current cookie; its Origin requirement is unchanged. Existing allowlist routes and response shapes remain compatible; these account-only routes are not exposed in allowlist mode. The existing logout remains local to this browser and, in account mode, clears the cookie even while D1 is unavailable or its binding is missing (the same-origin POST with a validly signed cookie is the one call the configuration gate lets through), so an outage never keeps a browser signed in. After a switch between modes, local logout also clears a validly signed cookie from the other mode, so a browser is never left holding a cookie it cannot remove.

Account-mode live hubs are named only from the verified persisted account id. Every incoming application message, notification RPC and handshake checks the current account/revision before acting. Application heartbeat auto-responses are disabled in this mode so they cannot bypass revocation. A best-effort thirty-second alarm closes expired/revoked idle sockets. In account mode the hub keeps the presence lease in a per-socket timestamp refreshed by each checked `ping` message, since auto-responses are off; it is scheduled only while open sockets exist and cancelled after the last closes. The alarm is not a hard real-time guarantee. Before every presence publication, notification and sweep the hub validates each distinct account id, numeric identity and revision among its sockets, retires only the revoked ones, and closes every socket if D1 cannot be read, in which case the notification call reports `503` (or `401` for a revoked caller) instead of acknowledging it, so a socket from an older session revision never receives an event meant for the current one. Failure to validate D1 closes rather than authorizes a socket. Allowlist-mode heartbeat behavior is unchanged.

## Quota accounting seam

`QuotaStore` is an exported server-only D1 module, not a public upload route. Deployers select the byte allowance when granting an invitation; the generic package embeds no instance limit. The account's encoded payload bytes, including padding and retained versions, count; D1's registry/index overhead is not payload usage. Reservations count against the allowance before an upload begins. The read-only account routes consume the usage view; the object storage routes consume the mutation interface.

The lifecycle is `reserved → writing → committed`, with cancellation/reconciliation to terminal `released` only after an uncommitted write is safely settled. The `(account id, operation id)` idempotency key binds the immutable object key, size, session revision and lease deadline. Retrying cannot charge twice or repurpose a key; object keys and operation ids are bounded opaque identifiers. One atomic SQL operation admits a reservation only for an active account/revision with sufficient capacity. Concurrent reservations cannot oversubscribe and counters cannot become negative.

Before any object side effect, the writer changes the lease to writing and rechecks its identity/revision/deadline. The clock is sampled after the reads that precede that change, so a lease that lapsed during them is refused as expired. Each call reports success only when the operation is in the state that call aims at: begin needs writing, commit needs committed, and cancel or abort need aborted or released. Anything else, such as beginning a committed or released operation, committing a released one or cancelling a committed one, is refused as a transition, so a caller cannot acknowledge data that was reconciled away. Commit charges exactly the reserved encoded length once and remains charged for retained data. No method in this slice frees committed retained bytes; future collection needs its own reachability proof. A reservation that never began writing may be cancelled safely. A write that began is never refunded merely because time elapsed or a client reports failure.

The caller configures a finite write lease and bounded sweep interval. Each due, failed or revoked uncommitted operation is reconciled through a trusted writer adapter that settles/aborts that operation, confirms the object is not committed/reachable, removes any unreferenced result, and confirms absence before releasing its charge. An old writer cannot resume after that settlement. This is a storage-adapter obligation: D1 does not make an external object write atomic. Without that proof, retain the charge and retry every sweep. Each attempt records its sweep time, and the next sweep orders by it before the deadline, so a settlement that stays unconfirmed waits behind operations that have not been tried and cannot starve them or another account's. The adapter keys its writer fences and stored objects by account id as well as operation id and object key, because two accounts may reuse the same operation and object names. Log only the opaque account id and deferred object count, never object names, bodies, URLs or raw adapter errors. Test release within the configured healthy-storage bound and on the first sweep after an unavailable adapter recovers.

The R2 writer and the scheduled sweep are wired by the encrypted object storage section below. The local D1 tests use a deterministic fake uploader through the same settlement seam; the storage tests exercise the real R2 adapter through workerd, including the crash/race paths and the outage exception. Neither a successful sign-in nor these accounting tests claim that a service is launch-ready.

The agreed test seams are verified OAuth/HTTP through actual workerd with local D1 and R2, the exported account/operator interface, and `QuotaStore` with real local D1 and a fake uploader. Cover identity rename/reuse, concurrent claims/reservations, session cutover/revocation including existing sockets, quota boundaries, idempotency, retained charges and failed/recovered reconciliation. The browser dependency boundary remains a repository guard.

## Encrypted object storage

**Status.** In account mode with the `PROJECT_STORE` R2 binding, the Worker implements the blob service of [hosted.md §6](hosted.md): opaque bytes under opaque names, one account at a time. The server never parses, decrypts or inspects a payload. Without the binding the storage routes answer `503`; in allowlist mode they do not exist (`404`). The local browser app imports none of this; `@caotang/remote-store` ships the matching HTTP client.

### Routes and validation

| Route | Contract |
|---|---|
| `GET /v1/projects/{projectId}/blobs` | `200` JSON `[{name, etag, size}]` of the live objects, ordered by name. |
| `GET /v1/projects/{projectId}/blobs/{name}` | `200` bytes with `ETag` and `Content-Type: application/octet-stream`; `404` when absent or soft-deleted. |
| `PUT /v1/projects/{projectId}/blobs/{name}` | `If-None-Match: *` creates (`201`); `If-Match: "<etag>"` replaces exactly that version (`200`). Both answer with the new `ETag`. `412` when the precondition fails, `400` when it is missing or malformed, `409` for a refused or settled idempotent upload, `411` without `Content-Length`, `413` over the object cap, `507` over the account allowance, `503` when D1 or R2 is unavailable. Nothing is written on any refusal. |
| `DELETE /v1/projects/{projectId}/blobs/{name}` | Soft delete, `204`; a no-op for an absent or already deleted name. |

A project id is at most 64 letters, digits, `-` and `_`; an object name is at most 64 lower-case letters, digits and `-` (`manifest` is the index name). The body is `application/octet-stream` with a truthful `Content-Length`, at most 64 MiB (`413` above). Every storage call revalidates the account like every other protected route; the account id comes from the session only, and every R2 key begins with it, so one account can never address another's objects. Mutating routes keep the exact-Origin CSRF guard.

### Layout and commit

Each write stores its payload once, under `{accountId}/o/{operationId}`, and never replaces it. The live pointer `{accountId}/live/{projectId}/{name}` carries the current operation id and payload size in its metadata; the pointer's R2 ETag is the object's ETag on the wire. The pointer swap is the commit: R2's conditional put (create-only for `If-None-Match: *`, exact-ETag for `If-Match`) serialises concurrent writers, and a losing swap answers `412` with nothing committed. A soft delete swaps the pointer for a tombstone under the same precondition; the payload stays. A replaced or deleted version keeps a small history record under `{accountId}/history/{operationId}` so an operator can recover an older index by hand. Pointers, tombstones, history records and fences are index overhead, not payload usage.

### Quota charging

Every PUT runs the D1 lease lifecycle around the object writes: `reserve` admits the exact payload length against the account's remaining allowance (one byte over is `507`), `beginWrite` rechecks identity, revision and deadline before any R2 side effect, and `commit` charges the reserved bytes once, after the pointer swap. The `(accountId, operationId)` idempotency key comes from the optional `Idempotency-Key` header (at most 120 letters, digits, `-` and `_`); without it the server draws a random one. A retry with the same key and payload replays the committed ETag without a second charge; a different payload or name under the same key, or an operation the sweep already settled, is `409`. A failed precondition cancels the lease; the sweep releases its reservation and removes its unreferenced version.

### Sweep and settlement

The Worker's `scheduled` handler runs the quota reconciliation sweep over due, failed and revoked uncommitted operations, in batches of 100, ordered by last sweep time. The deployer schedules it with a cron trigger; without account mode or the bucket it is a no-op. The R2 settlement adapter fences the operation (`{accountId}/fences/{operationId}`), proves the version object is not the live pointer's current version, deletes the unreferenced version and its history record, and confirms both absent before the charge is released. A writer checks the fence before its version write, before the pointer swap and after it, and undoes a fenced swap, so a settled writer cannot resurrect an object or strand a pointer.

**Outage exception.** D1 does not make the R2 pointer swap atomic with the quota commit. If the pointer swap lands and the commit is then lost (a crash or a D1 outage in that window), the object is live and readable, the operation stays uncommitted, and every sweep defers it: the reservation keeps counting against the allowance, because releasing it would undercount live bytes and deleting the object would destroy committed data. A client retry under the same key completes the commit while the lease lives; after the lease lapses the retry is `409` and the data remains readable. This is the documented price of the two-system write; it costs capacity, never data.

### Retention

Replaced and soft-deleted versions are retained and remain charged; nothing in this slice frees committed bytes. The agreed thinning (every version for 24 hours, then one per day to 30 days) and the purge of expired versions need a collection pass with its own reachability proof and a committed-bytes release, and land in a later slice. Until then an account at its cap is refused with `507`.

## Not yet built

This package is not a complete sync service. Retention collection, client sync, merge/history, encryption setup and public-service hardening need their own contracts and tests. Its exports do not select a deployment or alter the browser app.
