# Hosted instance — end-to-end encrypted projects

> Status: **the storage core, the account-key layer and the app's open and save path are built.** `caotang.app` stays local-only and unchanged: no accounts, no server calls, the same CSP. The key hierarchy and sealing, the account-key orchestration (setup, unlock, recovery, passphrase rotation), the Argon2id adapter, remember-device and the provider-key vault seam ([`packages/crypto`](../../packages/crypto), §2–§4, §7), the encrypted adapter, the batched save, the offline queue, the HTTP blob client ([`packages/remote-store`](../../packages/remote-store), §5–§7) and a project's record and registry are built and tested, and the standalone server implements the blob service on R2 ([sync-server.md](sync-server.md#encrypted-object-storage)). The app opens a project a host hands it from that adapter, saves it back to the account, and asks the "files changed" question when another device got there first (§7, §11); the adapter is behind the host seam and reaches the app's graph only through it, so the folder app's bundle, CSP and network behaviour are unchanged. The sign-in interface, the unlock screens, the app's own offline queue and high-water marks, the device lease in the interface, the `coherence.json` merge and the relay are not built. The epic is #17.

## 1. Scope

An optional hosted instance of Caotang that lets a writer reach one project from several machines. The project format does not change: the hosted store is one more `ArtifactFs` ([project-format.md §1, §4](project-format.md)), so everything above the port (the store's read and write, the bus, the exporter) runs on it as it does on a folder.

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
                                              │               │ HKDF-SHA-256, distinct info labels
                                              │               ├─ file key      (per file, info = label ‖ pathHash)
                                              │               ├─ path-HMAC key
                                              │               └─ manifest key
                                              └─ HKDF-SHA-256 ──> vault key (provider-key sync, P9; its own slice)
```

| Key | Made by | Held | Role |
|---|---|---|---|
| KEK | Argon2id over the NFKC-normalised passphrase and a per-account salt (at least 16 bytes) | memory only, while unlocked | wraps the MK |
| MK | 256 random bits, once per account | wrapped under the KEK on the server; encoded as the recovery key (§4); optionally wrapped under a device key (§2.3) | wraps each PK |
| PK | 256 random bits, once per project | wrapped under the MK on the server, bound to the project id | root of that project's keys |
| file, path, name, manifest keys | HKDF-SHA-256 of the PK, empty salt | derived on demand | one purpose each |
| vault key | HKDF-SHA-256 of the MK, empty salt, info `caotang/v1/vault-key` | derived on demand | seals the provider-key vault (P9); the sync is its own slice |

- **Argon2id** is `m = 64 MiB, t = 3, p = 1`. These are **provisional** until measured on low-end phones. The hash sits behind an injectable `Kdf` port (`derive(passphrase, salt)`); the adapter is `argon2id.ts`, which loads `hash-wasm` (pinned to an exact version) lazily, so the WASM enters only on setup, unlock and recovery and never the first-load bundle. The algorithm and its parameters travel with the wrapped key (§2.1), so raising the cost later never strands an existing account. Parameters read from a record are bounded — memory at most 256 MiB (four times the default), iterations at most 10, parallelism at most 4, and memory at least 8 KiB for each lane — so a tampered descriptor cannot exhaust the unlocking client or name an invalid configuration; the default sits well inside the ceiling.
- **Wrapping** is AES-256-GCM with a random 96-bit nonce. Associated data is a label: `caotang/v1/wrap/master`, and `caotang/v1/wrap/project` ‖ NUL ‖ projectId, so a project's wrapped key cannot stand in for another's.
- **Info labels** are `caotang/v1/file-key`, `caotang/v1/path-hmac-key`, `caotang/v1/manifest-key`, `caotang/v1/name-key` and `caotang/v1/vault-key`; a file key's info is its label ‖ NUL ‖ the file's path hash. No two purposes can derive the same key, and the vault key is derived from the MK, never the PK.
- **The project key crosses as a non-extractable key.** A host that has unwrapped a project key imports it once (`importProjectKey`) and hands the studio frame that, never its bytes: the frame derives every file, path, manifest and name key it needs from it, and `crypto.subtle.exportKey` on what it holds throws. So a compromise of the frame's script yields that session's file access, not a key that opens the project's store afterwards — the same limit the provider-key vault's key has (§2.5).
- Only WebCrypto is used for the primitives: AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256, SHA-256. Argon2id is the one step WebCrypto does not provide, and it is the lazily loaded WASM above. The key type prints as its role, so a logged key shows no bytes, and no key enters a project, bundle, export or log.

### 2.1 The account record

What the server stores beside the account is an `AccountKeyRecord`: `{ format: 2, accountId, kdf: { id, params }, salt, wrappedMaster, verifier }`, where `salt`, `wrappedMaster` and `verifier` are base64. A record whose master-key rotation is not finished carries one more field — `format: 3` with `retired`, the master key the rotation replaces sealed under the new one (§2.2) — so a replacement is either a finished record or a rotation in progress, and never anything else. `kdf.id` names the algorithm (`argon2id`) and `kdf.params` its cost (`memoryKiB`, `iterations`, `parallelism`); an unlock rebuilds the KDF from this descriptor, so an account set up at one cost still unlocks after the default rises. `wrappedMaster` is the MK sealed under the KEK (§2), with the account id in its associated data, so a record served to another account does not open even when the two accounts share a passphrase. `verifier` is 32 bytes: HMAC-SHA-256 under the MK of the label `caotang/v1/account-verify` and the account id, which the recovery path checks before it accepts a printed key — a recovery key from another account is refused instead of unlocking a session that could never open this account's vault. The record holds no plaintext key. Signing in proves identity to the server and never derives a key; setup, unlock, recovery and passphrase rotation are the orchestration in `account.ts`.

`format: 1` records — no account binding, no verifier — are still readable, so nothing needs a migration; they open with the one-argument label as before, and the next passphrase change or rotation rewrites them as format 2. Until then their recovery path has no verifier to check against, which is the residual risk the earlier format carried.

The [account-mode server](sync-server.md#wrapped-account-key-records) lets an authenticated device read this record or create it exactly once, and refuses a format-2 record whose `accountId` is not the account that sent it. The client acknowledges the printable recovery key before submitting the wrapped record. It sends neither the passphrase nor the recovery key. Concurrent setup on another device returns a conflict and the first committed record remains authoritative. A passphrase change re-wraps the same master key under a fresh salt and replaces the record under its version (§2.1), and says in the interface that it does not sign a remembered device out and does not invalidate a printed recovery key: the master key is the recovery key and every project key derives from it, so only a rotation that generates a new master key revokes anything, and that is its own operation.

### 2.2 Changing the passphrase, and rotating the master key

Two operations touch the account's keys and they guarantee different things, so the interface names them separately.

**Changing the passphrase** derives a new KEK from a fresh salt, re-wraps the **same** MK (optionally at a new KDF cost) and replaces the record under its version (§2.1). Nothing else moves: every project key and every sealed byte stays valid, no file is rewritten, a device that already remembers the MK stays unlocked, and a printed recovery key — which *is* the MK (§4) — still opens the account. The dialog states all of that rather than leaving it to be assumed.

A passphrase change is **refused while a rotation is waiting to be finished**. The plain record it writes carries no retired key, and until the rotation's last write the account's vault is still sealed under that key, so a change allowed there would drop the only stored path to it and make the interruption permanent. The refusal says which operation to finish first; finishing the rotation and changing the passphrase afterwards is the supported order.

**Rotating the master key** — *Revoke other devices and the old recovery key* — replaces the MK itself:

1. A new MK is generated and the record is rewritten under a fresh KEK derived from the **same passphrase**, carrying the new MK's verifier. So a rotation revokes the *key*, not the passphrase: a device that knows the passphrase unlocks again, while a device that had remembered the retired MK, and any printed recovery key, stop opening what the account holds.
2. Every project key is unwrapped under the retired MK and re-wrapped under the new one. The project keys are unchanged, so nothing they sealed is re-encrypted and no manuscript moves. A project's record — its name, §5 — is sealed under the project key, so re-wrapping leaves every name readable and a rotation rewrites no record.
3. The provider-key vault is re-sealed under the vault key of the new MK (§2.5).
4. The new recovery key is shown once, **before** the record is stored, and acknowledged.

The record in the middle of the operation is format 3: it opens with the **new** MK and carries the retired one sealed under it with associated data `caotang/v1/rotate/retired` ‖ account id. That single field is what makes the operation crash-safe; the steps are ordered so that every interruption is recoverable.

| Interrupted | What is stored | How it finishes |
|---|---|---|
| before the record is replaced | nothing changed | the old passphrase, the old recovery key and every remembered device still work |
| after the record, before the vault | format 3; the vault still sealed under the retired key | anyone who can open the record — with the passphrase, on any device — unseals the retired MK from it, re-seals the vault under the new MK's key, then writes the format-2 record |
| after the vault, before the last write | format 3; the vault already sealed under the new key | the same step finds the vault already opens with the new key, writes nothing there, and writes the format-2 record |

A re-seal that finds the vault already current does nothing, so that step is idempotent: two devices resuming the same rotation do not fight, and neither can produce a vault sealed half under one key and half under the other. The last write is the point of no return — after it, nothing the server holds opens with the retired MK.

The window in between is stated rather than hidden: while the record is format 3, the retired MK is reachable from it by anyone who can open it, which is exactly what lets an interrupted rotation finish. Nothing else in the account is more exposed than it was before the rotation started.

**What a rotation cannot revoke.** Text a device has already opened stays readable to it, and a project key it has cached still opens the files sealed under that key until the project's own key is rotated — content is revoked by re-keying the thing that seals it, not by moving the account's key. The same limit applies to any copy of a retired wrap that outlives its replacement: an older server-side version of a wrapped project key, or a retained copy of a vault, still opens with the retired MK, so the store that keeps those versions has to purge them as part of the rotation. No project-key record exists on the server yet (§5 is where the encrypted project store lands), so the reference wiring re-wraps none today; `rewrapProjectKeys` in `packages/crypto` is the seam that store has to call.

### 2.3 Remember this device

After the first passphrase unlock the device may wrap the MK under a fresh **non-extractable** AES-256-GCM key it keeps locally (the browser binds the `DeviceWrapStore` port to IndexedDB), so the passphrase is needed once per device. The wrapped form is `nonce(12) ‖ ciphertext ‖ tag(16)` with associated data `caotang/v1/remember-device`. The wrapping key never leaves the device as bytes; script in the page can use it while the app is open, the same limit as the provider-key vault (§9). `forgetDevice` removes it and the next unlock needs the passphrase again. Signing out everywhere revokes the session.

### 2.4 The provider-key vault seam

The vault key is HKDF-SHA-256 of the MK under `caotang/v1/vault-key`, a label no project subkey uses. Encrypted provider-key sync (P9) is its own slice; this slice ships only the derivation, so the vault has a key to seal under that cannot collide with a file, path or manifest key.

### 2.5 The sealed provider-key vault

Provider keys and the profiles they belong to are sealed into **one vault object per account**, outside project files, exports and bundles. MCP bearer tokens and server configuration are excluded pending their own decision.

The vault is sealed twice, because there are two different mistakes to catch:

- **Each profile's entry** is sealed under the vault key with associated data `caotang/v1/vault-entry` NUL account NUL profile id NUL endpoint origin. A key therefore cannot be read as another profile's, or as the same provider at another address.
- **The vault itself** is sealed with associated data `caotang/v1/vault` NUL account NUL version, where the version is the one the server holds. A vault replayed from an older version, or moved to another account, does not open.

Both use format byte `0x02`, so a vault value is refused by the file and manifest readers and the reverse. The server sees one opaque object and cannot tell which profiles exist.

What the outer seal wraps is the **container**: UTF-8 JSON `{"v": 1, "entries": [{"profileId": "<id>", "sealed": "<base64>"}]}`, one entry per profile whose key this account syncs, each `sealed` being that profile's entry seal. The version field is the container's own, so a reader refuses a layout it does not know instead of opening one of its entries on a guess, and a repeated profile id inside one container is refused. A profile the reader no longer has, or one whose endpoint origin changed, is left out of what it restores rather than failing the whole vault.

The vault key can be derived once and imported as a **non-extractable AES-GCM `CryptoKey`**: a host that holds the master key hands the import to the code that seals and opens the vault — inside the studio frame, which is where provider keys are saved — so that code never holds the master key or the vault key's bytes, and `crypto.subtle.exportKey` on the key it does hold throws.

The wire form is `{version, vault}`, the vault being base64 of the sealed object. The version is the server's own counter: a client seals at `version + 1` and commits with `If-Match` of the version it read, so the first commit wins and the later device is told to re-read. Before a first commit the route answers `404` with the version to seal at, and a create names that version in `X-Caotang-Vault-Version`, so the server can store exactly the version the ciphertext was sealed under — otherwise a vault committed after a removal would be stored at a version no client had sealed at and could never be opened. The counter outlives the vault it counts, so removing the vault and committing a new one continues the sequence; a precondition held from before a removal is refused instead of overwriting the replacement, which is what keeps a device's high-water mark meaningful across that removal. Each device keeps a high-water mark for the vault (`HighWaterMarks`), so an object below its mark is refused as a rollback rather than opened. A device that opts out of syncing writes no vault at all and keeps its own copy locally; **remove synced keys** deletes the account vault and advises rotating the keys at the providers.

The studio app reaches that vault through its host seam (`studio-host.ts`): a host is told when a provider key is sealed or removed, and can supply keys this device has none for, which are installed before the stored profiles are read so a profile whose key lives on the account opens instead of being reported as missing. Installing what the host supplies is not reported back to it as a change.

A write that loses the race re-reads, re-seals the profiles it changed onto the version it found, and retries once; a second loss surfaces as a conflict the writer is told about, with the profiles that changed named. Re-sealing never rewrites a profile the device did not change.

### 2.6 Account-scoped studio storage

The frame is one origin serving several accounts, so everything the studio opens for itself is named per account. The shell names the account before the frame boots (`setStorageScope`, `apps/desktop/src/app/storage-scope.ts`), and each name carries it: the app database (`caotang-app--<account>`), the provider key vault (`caotang-provider-keys--<account>`), the runtime store (`caotang--<account>`), each folder's native store (`caotang-native-<folder>--<account>`), the image database (`caotang-assets--<account>`), and the two journal namespaces that hold words a page has not saved yet (`caotang.pending.<project>--<account>`, `caotang.unsent.<project>--<account>`). With no scope — the folder app, which has one writer at its origin — the names are exactly the fixed ones the specs give, so a writer's existing data keeps opening; nothing is renamed for the folder app.

A second account on one browser therefore opens empty stores rather than the first account's projects, settings, images and provider keys, and the first account's local work is left where it is rather than cleared. The journals are named too because two accounts can hold the *same* project id — the same bundle imported into both — and a journal keyed only by project id would hand one account's unsaved words to the other. Storage written before this rule existed is not adopted by any account: the hosted instance had not shipped when the rule was introduced, so nothing was left behind in the unscoped names. Preferences the shell keeps for itself (interface language, the shell's own appearance) stay per browser, as the sign-in page's, and hold no project content.

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

There is **no escrow**. If the passphrase and the recovery key are both lost, the data is lost, and the sign-up screen says that in those words. Changing the passphrase re-wraps the MK and rewrites no project file, so the printed key keeps working; rotating the master key (§2.2) generates a new MK, so it is shown again and the old printed key stops opening the account at that rotation's last write.

## 5. The encrypted index and versions

`ArtifactFs` stays **unchanged**. Two things it cannot carry are kept by the adapter ([`EncryptedRemoteArtifactFs`](../../packages/remote-store/src/encrypted-remote-fs.ts)): a version on a write (`writeAtomic` has no parameter for one), and a listing (`listFiles` and `listDirs` cannot ask a server that only knows hashed names).

- **Each file is a blob written once**, under a random name, and never replaced. A write creates a new blob; the old one is soft-deleted after the commit.
- **One `manifest` blob** is the index. On the wire it is an 8-byte big-endian counter ‖ the sealed JSON. The counter is read first because it is part of the associated data, and it rises by one on every commit. The JSON lists, for every path, `[path, pathHash, version, blobName, deleted]`, and the explicit directories. A removed file stays as a tombstone with its version raised, so its mark still means something. `listFiles`, `listDirs` and `exists` answer from the index; a directory that holds a file exists without `ensureDir`, as it does on a folder.
- **A write** (a) seals the content at `version + 1`, (b) puts the blob with `If-None-Match: *`, then (c) puts the new manifest with `If-Match` of the manifest it read. (c) is the commit. A write that fails before (c) leaves an unreferenced blob that is never read and that the server's quota sweep clears.
- **A project save is one batch and one commit.** `commitChanges` seals every file of the save at its path's next version, puts each blob, then swaps the manifest once, so a forty-file save moves the index once instead of forty times and a refused save leaves the index exactly as it was. A 412 on the swap is not automatically a conflict: the index is read again, and when none of the save's own paths moved, the batch is rebuilt on the other device's state and retried, so two devices saving different files both keep their work. When one of them did move, the write stops with `RemoteConflictError` naming **every** path of the save that changed elsewhere (§7). A directory creation merges the same way, because the index only ever adds directories. Directories named with the batch (`options.dirs`) ride in that same swap, so a save that creates `assets/` or `exports/` costs one commit and not one more. The store's own write path writes a project file by file, so `BatchedSave` binds the adapter for the length of one save: it holds the writes, deletions and directories, answers a read from what it has staged, and sends them as that one commit.
- **Reads** serve the index as of the last open, refresh or commit. They do not poll. A read whose blob is gone asks the server for the index: if it moved on, another device replaced the file and the read raises the conflict error; if not, the server lost the file and the read raises an integrity error.
- **One writer at a time per device**: mutations run in a queue, each one reading, changing and swapping the index.
- **Paths** are checked as `MemoryArtifactFs` checks them (project-relative, no `..`). The same contract suite runs against both bindings.

### The project record and the account's registry

A server that only knows hashed names cannot tell a device which projects an account has, and a device cannot open one until it has that project's key. Both travel as one row per project on the server:

- **The wrapper** is the project key sealed under the master key (§2), bound to the project id, so a key recorded for one project cannot stand in for another's.
- **The record** is the project's name, sealed under a key of that project's own (`caotang/v1/name-key`), with the account and the project id as associated data, so a record moved to another project or account does not open. It is sealed under the project key rather than the master key deliberately: a master-key rotation re-wraps the project key, so every name stays readable without rewriting a record (§2.2).
- **On the wire** both are opaque base64, the wrapper 61 bytes and the record at most 1,024, which is a 200-character name. The server parses neither and can read neither; the project id is the only thing it sees in the clear, and that is random.
- **A second device** lists the account's projects, unwraps each project key under the master key, opens each record to show its name, and opens the one the writer picks through the adapter above. Nothing else about the project travels this way.
- **Registering** a project is a write of its row, and replacing that row is what a rename is: a label, not content, so the last write wins. Manuscripts never travel this route; their edits go through the blob service, where the index precondition makes an overwrite impossible (§7).

What this package does not do yet: the app does not import it (§11 has the wiring), the device lease and the conflict question are Phase 3 (§7), and the server's collection of retained versions is its own slice. The offline queue is built beside the adapter (`pending-edits.ts`, §7); the record and its registry routes are `packages/crypto/src/project-record.ts`, `packages/sync-server/src/project-records.ts` and `packages/remote-store/src/http-project-records.ts`.

## 6. The blob service

The server is backend-neutral: a small HTTP service that stores opaque bytes under opaque names, for one project at a time. Anyone can run it; the official instance is one deployment of it.

| Request | Meaning | Answers |
|---|---|---|
| `GET /v1/projects/{id}/blobs/{name}` | the live object | `200` bytes and `ETag`; `404` when absent or soft-deleted |
| `PUT /v1/projects/{id}/blobs/{name}` | `If-None-Match: *` creates; `If-Match: "<etag>"` replaces that version only | `200`/`201` and `ETag`; `412` when the precondition fails (nothing written); `507` over the account's storage cap |
| `DELETE /v1/projects/{id}/blobs/{name}` | soft delete | `204`; the bytes are retained and stay charged until retention collection lands |
| `GET /v1/projects/{id}/blobs` | live names | `200` JSON `[{name, etag, size}]` |

- A name is lower-case letters, digits and `-`, at most 64 characters. The index is always `manifest`. The body is non-empty `application/octet-stream` with a truthful `Content-Length`, at most 64 MiB, and is never parsed; each version is charged at least 285 bytes, the smallest sealed object, so the allowance also bounds the object count.
- A write may carry an `Idempotency-Key` (at most 120 letters, digits, `-` and `_`), bound to the project id, the object name and a SHA-256 fingerprint of the payload; a retry under the same key replays the committed ETag without a second charge, and a key reused for a different upload or already settled is refused with `409`. Missing or malformed preconditions are `400`, a missing `Content-Length` is `411`, an oversized body is `413`, and an unavailable store is `503`.
- The server keeps every replaced and soft-deleted version, and keeps charging for it, so an older index can be recovered by hand. Thinning and purging retained versions (every version for 24 hours, then one per day to 30 days) need a collection pass with a reachability proof and a committed-bytes release; that is a later slice, and until it lands an account at its cap is refused with `507`.
- It logs only what operation and abuse prevention strictly need: no content, no names beyond the request line, short retention. No telemetry, no analytics.
- Authentication (email link, Google, GitHub; `HttpOnly`, `Secure`, `SameSite=Lax` cookies, CSRF protection on mutating routes) decides who may call these routes. It never derives a key.

In code, `RemoteBlobStore` (`get`, `put` with a precondition, `delete`, `list`) is this contract, and `createHttpBlobStore` in [`packages/remote-store`](../../packages/remote-store/src/http-blob-store.ts) is its HTTP client: same-origin session cookies, one idempotency key per logical write across bounded retries, and typed errors for a lost race (`BlobPreconditionFailedError`), an exhausted allowance (`RemoteQuotaExceededError`) and an unreachable server (`RemoteUnavailableError`). The contract's test double, a `FakeBlobServer` with ETags, 412, soft delete, an offline switch and a `dump()` of every version ever kept, lives in the package's tests. The R2-backed service itself is specified and built in [sync-server.md](sync-server.md#encrypted-object-storage).

## 7. Sync, conflicts and rollback

- **A 412 on a file this device's save touches is the "files changed" question.** The adapter raises `RemoteConflictError` naming every such path; nothing was overwritten. The app asks the question the folder save already asks when a file changed under it ([`FolderDriftError`](../../packages/store/src/write.ts) stops and names the file), and the writer chooses. A 412 caused only by files the save does not touch is merged instead, so a writer is never asked about a file nobody else edited. The adapter never refreshes or merges *the same* file by itself; after the refusal `refresh()` reads what the other device did, "keep mine" saves again on top of it, and "take theirs" drops those paths from the queue.
- **Offline**: a write with no server rejects with `RemoteUnavailableError` and changes nothing. A save made then is held in the device's queue (`PendingEdits`): the last state of each path, staged before the attempt, sent in one commit when the server answers again. A conflict keeps the whole queue until the writer answers, so nothing queued is lost; the queue is plain data and survives a reload in the device store. A save made in the same session is not queued once it has committed. The queue is settled per path rather than cleared: a path forgotten only where it still holds exactly what the commit carried, so an edit staged while that commit was in flight is newer than what the server took and stays queued for the next replay.
- **Device lease**: one device edits a project and the others read it. The lease is soft: the editing device renews a heartbeat every 20 seconds and the lease lapses 60 seconds after the last one, so a closed tab, a lost network or a crash frees the project without anyone clearing a lock. While it is live the server refuses a blob write from another device (`423`) and a write that names no device at all (`428`), so the second device is read-only in fact and not only in the interface; its reads keep working. Any device may take it over, but only when the writer says so — the interface offers it as "edit here instead" — so two people cannot silently overwrite each other while both believe they hold the project. The device names itself with a label it draws once per session; the label authorizes nothing, the account still comes from the session, and one device never learns another's label. A client that takes no lease at all is unaffected, which is what keeps a script or the desktop's own path working.
- **`sessions.jsonl`** keeps its append-merge. **`coherence.json`** merges as derived state under the rule decided for the MCP server's `coherence.json` (#11) and the conflict question (#12). Phase 3 waits on those.
- **Rollback.** A server can serve an old, correctly sealed value. Each device keeps a high-water mark per file (keyed by path hash) and for the index (`HighWaterMarks`), raised on every read and commit and persisted by the app. Opening or refreshing an index below its mark, an index that lists a file below its mark, or no index after one was seen raises `RollbackError`. A stale blob served under a current name fails to authenticate. A device with no marks (a first sign-in on a new machine) trusts the first state it meets; that is a limit (§9).

## 8. Provider relay — deferred

Not specified for build. A relay would let a browser reach a provider that blocks CORS. Whether it is built waits for the CORS sweep to be run and recorded (today 2 `ok` — Anthropic and the mock —, 24 `unknown`, 1 `blocked` — OpenCode, whose chat route refuses the browser preflight; the desktop app already reaches blocked providers). If it is built:

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
- **Remember this device trades the passphrase for the device.** A device that remembered the MK (§2.3) unlocks without the passphrase until it is forgotten. The wrapping key is non-extractable but usable by script in the page while the app is open, so anyone who can run code in that browser profile can use it; it is opt-in per device, and signing out everywhere revokes the session.
- **Rotating the master key revokes a key, not what a device already has.** A rotation (§2.2) makes the retired MK open nothing the account holds: the vault is re-sealed under the new key and the account's record no longer wraps the old one. It cannot reach text a device already decrypted, a project key it cached, or a copy of a retired wrap the server still retains — those are revoked by re-keying the thing that seals them, at the level that owns it.
- **A rotation keeps the passphrase.** So a device that knows the passphrase can unlock again after a rotation, and the operation is about the key, not about who knows the words. What it ends is access through the retired MK: a remembered device, and any printed recovery key, stop opening the account.
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
| 1 | Auth and accounts; passphrase setup, recovery-key screen, unlock; account deletion; `.caotang` export; Argon2id adapter | Argon2id adapter and account-key orchestration built; auth and the screens not started |
| 2 | Encrypted storage: `packages/crypto`, `packages/remote-store`, a fake backend | **the two packages here**, with the account-key layer, the HTTP client and the standalone server; the app does not import them |
| 3 | Sync: batching, offline queue, device lease, conflict question, `coherence.json` merge, import and export between the browser store, bundles and hosted | the batched save, the offline queue and the device lease are built in `packages/remote-store` and `packages/sync-server`, a project's record is sealed and registered (crypto, server routes, client), and the app opens a hosted project from the adapter, saves it back and asks the conflict question; the app's own queue and high-water marks, the lease in the interface, the `coherence.json` merge and the import and export between the sources follow |
| 4 | Relay (§8) | waits on the CORS sweep and its own decision |
| 5 | Hardening and launch: hosted CSP, SRI, build hash, review, deploy | not started |

Child issues for the owner to open, one per phase 1 to 5, linked from #17. The epic is closed only when the owner decides it is done.
