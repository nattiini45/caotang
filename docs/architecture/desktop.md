# Caotang for desktop

## Account connector (specified)

The installed app may connect to a compatible account server. The writer explicitly opens the account window and enters an HTTPS origin, or uses an origin supplied by their build. There is no default service address in the source and no connection on ordinary app startup. Changing the address ends the current account handoff before using the new origin. Existing local projects and folder writes stay in the local window and are never uploaded by connecting.

The account client and studio are packaged code, not a page navigated to the server. The account window is isolated from the local window, has no folder, provider, MCP or general HTTP bridge, and cannot navigate to remote pages. The main process opens the system browser for sign-in; it does not embed a provider's login page. After browser approval, a short-lived, one-use grant installs a server session in the main process. The authorization flow and allowed requests are specified in [hosted.md §2.8](hosted.md#28-the-desktop-connector).

The main process owns session credentials. Any session or remembered-device secret it persists goes into the existing native key vault, associated with exactly the confirmed origin. It cannot be read through the renderer's generic vault interface, placed in a project or bundle, or written to web storage. When a real OS key vault is unavailable, the app may connect for the current run but must not persist a credential; the writer signs in and unlocks again after quitting. The renderer sees account status, not the session secret. The encryption passphrase and recovery key remain separate from sign-in and are never sent to the server.

The native account transport is limited to the pinned origin and the account endpoints used by the bundled client. It does not follow redirects, attach a credential to a URL, or give remote content a bridge. The native entry and its transport are not imported by the public web entry. A normal web build still has no account UI, no calls to an account server, and byte-identical CSP; the Classic and Modern first load does not grow.

The [development shell](../../apps/desktop-shell/README.md) in [epic #16](https://github.com/nattiini45/caotang/issues/16) hosts the existing root-base Vite build from `apps/desktop/dist/`. The browser site, project format, storage schema and Vite output stay unchanged. This spec records the feasibility spike (#398), the shell (#400), the unsigned packages (#401), native project folders (#402), the watcher (#403), the keychain (#404), native provider calls (#405) and the project's own MCP server (#406).

## Runtime and trust boundary

- Serve the build from the fixed origin `app://caotang/`; keep that origin stable because Chromium keys storage to it. Register the scheme before Electron is ready as standard, secure and Fetch/CORS-capable. Do not bypass CSP. Serve only built assets from a fixed directory, reject other hosts and paths outside that directory, and do not start a loopback server.
- The renderer is sandboxed and context-isolated, with Node integration off and Chromium web security on. It never navigates to remote pages or creates arbitrary windows. Serve a CSP header alongside the unchanged HTML meta policy: scripts, styles and Workers are same-origin; no inline script, eval, embedded frames, objects or form submission. Deny framing with `frame-ancestors 'none'` in the header, where Chromium enforces it. Renderer data requests remain subject to Chromium's network rules, except the provider calls the main process makes for it (below); the keychain is still to come (#404).
- The typed preload bridge exposes `window.caotangDesktop.version` and three namespaces under it: `folders` (the folder calls below), `net` (the provider port below) and `os` (the menu commands, the deep link's answer, the Save dialog, the system timezone and the window's tray state). The version is 6, and a page reads it before it reads a namespace, so a page and a shell from different builds each see only what both have. There is no generic Electron or IPC API. Only the studio URL can receive Electron permission for sanitized clipboard writes. Other permission requests, including browser file handles, are denied. Packaged-binary fuses and ASAR integrity belong to #401, not the unpacked smoke launcher.
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
Electron and no network in it: https to an origin the app configured, this computer only through a `local` entry, no
credentials in the address, a method a model call or a listing uses, at most 32 headers and 32 KiB of them, a 24 MiB request
body, and a response counted as it streams with a 64 MiB cap. A header that names the connection rather than the request (`host`, `content-length`,
`transfer-encoding` and the like) is refused, and a header value carrying a line break with it. A redirect is never followed:
the status goes back to the page, which already refuses a 3xx with what it means, because following one would make the
allowlist a starting point rather than a rule.

**The origins come from the app, read before each call.** The page publishes the origin of every provider profile from the
profile store at the moment of a request — not at start-up — so a profile saved a second ago is reachable on its first call.
A profile that does not parse, or that names a plain-http address which is not on this computer, contributes nothing; every
other profile is an https origin, and one on this computer is a `local` entry, the same kind a local MCP server is. "This
computer" is judged by text and by the local presets' own rule (`isLocalBase`), so `127.0.0.1`, `localhost`, `[::1]` and an
IPv4-mapped spelling such as `[::ffff:127.0.0.1]` are the same machine while a `*.localhost` name is not: a local entry is the
one kind the port may reach over plain http, so it is the narrowest reading. Ollama, LM Studio and `llama-server` are therefore
called by the main process, which is what lets a server that asks for a key receive it: the keychain holds the key and only the
main process can read it, so a page request carries `caotang-key:<id>` and the host swaps it for the secret at that loopback
origin. Those servers keep the browser's Local Network Access prompt and the product's CORS advice only in the browser build.
A connected MCP server's URL is published the same way, a local server as a `local` entry with its bearer token (#404).

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

**A call is claimed before its key is opened.** Opening one is asynchronous — the operating system decrypts the seal (§The
keychain) — so the call is registered as stoppable first and the request is checked again after the secret arrives and before
it opens: a cancel that lands during that wait finds the call and stops it, and one that lands a moment late still keeps the
request from leaving. A call stopped while its key was being opened is answered as `aborted`, never as whatever the key did on
its way out, and a decryption nobody waits for any more is still handled rather than left as a rejection with no owner.
Claimed after the wait, the cancel found no call to stop and was answered as though the call had never been made, and then
the request went out for a writer who had already stopped it (#869).

**What the page sees.** The preload bridge is version 6 and exposes `net` beside `folders`: `configure`, `start`, `abort`,
`onChunk`, `onEnd`. Every call is checked for the studio's own top frame at `app://caotang/`, so a child frame or another
origin cannot use the port. A request's shape is checked before any socket opens, and `invalid` covers what the network stack would otherwise refuse on
the way out: a header that names the connection, a body on a `GET`, a method the app never sends. A call stopped before it
started is not made at all, and one stopped while its key was being opened or while its head was still arriving is reported as
`aborted` rather than as a dead network or as a key that would not open. A refusal names its reason (`invalid`, `denied`,
`too-large`, `unavailable`, `aborted`), and the
page turns it into the failure the gateway already knows how to explain, so a refused address reads as an address the app
does not connect to rather than as a dead network.

The rule is tested by the repository's gate
([`native-egress.test.ts`](../../packages/gateway/test/native-egress.test.ts)), the port by a launched app
([`egress.spec.ts`](../../apps/desktop-shell/test/egress.spec.ts)), which configures one origin and proves every other
address is refused after it, and its cancellation by a check with its own slot (`egress-cancel.test.ts`, beside it), because
a vault that opens slowly is not something a runner with no keychain can be given.

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
so the file appears whole or not at all; Windows, which will not rename over an existing file, first moves the file already there
aside to its own name and puts it back if the replacement fails, so a save that cannot finish costs neither copy — the dialog having
already asked about replacing it.

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
## The keychain (#404)

The desktop app keeps provider keys and MCP bearer tokens in the main process, sealed by the operating system's own store
through Electron's `safeStorage`: DPAPI on Windows, the login keychain on macOS, libsecret or KWallet on Linux. The vault is
one file in the app profile, `native-key-vault.json`, holding one entry per key id — a profile id for a provider, an `mcp:`
reference for a server's token — where each entry is the sealed secret and the address it was entered for. Every change writes
that whole file in one turn, the way every other Caotang artifact is written
([`os-vault.ts`](../../packages/gateway/src/keys/os-vault.ts) is the vault, and the rule it keeps).

**The page may store, check, revise, restore and remove; it may never read.** The preload's `vault` channels are
`available`, `put`, `putReplacement`, `putHeaders`, `remove`, `has`, `revision`, `restore`, `headers` and `keyState` — there is no
`read`, `get` or `reveal` among them, and the shell suite asserts that list. A key is written by the form that took it; from then
on the page learns only whether one is there, whether the entry holds a key at all, which revision it is at, and the extra header
values the writer typed beside it, never the key itself.

**Which address a key belongs to is main-process state, inside the vault's own record (#864).** Each entry is the sealed
secret and the address the writer entered it for, and one write of the file commits both: there is no step that stores a key and
a later step that says where it goes, so a key is never stored without its address and never has an address without its key, and
a write that fails leaves neither. The page has no call that says where an existing key goes: the port rebuilds the allowlist on
every request from those addresses, so a page can name a key's id inside a request and cannot say which address that id belongs
to. A `put` for an id stored for another address is refused rather than rebinding it, and the refusal says `bound`, which is how
the page tells the writer the key is kept for a different address and to enter it again, rather than reporting a keychain that
would not answer (#879); a key with no address is denied rather than sent. The one replacement that moves an address is `putReplacement`, which carries the key the writer typed again for an
endpoint they changed: it writes the new secret and the new address in the same turn, so no secret already stored is ever
pointed at a new address. A key nothing has placed — one stored before addresses were kept — stays denied, and the one act that
gives it an address is the writer entering it again for the endpoint the profile names; no page call can assign an address to a
secret it did not enter. The address is a bare origin, https anywhere and plain http only on this computer, which is the one
non-https address the port reaches (`key-origin.ts`).

**A key reaches a request as a handle that becomes a secret.** The page's key store answers `reveal` with
`caotang-key:<id>`, and the adapter that knows a provider's protocol writes that handle where the key would go — in
`authorization`, in `x-api-key`, in a query parameter, wherever its own route puts it. When the call reaches the main process,
the handle is swapped for the secret from the keychain, but only for an address that key was configured for: a handle at any
other origin is refused as `denied` rather than sent. So a script in the page can use a stored key while the app is open, and
cannot take one away — which is the difference the browser vault cannot offer (provider-gateway §7).

**A key may be empty when the profile authenticates with its headers alone.** The generic endpoint preset reaches a service that
wants its own headers rather than a bearer key, and a profile saved that way reaches the vault as `{ apiKey: '', customHeaders }`
with at least one header beside the empty key. The vault accepts that payload, because a profile with no bearer key is still a
profile; it refuses one that holds neither a key nor a header, since there would be nothing to seal. The empty key stays an empty
key: `keyState` answers whether an id holds nothing, a key, or headers alone, and `reveal` and `revealPayload` answer `''` for the
last rather than a handle, because a handle names a secret and there is none — so a call made from such a profile carries its own
headers and no key at all. That is the shape the browser's WebCrypto vault already stores, so a headers-only profile reads the same
in both stores (#868).

**A provider that echoes a key cannot put one in the log.** The secret is attached in the main process, so the page's own
redaction, which scrubs the values it sent and it sent a handle, would not see it. The answer's bytes are scrubbed of every
secret attached to that call as they stream back, across chunk boundaries, before the page receives one. The pass reads the
answer once, longest secret first, and never reads what it wrote: `[redacted]` is not candidate text, which it has to be when a
key is a single character — one that is also part of the word replacing it — or the pass would find its own output and grow
without end (#870). That holds across a chunk boundary too: what is held back for the next chunk is the provider's own bytes,
never a replacement already written (#877). The same rule applies to a header value and a reason phrase, which are scrubbed as strings.

**A write can be undone without a read.** The vault remembers the entry the last write of an id replaced — the sealed secret
and the address it was written for — and `restore` puts that entry back in one write of the file, so the MCP client's "store the
new token, then update the server, and put the old one back if that update is refused" works with a store that cannot read: the
undo is the vault's, not the page's. An undo can only ever put back a pair that was stored as a pair, so restoring can never
carry the older key to the address the newer one was entered for, and a headers edit keeps the address its entry had. A request
reads its secret in the same turn a write takes, so a request made while a replacement is being sealed is answered from the
address the key is still stored for, and the new address reaches nothing until the write that moves the key lands. A removal
drops the undo with the key, so a removed secret cannot come back at any address. `os-vault.ts` is that rule, and the
repository's gate tests it without Electron.

**Migration writes, verifies, deletes.** On first open with a keychain, each key an earlier build sealed in this browser's
IndexedDB vault is opened by the store that already holds it, written to the keychain, read back by the main process before it
is reported stored, checked once more, and only then removed from the browser. An entry the browser's store cannot open is left
where it is. An entry that holds only headers moves like any other key, under its own id, so the profile whose origin it belongs
to keeps it. A machine where the move stops part-way keeps every key it did not move, and the app says so rather than opening as
though nothing were missing. A key moves (or, for MCP, a bearer token moves) only for an address its own record names: a provider
profile's endpoint origin, or an MCP server's own URL origin for the token its settings reference. Two servers that name one
reference at two addresses are one entry's worth of token: it is placed for the first server that names it, in the settings'
own order, and the second is refused rather than handed a token saved for another address (#879). A credential whose record is
gone, or whose address does not parse, is left where it is and stays denied.

**A key the keychain already held has no address, and stays denied (#864).** A record written before addresses were kept holds
its keys without one; the upgrade keeps the entries as they are, so the port refuses every request that names one, and there is
no call that gives an existing secret an address, because the page supplies both the id and the address, which is the pairing
this design keeps out of the page. The writer enters the key again for the endpoint the profile names, which places it in one
write, and Settings names the profile without a usable key. No shipped build has such keys. The settings database is read for
the migration as auxiliary data, so a read that fails names no addresses and startup continues; the provider store reads the
profile list twice before it gives up, and a session that still could not read it keeps those records rather than replacing them
with the demo profile. Adding, editing or removing a profile in that session is refused in words, because a change that could
not be written must not be reported as saved.

**Without a keychain the browser's vault stays, and says so.** `safeStorage` on Linux falls back to a built-in key that is the
same on every machine, which is obfuscation rather than encryption; the vault treats `basic_text` and `unknown` backends as no
keychain at all. There, the WebCrypto vault of provider-gateway §7 keeps the keys, and Settings says the keys are in this
browser rather than in the computer's keychain, as does the notice at start-up.

**A server on this computer is a local entry, and a key it asks for arrives.** A credential held by the main process cannot be
attached by the page, so MCP HTTP goes through the same port, and so does a provider profile whose address is a loopback literal
([native-egress.ts](../../packages/gateway/src/native-egress.ts)). Such an entry is the only kind allowed plain http, and the port
refuses plain http to any other address even when an entry says `local`; a profile elsewhere is published as an https origin. A
key or a bearer token for one of them is stored for that plain-http origin, because the vault accepts exactly the addresses the
port will send to (`key-origin.ts`). Without this, a local model server that asks for a key was sent `caotang-key:<id>` as its
bearer token and answered an authentication failure (#867).


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
saving and that a read is never refused. Every control call names the pause in `X-Caotang-Pause`, a lease of the app's own making, so
a resume or a cancel lets go of that pause and no other — even when the pause has not reached the server yet, which is the case a save
that stopped waiting for its answer is in. `POST /control/cancel` is that save's call: it lets the pause go and reads nothing, because
no save of it is coming. The endpoints exist on every HTTP server this package starts, including one a terminal started, where nobody
uses them; a server started without a gate answers `404` and says nothing coordinates a save with it.

What the pause does and does not guarantee: a write tool that has not started is refused rather than queued, so nothing lands after
the save; so is `coherence.scan`, the one read whose answer the server appends to `coherence.json`, because its run reaches the same
folder a write does — and a read-only server, which saves nothing for it, still answers it; the pause is a barrier, so a write the
server had already admitted finishes first — the pause answers only once every such
write has released, and a folder with none in flight answers at once, so a save into a free folder never waits. A save therefore never
runs while the server is still persisting a file, and the app's digest check — the one `writeProject` makes for each file before it
replaces it, and `changedDuringSave` after — stays the backstop for a change from anywhere else, naming the file to the writer instead
of replacing it. That is "reported, not lost", the same guarantee the folder guard gives without a server. The pause is taken only for
a save that writes: a save the verdict refuses never reaches it.

**A pause that cannot be confirmed stops the save.** With a server holding this folder, a save whose pause did not answer takes the
folder's own lock refusal, so the writer is asked before anything is written and can save anyway. A pause that is draining a long write
can take that write's own time, and one that outlasts the app's wait gets the same answer: the save stops and the writer is asked,
rather than written beside a server that may still be writing. A pause the app stopped waiting for is let go by the app: it posts the
cancel it would otherwise never send, naming the same lease, so a pause is only ever held by a save that is still running and the folder
does not stay paused until the server restarts. A server that has already seen the cancel and not yet the pause cancels that lease, so
the pause that lands afterwards does not stand either. A server that answers neither the pause nor that resume is stopped, and the app
tells the writer to start it again. Without that refusal the save would run while a server that may still accept writes holds the same
folder, which is the one thing this pause exists to prevent; the digest check would still catch a file it changed, but the promise is
about what the server cannot start, not only about what it already did.

**The resume that ends a save is when the server reads the folder again.** The server holds the project it read when it opened, plus a
digest of every document and codex file it read, so a save by the app would otherwise leave it answering from the project as it was —
and its next write tool would find the app's files against that old baseline and stop its own writes for good. So the last resume of a
save reads the folder again before it is answered — a cancel never does, since it is the save that never happened (`folder.reload` in `@caotang/sdk`, through the folder's own queue): the manifest
text is the check that anything was written, because every save rewrites `caotang.json`; the documents are digested before the project
is read, as at open; the state the server already holds is given the loaded project's fields, so its tools, resources and exporter see
the new project; and the digests and `coherence.json` it checks its saves against become the folder's. A host subscribed to the
project's changes is told to read them again, and the server's own writes start again checked against what the save left. Nothing is
written by the read, and the app's save is never lost: a write of the server's queued before the reload is saved first, and a write
refused because the app changed a file stays refused and names it.

A read that arrives while a save is in flight is still answered at once, from the project the server holds, as the pause promises: the
pause is about writes, and the save is only adopted when the app says it is done. A resume that lifts a pause another save still holds
answers at once, because the folder is still being written. The pause stands across the server's own read as well, so a write tool that
arrives in that moment is refused with the save's own words and can be asked again; a write that did start before the pause was
refused at the app's digest check and names the file, exactly as before. The app gives the resume a longer wait than the pause (20 s
against 2 s in `mcp.mts`), since it now includes the folder's read and is bounded by the project's size rather than by a round trip; a
resume the server does not answer at all is still reported as the server being stopped rather than left refusing.

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
