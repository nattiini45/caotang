# `@caotang/mcp-server` — Caotang as an MCP server

Caotang's tool registry, served to an outside agent over MCP, with the project's text as resources and the writer's workflows as prompts: the same tools, under the same names, descriptions and schemas, through the same command bus and the same permission gate. The design is [extensibility.md §9](../../docs/architecture/extensibility.md). The tool list is in [The tools](#the-tools) below, and it is the list a host sees.

It is **read-only by default**. Writes are exposed only when the project is opened with `--allow-writes` (or `CAOTANG_MCP_ALLOW_WRITES=true`). Then sixteen tools write: seven apply their change at once, and nine ask the user to confirm each call in the host before anything is written. The tables under [The tools](#the-tools) say which is which.

## Build

```sh
pnpm --filter @caotang/mcp-server build      # writes dist/caotang-mcp.mjs
pnpm --filter @caotang/mcp-server run pack       # builds, then writes dist/caotang-mcp-<version>.mcpb
```

`dist/caotang-mcp.mjs` is one file: the workspace packages and the MCP SDK are inlined, so it runs with a plain `node` (the workspace's `engines` range, Node 22.12 or a later supported release). Nothing else needs to be installed next to it, except the two fonts below for a PDF that needs them.

The two PDF exports (the screenplay PDF and the storyboard contact sheet) set text Helvetica or Courier Prime cannot print in fallback fonts, and both PDFs share the same files: `NotoSansMonoCJKsc-Regular.woff` (Noto Sans Mono CJK SC, `@caotang/font-noto-cjk`, 10,692,940 bytes, with the regional forms of Han characters) and `NotoSansMonoCJKsc-Regular-common.woff` (the same font cut to the characters of everyday use, 1,956,568 bytes), `NotoSansMonoCJKsc-Bold.woff` and `NotoSansMonoCJKsc-Bold-common.woff` (its Bold, 10,786,312 and 1,968,608 bytes, for text outside Latin script in the contact sheet's title, page label and number chips), `NotoEmoji-Regular.woff` (Noto Emoji, `@caotang/font-noto-emoji`, 579,236 bytes) and `NotoEmoji-Regular-common.woff` (the single-code-point emoji and the keycaps, 298,992 bytes), `NotoSansArabic-Regular.ttf` (Noto Sans Arabic, `@caotang/font-noto-arabic`, 142,140 bytes) `NotoSansHebrew-Regular.ttf` (Noto Sans Hebrew, `@caotang/font-noto-hebrew`, 16,836 bytes) and `NotoSansDevanagari-Regular.ttf` (Noto Sans Devanagari, `@caotang/font-noto-devanagari`, 184,228 bytes). The server reads each only for a PDF that holds such text: from `fonts/` beside the bundle, then from its package in a checkout. For the CJK and emoji fonts it reads the common file when every character the PDF sets in the font is in it, and the full font when any one is not; the PDF holds the same glyphs either way.

The contact sheet draws a WebP picture by decoding it to PNG with `@jsquash/webp`. Its decoder, `webp_dec.wasm` (137,960 bytes), is read from beside the bundle, then from the package in a checkout. An animated WebP is not decoded: its cards show the caption.

`pack` makes the MCPB bundle a host can install. The bundle holds `server/caotang-mcp.mjs`, `server/fonts/NotoSansMonoCJKsc-Regular.woff`, `server/fonts/NotoSansMonoCJKsc-Regular-common.woff`, `server/fonts/NotoSansMonoCJKsc-Bold.woff`, `server/fonts/NotoSansMonoCJKsc-Bold-common.woff`, `server/fonts/NotoEmoji-Regular.woff`, `server/fonts/NotoEmoji-Regular-common.woff`, `server/fonts/NotoSansArabic-Regular.ttf`, `server/fonts/NotoSansHebrew-Regular.ttf` and `server/fonts/NotoSansDevanagari-Regular.ttf` (26.6 MB together: 13.9 MB before the CJK Bold, which adds 12.8 MB; the bundle held four font files and 25,065,212 bytes before the two PDFs shared one of each), `server/webp_dec.wasm`, `THIRD-PARTY-NOTICES.md` for the bundle's dependencies, and the repository's `LICENSE`. The pack script stages those files, checks the manifest against the bundle (its version, its entry point, the arguments, and the write setting), validates it and packs it with the MCPB CLI this package pins (`@anthropic-ai/mcpb`, an exact version). It then reads the result back. The bundle is not signed.

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
| `--create <name>` | Make a new project named `<name>` when the folder holds no `caotang.json`. Ignored for a folder that already has one. **Refused, with the folder unchanged, when the folder holds document or codex files** (a body file in `docs/` named by a document id, such as `docs/n_*.md`, and `codex/c_*.md`) **or a manifest copy** (`caotang.json.*`): a new manifest would not own them, and its first save would delete them. Open such a folder in Caotang, which recovers a project whose manifest is lost, then start the server without `--create`. A `caotang.json` that exists but cannot be read is not replaced either: the server starts without a project and offers its recovery (see [A project that will not open](#a-project-that-will-not-open)). |
| `--allow-writes` | Let external callers change the project. Off by default: the server is read-only. The environment variable `CAOTANG_MCP_ALLOW_WRITES=true` does the same; only the exact value `true` counts. |
| `--port <n>` | The loopback port for Streamable HTTP. Default `7433`; `0` picks a free one and prints it. |
| `--token-env <VAR>` | Read the bearer token from this environment variable. Default `CAOTANG_MCP_TOKEN`. |
| `--stdio` | Serve over stdin and stdout instead of HTTP. No port and no token: the host's process boundary stands in for both. |

`caotang mcp serve ...` (the `caotang` command of `@caotang/cli`) takes the same flags and runs the same server; `caotang-mcp` stays the bin of this package and of the `.mcpb` bundle.

Every line the server writes goes to **stderr**. In `--stdio` mode stdout carries only the protocol.

At start one line says how `CAOTANG_MCP_ALLOW_WRITES` was set: `is unset`, `is "true"`, `is "false"` or `is other (not "true", so it does not turn writes on)`. It never prints the value itself, so a host that passes a template it did not fill in shows as `other`.

The server holds a single-writer lock, `.caotang-mcp.lock`, in the project folder while it runs, and removes it on exit. A second writer on the same folder is refused with exit code 3. A lock left behind by a process that has died is taken over, and that takeover is marked by `.caotang-mcp.lock.takeover` beside it, so that only one writer takes it over. A lock whose body cannot be read is not taken over: nothing says whose it is, so a writer that is writing it right now would lose it, and the age of a file proves nothing. The folder is refused, and the refusal names the lock file and says how to clear it. A marker is named in the refusal that is about it: the refusal for a live holder names the marker beside that lock, and the refusal for a takeover that is marked names the marker itself. Either way the refusal says which of the three states the marker is in: when the writer that marked it is still running, it says to wait for it to finish; when the marker is being written right now, it says to wait a moment for it to finish; when it is an orphan, it says to delete the file, once no other Caotang or MCP process is using the folder. Deleting the orphan marker is what lets a writer take the lock over. A refusal about a lock whose body cannot be read names that lock and not the marker beside it, because the lock is what the folder is refused for. A folder that holds the marker alone is not refused: the lock is taken, and the marker is left where it is. The lock is advisory: it stops another instance of this server, and a script using `@caotang/sdk`, which takes the same lock. The Caotang desktop app reads it and asks before it saves over it, but a program that reads neither can still write the folder (see Known gaps).

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

These are the tools a host lists, measured from `tools/list` on a server started with each setting. The annotations and descriptions are the harness's registry-to-MCP mapping ([extensibility.md §7](../../docs/architecture/extensibility.md)), unchanged. Two things differ from the whole registry: `tool.search` is not listed, and the tools that need a model are not listed; the host's model writes through a brief and an apply instead ([Drafting with the host's model](#drafting-with-the-hosts-model)). The empty-project note of `project.overview` is the harness's own, and it names a write tool only to a caller whose server allows writes.

**Read-only server (10 tools), and always:**

| Tool | Risk |
|---|---|
| `project.overview` | read |
| `binder.read_tree` | read |
| `doc.read` | read |
| `notes.read` | read |
| `codex.read` | read |
| `coherence.scan` | read |
| `dialogue.table` | read |
| `memory.read` | read |
| `scene.brief` | read |
| `dialogue.brief` | read |

**With `--allow-writes` (26 tools):** the ten above, and:

| Tool | Risk | What the host does |
|---|---|---|
| `meta.set`, `notes.append`, `synopsis.set`, `filter.save`, `goal.save`, `coherence.setFindingStatus`, `shots.annotate` | write-auto | Applies at once when the call arrives. |
| `binder.restructure`, `codex.write`, `codex.import`, `doc.import`, `export.compile`, `notes.replace`, `vocabulary.upsert`, `scene.apply`, `dialogue.apply` | write-confirm | Asks the user to confirm each call (its description starts "Requires user confirmation."), and writes nothing if the answer is not an accept. |

`export.compile` writes any format in the list into `exports/`. It takes the project's identifier, language, author and cover through the mapping the desktop app's exporter uses (`exportMetadataOf`), and the images under `assets/` that a shot list or a prompt pack names (`assetRecordsOf`), so one project writes the same book and shot list from either host. An EPUB compiles here for any project. A project that predates the identifier is given one when it opens, but this server does not save on open: the identifier is stored by the first save of the folder, which is a write or a compile that succeeds, and the book that compile writes carries the identifier it stores. A prompt pack names its vendor template in `template`, or the recipe does, and a call that names neither is refused before the dialog. So is a compile the exporter's own gates would refuse for its selection: a screenplay format (Fountain or Final Draft) with no scene, an Ink story or a dialogue table with no dialogue container, a shot list with no shot, and an EPUB with no identifier. Each is refused with its reason, nothing is written, and the writer is not asked. A call can name a saved recipe with `recipeName`: the recipe supplies the title page, contents, author, character limit and template, and, when `selection` is left out, the nodes it compiles (the manuscript, or the part the recipe names). A folder whose images cannot be listed refuses a shot list (CSV or XLSX) or a prompt pack, the three formats that name images, with the reason, so no shot list is written with its images named as missing; the other formats still compile.

**Output schemas.** Every tool listed here declares an `outputSchema`, so a host that types tool output can read an answer's shape before it calls. The schema is the envelope `structuredContent` carries: `{ summary, data, affected, undoGroupId?, notes? }`, where `data` is the tool's own result schema (the registry's `resultSchema`, [agent-harness.md §3](../../docs/architecture/agent-harness.md)), or, when the host declined or cancelled a confirmation, `{ status, written: false, tool }`. A refusal sets `isError` and carries `{ error }`, which a client does not check against an output schema. The two recovery tools of a server that could not open its project (below) are not registry tools and declare none. `test/output-schema.test.ts` round-trips real results, a declined confirmation included, through the SDK's own client, which checks each against the advertised schema.

**Not listed, in any mode:**

- `agent.plan` is protocol, not a tool.
- `project.deleteNode` is hard-denied: it is refused whatever the caller asks, in every mode, with the bus's own message.
- `memory.write` and `instructions.propose` are not listed either. The writer's `CAOTANG.md` and the agent's memory notes are readable here (`memory.read`, and every prompt carries them), and they change in the app, at a card: a rule or a memory is a standing instruction, so no `--allow-writes` hands it to a host. `memory.forget` is the writer's alone and is hard-denied.
- `tool.search` is not listed. It searches the tool servers Caotang's own MCP client connects to, and this server connects to none, so the tool could only report that.
- The eight tools that need a model are not listed, because the server holds no provider key: `scene.draft`, `synopsis.fill`, `continuity.scan`, `coherence.review`, `shots.derive`, `prompt.draft`, `prompt.variant` and `dialogue.draft`. The host's own model does the writing for two of them, through `scene.brief` and `scene.apply`, and `dialogue.brief` and `dialogue.apply`. The other six have no pair yet.

## Resources

The project's text, for a host that lets the writer attach it: `@caotang:caotang://doc/…` in Claude Code, the resource picker in Cursor and VS Code. A resource is something the writer chose, so it is the **whole** body; the 25,000-token cap of `doc.read` is for what a model is handed on its own. The design is [extensibility.md §9](../../docs/architecture/extensibility.md).

| URI | MIME | What |
|---|---|---|
| `caotang://project` | `text/markdown` | The overview: title, size, and the binder's first two levels with the ids to read by. |
| `caotang://binder` | `application/json` | The `binder.read_tree` data, root to depth 3, with word counts. |
| `caotang://codex` | `application/json` | The codex index: id, name, type, aliases, include policy. |
| `caotang://doc/{id}` | `text/markdown`, `text/x-fountain` (a screenplay), `text/plain` (a dialogue container's Ink) | A document's body, whole. |
| `caotang://notes/{id}` | `text/markdown` | A node's synopsis, notes and keywords. |
| `caotang://codex/{id}` | `text/markdown` | A codex entry, with its whole description. |

- **Ids only.** A URI names a node or an entry by its id, never by a file name or a title.
- **Listed in a fixed order.** `resources/list` gives the three fixed URIs, then the documents in binder order and the codex entries in codex order; two lists of one project are byte-identical. Notes are read by the id of a listed node and are not listed. The templates complete on a title or a name and return ids.
- **Never cut.** A body over 2 MiB (`RESOURCE_MAX_BYTES`) is refused with its size named. An unknown id, or a folder where a document is wanted, is refused with `-32602` and the words `doc.read` uses.
- **Cached privately, not at all.** Results carry `cacheScope: "private"` and `ttlMs: 0`.
- **Reading never writes.** A resource read saves nothing, with or without `--allow-writes`, and writes no log row.
- **Subscriptions, with `--allow-writes` only.** A read-only server reports `resources.subscribe` and `resources.listChanged` as `false`, because its resources cannot change while it runs. With writes on, a `notes.append` sends `notifications/resources/updated` for `caotang://notes/{id}` to a host that subscribed (a `subscriptions/listen` stream on 2026-07-28, `resources/subscribe` on a 2025-era connection or over stdio), and a create, move or rename sends `list_changed`. The notice is sent after the save. **The server does not watch the folder:** a change another program makes stops the server's writes, and the server says so once with a `list_changed`, so a subscribed host reads again.
- **No findings resource yet.** Open coherence findings wait for the server to serve them in a form a host can attach.

## Drafting with the host's model

`scene.draft` and `dialogue.draft` need a model, and this server has none. The host has one. So each is split into a **brief**, which returns what Caotang's tool would send its model, and an **apply**, which takes what the host's model wrote and puts it in the project through the same checks Caotang's own tool uses. The design is [agent-harness.md §3, "External-only rows"](../../docs/architecture/agent-harness.md). The server holds no key, makes no model call and does not use MCP sampling.

| Brief (read, every mode) | Apply (write-confirm, `--allow-writes`) | Takes |
|---|---|---|
| `scene.brief` | `scene.apply` | The brief takes the arguments of `scene.draft`. The apply takes `doc`, `text`, `mode`, `selection` for a rewrite, and `briefId`. |
| `dialogue.brief` | `dialogue.apply` | The brief takes the arguments of `dialogue.draft`. The apply takes `doc`, `ink`, `fromBeats` and `briefId`. |

1. The host calls the brief. The answer holds `messages`: the system message and the user message that `scene.draft` sends in the app for the same request, as it would in the first turn of a session with the default context budgets. They differ in one thing: `CAOTANG.md` and the memory index sit in an `<<untrusted …>>` envelope, whose id is the fixed `000000000000` in a brief and the turn's own in the app. A later turn in the app also carries the earlier turns, and a loaded skill adds its block, so those are not in the brief. They carry the writer's `CAOTANG.md` and memory index, the codex entries the scene mentions, the structure, the story so far and the focus text, within the budget. `droppedContext` says what the budget left out. `reply` says how to answer, `applyWith` holds the arguments to pass on, and `briefId` ties the two calls together.
2. The host's model writes from `messages`.
3. The host calls the apply with `applyWith` and the text. The server checks the `briefId`, then runs the text through the same checks as `scene.draft`, and the user confirms in the host, as for any write that asks.

- **A brief is refused when `scene.draft` would be**, in its words: `mode: draft` on a document that has text, a rewrite with no selection, a selection that cannot be found. A part of the project a read rule keeps from the agent is left out of the messages, and a brief of it is refused.
- **The handle goes stale.** A `briefId` is kept in memory for 30 minutes (the last 64), and a restart forgets it. An apply is refused, before the host is asked, when the id is unknown or expired, belongs to another document, mode or selection, or when the document changed since the brief. The refusal names the document by its title and says to ask for a new brief. The text is written against the revision the brief saw, so the caller cannot supply another.
- **The confirmation names the title and the change in words, and nothing else:** "continue "The Landing" (+120 words)". The text is the call's arguments, which the host shows with its tool call. **The confirmation is not a review**: a host may show the user nothing, or the user may accept without reading. Undo is the safety net: the apply is one undo group, and it restores the document as it was.
- **There is no overwrite.** `draft` writes into an empty document, `continue` appends, `rewrite_selection` replaces the selected passage. A reply of more than 16,384 characters (about the most a model call produces in the app) is refused and never cut. Ink that does not compile is refused with the compiler's words, and the brief still stands for a second try.
- **The context is the writer's text.** The brief's `framing` says so, but a manuscript, a note or a codex entry can hold words aimed at a model, and the host's model reads them. Only `CAOTANG.md` and the memory index are marked as outside text in an envelope; the rest is not. This is the same risk as a resource or a prompt, and no filter removes it: read what the model wrote before you accept.
- **The record is `source: "mcp"`.** The activity log marks the rows as it does for any external write. It does not name the host.

## Prompts

Five prompts, listed in every mode. Each runs Caotang's own context assembly ([context-assembly.md](../../docs/architecture/context-assembly.md)) on the same task the in-app tool builds, and returns it as a prompt for the host's model: the codex entries the scene mentions, the structure, the story so far and the focus text, within budget. **Nothing on this server calls a model, and it holds no key:** the host's own model does the writing.

| Prompt | Arguments | What it asks the host's model |
|---|---|---|
| `draft-scene` | `doc`, `instruction`, `mode?` (`draft`, `continue`, `rewrite_selection`) | To draft, continue or rewrite a scene. `draft` needs an empty document, as `scene.draft` does. |
| `fill-synopsis` | `doc` | To write the document's synopsis. |
| `continuity-check` | `scope?` (a part or folder; else the manuscript; at most 20 documents) | To report continuity problems. |
| `codex-from-doc` | `doc` | To list the codex entries the document introduces that the codex lacks. |
| `revise-with-codex` | `doc`, `instruction` | To rewrite the whole text to a brief, with the codex it mentions. |

- **A closing line says what to do with the result.** With `--allow-writes` it names the tool that stores it (`doc.import` into a new document, `synopsis.set`, `codex.write`), and the host's own confirmation applies as for any write; on a read-only server it says the server is read-only and the result is shown to the writer.
- **A prompt refuses what the tool would refuse**, in the tool's words: a folder where a document is wanted, or `mode: draft` on a document that has text.
- **The budgets are the defaults.** The writer's in-app context budgets live in the browser, not in the project folder, so the server uses `ContextConfig`'s defaults.
- **Manuscript text goes to the host's model.** That is the writer's own host and choice, as it is when a model calls `doc.read`.

## A retried write

A host that times out on a write and sends it again would make a second, real write: each request is its own turn, so the bus's replay cache, keyed on a turn and call id the server minted, never sees a retry. A caller that wants a retry to write once sends a key in the request's `_meta`:

```json
{ "name": "notes.append", "arguments": { "doc": "n_…", "text": "…" }, "_meta": { "app.caotang/idempotencyKey": "9f2c…" } }
```

The prefix is the project's reverse-DNS name and the name is what the caller varies. A key without the prefix is not a valid `_meta` key name, and a `io.modelcontextprotocol/*` name is the SDK's, never a key.

- **Only the seven write-auto tools read it** (`meta.set`, `notes.append`, `synopsis.set`, `filter.save`, `goal.save`, `coherence.setFindingStatus`, `shots.annotate`). A read has nothing to repeat, and a write-confirm call takes its call from the sealed confirmation state, so it ignores the key.
- **A repeat is the first answer.** The same key with the same tool and arguments, within 5 minutes, gets the first answer and writes nothing. A repeat that arrives while the first write is still being saved waits for it and gets the same answer.
- **A reused key is refused, not merged.** The same key with other arguments, or for another tool, is an error that names both calls, and writes nothing.
- **A refusal is not kept.** A call the harness refused wrote nothing, so the same key can be sent again and may succeed. A failure after the change was made (a save that failed) is kept, because running it again would write twice.
- **Optional.** A request without a key, or with a blank key, one over 128 characters, or one that is not a string, is a new call, as before. The tool's annotation stays `idempotentHint: false`: the tool is not idempotent by design, it is idempotent when the caller sends a key.
- **In this process only.** The answers can quote the writer's text, so they are held in memory and never written to the folder. A restart ends them, so the guarantee holds across a retry, not across a restart.

## Write-confirm across the boundary

A write-confirm call is not run on the first request. The server asks with an elicitation whose schema is exactly `{ confirmed: boolean }`: a 2026-07-28 host gets it as an `input_required` result, and a 2025-era host gets it as an elicitation request on its connection. The host shows that as a dialog, and the call runs only when the user accepts it:

- **Accept** runs the call once, and the change is written to the folder before the result returns.
- **Decline** or **cancel** writes nothing, and the result says `"written": false`.
- An answer applies only to the arguments it was asked about. A retry with different arguments is asked again.
- A replayed accepted retry is answered from the first answer and is not applied a second time. That holds when the replay arrives while the first is still being saved: it waits for the same answer. The replay is answered before the arguments are checked again, so a create the first accept made is not refused as a name already taken.

The confirmation text names the change in words, and it is made before the host is asked. The arguments are checked first, with the same checks the write would run, so a call that could not run is refused at once and the dialog never asks for it. The text names what the change touches: a document import shows its title, its word count and the title of its parent; a binder change names the first few nodes it moves, renames or adds, by their titles; a codex change names the first few entries by their names and types, and an update by the name the project holds for its entry; an export names its selection, its format and its recipe. It never carries a document body, an entry description or an alias. Those are the text the writer wrote, and an elicitation form never carries long private content.

## A project that will not open

A folder whose `caotang.json` does not parse, or fails the schema, does not end the server. The server keeps the folder's lock, walks the store's recovery ladder read-only (project-format §5: the snapshots `caotang.json.bak.1` to `bak.3`, then a rebuild from the documents' front matter), writes nothing, and starts **without a project**. It prints, on stderr, what the ladder found, the way forward, and that it holds the lock. A `caotang.json` that names another app or a newer format is still refused outright, with no ladder, as the app refuses it.

A degraded server lists these tools and no others:

| Tool | Listed | What it does |
|---|---|---|
| `project.recover` | always | Read. Shows the offer: the file the recovery would restore from, or that it would rebuild from the document and codex files, what a rebuild loses, whether it needs its own yes, and the files whose bytes are not UTF-8 (by name; they are reported, not rewritten). It never returns the unreadable manifest's bytes or any document text. |
| `project.recoverApply` | with `--allow-writes`, when there is an offer | Write-confirm. Applies the offer after the user accepts the host's dialog. |

Every other tool is refused as a tool result: "this project could not be opened; recover it first". The `initialize` instructions say the same. A folder with nothing to recover from (no snapshot, no document or codex file) gets the honest bound, "Caotang could not find a readable copy of this project", and no write tool.

**The dialog is the writer's yes, on three terms.** Its text is worded from the offer: it names the exact source file, the copy the unreadable manifest is kept as (`caotang.json.corrupt-<timestamp>`), the whole loss list, and that the server holds the folder lock. It carries no title and no document text. A **rebuild** loses the folder structure and the vocabulary, so it is a separate confirmation: a call without `rebuild: true` is refused with the loss named and nothing is asked, and `rebuild: true` is a different set of arguments, which the host's answer is bound to (see above). A snapshot restore's yes never covers a rebuild. A host that cannot be asked (it declared no elicitation, or sent no session) is refused and sent to the desktop app. No command-line flag is a yes.

**Before anything is written** the folder is checked against what the offer read: the text of `caotang.json`, and a digest of every document and codex file. If another program changed any of them, at the question or at the accept, nothing is written and the refusal names what changed. Then the store's `commitRecovery` writes the corrupt original to `caotang.json.corrupt-<timestamp>`, removes the path, and writes the recovered project as a new manifest. The corrupt bytes are not rotated into `bak.1`, so the snapshots stay where they were. The result names the source and the preserved copy, and so does a line on stderr.

**After a recovery the server holds no project.** It releases the lock, and every tool answers "recovered; restart or reconnect the server to open the project". The tool list does not change (`tools.listChanged` stays `false`), and the server does not swap a project in live. Restart `caotang-mcp`, or reconnect the host, which starts it again; the folder then opens as any project does.

## Security model

- **Loopback only.** The listener binds `127.0.0.1`. `Host` and `Origin` headers that are not localhost are refused with `403` (DNS rebinding and browser pages).
- **Bearer token** on every request, compared in constant time.
- **Read-only by default.** Write tools are not even listed without `--allow-writes`. A read never changes the manuscript, codex or manifest, with or without it. The server reads `coherence.json` when it opens, and without `--allow-writes` it writes nothing: a run that `coherence.scan` records stays in the server's memory, and a damaged `coherence.json` is not repaired. With `--allow-writes`, `coherence.scan` appends its run to `coherence.json`, and `coherence.setFindingStatus` keeps `fixed` there, as derived state like `sessions.jsonl`.
- **Bounded 2025-era connections.** A 2025-era connection is held in memory only while the host keeps it. At most 16 are held, a connection idle for 30 minutes is closed, and a connection with a confirmation still open is never closed to make room. That confirmation waits 60 seconds for its answer, then the connection is free again. A new host is refused with `503` while every connection is busy; the refusal names the limit, how many are busy and the wait, and carries a `Retry-After` header of 60 seconds. A request on a session that has ended gets `404`, and the host sends `initialize` again. The table holds the connection and its server, never project data.
- **A recovery is the host's word, with the folder checked.** `project.recoverApply` exists only with `--allow-writes`, asks through the same confirmation round trip as every other write, and writes only the store's ladder (the new manifest and the kept original), after the drift check above. A degraded server runs no other tool, so it has no general file access.
- **The idempotency key is a handle, not a capability.** It grants no write access, which the bearer token and `--allow-writes` do. It only makes a repeat of one call write once, and a key reused for another call is refused.
- **Hard-deny is server-side.** `project.deleteNode` is refused by the guard before the SDK sees the request, so the refusal does not depend on what the host allows.
- **The project's agent rules bind the host.** The `agent.rules` in `caotang.json` (a folder marked **Agent: may read only** or **Agent: may not read** in the desktop app, and any `deny` or `ask` rule written there by hand) are read when the server opens the folder and given to the harness every tool call goes through. A `deny` refuses the call with the rule named and writes nothing. An `ask` on a write becomes the host's confirmation question, as a write-confirm tool's is. A folder the writer marked **Agent: may not read** is left out of `binder.read_tree`, `project.overview`, `codex.read`, the scans, `resources/list`, the resources and the prompts. If a rule in the file could not be read, the server refuses every write until the file is fixed and the server restarted, and a read still works. The server holds the rules as they were at start, so a rule added later takes effect at the next start. The writer's own rules in the desktop app's Settings are app settings and are not read here.
- **Saves check the folder first.** Before a save the folder must hold the `caotang.json`, document and codex files this server last loaded or saved (The save guard). A change by another program stops writes, and nothing it wrote is overwritten or removed.
- **Every external row is tagged** `source: "mcp"` in the activity log, including confirmed writes. A resource read or a prompt writes no row.
- **No key, no model call.** The prompts, the resources and the briefs are text built from the project. The server never sends the manuscript anywhere itself: a host reads it and passes it to the model the writer chose.
- **The host's text is checked, not trusted.** An apply is a write that asks: it runs only with `--allow-writes`, after the user accepts, with the mode rules, the anchor and the dialogue compile check of the in-app tool, at the revision the brief saw. A brief or an apply obeys the project's rules as `scene.draft` does (a read-deny keeps its nodes out of the brief, a write-deny refuses the apply). The handle holds a digest of the messages, never the messages.
- **Atomic writes, contained paths.** Every file write is a temp file, an fsync and a rename. A path that would leave the project folder, including through a symlink or a junction, is refused.
- **The confirmation is the host's word.** The server cannot see a person click accept. It checks that the answer is for these arguments and that it was not replayed. On a 2025-era connection the question waits 60 seconds, and the dialog text and the `initialize` instructions say so. After that the call returns an error result from the SDK ("Fulfilling input required by 'tools/call' failed: Request timed out"), nothing is written, and calling again asks a new question; an answer that comes late has no question to answer and is dropped. A host that keeps sending progress while its dialog is open keeps the wait alive. The 2026-07-28 path and stdio hold no connection open and keep the SDK's own wait. The bearer token is the boundary; the dialog is the host's promise to the user.
- **The bundle has no network listener.** Installed as a `.mcpb`, the server runs over stdio, and the host's process boundary stands in for the token.

## Known gaps

These are stated, not hidden. Each is a behaviour a reader of the code could otherwise take for a feature.

The real-host runs that would settle the two bundle gaps below are listed in [HOST-CHECKS.md](HOST-CHECKS.md); none has been run.

- **The server does not watch the folder.** A subscribed host hears of the writes this server made. A file another program changed is found only when the server next tries to save or to ask for a confirmation: the writes stop, and the server says so once. Until then the server, and a host that holds a resource open, still show the project as it was loaded.
- **A listening 2025-era connection is idle.** A connection that holds a subscription and an open stream has no request in flight, so the table can close it to make room for a new one, or after 30 idle minutes; the host has to `initialize` and subscribe again.
- **Model-backed tools are not listed.** The eight tools named under The tools need a provider key, and this server holds none. Two of them have a brief and an apply for the host's model ([Drafting with the host's model](#drafting-with-the-hosts-model)); the other six have none yet (synopses, continuity and coherence wait for the tools that store their results, #56 and #11; shots and prompts wait for a way to brief them).
- **No staged sessions.** Each apply is its own confirmation and its own undo group, so a run of several writes is as many questions. Staging a run as one change is specified and not built ([extensibility.md §9](../../docs/architecture/extensibility.md)).
- **How a host shows the confirmation is unchecked.** Whether a real host shows the call's arguments with the question, and accepts dotted tool names, has not been seen ([HOST-CHECKS.md](HOST-CHECKS.md)).
- **A 2025-era connection ends with the server.** The connections live in this process. A restart closes every one of them, and any confirmation open on one ends with it, with nothing written; the host has to `initialize` again and ask again. A host that never sends a session id is served statelessly, and it cannot be asked a question, so it is refused the writes that ask. A 2026-07-28 host has no connection to keep, so nothing changes for it.
- **The `.mcpb` bundle has not been run in a real host.** The manifest is checked by the pinned MCPB CLI, the pack is tested end to end, and the write setting is read from `CAOTANG_MCP_ALLOW_WRITES`, where only the exact value `true` turns writes on. The step that depends on the host is the substitution of `${user_config.allow_writes}` into that variable. A host that substitutes something else leaves writes off, which is the safe direction.
- **The bundle is not signed.** `mcpb sign` needs a signing key that the project does not hold.
- **The desktop app can still replace what another program wrote, but it keeps a copy.** Saving a project folder from the desktop app checks first, as the server does. It asks when `.caotang-mcp.lock` is in the folder, when `caotang.json` is no longer the text the app last loaded or saved from that folder, when a document or codex file has changed, been removed or been added since then, and when the folder holds a project the app never loaded. The question names each changed document by its title and each codex entry by its name. "Save anyway" overrides the lock. "Save over them" and "Save over it" write the app's copy over the changed documents and codex entries, and replace a changed or unknown manifest, which is kept as a backup. Each document or codex file the app replaces or removes, if it is not the text the app last wrote, is copied first to `.caotang-backup/<time>/<path>` in the folder; the newest 20 saves' copies are kept, and the directory is in no digest and no bundle. A lock left by a server that has died looks the same as a live one, so the question cannot tell them apart. After a save the writer confirms over a change this server made, the server refuses its later writes until it is restarted, because its copy no longer matches the folder; reads still work. What is left is this. The check and the write of each file are separate steps, and a browser has no compare-and-swap, so a change made to a file in the instant between its check and its rename cannot be prevented. The app narrows it: it reads the file's digest once more as it copies it, stops before the file if it changed, and after the save reads the folder's files, `caotang.json` and the lock again. A file changed meanwhile, or a lock that appeared, is named to the writer, and the app's next save asks about it and keeps the server's version. That is "reported, not lost" and not "prevented". The findings file, `coherence.json`, is written into an open folder only while it is the one the app last read or wrote (a digest held since then); a server write to it is not replaced, and the app says so in the Findings tab, keeping the findings in the browser. Before a confirmed overwrite, the app shows a compact line comparison for each readable document and codex entry: lines marked − are in the folder and lines marked + are in this tab. Long changed sections are shortened, inputs too large for a safe preview show a note, and the backup keeps the full folder file. The app does not merge the two versions. The server's undo history is not reachable from Caotang either.
- **The desktop app does not see a scan until the folder is opened again.** The server reads `coherence.json` when it opens the project, so a scan finds the findings and dismissals the app saved and reuses their ids. With `--allow-writes` it saves its runs and `fixed` marks to that file. An app that already has the folder open does not pick them up live; it reads the file when the folder is opened again. Live pickup is a follow-up, tied to the Tauri desktop work (#16).
- **A recovery ends with a restart.** After `project.recoverApply` the server releases the lock and holds no project; every tool says to restart or reconnect it. A live swap of the recovered project, with a `tools/list_changed` notice, is not built. A stateless 2026-07-28 request or a request with no session can see the offer and cannot apply it, because it cannot be asked: the refusal names the desktop app. There is no `--recover` flag: a flag cannot show the copy or the loss at the moment of choosing. The dialog wording has not been seen in a real host ([HOST-CHECKS.md](HOST-CHECKS.md)).
- **A lock whose body cannot be read refuses the folder until a person clears it.** A writer that is killed between creating the lock and writing its body leaves a lock file of zero bytes, and nothing says whose it is, so it is never taken over: the age of a file proves nothing, because a write that is slow looks exactly like a file left behind. The refusal names the lock file and says how to clear it, and the folder opens again once that file is deleted and no other Caotang or MCP process is using the folder.
- **A retried write is a second write unless the caller sends a key.** The server keeps no state between requests, so a retry that carries no `app.caotang/idempotencyKey` is a new call (A retried write). A host that mints a new key for each retry gets no protection.
- **Confirmations do not survive a restart.** The round-state key is random per process and nothing is written to disk, so a restart ends every open confirmation, on both paths. On the 2026-07-28 path a retry carrying the old `requestState` is refused with `-32602` "Invalid or expired requestState", the same answer as for an altered or expired state: the SDK gives the server no way to word it, so a restart is one of three causes it does not name. Nothing is written; ask for the change again. On a 2025-era connection the question is on the host's own connection, which ends with the process, and the answer gets `404` "Session not found" (the message says an open confirmation ended too); `initialize` again and ask again. The safe failure is the one that happens: a confirmation the server cannot verify is never acted on. A durable key is deferred (issue #92); the 2025-era path could never resume.
- **One client refusal has no test.** The client refuses a request to an address outside the connected server, and that refusal is not covered by a test: the SDK only ever asks for the server's own URL, so the refusal cannot be reached from outside the module. The behaviour is in the code; what is missing is the test that would keep it there. The client's egress allowlist, its CORS/network probe split and its answered-revision helper are covered by the client's own suite.

## Layout

| File | What it is |
|---|---|
| `@caotang/sdk/folder` | Not in this package: the Node folder session this server shares with the SDK moved to `packages/sdk`. `node-fs.ts` (the store's `ArtifactFs` port on `node:fs`: atomic writes, root containment), `lock.ts` (the single-writer lock), `coherence-file.ts` and `folder.ts` (open, load, the exporter with its font loaders, the write queue, and the check that the folder still holds what this server last wrote) live there. |
| `src/session.ts` | Open (and create, refused over another project's files) through that session, the harness (`createProductHarness` with `ports: 'external'`), the posture, and the two ways a call reaches the project. |
| `src/attribution.ts` | Tags the rows of a confirmed write `mcp` (see the note in the file). |
| `src/recovery.ts` | A folder whose `caotang.json` will not load: the degraded session that holds the lock and the store's offer, `project.recover` and `project.recoverApply`, the drift check, and the words of the refusals, the question and the instructions. |
| `src/confirm.ts` | The round state, the argument digest, the dialog text, the replay ledger. |
| `src/guard.ts` | Refusals before the SDK: hard-deny, read-only writes, and every other tool on a degraded server. |
| `src/resources.ts`, `src/uris.ts` | The resources: their URIs, lists, completions, whole-body reads, and which resources a log row changes. |
| `src/prompts.ts` | The five prompts: their tasks (the harness's own task builders), the assembly, and the closing line. |
| `src/changes.ts`, `src/subscriptions.ts` | The change feed the session announces to after a save, and its delivery to a `subscriptions/listen` stream or a 2025-era subscriber. |
| `src/tools.ts` | The harness registry as MCP tools, and the confirmation round trip (`confirmRound`, shared with the recovery). The one presentation rule is that `tool.search` is not listed. |
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
