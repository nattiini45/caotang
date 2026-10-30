# Hosted instance — end-to-end encrypted projects

> Status: **specified, not built.** Nothing here runs in the app. `caotang.app` stays local-only and unchanged: no accounts, no server calls, the same CSP. Two private packages build the storage core against an in-memory fake server and are imported by nothing: [`packages/crypto`](../../packages/crypto) (§2–§4, §7) and [`packages/remote-store`](../../packages/remote-store) (§5–§7). The backend, accounts, relay, domain and UI are not built, and none of them is until the owner funds the instance (§10). The epic is #17.

## 1. Scope

An optional hosted copy of Caotang at `caotang.pawcommit.com` that lets a writer reach one project from several machines. The project format does not change: the hosted store is one more `ArtifactFs` ([project-format.md §1, §4](project-format.md)), so everything above the port (the store's read and write, the bus, the exporter) runs on it as it does on a folder.

**Goals**

- The operator, a database dump or a backup cannot read a manuscript, a codex entry, a note or a file name.
- Signing in proves who you are to the server. It never derives or unlocks a key.
- A conflicting edit is asked about and never lost (§7).
- A plain `.caotang` bundle export is always available; there is no lock-in.
- The server is a ciphertext-only blob service that anyone can self-host (§6).

**Non-goals for v1**: real-time collaboration, passkey (WebAuthn PRF) unlock, syncing provider keys, server-side search, a server that can open a file for any reason.

**Decisions this builds on.** `docs/decisions.md` keeps the owner lines untouched: local-first, no Caotang server and no accounts *in the local version*, no telemetry, "no meters, gates, paid tiers or subscriptions", and the *Desktop app or hosted only* label. Hosted is free with one fixed, published storage cap per account. A capacity cap is not a meter, gate or tier; there are no credits and no feature gating, and donations are optional. Self-hosting is the fallback if no official instance is funded.

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

- **Argon2id** is `m = 64 MiB, t = 3, p = 1`. These are **provisional** until measured on low-end phones. The hash sits behind an injectable `Kdf` port (`derive(passphrase, salt)`); the Argon2id adapter, and the choice of a WASM library and its bundle cost, are a Phase 1 decision, so the packages carry no third-party dependency.
- **Wrapping** is AES-256-GCM with a random 96-bit nonce. Associated data is a label: `caotang/v1/wrap/master`, and `caotang/v1/wrap/project` ‖ NUL ‖ projectId, so a project's wrapped key cannot stand in for another's.
- **Info labels** are `caotang/v1/file-key`, `caotang/v1/path-hmac-key` and `caotang/v1/manifest-key`; a file key's info is its label ‖ NUL ‖ the file's path hash. No two purposes can derive the same key.
- Only WebCrypto is used: AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256, SHA-256. The key type prints as its role, so a logged key shows no bytes, and no key enters a project, bundle, export or log.

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

What this slice does not do, and Phase 3 owns: batching several writes into one index commit (a project save is one commit per file today), an offline queue, and clearing unreferenced blobs.

## 6. The blob service

The server is backend-neutral: a small HTTP service that stores opaque bytes under opaque names, for one project at a time. Anyone can run it; the official instance is one deployment of it.

| Request | Meaning | Answers |
|---|---|---|
| `GET /v1/projects/{id}/blobs/{name}` | the live object | `200` bytes and `ETag`; `404` when absent or soft-deleted |
| `PUT /v1/projects/{id}/blobs/{name}` | `If-None-Match: *` creates; `If-Match: "<etag>"` replaces that version only | `200`/`201` and `ETag`; `412` when the precondition fails (nothing written); `507` over the account's storage cap |
| `DELETE /v1/projects/{id}/blobs/{name}` | soft delete | `204`; the server keeps the bytes 30 days, then purges |
| `GET /v1/projects/{id}/blobs` | live names | `200` JSON `[{name, etag, size}]` |

- A name is lower-case letters, digits and `-`, at most 64 characters. The index is always `manifest`. The body is `application/octet-stream` and is never parsed.
- The server keeps a replaced version of any object for the same 30 days, which is how an older index can be recovered by hand.
- It logs only what operation and abuse prevention strictly need: no content, no names beyond the request line, short retention. No telemetry, no analytics.
- Authentication (email link, Google, GitHub; `HttpOnly`, `Secure`, `SameSite=Lax` cookies, CSRF protection on mutating routes) decides who may call these routes. It never derives a key.

In code, `RemoteBlobStore` (`get`, `put` with a precondition, `delete`, `list`) is this contract. Its test double, a `FakeBlobServer` with ETags, 412, soft delete, an offline switch and a `dump()` of every version ever kept, lives in the package's tests. There is no HTTP client yet.

## 7. Sync, conflicts and rollback

- **A 412 is the "files changed" question.** The adapter raises `RemoteConflictError` naming the file; nothing was overwritten. The app will ask the question the folder save already asks when a file changed under it ([`FolderDriftError`](../../packages/store/src/write.ts) stops and names the file), and the writer chooses. The adapter does not retry, merge or refresh by itself; `refresh()` reads what the other device did.
- **Offline**: a write with no server rejects with `RemoteUnavailableError` and changes nothing. Queue and replay are Phase 3.
- **Device lease**: a soft heartbeat lease makes a second device read-only while the first holds it. It replaces today's single-tab ownership. Phase 3.
- **`sessions.jsonl`** keeps its append-merge. **`coherence.json`** merges as derived state under the rule decided for the MCP server's `coherence.json` (#11) and the conflict question (#12). Phase 3 waits on those.
- **Rollback.** A server can serve an old, correctly sealed value. Each device keeps a high-water mark per file (keyed by path hash) and for the index (`HighWaterMarks`), raised on every read and commit and persisted by the app. Opening or refreshing an index below its mark, an index that lists a file below its mark, or no index after one was seen raises `RollbackError`. A stale blob served under a current name fails to authenticate. A device with no marks (a first sign-in on a new machine) trusts the first state it meets; that is a limit (§9).

## 8. Provider relay — deferred

Not specified for build. A relay would let a browser reach a provider that blocks CORS. Whether it is built waits for the CORS sweep to be run and recorded (today 2 `ok` — Anthropic and the mock —, 23 `unknown`, 2 `blocked` — Z.ai and OpenCode, whose chat routes refuse the browser preflight; the desktop app already reaches blocked providers). If it is built:

- opt-in per provider profile, with a warning at the switch that the relay sees the key and the prompt in transit, because end-to-end encryption does not cover a relayed call;
- a server-side allowlist generated from `presets/registry.ts`, only for presets recorded as CORS-blocked, never a URL from the client, so it is a forwarder and not the bundled CORS proxy that `docs/decisions.md` rules out;
- no logging or storing of bodies or keys, a per-account rate limit, and a check of each relayed provider's terms of service.

## 9. Threat model and honest limits

| Adversary | Can | Cannot | Mitigation |
|---|---|---|---|
| Curious or compromised operator, or a dump | see emails, OAuth ids, counts, padded sizes, timestamps, IPs | read text, codex, notes, file names or keys | client-side AES-GCM; hashed paths; the KEK never leaves the device |
| Network attacker | see TLS metadata | read or alter content | HTTPS, HSTS; AEAD rejects tampering |
| Malicious served code | exfiltrate keys from the page | stay undetected for ever | hosted-only strict CSP, SRI, a published build hash, the desktop and mobile apps as non-web clients |
| Account takeover | sign in, delete or replace ciphertext | decrypt without the passphrase | a separate passphrase; 30-day soft delete and history; notice on a new device |
| Rolling back or replaying | serve older ciphertext | forge new content | version in the associated data; high-water marks (§7) |
| Relay operator | read relayed prompts and keys in transit | read stored projects | opt-in, no logging (§8) |

Limits that are stated, not hidden (SECURITY.md carries a pointer):

- **Web end-to-end encryption cannot stop a malicious bundle.** An operator who serves a backdoored script can read what the page can. The mitigations above shrink the window; they do not close it.
- **The server still sees metadata**: account email and OAuth identity, how many projects and blobs, padded sizes, timestamps, IPs and access patterns. A file's bucket is visible; its exact size is not. Blob names are random, but the number of writes is visible.
- **A fresh device has no rollback memory** until it has read the project once.
- **Argon2id cost** protects a weak passphrase only as far as the parameters allow.
- **An independent security review of the crypto and the hosted CSP and SRI is required before any launch.** These packages have not had one.

## 10. Gates

- **Funding.** An official instance is launched only with the owner's yes, a published storage cap, and the confirmed reading that a capacity cap is not a meter, gate or tier.
- **Owner-only calls**: backend vendor or self-host, EU region, the hosting bill and backups, OAuth client apps and an email sender, DNS and TLS for the domain, Impressum, GDPR privacy policy and a data processing agreement, the final Argon2id parameters, and the independent review.
- **Telemetry.** None on hosted either.

## 11. Phases

| Phase | Work | State |
|---|---|---|
| 0 | Owner decisions (§10); this spec; run and record the CORS sweep | spec written; decisions open |
| 1 | Auth and accounts; passphrase setup, recovery-key screen, unlock; account deletion; `.caotang` export; Argon2id adapter | not started |
| 2 | Encrypted storage: `packages/crypto`, `packages/remote-store`, a fake backend | **the two packages here**; no server, HTTP client or UI |
| 3 | Sync: batching, offline queue, device lease, conflict question, `coherence.json` merge, import and export between the browser store, bundles and hosted | waits on #11 and #12 |
| 4 | Relay (§8) | waits on the CORS sweep and its own decision |
| 5 | Hardening and launch: hosted CSP, SRI, build hash, review, deploy | not started |

Child issues for the owner to open, one per phase 1 to 5, linked from #17. The epic is closed only when the owner decides it is done.
