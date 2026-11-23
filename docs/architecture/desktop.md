# Caotang for desktop

The [development shell](../../apps/desktop-shell/README.md) in [epic #16](https://github.com/nattiini45/caotang/issues/16) hosts the existing root-base Vite build from `apps/desktop/dist/`. The browser site, project format, storage schema and Vite output stay unchanged. This spec records the feasibility spike (#398), the shell (#400) and the unsigned packages (#401).

## Runtime and trust boundary

- Serve the build from the fixed origin `app://caotang/`; keep that origin stable because Chromium keys storage to it. Register the scheme before Electron is ready as standard, secure and Fetch/CORS-capable. Do not bypass CSP. Serve only built assets from a fixed directory, reject other hosts and paths outside that directory, and do not start a loopback server.
- The renderer is sandboxed and context-isolated, with Node integration off and Chromium web security on. It never navigates to remote pages or creates arbitrary windows. Serve a CSP header alongside the unchanged HTML meta policy: scripts, styles and Workers are same-origin; no inline script, eval, embedded frames, objects or form submission. Deny framing with `frame-ancestors 'none'` in the header, where Chromium enforces it. Renderer data requests remain subject to Chromium's network rules; a native network proxy, filesystem and keychain are not part of the shell.
- The typed preload bridge exposes `window.caotangDesktop.version` and two namespaces under it: `folders` (the folder calls below) and `os` (the menu commands, the deep link's answer, the Save dialog, the system timezone and the window's tray state). The version is 3, and a page reads it before it reads a namespace, so a page and a shell from different builds each see only what both have. There is no generic Electron or IPC API. Only the studio URL can receive Electron permission for sanitized clipboard writes. Other permission requests, including browser file handles, are denied. Packaged-binary fuses and ASAR integrity belong to #401, not the unpacked smoke launcher.
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

## Native menus (#407)

The main process builds one application menu from a template that is pure and read by the shell's suite
([`menu.mts`](../../apps/desktop-shell/src/menu.mts)); the page supplies its words through `os.publish`, so a German interface has a
German menu and the shell itself holds no sentence. File has New project…, Open folder…, Compile…, Export bundle…, Settings… and
Quit (the last two, and Quit, move to the application menu on macOS, where they belong). Edit exists on macOS only, because the
clipboard's own chords need it there and Chromium provides them without a menu elsewhere: its Undo is a command to the page, and
Cut, Copy, Paste and Select All are Electron's roles. View has Focus mode and Toggle full screen; Window has Minimize and Close;
Windows and Linux add Help › About Caotang. An item that needs a project is enabled only while one is open — the page publishes
whether one is, with the rest of the state — so a menu never offers a click that would do nothing. Choosing an item sends one
command to the page, which runs the same handler its toolbar button runs and answers in its own words.

**Which shortcuts are the menu's, and which stay the page's.** The page's keymap is the one authority for its own chords, because
a menu accelerator is delivered *before* the page: a writer pressing Ctrl+Z inside a field would lose the field's own undo to the
app-wide one, and every context rule in `keymap.ts` would be bypassed. So the menu registers no chord the page owns:

| Chord | Owner |
| --- | --- |
| Ctrl+N (new document), Ctrl+Z (app undo outside fields), Ctrl+Shift+F (focus mode), Ctrl+Alt+F (filter), Ctrl+Enter (open in editor), Ctrl+K and Ctrl+J (Modern's palette and agent), Ctrl+Shift+N (Modern's New menu), F2, Delete, the arrows, Alt+arrows, Enter/Space, Shift+F10, Escape | the page |
| Ctrl+O (open a folder), Ctrl+, (Settings), Ctrl+W (close window), Ctrl+Q (quit, Windows and Linux) | the menu |
| Cut, Copy, Paste, Select All, Minimize, Quit and the application menu's Hide, on macOS | the menu, as Electron roles |

On Windows and Linux a chord the page owns may still be *shown* beside an item, because Electron can display an accelerator it does
not register (`registerAccelerator: false`): Focus mode shows Ctrl+Shift+F. On macOS a key equivalent cannot be displayed without
being registered, so those items carry none, and the toolbar's hint stays the place the chord is named. Not built: an Open recent
submenu, a Print item, zoom items, and documentation links, which the shell blocks from opening a browser anyway. The macOS
application menu is Electron's own role menu and its items keep Electron's English labels; the four menus this spec owns are
translated.

## Deep links and folder handoff (#407)

One scheme, one route, one parser: `caotang://project/<id>`, where the id is a folder **this profile has already been granted** —
one opened with the picker or remembered in Recent project folders. A link therefore reaches only a folder Caotang would open
anyway, and it can neither carry a path nor name one. Every other shape — another route, a query, a fragment, a user, a port, an
id this profile does not know — is refused, and the page says so in a sentence: "That link names a project this copy of Caotang
does not have" or "That link is not a Caotang project link". [`links.mts`](../../apps/desktop-shell/src/links.mts) is the only
place either rule is written.

The scheme is registered when a package is installed: electron-builder's `protocols` writes the Windows registry entry, the
macOS `Info.plist`'s `CFBundleURLTypes` and the AppImage's `MimeType=x-scheme-handler/caotang`. A packaged build also asks the
running system to point the scheme at itself. A development shell does not take the scheme over; it is given the URL as an
argument, which is exactly how the system delivers one.

A folder the operating system hands over — a file manager's "Open with", a desktop file, a command line, the `open-file` event on
macOS — is granted by the picker's own rule: a readable directory that holds a `caotang.json`. Anything else is refused with "That
folder does not hold a Caotang project" or "Caotang could not read that folder". An empty folder is not accepted, so nothing outside
the app can start a project; the grant joins the recent list, so the writer can reopen it from the projects list afterwards. The
app's own paths — its executable and the directory a development launcher is given — are never treated as a folder.

Deliveries reach the page as commands on the same channel the menu uses. A command that arrives before the page is listening waits
in the main process and is handed over when the page asks on mount, so a link that launched the app lands exactly where one that
arrived later does. While a project is open, a delivery does not replace it: the workspace says "Close this project before opening
another one from a link." Not built: a link to a scene, a codex entry or a place inside a project; a link that carries a path; more
than one project per launch; and opening a second project from outside while one is open.

## Native save (#407)

The exporter makes the bytes and the name; the shell shows the operating system's Save dialog and writes once. `os.saveFile` takes
a name and bytes, refuses a name that is a path or holds a control character, an empty file and one over 256 MiB, and answers
`saved: false` when the writer cancels — nothing is written and that is not an error. The default place is the writer's Documents
folder and the dialog filters by the file's own extension. The write goes through a temporary name in the same folder and a rename,
so the file appears whole or not at all; Windows, which will not rename over an existing file, removes the target first, the dialog
having already asked about replacing it.

Compile… offers it for what a compile writes: the one file the format makes, or the zip of several. The bytes are the exporter's own,
read through `ExportStore.read`, whose `isBinaryPath` list decides text from bytes — a Markdown or plain-text export is its text
encoded as UTF-8, and a DOCX, EPUB, XLSX or PDF is the bytes as made. Cancelling leaves the dialog open saying "Nothing was saved."
The project bundle's **Export bundle** keeps the browser's download, because it is a copy of the whole project rather than a file the
writer is placing. The browser build is unchanged: with no shell the same call downloads.

## The system timezone (#407)

`os.timeZone()` answers with the zone Node reads for the platform (falling back to `UTC`), read once at start-up; it is read-only and
nothing about it is stored. It is what goals-progress's assumption A3 can finally be: the writer's own calendar day. The session
target counts "today" in that zone (`dayKeyIn`, `session-progress.ts`), and a scheduled task is due in it, so a daily 09:00 task runs
at 09:00 on the writer's clock rather than the renderer's idea of it. The browser keeps the device's local day, which is the only
honest reading a page has. No project format, schema or setting changes.

## The tray and scheduled task runs (#407)

Closing the window **hides** it while a tray exists; the app keeps running, and Quit — the menu's, the tray's, or Cmd+Q/Ctrl+Q — is
the only thing that ends it. The tray is made on the page's first publish, because its words are the page's, and until then closing
the window ends the app as it did before there was a tray. A window that cannot be put back is worse than none, so when the tray
cannot be made at all the shell keeps the old behaviour and lets the close end the app.

The hidden window's renderer keeps its timers: `backgroundThrottling` is off for it, so a hidden page is not a throttled tab. The
page treats the tray-held window as running for its recurring tasks — the whole rule is `ticksCount` in `native-os.ts` — so the
once-a-minute due check still happens, and a task that becomes due is handled as it is with the window open.

What that honestly means: a `scan` task whose file says `run`, and a `plan` task the writer allowed and capped, start by themselves,
stage their drafts in the Inbox for review, and record the run in the task history as usual; nothing applies by itself. An `intent`
task is always offered rather than started (#685), so it waits, in the tray as it would on screen. No project open means nothing is
scheduled. Quitting stops all of it, and the tray's Quit says so. The tray's status line is the page's own sentence — no project
open, tasks running while the window is open, or tasks keeping on while Caotang is in the tray — so the tray never claims a run that
is not happening. Not built: a task runner in the main process (nothing runs with the app quit), a tray item that runs a task now,
and a notification when a run finishes.

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
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on every pull request, so a released commit is never gated by
less than a merged one. The Windows leg leaves out the five `packages/sync-server/test` suites whose cases run through a Worker
runtime — `account-mode`, `storage`, `server`, `quota` and `accounts` — with `CAOTANG_SKIP_WORKER_SUITES=1`, exactly as ci.yml's
`verify (Windows)` job does while #815 moves those files onto one shared runtime and #820 tracks the later ones.

The job that builds packages also runs on `workflow_dispatch`, so the packaging can be proved without releasing anything: a
dispatch publishes nothing and only leaves the packages and their checksums as workflow artifacts.
