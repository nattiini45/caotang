# Caotang for desktop

The [development shell](../../apps/desktop-shell/README.md) in [epic #16](https://github.com/nattiini45/caotang/issues/16) hosts the existing root-base Vite build from `apps/desktop/dist/`. The browser site, project format, storage schema and Vite output stay unchanged. This spec records the feasibility spike (#398), the shell (#400) and the unsigned packages (#401).

## Runtime and trust boundary

- Serve the build from the fixed origin `app://caotang/`; keep that origin stable because Chromium keys storage to it. Register the scheme before Electron is ready as standard, secure and Fetch/CORS-capable. Do not bypass CSP. Serve only built assets from a fixed directory, reject other hosts and paths outside that directory, and do not start a loopback server.
- The renderer is sandboxed and context-isolated, with Node integration off and Chromium web security on. It never navigates to remote pages or creates arbitrary windows. Serve a CSP header alongside the unchanged HTML meta policy: scripts, styles and Workers are same-origin; no inline script, eval, embedded frames, objects or form submission. Deny framing with `frame-ancestors 'none'` in the header, where Chromium enforces it. Renderer data requests remain subject to Chromium's network rules; a native network proxy, filesystem and keychain are not part of the shell.
- The typed preload bridge exposes `window.caotangDesktop.version` and the narrow folder calls below. There is no generic Electron or IPC API. Only the studio URL can receive Electron permission for sanitized clipboard writes. Other permission requests, including browser file handles, are denied. Packaged-binary fuses and ASAR integrity belong to #401, not the unpacked smoke launcher.
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

For the keychain follow-up (#404), [`@napi-rs/keyring` 2.1.2](https://www.npmjs.com/package/@napi-rs/keyring) is MIT and offers a Node-facing binding, while [`keyring` for Rust](https://github.com/open-source-cooperative/keyring-rs) is MIT OR Apache-2.0 and would require a binding maintained here. Both repositories showed recent activity at the time of the spike. Neither was installed or tested; verify packaged binaries and keychain behaviour on target platforms before choosing.

## Native project folders (#402)

An existing native project opens from its folder, including after a restart. The cache uses a separate IndexedDB database per opaque folder ID; it is seeded from disk on every open and does not replace the folder when it is missing or read-only. Manuscript edits still pass through the command bus. The folder is written before a save is reported and before the manuscript cache advances. External changes refuse a guarded save; live watching and reconcile offers are #403.

The main process grants access only through the native directory picker and remembers successful opens in its profile. The typed preload presents folder IDs and display names, never absolute paths. Artifact calls check the trusted main frame, the folder's identity, its permissions, and project-relative paths beneath the selected root. The Node adapter shared with the SDK performs same-directory temp writes, fsync and rename, and a rename that another program still holds after the retries is reported as access trouble ("could not access the project folder"), never as a read-only folder: the writability check has already passed. No project format changes.

An IndexedDB-only project stays available. **Copy to a folder** copies its portable project data into an explicitly chosen empty folder using a new project ID. It never modifies the original, searches browser profiles, or runs automatically. The site keeps using its original browser storage and folder picker.

## External folder changes (#403)

The main process watches the open native project folder and no other: one watcher per folder and window, with a separate subscription handed to each watch call on it so that a holder releasing late cannot stop the watch a later holder relies on; the watcher stops when the window goes or when the last of those subscriptions is released. It uses the prebuilt Parcel watcher (`@parcel/watcher`, external to the shell bundle, with its install script blocked so nothing is compiled); no Rust binding is introduced. Git metadata, `node_modules`, `exports/`, `.caotang-backup/`, the MCP lock and the `.<name>.<hex>.tmp` names an artifact write uses on its way to a rename are not watched. A Linux Electron 45.4.1 spike with 300 scene files measured a median 50.8 ms and a maximum of 51.7 ms across 20 atomic replacements, from write start to watcher delivery; the user-facing target is 500 ms under that load, which the shell suite asserts end to end from an external write to the renderer.

The preload delivers the folder id and project-relative paths, never bytes or absolute paths. The renderer waits 150 ms for a burst to settle, then compares the reported paths the open copy can judge — the manifest, whose text it keeps, and the project files whose digests it holds — against that copy. Every reported path is judged: the known ones are read in passes of forty, so a bulk edit of hundreds of files is read rather than cut off at the first pass, and the offer counts what changed. A first read that finds a difference waits for this session's own write into the folder to end and reads again against the copy that write left behind, so a save of this tab's own is never mistaken for another program's edit however long the project takes to write and re-digest. A file the folder no longer holds counts as changed. Files the copy does not hold — `coherence.json`, `tasks.json` and the pictures — are not judged here, so a change to one raises no offer.

A confirmed change raises an offer in the status line that names the changed files, and nothing is reloaded or merged by itself. **Reopen the folder's version** settles and closes the session, then opens the folder as it now stands; it is offered only when this tab has nothing unsaved, and otherwise the offer asks for **Export a backup** first, so a reload cannot drop the writer's words. An opening that needs an answer (a manifest that will not load, a copy that differs) is not decided here: the offer sends the writer to the projects list, where that question lives. This reopen and an opening asked for from the projects list take their turn from one queue, so an open already in flight finishes first and neither replaces the session the other put in front of the writer. The existing save guard stays in force — a save into a folder that changed is still refused and questioned. The browser build has neither a watcher nor native folders.

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
