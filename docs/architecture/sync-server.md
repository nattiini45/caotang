# Self-hostable sync server — authentication and live-push skeleton

Status: the server package is a standalone skeleton. The local browser app does not import it or make server requests. Storage, account persistence, project sync and a sign-in interface are not implemented by this package.

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

The hub accepts sockets through the hibernation API. An automatic application-level `ping`/`pong` pair avoids waking it for ordinary heartbeats; browser protocol ping/pong also remains available. Clients cannot publish arbitrary socket messages: unexpected messages close the connection. A socket attachment carries only its session expiry. Expired sockets are closed before a notification is sent, and the next connection must authenticate again. Logout clears this browser's cookie but cannot retroactively revoke another device's signed session or an already-open socket; persistent revocation belongs to the account layer.

Deploy the class as a SQLite-backed Durable Object. A local runtime test must exercise the real `101` upgrade, not replace the namespace with a fake. It must prove that two identities cannot receive one another's ping, that cross-origin/unauthenticated handshakes fail, and that OAuth's state, PKCE, cookie attributes and failure paths are checked. Provider requests are mocked; tests must never contact GitHub or need real credentials.

## Not yet built

This package stores no manuscripts and is not a complete sync service. Accounts/invites/quotas, encrypted blob and manifest APIs, durable revocation, client sync, merge/history, encryption setup and public-service hardening need their own contracts and tests. Its exports do not select a deployment or alter the browser app.
