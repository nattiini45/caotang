# `@caotang/mcp-server` — Caotang as an MCP server

Caotang's tool registry, served to an outside agent over MCP: the same tools, under the same names, descriptions and schemas, through the same command bus and the same permission gate. The design is [extensibility.md §9](../../docs/architecture/extensibility.md). The tool list is in [The tools](#the-tools) below, and it is the list a host sees.

It is **read-only by default**. Writes are exposed only when the project is opened with `--allow-writes` (or `CAOTANG_MCP_ALLOW_WRITES=true`). Then fourteen tools write: seven apply their change at once, and seven ask the user to confirm each call in the host before anything is written. The tables under [The tools](#the-tools) say which is which.

## Build

```sh
pnpm --filter @caotang/mcp-server build      # writes dist/caotang-mcp.mjs
pnpm --filter @caotang/mcp-server run pack       # builds, then writes dist/caotang-mcp-<version>.mcpb
```

`dist/caotang-mcp.mjs` is one file: the workspace packages and the MCP SDK are inlined, so it runs with a plain `node` (the workspace's `engines` range, Node 22.12 or a later supported release). Nothing else needs to be installed next to it, except the two fonts below for a PDF that needs them.

The two PDF exports (the screenplay PDF and the storyboard contact sheet) set text Helvetica or Courier Prime cannot print in two fallback fonts, one CJK font and one emoji font, and both PDFs share the same two files: `NotoSansMonoCJKsc-Regular.woff` (Noto Sans Mono CJK SC, `@caotang/font-noto-cjk`, 7,219,856 bytes) and `NotoEmoji-Regular.woff` (Noto Emoji, `@caotang/font-noto-emoji`, 579,236 bytes). The server reads each only for a PDF that holds such text: from `fonts/` beside the bundle, then from its package in a checkout.

`pack` makes the MCPB bundle a host can install. The bundle holds `server/caotang-mcp.mjs`, `server/fonts/NotoSansMonoCJKsc-Regular.woff` and `server/fonts/NotoEmoji-Regular.woff` (7.8 MB together, where the bundle held four font files and 25,065,212 bytes before the two PDFs shared one of each), `THIRD-PARTY-NOTICES.md` for the bundle's dependencies, and the repository's `LICENSE`. The pack script stages those files, checks the manifest against the bundle (its version, its entry point, the arguments, and the write setting), validates it and packs it with the MCPB CLI this package pins (`@anthropic-ai/mcpb`, an exact version). It then reads the result back. The bundle is not signed.

## Run

```sh
node dist/caotang-mcp.mjs serve --project ~/Writing/my-novel
node dist/caotang-mcp.mjs serve --project ~/Writing/new-book --create "New Book"
node dist/caotang-mcp.mjs serve --project ~/Writing/my-novel --allow-writes --port 7433
node dist/caotang-mcp.mjs serve --project ~/Writing/my-novel --stdio
```

| Flag | Meaning |
|---|---|
| `--project <dir>` | The project folder to serve (required). |
| `--create <name>` | Make a new project named `<name>` when the folder holds no `caotang.json`. Ignored for a folder that already has one. **Refused, with the folder unchanged, when the folder holds document or codex files** (a body file in `docs/` named by a document id, such as `docs/n_*.md`, and `codex/c_*.md`) **or a manifest copy** (`caotang.json.*`): a new manifest would not own them, and its first save would delete them. Open such a folder in Caotang, which recovers a project whose manifest is lost, then start the server without `--create`. |
| `--allow-writes` | Let external callers change the project. Off by default: the server is read-only. The environment variable `CAOTANG_MCP_ALLOW_WRITES=true` does the same; only the exact value `true` counts. |
| `--port <n>` | The loopback port for Streamable HTTP. Default `7433`; `0` picks a free one and prints it. |
| `--token-env <VAR>` | Read the bearer token from this environment variable. Default `CAOTANG_MCP_TOKEN`. |
| `--stdio` | Serve over stdin and stdout instead of HTTP. No port and no token: the host's process boundary stands in for both. |

Every line the server writes goes to **stderr**. In `--stdio` mode stdout carries only the protocol.

The server holds a single-writer lock, `.caotang-mcp.lock`, in the project folder while it runs, and removes it on exit. A second writer on the same folder is refused with exit code 3. A lock left behind by a process that has died is taken over, and that takeover is marked by `.caotang-mcp.lock.takeover` beside it, so that only one writer takes it over. A lock whose body cannot be read is not taken over: nothing says whose it is, so a writer that is writing it right now would lose it, and the age of a file proves nothing. The folder is refused, and the refusal names the lock file and says how to clear it. A marker is named in the refusal that is about it: the refusal for a live holder names the marker beside that lock, and the refusal for a takeover that is marked names the marker itself. Either way the refusal says which of the three states the marker is in: when the writer that marked it is still running, it says to wait for it to finish; when the marker is being written right now, it says to wait a moment for it to finish; when it is an orphan, it says to delete the file, once no other Caotang or MCP process is using the folder. Deleting the orphan marker is what lets a writer take the lock over. A refusal about a lock whose body cannot be read names that lock and not the marker beside it, because the lock is what the folder is refused for. A folder that holds the marker alone is not refused: the lock is taken, and the marker is left where it is. The lock is advisory: it stops another instance of this server. The Caotang desktop app reads it and asks before it saves over it, but a program that reads neither can still write the folder (see Known gaps).

**The save guard.** The folder can be changed by any program, so the server keeps what it last loaded or saved: the text of `caotang.json`, and a SHA-256 digest of every document file (a body in `docs/`, `.md`, `.fountain` or `.ink`) and every codex file (`codex/c_*.md`). Before each save it compares the folder with that copy. If `caotang.json` changed, or a document or codex file changed, was removed, or was added, the save is refused with `FolderChangedError`, nothing is written, and writes stop until the server restarts and reads the folder again. A write asked for after that is refused before the writer is asked, with the same reason, so no question promises a change that cannot be made. A write that needs the host's confirmation also checks the folder first, before the host is asked: it reads `caotang.json` and every document and codex digest, so a change the save would refuse is refused without a question (about a quarter of a second for 270 files on the development machine). The refusal names each document by its title and each codex entry by its name, and no file name or node id. `coherence.json` is not part of this check: it is derived state that the desktop app writes too, so a change to it never stops a save of the manuscript (see **The findings file**). Unchanged bodies are not written: a save writes only the document and codex files whose text changed. Only the documents this session deleted are removed from `docs/`, and each is removed after the manifest that stops naming it is written. Each file is checked against its digest again just before it is written or removed, so a change made during a save is refused at that file. A save that fails part way keeps the digests of the files it did write, so this server's own partial write is not taken for another program's change.

**The findings file.** `coherence.json` is derived state, and the desktop app writes it into an open folder as findings change. The server reads it when it opens, and writes it only with `--allow-writes`, after any project save in flight, through the same code the app saves with (the `.bak.1` to `.bak.3` snapshots and the atomic write). Before it writes, it checks the file against the digest it held since it last loaded or saved it. If another program wrote it meanwhile, the file on disk wins: the server reads it again and puts back only its own additions, which are the runs it recorded, the findings it created that the file lacks, and a finding it marked fixed that the file still has open. It never changes a finding the writer dismissed, never reopens one, and never touches scene declarations or world rules. A file it cannot merge, because it is unreadable or was written by a newer Caotang, is not written: the refusal names `coherence.json` on stderr and in the session notices, and the server writes no more findings until it restarts. The check narrows the chance that two writers lose each other's work and does not close it, because the check and the write are separate steps.

## The token

The server listens on `127.0.0.1` only and requires `Authorization: Bearer <token>` on every request. There are two ways to set the token:

- **Minted (default).** When `CAOTANG_MCP_TOKEN` is unset, the server mints 256 bits of randomness at start and prints it once on stderr:

  ```
  caotang-mcp: bearer token (shown once, never written to the project): <token>
  ```

  It is never written to the project folder. Copy it into your host's configuration; a new token is minted on every start.

- **Supplied.** Set `CAOTANG_MCP_TOKEN` (or the variable named by `--token-env`) to a value of at least 16 characters. The server uses it as given and does not print it. A value that is too short, or empty, is refused at start rather than replaced by a minted one.

A missing or wrong token gets `401` before any MCP code runs.

## Add it to an MCP host

Point the host at the endpoint with the header:

- **URL:** `http://127.0.0.1:7433/mcp` (the port you started with; check the `MCP endpoint` line on stderr)
- **Header:** `Authorization: Bearer <token>`

The exact keys depend on the host. As a generic `mcpServers` entry:

```json
{
  "mcpServers": {
    "caotang": {
      "type": "http",
      "url": "http://127.0.0.1:7433/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

For a host that starts a server as a child process, use `--stdio` with the same `node dist/caotang-mcp.mjs serve --project …` command, or install the `.mcpb` bundle, which runs that command for you. The bundle's [`manifest.json`](manifest.json) declares the arguments, and its one setting, **Allow changes**, sets `CAOTANG_MCP_ALLOW_WRITES` from the user's choice.

Which transport a host should use:

- A host that wants confirmation prompts for writes must declare **elicitation** support. If it does not, a write that asks is refused with a structured error saying so, and nothing is written.
- A host on a **2025 protocol revision** confirms writes over HTTP as it does over stdio, provided it declares elicitation. Its handshake is an `initialize` request, and the server keeps that connection under the `Mcp-Session-Id` it returns. The host sends that id on every later request, as the 2025 transport requires, and the server asks its questions on that connection. A request that names no session is served without one, so a write that would ask is refused, and the refusal names the handshake and the stdio route. The connections are bounded: the server holds at most 16, and closes one that has been idle for 30 minutes (see the security model).
- A host on the 2026-07-28 revision confirms writes over either transport.

## The tools

These are the tools a host lists, measured from `tools/list` on a server started with each setting. The annotations and descriptions are the harness's registry-to-MCP mapping ([extensibility.md §7](../../docs/architecture/extensibility.md)), unchanged. Two things differ from the whole registry: `tool.search` is not listed, and the tools that need a model are not listed. The empty-project note of `project.overview` is the harness's own, and it names a write tool only to a caller whose server allows writes.

**Read-only server (7 tools), and always:**

| Tool | Risk |
|---|---|
| `project.overview` | read |
| `binder.read_tree` | read |
| `doc.read` | read |
| `notes.read` | read |
| `codex.read` | read |
| `coherence.scan` | read |
| `dialogue.table` | read |

**With `--allow-writes` (21 tools):** the seven above, and:

| Tool | Risk | What the host does |
|---|---|---|
| `meta.set`, `notes.append`, `synopsis.set`, `filter.save`, `goal.save`, `coherence.setFindingStatus`, `shots.annotate` | write-auto | Applies at once when the call arrives. |
| `binder.restructure`, `codex.write`, `codex.import`, `doc.import`, `export.compile`, `notes.replace`, `vocabulary.upsert` | write-confirm | Asks the user to confirm each call (its description starts "Requires user confirmation."), and writes nothing if the answer is not an accept. |

`export.compile` writes any format in the list into `exports/`. It takes the project's identifier, language, author and cover through the mapping the desktop app's exporter uses (`exportMetadataOf`), and the images under `assets/` that a shot list or a prompt pack names (`assetRecordsOf`), so one project writes the same book and shot list from either host. An EPUB compiles here for any project. A project that predates the identifier is given one when it opens, but this server does not save on open: the identifier is stored by the first save of the folder, which is a write or a compile that succeeds, and the book that compile writes carries the identifier it stores. A prompt pack names its vendor template in `template`, or the recipe does, and a call that names neither is refused before the dialog. So is a compile the exporter's own gates would refuse for its selection: a screenplay format (Fountain or Final Draft) with no scene, an Ink story or a dialogue table with no dialogue container, a shot list with no shot, and an EPUB with no identifier. Each is refused with its reason, nothing is written, and the writer is not asked. A call can name a saved recipe with `recipeName`: the recipe supplies the title page, contents, author, character limit and template, and, when `selection` is left out, the nodes it compiles (the manuscript, or the part the recipe names). A folder whose images cannot be listed refuses a shot list (CSV or XLSX) or a prompt pack, the three formats that name images, with the reason, so no shot list is written with its images named as missing; the other formats still compile.

**Not listed, in any mode:**

- `agent.plan` is protocol, not a tool.
- `project.deleteNode` is hard-denied: it is refused whatever the caller asks, in every mode, with the bus's own message.
- `tool.search` is not listed. It searches the tool servers Caotang's own MCP client connects to, and this server connects to none, so the tool could only report that.
- The eight tools that need a model are not listed, because the server holds no provider key: `scene.draft`, `synopsis.fill`, `continuity.scan`, `coherence.review`, `shots.derive`, `prompt.draft`, `prompt.variant` and `dialogue.draft`.

## Write-confirm across the boundary

A write-confirm call is not run on the first request. The server asks with an elicitation whose schema is exactly `{ confirmed: boolean }`: a 2026-07-28 host gets it as an `input_required` result, and a 2025-era host gets it as an elicitation request on its connection. The host shows that as a dialog, and the call runs only when the user accepts it:

- **Accept** runs the call once, and the change is written to the folder before the result returns.
- **Decline** or **cancel** writes nothing, and the result says `"written": false`.
- An answer applies only to the arguments it was asked about. A retry with different arguments is asked again.
- A replayed accepted retry is answered from the first answer and is not applied a second time. That holds when the replay arrives while the first is still being saved: it waits for the same answer. The replay is answered before the arguments are checked again, so a create the first accept made is not refused as a name already taken.

The confirmation text names the change in words, and it is made before the host is asked. The arguments are checked first, with the same checks the write would run, so a call that could not run is refused at once and the dialog never asks for it. The text names what the change touches: a document import shows its title, its word count and the title of its parent; a binder change names the first few nodes it moves, renames or adds, by their titles; a codex change names the first few entries by their names and types, and an update by the name the project holds for its entry; an export names its selection, its format and its recipe. It never carries a document body, an entry description or an alias. Those are the text the writer wrote, and an elicitation form never carries long private content.

## Security model

- **Loopback only.** The listener binds `127.0.0.1`. `Host` and `Origin` headers that are not localhost are refused with `403` (DNS rebinding and browser pages).
- **Bearer token** on every request, compared in constant time.
- **Read-only by default.** Write tools are not even listed without `--allow-writes`. A read never changes the manuscript, codex or manifest, with or without it. The server reads `coherence.json` when it opens, and without `--allow-writes` it writes nothing: a run that `coherence.scan` records stays in the server's memory, and a damaged `coherence.json` is not repaired. With `--allow-writes`, `coherence.scan` appends its run to `coherence.json`, and `coherence.setFindingStatus` keeps `fixed` there, as derived state like `sessions.jsonl`.
- **Bounded 2025-era connections.** A 2025-era connection is held in memory only while the host keeps it. At most 16 are held, a connection idle for 30 minutes is closed, and a connection with a confirmation still open is never closed to make room. That confirmation waits 60 seconds for its answer, then the connection is free again. A new host is refused with `503` while every connection is busy; the refusal names the limit, how many are busy and the wait, and carries a `Retry-After` header of 60 seconds. A request on a session that has ended gets `404`, and the host sends `initialize` again. The table holds the connection and its server, never project data.
- **Hard-deny is server-side.** `project.deleteNode` is refused by the guard before the SDK sees the request, so the refusal does not depend on what the host allows.
- **Saves check the folder first.** Before a save the folder must hold the `caotang.json`, document and codex files this server last loaded or saved (The save guard). A change by another program stops writes, and nothing it wrote is overwritten or removed.
- **Every external row is tagged** `source: "mcp"` in the activity log, including confirmed writes.
- **Atomic writes, contained paths.** Every file write is a temp file, an fsync and a rename. A path that would leave the project folder, including through a symlink or a junction, is refused.
- **The confirmation is the host's word.** The server cannot see a person click accept. It checks that the answer is for these arguments and that it was not replayed. On a 2025-era connection the question waits 60 seconds, and the dialog text and the `initialize` instructions say so. After that the call returns an error result from the SDK ("Fulfilling input required by 'tools/call' failed: Request timed out"), nothing is written, and calling again asks a new question; an answer that comes late has no question to answer and is dropped. A host that keeps sending progress while its dialog is open keeps the wait alive. The 2026-07-28 path and stdio hold no connection open and keep the SDK's own wait. The bearer token is the boundary; the dialog is the host's promise to the user.
- **The bundle has no network listener.** Installed as a `.mcpb`, the server runs over stdio, and the host's process boundary stands in for the token.

## Known gaps

These are stated, not hidden. Each is a behaviour a reader of the code could otherwise take for a feature.

- **Model-backed tools are not listed.** The eight tools named under The tools need a provider key, and this server holds none. They return in a build that wires them to a provider.
- **A 2025-era connection ends with the server.** The connections live in this process. A restart closes every one of them, and the host has to `initialize` again. A host that never sends a session id is served statelessly, and it cannot be asked a question, so it is refused the writes that ask. A 2026-07-28 host has no connection to keep, so nothing changes for it.
- **The `.mcpb` bundle has not been run in a real host.** The manifest is checked by the pinned MCPB CLI, the pack is tested end to end, and the write setting is read from `CAOTANG_MCP_ALLOW_WRITES`, where only the exact value `true` turns writes on. The step that depends on the host is the substitution of `${user_config.allow_writes}` into that variable. A host that substitutes something else leaves writes off, which is the safe direction.
- **The bundle is not signed.** `mcpb sign` needs a signing key that the project does not hold.
- **The desktop app can still replace what another program wrote, in two cases.** Saving a project folder from the desktop app checks first, as the server does. It asks when `.caotang-mcp.lock` is in the folder, when `caotang.json` is no longer the text the app last loaded or saved from that folder, when a document or codex file has changed, been removed or been added since then, and when the folder holds a project the app never loaded. The question names each changed document by its title and each codex entry by its name. "Save anyway" overrides the lock. "Save over them" and "Save over it" write the app's copy over the changed documents and codex entries, and replace a changed or unknown manifest, which is kept as a backup. The text of a replaced document is not kept as a backup. A lock left by a server that has died looks the same as a live one, so the question cannot tell them apart. After a save the writer confirms over a change this server made, the server refuses its later writes until it is restarted, because its copy no longer matches the folder; reads still work. The two limits are these. The check and the write of each file are separate steps, so a change made to a file between its check and its rename is replaced. And the findings file, `coherence.json`, is written into an open folder as findings change, without these checks (the server's own check of that file is described under **The findings file**). Keep the server stopped while the app saves to the same folder, or check each answer before saying yes. The server's undo history is not reachable from Caotang either.
- **The desktop app does not see a scan until the folder is opened again.** The server reads `coherence.json` when it opens the project, so a scan finds the findings and dismissals the app saved and reuses their ids. With `--allow-writes` it saves its runs and `fixed` marks to that file. An app that already has the folder open does not pick them up live; it reads the file when the folder is opened again. Live pickup is a follow-up, tied to the Tauri desktop work (#16).
- **No recovery.** A folder whose `caotang.json` is unreadable is refused at start. Open it in Caotang, which offers the recovery ladder with consent; the server does not recover on its own.
- **A lock whose body cannot be read refuses the folder until a person clears it.** A writer that is killed between creating the lock and writing its body leaves a lock file of zero bytes, and nothing says whose it is, so it is never taken over: the age of a file proves nothing, because a write that is slow looks exactly like a file left behind. The refusal names the lock file and says how to clear it, and the folder opens again once that file is deleted and no other Caotang or MCP process is using the folder.
- **`notes.append` is not idempotent across HTTP retries.** The server keeps no state between requests, so a retried request is a new call. The harness's replay cache covers one confirmation round trip, not two separate requests.
- **Confirmations do not survive a restart.** The round-state key is random per process, so a restart ends every open confirmation. The safe failure is the one that happens: a confirmation the server cannot verify is never acted on.
- **One client refusal has no test.** The client refuses a request to an address outside the connected server, and that refusal is not covered by a test: the SDK only ever asks for the server's own URL, so the refusal cannot be reached from outside the module. The behaviour is in the code; what is missing is the test that would keep it there. The client's egress allowlist, its CORS/network probe split and its answered-revision helper are covered by the client's own suite.

## Layout

| File | What it is |
|---|---|
| `src/node-fs.ts` | The store's `ArtifactFs` port on `node:fs`: atomic writes, root containment. |
| `src/lock.ts` | The single-writer lock. |
| `src/session.ts` | Open, create (refused over another project's files), load, the exporter and harness wiring, the write queue, and the check that the folder still holds what this server last wrote. |
| `src/attribution.ts` | Tags the rows of a confirmed write `mcp` (see the note in the file). |
| `src/confirm.ts` | The round state, the argument digest, the dialog text, the replay ledger. |
| `src/guard.ts` | Refusals before the SDK: hard-deny and read-only writes. |
| `src/tools.ts` | The harness registry as MCP tools, and the confirmation round trip. The one presentation rule is that `tool.search` is not listed. |
| `src/server.ts` | The HTTP listener (guards, token, the SDK's handler), the stdio transport, and the instructions the host reads at initialize. |
| `src/auth.ts` | The bearer token: minted or supplied, its length rule, and the constant-time comparison. |
| `src/version.ts` | The server's version, as a client is told it, and the MCP endpoint path. |
| `src/index.ts` | The package's exports, for a test or a host that embeds the server. |
| `src/legacy-sessions.ts` | The 2025-era connections over HTTP: one stateful transport per `Mcp-Session-Id`, bounded in number and closed when idle. |
| `src/cli.ts`, `src/bin.ts` | The command line (including `CAOTANG_MCP_ALLOW_WRITES`) and the bundle's entry point. |
| `vite.config.ts` | Builds `dist/caotang-mcp.mjs`. |
| `manifest.json` | The MCPB manifest for the `.mcpb` bundle. |
| `scripts/pack-mcpb.mjs` | Stages, checks, validates and packs the `.mcpb` bundle, through the pinned MCPB CLI. |

## Tests

```sh
pnpm exec vitest run packages/mcp-server
```

The suite runs against the real MCP client over Streamable HTTP on an ephemeral loopback port, and against the built bundle as a child process over both HTTP and stdio. The pack tests run the pinned MCPB CLI, validate the manifest, and unpack the archive they made. Nothing is mocked: the project is written by the store, and the client is the SDK's own.
