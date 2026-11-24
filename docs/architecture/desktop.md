# Caotang for desktop

The [development shell](../../apps/desktop-shell/README.md) in [epic #16](https://github.com/nattiini45/caotang/issues/16) hosts the existing root-base Vite build from `apps/desktop/dist/`. The browser site, project format, storage schema and Vite output stay unchanged. This spec records the feasibility spike (#398), the shell (#400), the unsigned packages (#401), native project folders (#402), the watcher (#403), the keychain (#404) and native provider calls (#405).
\nThe [development shell](../../apps/desktop-shell/README.md) in [epic #16](https://github.com/nattiini45/caotang/issues/16) hosts the existing root-base Vite build from `apps/desktop/dist/`. The browser site, project format, storage schema and Vite output stay unchanged. This spec records the feasibility spike (#398), the shell (#400), the unsigned packages (#401), native project folders (#402), the watcher (#403), the keychain (#404), native provider calls (#405) and the project's own MCP server (#406).

## Runtime and trust boundary

- Serve the build from the fixed origin `app://caotang/`; keep that origin stable because Chromium keys storage to it. Register the scheme before Electron is ready as standard, secure and Fetch/CORS-capable. Do not bypass CSP. Serve only built assets from a fixed directory, reject other hosts and paths outside that directory, and do not start a loopback server.
- The renderer is sandboxed and context-isolated, with Node integration off and Chromium web security on. It never navigates to remote pages or creates arbitrary windows. Serve a CSP header alongside the unchanged HTML meta policy: scripts, styles and Workers are same-origin; no inline script, eval, embedded frames, objects or form submission. Deny framing with `frame-ancestors 'none'` in the header, where Chromium enforces it. Renderer data requests remain subject to Chromium's network rules, except the provider and MCP calls the main process makes for it; keys and tokens live in the main process and the page never reads one.
- The typed preload bridge exposes `window.caotangDesktop.version`, the narrow folder calls below and the provider port below. There is no generic Electron or IPC API. Only the studio URL can receive Electron permission for sanitized clipboard writes. Other permission requests, including browser file handles, are denied. Packaged-binary fuses and ASAR integrity belong to #401, not the unpacked smoke launcher.
- Each Electron profile allows one instance. It restores the last normal window dimensions and maximized state, not the screen position, so changing monitors does not reopen the window off-screen.
- There is no shipped service worker in the web build. The custom scheme can support one, but the shell does not register one or enable that privilege until there is a worker to ship and its update/cache policy is specified.

## Spike results (Linux x64)

Built current main with `pnpm build`, then launched Electron **45.4.1** (Chromium **156.0.8078.100**, Node **24.22.3**) with Playwright `_electron` using `chromiumSandbox: true` under Xvfb. No application source or build output was modified.

| Surface | Observed result |
| --- | --- |
| App and lazy chunks | The writing studio rendered. Opening Settings loaded its production JS and CSS successfully. A `file://` control did not render: the existing absolute `/assets/` URLs resolved at the filesystem root. |
| Storage | A project created through the UI reappeared after terminating Electron and relaunching with the same `userData`. The app opened `caotang-app` and `caotang` in IndexedDB. A separate IDB round trip persisted; OPFS returned a directory handle and WebCrypto was available. The custom origin does not share a Chrome profile's storage. |
| Workers | The emitted import reader module Worker acknowledged opening a plain-text payload at its same-origin hashed asset URL. No blob URL or CSP exception was used. |
| CSP | Keeping the web meta policy and adding the shell header did not block the app or the lazy chunk. A test-only inline script was refused and emitted `securitypolicyviolation`. |
| Service worker | A test-only route on the privileged scheme registered a worker, took control of the page and served a synthetic Fetch response. No worker or cache was added to the web build or proposed for the shell. |
| Folder picker | `showDirectoryPicker({mode: 'readwrite'})` opened the native Linux chooser under user activation. The probe did not complete a selection or verify a write or reopen. Browser-style folder access is not evidence for the folder-first store in #402. |
| IME | A CDP composition of `ni` followed by a candidate commit produced exactly `你` in the New Project field. This is a one-field smoke, not an operating-system IME or the editor composition matrix. |

The initial probes reached the project picker in about **0.62–0.63 s** from Playwright launch on a fresh Linux profile. One near-start sample of the browser, renderer, GPU and utility processes totalled about **526 MiB RSS** (shared pages can be counted twice). Neither number is a pass against the epic's reference-machine gates: they do not use the reopened large fixture, the interactive performance mark, or proportional set size after ten minutes.

For the keychain follow-up (#404), [`@napi-rs/keyring` 2.1.2](https://www.npmjs.com/package/@napi-rs/keyring) (MIT, a Node-facing binding) and [`keyring` for Rust](https://github.com/open-source-cooperative/keyring-rs) (MIT OR Apache-2.0, needing a binding maintained here) were the candidates the spike named. #404 chose neither: Electron's own `safeStorage` seals a value through DPAPI, the login keychain, or libsecret/KWallet with no native module to build, package or unpack from the ASAR, and it reports the one Linux case that matters — Chromium's built-in `basic_text` key — so the app can fall back instead of calling obfuscation encryption. See §The keychain.

## Native project folders (#402)

An existing native project opens from its folder, including after a restart. The cache uses a separate IndexedDB database per opaque folder ID; it is seeded from disk on every open and does not replace the folder when it is missing or read-only. Manuscript edits still pass through the command bus. The folder is written before a save is reported and before the manuscript cache advances. External changes refuse a guarded save; live watching and reconcile offers are #403.

The main process grants access only through the native directory picker and remembers successful opens in its profile. The typed preload presents folder IDs and display names, never absolute paths. Artifact calls check the trusted main frame, the folder's identity, its permissions, and project-relative paths beneath the selected root. The Node adapter shared with the SDK performs same-directory temp writes, fsync and rename, and a rename that another program still holds after the retries is reported as access trouble ("could not access the project folder"), never as a read-only folder: the writability check has already passed. No project format changes.

An IndexedDB-only project stays available. **Copy to a folder** copies its portable project data into an explicitly chosen empty folder using a new project ID. It never modifies the original, searches browser profiles, or runs automatically. The site keeps using its original browser storage and folder picker.

## External folder changes (#403)

The main process watches the open native project folder and no other: one watcher per folder and window, with a separate subscription handed to each watch call on it so that a holder releasing late cannot stop the watch a later holder relies on; the watcher stops when the window goes or when the last of those subscriptions is released. It uses the prebuilt Parcel watcher (`@parcel/watcher`, external to the shell bundle, with its install script blocked so nothing is compiled); no Rust binding is introduced. Git metadata, `node_modules`, `exports/`, `.caotang-backup/`, the MCP lock and the `.<name>.<hex>.tmp` names an artifact write uses on its way to a rename are not watched. A Linux Electron 45.4.1 spike with 300 scene files measured a median 50.8 ms and a maximum of 51.7 ms across 20 atomic replacements, from write start to watcher delivery; the user-facing target is 500 ms under that load, which the shell suite asserts end to end from an external write to the renderer.

The preload delivers the folder id and project-relative paths, never bytes or absolute paths. The renderer waits 150 ms for a burst to settle, then compares the reported paths the open copy can judge — the manifest, whose text it keeps, and the project files whose digests it holds — against that copy. Every reported path is judged: the known ones are read in passes of forty, so a bulk edit of hundreds of files is read rather than cut off at the first pass, and the offer counts what changed. A first read that finds a difference waits for this session's own write into the folder to end and reads again against the copy that write left behind, so a save of this tab's own is never mistaken for another program's edit however long the project takes to write and re-digest. A file the folder no longer holds counts as changed. Files the copy does not hold — `coherence.json`, `tasks.json` and the pictures — are not judged here, so a change to one raises no offer.

A confirmed change raises an offer in the status line that names the changed files, and nothing is reloaded or merged by itself. **Reopen the folder's version** settles and closes the session, then opens the folder as it now stands; it is offered only when this tab has nothing unsaved, and otherwise the offer asks for **Export a backup** first, so a reload cannot drop the writer's words. An opening that needs an answer (a manifest that will not load, a copy that differs) is not decided here: the offer sends the writer to the projects list, where that question lives. This reopen and an opening asked for from the projects list take their turn from one queue, so an open already in flight finishes first and neither replaces the session the other put in front of the writer. The existing save guard stays in force — a save into a folder that changed is still refused and questioned. The browser build has neither a watcher nor native folders.

## Native provider calls (#405)

A provider request from the desktop app is made by the main process, so no CORS preflight applies: a preset that sends no
`Access-Control-Allow-Origin` answers the app where a browser could not read its answer, and Settings no longer carries a
browser's verdict for a preset the app can use. Nothing above the transport changed — the gateway already took an injectable
`FetchLike` (`createGateway({ fetch })`, provider-gateway §4), and the desktop app hands it a port instead of the page's
`fetch`.

**The port is not a general fetcher.** [`native-egress.ts`](../../packages/gateway/src/native-egress.ts) is the rule, with no
Electron and no network in it: https to an origin the app configured, never this computer, no credentials in the address, a
method a model call or a listing uses, at most 32 headers and 32 KiB of them, a 24 MiB request body, and a response counted
as it streams with a 64 MiB cap. A header that names the connection rather than the request (`host`, `content-length`,
`transfer-encoding` and the like) is refused, and a header value carrying a line break with it. A redirect is never followed:
the status goes back to the page, which already refuses a 3xx with what it means, because following one would make the
allowlist a starting point rather than a rule.

**The origins come from the app, read before each call.** The page publishes the origin of every provider profile from the
profile store at the moment of a request — not at start-up — so a profile saved a second ago is reachable on its first call.
A profile that does not parse, is not https, or is this computer contributes nothing; "this computer" is judged by text, so
`127.0.0.1`, `localhost`, `[::1]`, any `*.localhost` name and an IPv4-mapped spelling such as `[::ffff:127.0.0.1]` are all the
same machine. The local model presets therefore keep
the browser's path exactly as they are today: decisions.md keeps loopback out of the native port, so Ollama, LM Studio and
`llama-server` are called from the page, with the Local Network Access prompt and the product's own CORS advice. A connected
MCP server's URL joins the list when MCP calls move onto the port with the keychain (#404), not before.

**Streaming.** The reply to a call is its status, its reason and its headers; the body follows as chunks on one channel
keyed by the request's own id, so a model's server-sent events reach the page as they are written rather than after the
answer ends. The page rebuilds a `Response` from the head and the chunks, which is why the gateway's SSE parser, its retry
and its deadline code needed no change. A body that passes the cap, or breaks part-way, ends the call with that reason: the
page has the status already, so the end of the body is the only place a failure can still be said. A head that carries no
body — 204, 205 and 304 — is answered as the head alone, because a `Response` refuses a stream with those statuses and a
successful call must not turn into a failed one. A call the page stops is stopped in the main process too, and a window that
goes stops every call it started — as does a reload or a navigation of the studio's own frame, which leaves the page that
made them behind. Chunks and ends are keyed to the stream that is still in the map for their id, so a stopped call's
remaining body reaches nobody.

**What the page sees.** The preload bridge is version 3 and exposes `net` beside `folders`: `configure`, `start`, `abort`,
`onChunk`, `onEnd`. Every call is checked for the studio's own top frame at `app://caotang/`, so a child frame or another
origin cannot use the port. A request's shape is checked before any socket opens, and `invalid` covers what the network stack would otherwise refuse on
the way out: a header that names the connection, a body on a `GET`, a method the app never sends. A call stopped before it
started is not made at all, and one stopped while its head was still arriving is reported as `aborted` rather than as a dead
network. A refusal names its reason (`invalid`, `denied`, `too-large`, `unavailable`, `aborted`), and the
page turns it into the failure the gateway already knows how to explain, so a refused address reads as an address the app
does not connect to rather than as a dead network.

The rule is tested by the repository's gate
([`native-egress.test.ts`](../../packages/gateway/test/native-egress.test.ts)) and the port by a launched app
([`egress.spec.ts`](../../apps/desktop-shell/test/egress.spec.ts)), which configures one origin and proves every other
address is refused after it.

## The keychain (#404)

The desktop app keeps provider keys and MCP bearer tokens in the main process, sealed by the operating system's own store
through Electron's `safeStorage`: DPAPI on Windows, the login keychain on macOS, libsecret or KWallet on Linux. The vault is
one file in the app profile, `native-key-vault.json`, holding one sealed entry per key id — a profile id for a provider, an
`mcp:` reference for a server's token — written the way every other Caotang artifact is written
([`os-vault.ts`](../../packages/gateway/src/keys/os-vault.ts) is the vault, and the rule it keeps).

**The page may store, check, revise, restore and remove; it may never read.** The preload's `vault` channels are
`available`, `put`, `remove`, `has`, `revision`, `restore` and `headers` — there is no `read`, `get` or `reveal` among them, and
the shell suite asserts that list. A key is written by the form that took it; from then on the page learns only whether one is
there, which revision it is at, and the extra header values the writer typed beside it, never the key itself.

**A key reaches a request as a handle that becomes a secret.** The page's key store answers `reveal` with
`caotang-key:<id>`, and the adapter that knows a provider's protocol writes that handle where the key would go — in
`authorization`, in `x-api-key`, in a query parameter, wherever its own route puts it. When the call reaches the main process,
the handle is swapped for the secret from the keychain, but only for an address that key was configured for: a handle at any
other origin is refused as `denied` rather than sent. So a script in the page can use a stored key while the app is open, and
cannot take one away — which is the difference the browser vault cannot offer (provider-gateway §7).

**A provider that echoes a key cannot put one in the log.** The secret is attached in the main process, so the page's own
redaction, which scrubs the values it sent and it sent a handle, would not see it. The answer's bytes are scrubbed of every
secret attached to that call as they stream back, across chunk boundaries, before the page receives one.

**A failed replacement can be undone without a read.** `put` remembers the sealed value it replaced, and `restore` writes it
back, so the MCP client's "store the new token, then update the server, and put the old one back if that update is refused"
works with a store that cannot read: the undo is the vault's, not the page's.

**Migration writes, verifies, deletes.** On first open with a keychain, each key an earlier build sealed in this browser's
IndexedDB vault is opened by the store that already holds it, written to the keychain, read back by the main process before it
is reported stored, checked once more, and only then removed from the browser. An entry the browser's store cannot open is left
where it is. A machine where the move stops part-way keeps every key it did not move, and the app says so rather than opening
as though nothing were missing.

**Without a keychain the browser's vault stays, and says so.** `safeStorage` on Linux falls back to a built-in key that is the
same on every machine, which is obfuscation rather than encryption; the vault treats `basic_text` and `unknown` backends as no
keychain at all. There, the WebCrypto vault of provider-gateway §7 keeps the keys, and Settings says the keys are in this
browser rather than in the computer's keychain, as does the notice at start-up.

**An MCP server on this computer is the one local address the port reaches.** A bearer token held by the main process cannot be
attached by the page, so MCP HTTP goes through the same port; a server whose address is a loopback literal is the one entry
allowed plain http
([native-egress.ts](../../packages/gateway/src/native-egress.ts)). A provider profile is never such an entry, so a local model
server keeps the browser's path exactly as it was.

**The two calls answer different shapes.** On the pinned Electron, `safeStorage.encryptStringAsync` resolves the sealed bytes and
`decryptStringAsync` resolves a record whose `result` is the plain text; a host that unwraps one like the other stores a value its
own read-back cannot match. The seal and the open both live in `apps/desktop-shell/src/vault.mts`, behind one `Sealer` a spec can
replace, so the vault's put, read-back and read run on a machine with no keyring as well as on one with.

What is not verified here: `safeStorage` on a real Windows, macOS or KDE desktop. The vault's rules are tested with a scripted
sealer (`packages/gateway/test/os-vault.test.ts`), and the shell suite proves the channels the page gets; the Linux runner the
suite runs on has no keyring, so the fallback is the path it exercises. Signing and notarisation (#409) and the upgrade train
(#410) are unchanged.

## The project's own MCP server (#406)

The app serves the open project over MCP itself, so a host on this computer can read the manuscript without a terminal, a port
number or a token typed in by hand. It runs no new program: `dist/mcp/caotang-mcp.mjs` — the same bundle the `.mcpb` ships — is
forked as an Electron `utilityProcess` with `serve --project <folder> --port 0`, so the port is one the operating system picks and
one app has one server. `apps/desktop-shell/scripts/mcp-bundle.mjs` copies the built bundle into `dist/mcp/`, and the shell's build,
smoke test and package preparation all do that first, so the bundle travels beside the app rather than being installed.

**One server, one open folder, named by id.** The page asks for a folder **id**, never a path: `mcp:start` takes an id and a write
setting, and the shell resolves the id through the grant list every folder channel uses. A page cannot point this server at a
directory the writer never opened, and a folder the writer closed grants nothing new. The server's own login flow stays as it is:
it takes the folder's single-writer lock, refuses a folder another writer holds, and reads and writes through `@caotang/sdk`'s
folder session.

**Read-only until the writer says otherwise.** The app passes `--allow-writes` only when the **Allow changes** switch is on, which is
off by default, and the switch says what it means: a host may write the same files the writer does. Changing the setting restarts the
server, because the tools a server lists are fixed when it opens the project.

**The token is minted in the main process and handed to the page, once.** The app makes 192 bits of base64url for each start, sets
`CAOTANG_MCP_TOKEN` in the child's environment, and keeps the value in its own memory; the server prints everything else on stderr
and never prints a token it was given. The page receives the address and the token in the bridge — that is the one place a token
crosses into the page in this app — because the writer's next step is to copy both into another program's configuration. It is not a
provider key (keychain, #404), it is not written into a project, an export or a log, and it ends with the run. The page shows it
read-only with a copy button beside the address and a **Copy the configuration** button that copies the JSON an MCP host reads.

**Two writers, one pause.** The app and the server write the same folder, and the server's lock alone cannot make the app wait: it
holds the lock for its whole run, and the app saves many times while it does. So the app pauses the server for the length of a save.
`pauseProjectServer` posts `POST /control/pause` with the same bearer token before the first file the save writes and
`resumeProjectServer` posts `POST /control/resume` after the last, and the guard refuses a write tool while the pause stands, with a refusal that says the app is
saving and that a read is never refused. The endpoints exist on every HTTP server this package starts, including one a terminal
started, where nobody uses them; a server started without a gate answers `404` and says nothing coordinates a save with it.

What the pause does and does not guarantee: a write tool that has not started is refused rather than queued, so nothing lands after
the save; a write that is already running when the pause arrives finishes, and the app's digest check — the one `writeProject` makes
for each file before it replaces it, and `changedDuringSave` after — refuses that file and names it to the writer instead of replacing
it. That is "reported, not lost", the same guarantee the folder guard gives without a server. The pause is taken only for a save that
writes: a save the verdict refuses never reaches it.

**A pause that cannot be confirmed stops the save.** With a server holding this folder, a save whose pause did not answer takes the
folder's own lock refusal, so the writer is asked before anything is written and can save anyway. Without that, the save would run
while a server that may still accept writes holds the same folder, which is the one thing this pause exists to prevent; the digest
check would still catch a file it changed, but the promise is about what the server cannot start, not only about what it already did.

**The app's own server's lock is not another writer's.** The server holds `.caotang-mcp.lock` for its whole run, so the checks that
refuse a locked folder would otherwise refuse every save. Two places tell the app's own server from another program's by the process
the lock body records: the folder channel (`folders.mts`) compares the lock's pid with the pid of the child it forked, and the save's
verdict (`writeFolder` in `lifecycle.ts`) treats the lock as gone while that server is running over this very folder. A lock from a
server started in a terminal is another writer, and is still refused and still asked about. After the app's server has died, its pid is
no longer one the app forked, so a lock it left behind reads as another writer's and the writer is asked — the same question a crashed
server has always asked — and the server's own stale-lock takeover is what clears the file.

What is not verified here: the whole path has only been run on Linux x64 under Xvfb. `utilityProcess` forking a bundle that speaks
MCP over HTTP has not been seen on Windows or macOS, and the bridge's `clipboard-sanitized-write` permission, which the copy buttons
rely on, has not been checked on a real desktop either. A packaged app's `dist/mcp/` has been built and copied in CI, and no packaged
build has started a server. Windows and macOS path and code-signing behaviour for the child (`#401`, `#409`) is unchecked.

## Packaging (#401)

A release is a `desktop-v<version>` tag whose version equals `apps/desktop-shell/package.json`'s, built by
[`.github/workflows/desktop-release.yml`](../../.github/workflows/desktop-release.yml) on GitHub-hosted runners from that
commit. Electron-builder's configuration is [`apps/desktop-shell/electron-builder.yml`](../../apps/desktop-shell/electron-builder.yml)
and every package is **unsigned** for now: Windows x64 NSIS (`Caotang-Setup-<version>.exe`), macOS arm64 and x64 DMG
(`Caotang-<version>-<arch>.dmg`), and Linux x64 AppImage (`Caotang-<version>.AppImage`). Linux is best-effort and
non-blocking, as `docs/decisions.md` records. Each platform's job writes a `SHA256SUMS` file beside the packages it built, and
[`docs/INSTALL.md`](../INSTALL.md) gives plain install steps that name the SmartScreen and Gatekeeper warnings, because an
unsigned download shows one.

The Windows executable is `Caotang.exe` and not the product name, because `.signpath/artifact-configuration.xml` signs that
name and the packaged build keeps it; the installer embeds it and is packaged from the already-unpacked app
(`--prepackaged`), so the signing pass that returns a signed `Caotang.exe` is the one the release ships.

The packaged app is the same build the shell already hosts: `apps/desktop/dist` travels as `resources/desktop/dist`, which is
the directory `src/main.mts` resolves two levels above its own `dist/` (`app.asar/dist` once packaged), so the fixed origin,
the CSP header and the path checks are unchanged. Production dependencies are packed from `node_modules` and nothing is
rebuilt (`npmRebuild: false`): the folder watcher's prebuilt binary for the build's own platform is unpacked beside the
archive, because a native module cannot be loaded from inside an ASAR. Each macOS architecture is built on a runner of that
architecture, so the watcher's prebuilt binary matches the package.

Electron fuses are applied to the packaged binary: no `runAsNode`, no `NODE_OPTIONS`, no `--inspect`, no extra file-protocol
privileges, cookie encryption on, the app is loaded only from `app.asar`, and that archive is validated against integrity data
written into the executable, so a modified archive refuses to start. Electron's own `LICENSES.chromium.html` and
`LICENSE.electron.txt` ship in the package root, and the studio's `THIRD-PARTY-NOTICES.md` ships in
`resources/desktop/dist`, which the app serves at `app://caotang/THIRD-PARTY-NOTICES.md`.

Each build leg runs the repository's gate (`pnpm verify`) for the commit it packages, the same gate
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs, so a released commit is never gated by less than a merged one. The
Windows leg leaves out the seven `packages/sync-server/test` suites whose cases run through a Worker runtime — `account-mode`,
`storage`, `server`, `quota`, `accounts`, `project-lease` and `project-records` — with `CAOTANG_SKIP_WORKER_SUITES=1`, exactly as
ci.yml's `verify (Windows)` job does while #815 moves those files onto one shared runtime and #820 tracks the later ones.

That ci.yml job and this Windows leg gate different moments: `verify (Windows)` runs on a push to main, on the nightly schedule and on
demand, and on no pull request, so a red Windows run reports on main without blocking a contributor whose change has nothing to do
with that runner; here it runs again for the commit being packaged, so a red suite stops a release. A red run away from a pull request
opens or updates one tracker issue named for the state, because nobody is watching a schedule.

The job that builds packages also runs on `workflow_dispatch`, so the packaging can be proved without releasing anything: a
dispatch publishes nothing and only leaves the packages and their checksums as workflow artifacts.
