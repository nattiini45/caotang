# Hosted instance — end-to-end encrypted projects

> Status: **specified, not built.** The owner chose an invite-only Cloudflare pilot on 2026-11-12; the slices in §11 implement it. Nothing here runs in the app yet. `caotang.app` stays local-only and unchanged: no accounts, no server calls, the same CSP and bundle caps. Two private packages build the storage core against an in-memory fake server and are imported by nothing: [`packages/crypto`](../../packages/crypto) (§2–§4, §7) and [`packages/remote-store`](../../packages/remote-store) (§5–§7). The Worker, accounts, sync UI and domain deployment are not built. The provider relay remains deferred (§8). The epic is #17.

## 1. Scope

An optional hosted copy of Caotang at `caotang.pawcommit.com` that automatically keeps a writer's projects available on phone, tablet and laptop, including edits made offline. It starts as Caspar's private, invite-only pilot, not public sign-up. The project format does not change: the hosted store is one more `ArtifactFs` ([project-format.md §1, §4](project-format.md)), so everything above the port (the store's read and write, the bus, the exporter) runs on it as it does on a folder. The hosted shell is a separate build target with its own caps; the local build gets no sync-server setting and no hosted requests.

**Goals**

- The operator, a database dump or a backup cannot read a manuscript, a codex entry, a note or a file name.
- Signing in proves who you are to the server. It never derives or unlocks a key.
- Conflicting edits merge automatically where possible; overlapping edits keep a conflict copy, never interrupt typing with a dialog (§7).
- A plain `.caotang` bundle export is always available; there is no lock-in.
- The server is a ciphertext-only blob service that anyone can self-host (§6).

**Non-goals for v1**: real-time collaboration, passkey (WebAuthn PRF) unlock, syncing MCP tokens or agent conversations, server-side search, billing, and a server that can open a file for any reason. Encrypted provider-key sync is in scope (§2.2).

**Decisions this builds on.** `docs/decisions.md` records P1–P12 verbatim as owner decisions of 2026-11-12, separately from delegated implementation choices. Local-first, no accounts *in the local version*, no telemetry, and the *Desktop app or hosted only* label still hold. The pilot is free, with a fixed published 2 GiB cap per account, no credits, billing or feature gating. Caspar is using it to explore a possible subscription service; that is not approval to build paid tiers now. Self-hosting the ciphertext service stays first-class.

### 1.1 Hosting and ownership

One Cloudflare Worker serves the hosted static build and `/v1` API and exports the SQLite-backed Durable Object class `AccountHub`. R2 holds only sealed files and the sealed index; D1 holds per-user accounts, invites, quotas and usage. An account id scopes every row, object prefix and live channel, taken from the session rather than a client parameter. There are no billing fields.

The existing `pawcommit.com` zone is already on Cloudflare (HOME-1), so the Worker gets custom domain `caotang.pawcommit.com`, overriding the wildcard that points at the VPS. This implements P1/P2 as one Worker with static assets, not Pages plus a second Worker for the Durable Object. Only `/v1/*` and `/healthz` run the Worker first. Asset requests remain on the free static path even when the API allowance is exhausted; CI enforces at most 20,000 asset files and 25 MiB per file. The Durable Object uses SQLite storage and the WebSocket hibernation API, supported on Workers Free. Paid Workers ($5/month) is headroom, not a prerequisite.

HOME-1 owns all Cloudflare account work: Worker project, R2, D1, bindings, variables, secrets, custom domain, tokens and backups. The crew never uses the Cloudflare connector or changes the account. Deployment uses Workers Builds' Git integration; no Cloudflare credential goes into the repo or GitHub Actions. The repo owns code, wrangler config, migrations, tests and the build. `docs/hosted-provisioning.md` (created by #628 and extended by later slices) is the handoff contract: names, commands, assets directory, compatibility date and flags, bindings, variable/secret names, migrations, domain and schedules. HOME-1 provisions from that list.

A portable ciphertext-service core keeps the optional Node adapter first-class (#639); Cloudflare is the official pilot's adapter, not a project-format dependency.

## 2. Keys

```
passphrase ──Argon2id(salt)──> KEK ──wraps──> MK ──wraps──> PK (one per project)
                                                              │ HKDF-SHA-256, distinct info labels
                                                              ├─ file key      (per file, info = label ‖ pathHash)
                                                              ├─ path-HMAC key
                                                              └─ manifest key
```

| Key | Made by | Held | Role |
|---|---|---|---|
| KEK | Argon2id over the NFKC-normalised passphrase and a per-account salt (at least 16 bytes) | memory only, while unlocked | wraps the MK |
| MK | 256 random bits, once per account | wrapped under the KEK on the server; encoded as the recovery key (§4) | wraps each PK |
| PK | 256 random bits, once per project | wrapped under the MK on the server, bound to the project id | root of that project's keys |
| file, path, manifest keys | HKDF-SHA-256 of the PK, empty salt | derived on demand | one purpose each |

- **Argon2id** is `m = 64 MiB, t = 3, p = 1`. These are **provisional** until measured on low-end phones. The hash sits behind an injectable `Kdf` port (`derive(passphrase, salt)`); the Argon2id adapter, and the choice of a WASM library and its bundle cost, belong to #631, so the packages carry no third-party dependency.
- **Wrapping** is AES-256-GCM with a random 96-bit nonce. Associated data is a label: `caotang/v1/wrap/master`, and `caotang/v1/wrap/project` ‖ NUL ‖ projectId, so a project's wrapped key cannot stand in for another's.
- **Info labels** are `caotang/v1/file-key`, `caotang/v1/path-hmac-key` and `caotang/v1/manifest-key`; a file key's info is its label ‖ NUL ‖ the file's path hash. No two purposes can derive the same key.
- Only WebCrypto is used: AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256, SHA-256. The key type prints as its role, so a logged key shows no bytes, and no key enters a project, bundle, export or log.

### 2.1 Remember this device

After the first passphrase unlock, the writer can choose **Remember this device**. The device wraps the MK under a non-extractable WebCrypto key kept in IndexedDB, outside the project. KEK remains memory-only. Forgetting the device removes that wrapper; signing out everywhere revokes server sessions through an account epoch, and the device list supports revocation. Revocation stops server access; it cannot remotely erase downloaded plaintext or device keys. Remembering is not passkey PRF unlock. Page script can still use the remembered key while the app is open; this is the same XSS limit as the provider vault.

### 2.2 Encrypted provider-key sync

Provider keys sync from the start of the hosted key-sync slice (#633), sealed under a vault key derived from the account MK with distinct HKDF info `caotang/v1/vault-key`. A separate sealed vault object carries the profile definitions the keys need (profile id, endpoint origin, model, prices and custom headers), a counter and conditional `If-Match` commits. Associated data binds account id, profile id and origin; a swapped entry or repointed origin must fail authentication. On unlock, each device re-seals keys into its existing device-local vault. Gateway reveal and origin pinning do not change.

Concurrent changes merge per profile in server commit order, with a notice. Deleting a profile deletes its entry. A per-device **Do not sync keys from this device** switch and **Remove synced keys** control are required; removal advises rotating the keys at the provider. Setup checks passphrase length and strength and explains that a cracked passphrase exposes both manuscripts and provider keys. Plaintext never syncs; no key enters a project, bundle, export or log. MCP bearer tokens and agent conversations are excluded pending separate owner decisions. This is specified, not implemented by the existing crypto packages.

## 3. Sealed files and hashed paths

A sealed value is `0x01 ‖ nonce(12) ‖ ciphertext ‖ tag(16)`. The first byte is the format; an unknown one is refused.

- **Content** is framed as a 4-byte big-endian length ‖ the bytes ‖ zero padding, then sealed with AES-256-GCM under the file's own key and a fresh random nonce. A file key sees one new nonce per write of that file, far below the random-nonce limit.
- **Padding buckets**: the framed length rounds up to the next power of two from 256 bytes to 1 MiB, then to whole MiB. Two small files in one bucket seal to the same size. The sealed size is the bucket plus 29 bytes.
- **Associated data** is `caotang/v1/file` NUL projectId NUL pathHash NUL version. A file sealed for one project, path or version does not open as another; neither does one altered byte. AES-GCM cannot say which of key, context or bytes was wrong, so the error is one: *unauthentic*.
- **Path hash** is HMAC-SHA-256 of the project-relative path under the path key, as 52 lower-case Crockford base32 characters. The server never sees a path. The hash is also the key of the rollback mark (§7).
- **The manifest** (§5) is sealed the same way under the manifest key, with associated data `caotang/v1/manifest` NUL projectId NUL counter. A file cannot be opened as a manifest or the reverse.
- **Blob names** on the server are 128 random bits, hex, drawn per write. They carry no path, version or hash, and two versions of a file cannot be linked by name.

## 4. Recovery key

The MK is shown once as a printable recovery key and must be acknowledged before the account is usable. It is the version byte `0x01`, the 32-byte MK and the first four bytes of SHA-256(`caotang/v1/recovery` ‖ version ‖ MK), in Crockford base32: 60 characters in 12 groups of five. A mistyped group fails the checksum before any decryption. Input is accepted in any case, with or without dashes and spaces; `O` reads as `0` and `I` or `L` as `1`.

There is **no escrow**. If the passphrase and the recovery key are both lost, the data is lost, and the sign-up screen says that in those words. Changing the passphrase re-wraps the MK and rewrites no project file.

## 5. The encrypted index and versions

`ArtifactFs` stays **unchanged**. Two things it cannot carry are kept by the adapter ([`EncryptedRemoteArtifactFs`](../../packages/remote-store/src/encrypted-remote-fs.ts)): a version on a write (`writeAtomic` has no parameter for one), and a listing (`listFiles` and `listDirs` cannot ask a server that only knows hashed names).

- **Each file is a blob written once**, under a random name, and never replaced. A write creates a new blob; the old one is soft-deleted after the commit.
- **One `manifest` blob** is the index. On the wire it is an 8-byte big-endian counter ‖ the sealed JSON. The counter is read first because it is part of the associated data, and it rises by one on every commit. The JSON lists, for every path, `[path, pathHash, version, blobName, deleted]`, and the explicit directories. A removed file stays as a tombstone with its version raised, so its mark still means something. `listFiles`, `listDirs` and `exists` answer from the index; a directory that holds a file exists without `ensureDir`, as it does on a folder.
- **A write** (a) seals the content at `version + 1`, (b) puts the blob with `If-None-Match: *`, then (c) puts the new manifest with `If-Match` of the manifest it read. (c) is the commit. A write that fails before (c) leaves an unreferenced blob that is never read and that the server's retention clears.
- **Reads** serve the index as of the last open, refresh or commit. They do not poll. A read whose blob is gone asks the server for the index: if it moved on, another device replaced the file and the read raises the conflict error; if not, the server lost the file and the read raises an integrity error.
- **One writer at a time per device**: mutations run in a queue, each one reading, changing and swapping the index.
- **Paths** are checked as `MemoryArtifactFs` checks them (project-relative, no `..`). The same contract suite runs against both bindings.

What the existing adapter does not do: batching several writes into one index commit (a project save is one commit per file today) and an offline queue (#632), or clearing unreferenced blobs (#637).

## 6. The blob service

The server is backend-neutral: a small HTTP service that stores opaque bytes under opaque names, for one project at a time. Anyone can run it; the official instance is one deployment of it.

| Request | Meaning | Answers |
|---|---|---|
| `GET /v1/projects/{id}/blobs/{name}` | the live object | `200` bytes and `ETag`; `404` when absent or soft-deleted |
| `PUT /v1/projects/{id}/blobs/{name}` | `If-None-Match: *` creates; `If-Match: "<etag>"` replaces that version only | `200`/`201` and `ETag`; `412` when the precondition fails (nothing written); `507` over the account's storage cap |
| `DELETE /v1/projects/{id}/blobs/{name}` | soft delete | `204`; history is thinned as below and expires after 30 days |
| `GET /v1/projects/{id}/blobs` | live names | `200` JSON `[{name, etag, size}]` |

- A name is lower-case letters, digits and `-`, at most 64 characters. The index is always `manifest`. The body is `application/octet-stream` and is never parsed.
- Per account the published storage cap is 2 GiB, with quota and usage counters. Keep every version for 24 hours, then one per day for 30 days; purge older history and unreferenced blobs. Retain the blobs referenced by each retained index so a retained version stays recoverable. A daily retention job is required (#637); R2 lifecycle rules alone cannot express thinning. HOME-1 owns a nightly read-only R2 copy covered by its backup job; D1 recovery is provisioned with the account database.
- It logs only what operation and abuse prevention strictly need: method, route template, status and account id, with short retention; never bodies, keys, file names or blob names, including in request URLs. No application telemetry or analytics. The privacy note discloses Cloudflare's own platform metadata and logs.
- Authentication is GitHub sign-in first, then passkeys as a second sign-in and recovery method. GitHub OAuth uses state and PKCE; sessions use signed `HttpOnly`, `Secure`, `SameSite=Lax` cookies. Non-GET `/v1` routes require a CSRF header and same-origin `Origin`. An unauthenticated API request returns 401, not a redirect; the app shell loads while signed out. Authentication never derives or unlocks a key.
- #628 uses `ALLOWED_GITHUB_LOGINS` until #629 moves invites into D1. No public sign-up; an uninvited login is refused in plain words. Caspar creates the GitHub OAuth App with callback `https://caotang.pawcommit.com/v1/auth/github/callback` and gives its values to HOME-1, which sets `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `SESSION_SECRET`. No production credential is needed for local tests: OAuth is mocked.

In code, `RemoteBlobStore` (`get`, `put` with a precondition, `delete`, `list`) is this contract. Its test double, a `FakeBlobServer` with ETags, 412, soft delete, an offline switch and a `dump()` of every version ever kept, lives in the package's tests. There is no HTTP client yet.

## 7. Sync, conflicts and rollback

- **Existing adapter boundary.** A 412 still raises `RemoteConflictError` without overwriting anything; the adapter does not retry or merge. `refresh()` reads the other device's index. An offline adapter write still raises `RemoteUnavailableError`. The hosted sync layer, not the low-level port, owns the following orchestration; local folder-save conflict behaviour stays unchanged.
- **State-based sync.** Each device keeps the last synced content and ETag as its base and recomputes a dirty set from its IndexedDB working copy. Push after 10 seconds of quiet or 60 seconds since the first unsynced edit, whichever is first; flush best-effort on hide/pagehide. Open, focus and reconnect pull changes. Seal changed files, PUT new blobs, then commit the index with `If-Match`; a 412 fetches the new index, merges and retries with bounded backoff. Batching several files into one commit is part of #632, not the current adapter.
- **Live push from day one.** One authenticated `/v1/live` WebSocket per device routes through the Worker to the account's `AccountHub`. After a successful index commit the Worker broadcasts only project id, counter and originating device id. No content or key crosses the socket; a notification merely prompts an authenticated pull with rollback checks. Hibernation and auto-response heartbeats avoid waking idle sockets. If the socket or allowance fails, poll the index ETag every 30 seconds while visible. #628 proves a ping through the Worker locally; HOME-1 must verify the custom-domain upgrade and idle duration after deploy. No account-side result is claimed from a local test.
- **Offline**: typing continues in IndexedDB. A visible state (`synced`, `syncing`, `offline`, `merging`, `attention`, exposed as `data-state`) says how many changes are not yet synced; reconnect resumes automatically. Phones sync while open/foregrounded; background execution while closed is not promised.
- **No cross-device writer lease.** Phone, tablet and laptop may edit concurrently. The existing single-tab-per-project lease remains local to a device; a second device is not made read-only.
- **Merge, never interrupt typing.** Different-file edits rebase automatically. Document bodies and manifest notes use three-way text merge against the base; disjoint edits merge, overlapping edits keep the first-landed document and save the other as a sibling conflict copy under **Sync conflicts**, named with device and time. A notice offers Compare, not a blocking dialog. Every automatic merge preserves the pre-merge snapshot and is one undoable step. Until #634 implements three-way merge, #632 uses a conflict copy for every divergent same-file edit.
- **Project tree and metadata** merge by stable node id. A field changed on one side takes that side; a field changed on both takes the second server commit, with a notice listing replaced values. Adds and removals union, but an edit wins over deletion and restores the document. Concurrent sibling reordering must preserve relative orders where compatible; #634's spike must prove a deterministic resolution when those orders disagree before that rule ships.
- **`sessions.jsonl`** keeps its existing append-merge. **`coherence.json`** is derived state under the rules settled by #11 and #12 (both closed); they no longer block sync. Assets download on first view rather than making a phone fetch every picture on open. Agent sessions/run logs, traces, undo journals, skill reviews and folder handles do not sync. Project files still travel unchanged; the provider vault (§2.2) is a separate object, never part of a bundle.
- **Rollback.** A server can serve an old, correctly sealed value. Each device keeps a high-water mark per file (keyed by path hash) and for the index (`HighWaterMarks`), raised on every read and commit and persisted by the app. Opening or refreshing an index below its mark, an index that lists a file below its mark, or no index after one was seen raises `RollbackError`. A stale blob served under a current name fails to authenticate. A device with no marks (a first sign-in on a new machine) trusts the first state it meets; that is a limit (§9).

## 8. Provider relay — deferred

Not specified for build. A relay would let a browser reach a provider that blocks CORS. Whether it is built waits for the CORS sweep to be run and recorded (today 2 `ok` — Anthropic and the mock —, 24 `unknown`, 1 `blocked` — OpenCode, whose chat route refuses the browser preflight; the desktop app already reaches blocked providers). If it is built:

- opt-in per provider profile, with a warning at the switch that the relay sees the key and the prompt in transit, because end-to-end encryption does not cover a relayed call;
- a server-side allowlist generated from `presets/registry.ts`, only for presets recorded as CORS-blocked, never a URL from the client, so it is a forwarder and not the bundled CORS proxy that `docs/decisions.md` rules out;
- no logging or storing of bodies or keys, a per-account rate limit, and a check of each relayed provider's terms of service.

The hosted build's `connect-src` is `'self'` only; it does not inherit the local build's open provider egress. Until a separately approved same-origin provider path exists, direct external provider and MCP requests are unavailable in hosted. Encrypted key sync does not itself authorise a relay or widen this CSP. `caotang.app` keeps its existing CSP and direct-provider behaviour.

## 9. Threat model and honest limits

| Adversary | Can | Cannot | Mitigation |
|---|---|---|---|
| Cloudflare, a curious or compromised operator, or a dump | see account/OAuth ids, counts, padded sizes, timestamps, IPs; try passwords offline | read text, codex, notes, file names or keys without the passphrase | client-side AES-GCM; hashed paths; strong passphrase; the KEK never leaves the device |
| Network attacker | see TLS metadata | read or alter content | HTTPS, HSTS; AEAD rejects tampering |
| Malicious served code | exfiltrate keys from the page | stay undetected for ever | hosted-only strict CSP, SRI, a published build hash, the desktop and mobile apps as non-web clients |
| Account takeover | sign in, delete or replace ciphertext | decrypt without the passphrase | a separate passphrase; thinned 30-day history; notice on a new device; session revocation |
| Rolling back or replaying | serve older ciphertext | forge new content | version in the associated data; high-water marks (§7) |
| Another signed-in account | access its own rows, blobs and live messages | access another account's data or events | session-derived account id; scoped prefixes and hubs; cross-account tests |
| Relay operator | read relayed prompts and keys in transit | read stored projects | opt-in, no logging (§8) |

Limits that are stated, not hidden (SECURITY.md carries a pointer):

- **Web end-to-end encryption cannot stop a malicious bundle.** An operator who serves a backdoored script can read what the page can. The mitigations above shrink the window; they do not close it.
- **The server still sees metadata**: account and OAuth identity, how many projects and blobs, padded sizes, timestamps, IPs and access patterns. A file's bucket is visible; its exact size is not. Blob names are random, but the number of writes is visible. Cloudflare is a third party in this chain, including in its platform logs.
- **A fresh device has no rollback memory** until it has read the project once.
- **Argon2id cost** protects a weak passphrase only as far as the parameters allow.
- **An independent security review of crypto, remote-store and the hosted CSP/SRI is required before going public.** P12 permits an invite-only soft launch first, with a privacy note and invitees told the risks. These packages have not had an independent review.

The hosted build keeps the current script, style and worker restrictions, narrows `connect-src` to `'self'`, and ships `_headers` with `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The local build's CSP remains byte-for-byte unchanged. A compromised Git build can still serve malicious code: release from reviewed tagged commits and publish the deployed build hash. HOME-1 owns the Git integration and production credentials.

## 10. Gates

- **Pilot approval.** P1–P12 authorise the invite-only Cloudflare pilot with the published 2 GiB per-account cap and thinned history. No public sign-up or billing. P3 explores a possible subscription service; it does not change the pricing of `caotang.app` or authorise a subscription implementation.
- **Soft launch.** Before real invitee use: a short privacy note, invitees told the risks, account isolation and deletion tested, `.caotang` export available, backup/restore checked, and HOME-1's domain/TLS and live-socket checks recorded. Independent review is required before public use (P12), not waived.
- **Owner/account-side work**: HOME-1 provisions Cloudflare, domain/TLS, secrets and backups from the repo list; Caspar creates the GitHub OAuth App. Region/data-processing terms, Impressum/GDPR, any later paid plan, final phone-measured Argon2id parameters and the independent review remain gates for their corresponding launch steps. The skeleton is not a claim that encrypted project use is ready.
- **Telemetry.** None on hosted either.

## 11. Phases

| Slice | Work | State |
|---|---|---|
| #627 | Record P1–P12 and amend this spec | this docs slice; no runtime change |
| #628 | Separate hosted build, one Worker, GitHub sign-in, `AccountHub` live ping, provisioning list | not started; local OAuth mocked; custom domain verified by HOME-1 after deploy |
| #629 | Per-user D1 accounts, invites, quotas, usage and revocation epoch; no billing | after #628 |
| #630 | R2 blob/index API with ETag preconditions and HTTP blob client | after #629; crypto and remote-store packages already exist against a fake |
| #631 | Two-device encrypted round trip, passphrase, printed recovery key, unlock and remember this device | after #630 |
| #632 | Continuous/offline sync and live push, batching and conflict-copy fallback | after #631; #11 and #12 are closed |
| #633 | Sealed provider-key and profile sync (§2.2) | after #632 |
| #634 | Three-way text merge, tree merge by id, conflict copies and reorder spike | after #632 |
| #635 | Installable phone/tablet shell, offline launch and real-device checklist | after #632; no real-device support claim before that checklist |
| #636 | Passkey sign-in and recovery, not data unlock | can start after #629 |
| #637 | History thinning, HOME-1 backup copy and all-project export | after sync/storage |
| #638 | Hardening, privacy note and invite-only soft-launch gate | after the required product slices; independent review before public use |
| #639 | Optional portable Node adapter and Dockerfile for self-hosting | first-class fallback; not required for the Cloudflare pilot |

These issues are children of #17. #633–#635 can run in parallel after #632. Relay (§8) is not one of these approved slices. #628 does not unlock project storage: after #632 projects sync with conflict copies; after #634/#635 they gain automatic merge and an installable shell. The epic is closed only when the owner decides it is done.
