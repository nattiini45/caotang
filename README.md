# Caotang

Caotang is a writing studio for novels and other long fiction. Your manuscript stays on your machine. An AI agent can work in it too. Plans and drafts wait for your approval, small changes apply at once, and each recent turn can be taken back within the checkpoint limits in Settings.

Caotang has the structure Scrivener writers know: a binder of chapters and scenes, a corkboard, an inspector, a codex of characters and places, and a compile step that writes Word, EPUB, Markdown or plain text. It also has editors for screenplay scenes (Fountain), branching dialogue (Ink) and storyboards with video prompt packs, and the compile step writes their formats too. The difference is the agent. Bring your own provider key and it works through the app's own commands. It proposes a plan, you approve or change it, and each turn that changes the project leaves a checkpoint you can restore, within the limits in Settings.

Try it at [caotang.app](https://caotang.app/), or open the app directly at [caotang.app/app](https://caotang.app/app/).

Caotang is free and MIT-licensed. There are no accounts, no subscriptions, no credit meters and no Caotang server. If you use a model provider, you pay that provider directly.

## What works today

- **Projects.** Create, open, rename and remove projects in your browser. Set the title, author, language, ISBN and cover. Export a project as a `.caotang` bundle and import one back. In Chrome or Edge, open a project folder or save to one. A folder of a project this browser already keeps opens as that project when it holds the same book, and a folder of a project another tab has open is refused. Caotang asks before it saves over a change it did not make, or before it writes back a `caotang.json` that another program removed. A folder's writing sessions come into this browser when you open it.
- **Binder.** A manuscript of chapters and scenes, and a research section that is never compiled. Drag to reorder, rename, set a status or a label, delete and undo. A filter bar (text, status, label, word counts, keywords and recent dates) with saved filters, and a footer with word goals, a sprint timer, a writing history and the words a stopped tab kept.
- **Corkboard.** The scenes of a chapter, or the chapters of the manuscript, as cards in three sizes. Drag to reorder.
- **Inspector.** Synopsis, notes, keywords, status and label, codex links and scene declarations for the selected item, and the container settings of a dialogue.
- **Editor.** Scenes are Markdown and save as you type. Word counts, a daily target and focus mode. Agent drafts appear in the scene first, in a preview bar.
- **Screenplays.** A scene is Fountain, with a Script view, a Source view and a Pages view, which opens a line in the Source view. Import a `.fountain` or `.fdx` script as sections and scenes. Final Draft files have not yet been checked against Final Draft itself.
- **Dialogue.** A container is an Ink story, with an outline, a branch graph, findings and line ids. Import a `.ink` story as one container for each group of knots that divert to one another, or a Twee 3 story (`.twee`) as one container, after a report of the logic the import strips.
- **Storyboards.** Shot cards with pictures (chosen, dropped or pasted), an animatic total, script coverage, a prompt for each target video model, and a prompt pack that exports as JSON, Markdown or CSV.
- **Codex.** Characters, locations, objects, lore, subplots and other entries, with aliases, include policies, excluded phrases and a list of the documents each name appears in.
- **Agent instructions and memory.** Your standing instructions live in `CAOTANG.md` at the root of the project and ride every request, within a visible 1,500-token limit; the notes the agent keeps are plain files in a `memory` folder you can read, edit and forget. The agent writes either only behind a card you approve.
- **Skills.** Reusable writing instructions for the agent ("draft in close third person"), kept in the project as standard Agent Skills folders other tools read too. You read and approve each skill before the agent is told about it, and a change asks again. A skill guides the agent and changes nothing about what needs your approval.
- **Findings.** A quick scan of the manuscript against the codex and the scene declarations, and a model review that runs only after you approve its plan. Findings are grouped by severity and quote their passages. Dismiss one with a reason, mark it fixed, or send it to the agent with **Fix with agent**. The run history keeps each run.
- **Agent.** Plans, one-step cards and draft previews in the agent panel, with checkpoints and restore. Stop a running turn, steer it with a note, or queue your next message while it works. A **Mode** control sets who answers its cards: Plan only, Ask (the default), Accept edits or Auto, with limits that stop a turn on a question. A plan that needs five or more model calls can run in the background while you write, and you review what it drafted before anything is applied. For a long reading job it can hand the reading to a helper agent, which only reads and suggests; a suggestion happens only if it is in the plan you approve. It runs on presets for the major providers (Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, OpenRouter and more) or any OpenAI-compatible endpoint you add, or on the built-in demo provider with no key. It uses native tool calling where the model supports it, and can run the model review as a plan step, and call the tools of the MCP servers you connect and enable (see below).
- **Export.** Markdown, plain text, Word (`.docx`) and EPUB, for the whole manuscript or one part of it. For screenplays, dialogue and storyboards: Fountain, Final Draft (`.fdx`, not yet checked in Final Draft itself), a paginated screenplay PDF, an Ink story, a dialogue table, a shot list and a storyboard contact sheet (PDF, also as blank numbered frames to draw in, with photographs of the drawings dropped back on their shots). Also a coherence report. Recipes keep your export settings.
- **Settings.** Provider profiles, the agent's context budgets, the daily target and autosave delay, coherence checks, light and dark themes, checkpoint limits, **MCP & tools**, and data.
- **MCP & tools.** Settings can connect external [Model Context Protocol](https://modelcontextprotocol.io) servers over Streamable HTTP. Each server's tool list is reviewed before its tools are used, and a tool can be switched off. The agent calls an enabled tool at once only when its server is trusted for reads and the tool is read-only. Any other call waits for your approval.
- **Caotang as an MCP server.** Other AI tools can read a project folder, attach its documents, notes and codex as resources, and run prompts that carry the context Caotang gathers for a scene. With writes allowed, they can change it, and each change that asks is confirmed in the host. See [Caotang as an MCP server](#caotang-as-an-mcp-server).

Not in this build yet: the desktop wrapper. [docs/USER-GUIDE.md](docs/USER-GUIDE.md#what-is-not-in-this-build-yet) lists it with the rest, and [docs/ROADMAP.md](docs/ROADMAP.md) has the order.

## Requirements

- **Node.js.** The `engines` field of [package.json](package.json) allows Node 22.12 or later in the 22 line, 24.x, and 26 or later. Continuous integration tests the 22.12.0 floor and Node 24; Node 26 is allowed but not covered.
- **pnpm** 12.9.1, pinned in `packageManager`. With Node 22.12.0, update Corepack first with `npm install --global corepack@0.34.3`; the bundled Corepack 0.29.4 cannot verify pnpm's current signing key. Then run `corepack enable`.
- **A browser.** The app is written for current browsers. End-to-end tests gate every pull request in Chromium, Firefox and WebKit; the Firefox and WebKit suite also runs nightly and on demand. Opening and saving a project folder needs Chrome or Edge, or another Chromium-based browser. Bundles work in any browser.
- **A window at least 960 px wide.** The layout is made for that width, and a narrower window scrolls rather than overlapping. Under 1100 px the toolbar wraps onto a second row and the side panels narrow.

## Install and run

From the repository root, after you clone it:

```sh
pnpm install
pnpm dev
```

`pnpm dev` serves the app at http://127.0.0.1:5173.

For a production build, run `pnpm build`, then `pnpm --filter @caotang/desktop preview`. The build goes to `apps/desktop/dist/`, with a `THIRD-PARTY-NOTICES.md` beside it. The preview serves it at http://127.0.0.1:4173 by default. Two things to know about it:

- The build works at the root of its origin, so serve it from the root, as the preview does, unless you built it for a sub-path with `CAOTANG_BASE` (see Self-hosting).
- Projects are kept per origin, which is the address and the port together. A project you made at http://127.0.0.1:5173 does not appear at http://127.0.0.1:4173. Export a bundle to move one.

## Self-hosting

Caotang is static files, so any static host can serve it: GitHub Pages, Netlify, Cloudflare Pages, an S3 bucket, or nginx on your own machine. There is no server part to run.

1. Build it: `pnpm install`, then `pnpm build`. The site is everything in `apps/desktop/dist/`, with `THIRD-PARTY-NOTICES.md` beside it. Copy the whole folder.
2. **Serve it over HTTPS.** Browsers offer the WebCrypto key sealing and the folder access Caotang uses on secure origins only (`https://`, or `http://localhost` and `http://127.0.0.1` on your own machine).
3. **Serve it at the root of its origin** (`https://writing.example.com/`), or build it for a sub-path with `CAOTANG_BASE`: `CAOTANG_BASE=/caotang/ pnpm build` makes a build that works at `https://example.com/caotang/`. By default the build's asset paths start at `/`.
4. **Folder saves need a Chromium browser** (Chrome, Edge, Brave, Arc and the like), which have the File System Access API. In other browsers, projects live in the browser and move as `.caotang` bundles.

Projects are kept per origin: a project made on one host does not appear on another. Export a bundle to move one.

The build's `index.html` already carries its Content-Security-Policy in a `<meta>` tag. A host that can send headers can send the same policy as a header, and add the protections a `<meta>` tag cannot (`frame-ancestors`):

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src *; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

`connect-src *` is deliberate: the agent talks to whichever provider and MCP servers you configure, straight from your browser. If you tighten it, list the providers you use, and `http://127.0.0.1:*` if you use a local model preset (Ollama, LM Studio, llama.cpp).

For **Netlify** or **Cloudflare Pages**, put the headers in a `_headers` file in `apps/desktop/dist/` (or in `apps/desktop/public/`, so each build copies it):

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src *; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

For **nginx**:

```nginx
server {
    listen 443 ssl;
    server_name writing.example.com;
    root /var/www/caotang;   # the contents of apps/desktop/dist

    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src *; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;

    location / {
        try_files $uri /index.html;
    }
}
```

The repository's [Pages workflow](.github/workflows/pages.yml) deploys caotang.app: the landing page in [`site/`](site/) at the root, with `llms.txt`, `robots.txt` and a sitemap, and the same build, made with `CAOTANG_BASE=/app/`, at `/app/`.

## Test

```sh
pnpm verify                             # lint, typecheck, and the unit tests in packages/ and test/
pnpm exec playwright install chromium   # once, for the browser the pull-request end-to-end tests use
pnpm test:e2e                           # the Chromium Playwright suite
pnpm exec playwright install firefox webkit  # once, for the optional cross-browser suite
CAOTANG_E2E_BROWSERS=all pnpm exec playwright test --project=webkit  # run a cross-browser project
```

`pnpm verify` does not run the desktop's pure model specs in `e2e/unit`, because they are Playwright specs. `pnpm test:e2e` runs them, with the dev-server suite and a smoke test of the production build (`e2e/prod-smoke.spec.ts`), which uses `vite preview` on its own port.

The end-to-end suite starts its own dev server, or, outside CI and when `CAOTANG_E2E_PORT` is not set, reuses one already on port 5173. To run it beside another copy of Caotang, give each checkout its own port with `CAOTANG_E2E_PORT`, for example `CAOTANG_E2E_PORT=5183 pnpm test:e2e`. In PowerShell, set it first with `$env:CAOTANG_E2E_PORT = 5183`. The production preview then uses that port plus 1000, or `CAOTANG_E2E_PREVIEW_PORT` when you set it.

Continuous integration (`.github/workflows/ci.yml`) runs a `verify` matrix on Node 22.12.0 and 24. Each leg uses a frozen, engine-strict install, then runs `pnpm verify`, `pnpm build`, the bundle-size check, the MCP server pack and the CLI bundle build. Node 22.12 CI installs the pnpm tarball directly after checking its SHA-512 against the `packageManager` pin; Node 24 uses Corepack. The Node 24 Chromium E2E suite runs as an independent job in parallel, alongside `office-interop` (the `.xlsx` corpus in openpyxl and LibreOffice) and `pdf-validate` (pdf.js, qpdf, Poppler, Ghostscript and MuPDF). A separate workflow gates pull requests in Firefox and WebKit, also runs nightly and on demand, and shards each browser into two jobs whose results merge into one HTML report uploaded when a shard fails. Set `CAOTANG_E2E_BROWSERS=all` locally to enable those projects. Folder-access specs skip outside Chromium, and `e2e/non-chromium-storage.spec.ts` checks the bundle-only path those browsers use.

A real-key check of the provider presets, `e2e/provider-smoke.spec.ts`, runs only with `CAOTANG_SMOKE_<PRESET>` keys set, on your machine or by a maintainer's manual dispatch of the `provider-smoke` workflow (`gh workflow run provider-smoke.yml -f presets="anthropic deepseek"`); it never runs on a pull request. See [providers-browser-cors.md](docs/architecture/providers-browser-cors.md#3-the-real-key-round).

The scripted demo is [`e2e/demo.spec.ts`](e2e/demo.spec.ts). It builds a three-chapter story, has the agent draft a scene and approve the draft, reorders the story on the corkboard, and compiles it to Word. Then it unzips the file and checks its structure. The demo runs on the built-in demo provider, with no key.

## Your key and your privacy

- **Bring your own key.** Add a provider in **Settings › Providers**: pick a preset (its address and authentication are filled in) or a generic endpoint of your own, choose a model, and paste the key. When you save, Caotang lists the provider's models to check it works.
- **Your key stays in this browser.** It is sealed with a key the page cannot export, and it is never written into a project file. Sealing keeps a stored key from being read out of storage. It does not protect against code running in the page while Caotang is open.
- **Requests go to the provider you chose.** The agent sends requests only to the endpoint of the profile each task role resolves to. A local model preset (Ollama, LM Studio, llama.cpp) talks to a server on your own computer, over plain http at a loopback address only, so the text stays on the machine; every other provider needs https. The built-in demo provider makes no network request at all.
- **Your text goes to that provider when the agent works.** The parts of the project the agent needs are sent with each request. The agent panel shows what it left out. A model review on the Findings tab sends the text it reads, after you approve its plan.
- **MCP servers are off until you turn them on.** **Settings › MCP & tools** is off by default, and while it is off no server is contacted. Once you turn it on and connect a server, Caotang sends requests to that server's address (https, or http on your own computer): to list its tools, and to check a tool before the agent calls it. When the agent calls a tool, the arguments it chose for that call go to that server, and the result comes back to Caotang. Caotang does not contact a server you have not connected.
- **No account, no Caotang server, no analytics.** Projects live in your browser. Export a bundle to keep a copy you can open anywhere.

## Projects on disk

A project is a folder:

```
caotang.json          the manifest: the binder tree, the codex, the vocabulary, recipes, filters and goals
caotang.json.bak.1..3 the three previous manifests
coherence.json        the findings and check runs, beside the manifest
tasks.json            the recurring agent tasks, definitions only (when each last ran stays in the browser)
docs/                 one file per scene, note or dialogue container, named by id: .md, .fountain or .ink
codex/                one file per codex entry
assets/               images: storyboard pictures and the cover
exports/              compiled files
sessions.jsonl        writing sessions, appended to and read back when the folder opens
.caotang-mcp.lock     present while an MCP server is running on the folder
```

The full format is in [docs/architecture/project-format.md](docs/architecture/project-format.md). A bundle is the same folder, zipped.

## Caotang as an MCP server

Caotang can serve a project folder to an outside AI tool over the Model Context Protocol. The full reference is [packages/mcp-server/README.md](packages/mcp-server/README.md).

Build the server once:

```sh
pnpm --filter @caotang/mcp-server build
```

This writes `packages/mcp-server/dist/caotang-mcp.mjs`, one file that runs with `node` (22 or later). To make an MCP bundle that a host can install, run:

```sh
pnpm --filter @caotang/mcp-server run pack
```

This writes `packages/mcp-server/dist/caotang-mcp-0.1.0.mcpb`. Or download `caotang-mcp-<version>.mcpb` from the [latest release](https://github.com/nattiini45/caotang/releases/latest), where `SHA256SUMS` holds its SHA-256. The bundle has the server, its manifest, the notices and the license. The manifest is checked by the MCPB CLI that this package pins. The host asks for a project folder and an **Allow changes** setting, which is off by default. The bundle is not signed, and it has not been run in a real MCPB host; it has been checked and run over stdio.

Serve a project folder over HTTP, on `127.0.0.1` only:

```sh
node packages/mcp-server/dist/caotang-mcp.mjs serve --project ~/Writing/my-novel
```

The server is read-only unless you add `--allow-writes`, or set `CAOTANG_MCP_ALLOW_WRITES=true`. With writes allowed, seven tools apply their change at once (`meta.set`, `notes.append`, `synopsis.set`, `filter.save`, `goal.save`, `coherence.setFindingStatus` and `shots.annotate`), and seven ask you to confirm each call in the host before anything is written (`binder.restructure`, `codex.write`, `codex.import`, `doc.import`, `export.compile`, `notes.replace` and `vocabulary.upsert`). Add `--create "New Book"` to make a new project in a folder that does not have one yet. `--create` is refused for a folder that already holds document or codex files, or manifest copies (`caotang.json.*`), so it cannot take them over.

**Token.** Over HTTP the server prints a bearer token once, when it starts. To choose the token yourself, set `CAOTANG_MCP_TOKEN` to at least 16 characters before you start the server. Every request must send `Authorization: Bearer <token>`.

**Stdio.** To let a host start the server itself, add `--stdio`. The host's process boundary takes the place of the port and the token:

```sh
node packages/mcp-server/dist/caotang-mcp.mjs serve --project ~/Writing/my-novel --stdio
```

**Connect a host.** Over HTTP, the endpoint is `http://127.0.0.1:7433/mcp`. The port is 7433 unless you pass `--port`. A host that takes an `mcpServers` entry needs this:

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

Besides the tools, the server offers the project's text as **resources**, which you attach on purpose (in Claude Code, `@caotang:caotang://doc/…`; in Cursor, the resource picker), and five **prompts** that hand your host's model the context Caotang builds for a job: `draft-scene`, `fill-synopsis`, `continuity-check`, `codex-from-doc` and `revise-with-codex`. A resource carries a whole document, and one over 2 MiB is refused, never cut. The prompts run on your host's model, so the text they carry goes to that model, as it does when the host reads a document through a tool; Caotang calls no model and holds no key. See the server's README, Resources and Prompts.

Three things to know before you connect:

- A change that needs confirmation is refused, with nothing written, if the host cannot show a confirmation. The host must support MCP elicitation.
- A host on a 2025 protocol revision confirms changes over HTTP when it declares elicitation and keeps the `Mcp-Session-Id` the server returns when it starts the session. The server holds at most 16 such connections, closes one that has been idle for 30 minutes, and answers `503` to a new host while all 16 are busy. A host that cannot keep a session can connect over `--stdio`, or install the `.mcpb` bundle, which runs over stdio.
- While the server runs with `--allow-writes`, save its folder from the Caotang app only with the server stopped, or with each save question checked. The app asks before it saves over the server's lock, but a confirmed save can still overwrite what the server wrote (see the server's README, Known gaps).

The tools that need a model, `scene.draft`, `synopsis.fill`, `continuity.scan`, `coherence.review`, `shots.derive`, `prompt.draft`, `prompt.variant` and `dialogue.draft`, are not available over MCP, because the server holds no provider key. [Bringing existing writing into Caotang](docs/USER-GUIDE.md#bringing-existing-writing-in-through-the-mcp-server) explains the import tools, `doc.import` and `codex.import`, which are available. With writes allowed, `export.compile` compiles the manuscript, one item or a saved recipe in any export format, EPUB included, once the host confirms it.

### Install the bundle

1. Build `caotang-mcp-0.1.0.mcpb` with the `pack` command above, or download it from the latest release.
2. Drag the file onto an MCPB host such as Claude Desktop, or open it with the host. The host shows a dialog with the bundle's name, its description and two settings.
3. Under **Project folder**, choose a folder that already holds a Caotang project.
4. Leave **Allow changes** off unless you want the assistant to change the project. Off, the assistant can only read it. On, some changes still ask you to confirm them in the host first.
5. The host may warn that the bundle is not signed and offer **Install Anyway**. The warning means the host cannot name a publisher for the file, because the signing tool today produces bundles that hosts refuse. The code is open, and you can build the same file from source with the `pack` command. Install it only if you built it or took it from this project's release.

The server runs on your computer over stdio and opens no network port. Uninstalling the bundle removes the server and leaves your project folder as it was. The wording of the dialog differs between hosts and versions.

The bundle is not signed, and it has not been tested in a real host yet. [packages/mcp-server/HOST-CHECKS.md](packages/mcp-server/HOST-CHECKS.md) lists the checks and holds the results; it has none so far. The release lists the file's SHA-256 in `SHA256SUMS`.

## Caotang from the command line

`caotang agent` runs one turn of the agent on a project folder and exits, for a terminal, a Makefile, a cron job or CI. It is read-only unless you say otherwise: without `--write` nothing in the folder changes, and the files that would change are printed as a diff. Build it with `pnpm --filter @caotang/cli build`, which writes `packages/cli/dist/caotang.mjs` (one file; run it with `node`, and keep its `fonts/` folder beside it).

```sh
# The demo provider: no key, no network. Prints the reply, exits 0, writes nothing.
node dist/caotang.mjs agent -p "Check the manuscript for continuity problems." --mock --project ~/Writing/my-novel

# A review with your own key, read-only. The key comes from the environment, never from a flag.
CAOTANG_API_KEY=... node dist/caotang.mjs agent -p "Check the manuscript for continuity problems." \
  --provider openrouter --project ~/Writing/my-novel --output-format json

# Approve every card the plan shows, save the folder, and print what changed.
CAOTANG_API_KEY=... node dist/caotang.mjs agent -p "Fill in the synopses for Chapter 1." \
  --provider openrouter --project ~/Writing/my-novel --permission approve-all --write
```

| Flag | Meaning |
|---|---|
| `-p <intent>` | What to ask. `-p -` reads it from stdin. |
| `--project <dir>` | The project folder (default: the working directory). |
| `--mock` or `--provider <preset>` | The demo provider, or a provider preset (`--base-url`, `--model` and `--thinking` refine it). |
| `--key-env <VAR>` | The environment variable that holds the key (default `CAOTANG_API_KEY`). There is no flag for the key itself: it would show in `ps` and in your shell history. |
| `--permission <mode>` | `read-only` (default): every card is cancelled. `auto`: a change that needs no card runs, every card is cancelled. `approve-all`: every card is approved as shown, and a draft the provider cut off never is. |
| `--approve-tools <tool,...>` | With `approve-all`: approve a card only if every step is one of these tools. A card with any other step in it is cancelled, whole. |
| `--write` | Save the folder after the turn. Needs `auto` or `approve-all`. |
| `--plan-file <plan.json>` | Run a plan you wrote, `{ "steps": [{ "tool", "params", "expect" }] }`, with no planner call. |
| `--output-format` | `text` (default), `json` (one object when the turn ends) or `stream-json` (one line per event, a `decision` line for each card, then the result). |
| `--max-model-calls <n>` | The most model calls a turn may make (default 8). |

Standard output carries only the chosen format; progress and notes go to standard error. The exit code is **0** when the turn is done, **1** for an internal error, **2** for a wrong command line or a folder that holds no project, **3** when another writer (the app, or `caotang-mcp serve`) holds the folder, **4** when the turn needs input (a card was cancelled by the permission mode, a bound was reached, or the provider failed), **5** for a conflict, **6** when verification failed, and **130** and **143** after SIGINT and SIGTERM. The undo history of a `--write` run ends with the command, so keep the folder in git. `caotang mcp serve` starts the MCP server with the same flags as `caotang-mcp serve`. `caotang scan` runs the continuity checks without a model; see [Continuity checks in CI](#continuity-checks-in-ci).

## Continuity checks in CI

`caotang scan` runs the deterministic checks of the Findings tab on a project folder, with no browser, no model and no key, so a project kept in a Git repository can be checked every night or on every pull request that touches the manuscript.

```sh
node dist/caotang.mjs scan --project ~/Writing/my-novel                          # a report in the terminal; exit 7 if an error is open
node dist/caotang.mjs scan --format github --fail-on warning --summary report.md  # annotations on the files, the Markdown report beside them
```

| Flag | Meaning |
|---|---|
| `--project <dir>` | The project folder (default: the working directory). |
| `--scope <scope>` | `full` (default) or `changed`. `full` reads every document; `changed` only those edited since the last saved run. Without `--write` that run never advances, so CI uses `full`. |
| `--checks <id,...>` | Run only these checks, such as `presence.expected,timeline.overlap` (default: all of them). |
| `--format` | `text` (default), `markdown` (the coherence report), `json`, or `github` (one workflow command per finding, so each shows on its file and line). |
| `--fail-on <level>` | `error` (default), `warning`, `info` or `never`: the severity at which an open finding fails the run. |
| `--write` | Save `coherence.json` with this run in it. Without it the folder is only read, and every file in it is byte-identical afterwards. |
| `--summary <file>` | Also write the Markdown report to this file. The file named by `$GITHUB_STEP_SUMMARY` is appended to, so it can follow other steps. |

The exit code is **0** when the scan is clean or `--fail-on never` is set, **7** when an open finding is at or above `--fail-on`, **8** when none is but a document or codex file is not UTF-8 text and so was not checked (the output names it and the scan is partial), **1** for an internal error, **2** for a wrong command line or a folder that holds no project, and **3** when another writer holds the folder (only with `--write`, which takes the folder's lock). A finding you dismissed or marked fixed in the app, and committed in `coherence.json`, neither prints nor fails the run; a `coherence.json` that cannot be read is not repaired, the findings are computed again, and the output says its dismissals are lost. The scan runs the dialogue checks too. It reads a document in the file where the project keeps it, so a finding in a screenplay lands on its `.fountain` file and one in a dialogue container on its `.ink` file.

**The workflow.** [docs/ci/continuity-scan.yml](docs/ci/continuity-scan.yml) is a GitHub Actions workflow to copy to `.github/workflows/` in your project repository. It runs nightly, by hand and on pull requests that change `docs/`, `codex/`, `caotang.json` or `coherence.json`; it asks for `contents: read`, holds no secret, and never uses `pull_request_target`. It does not run `npx`: it downloads `caotang.mjs` from a Caotang release and checks it against a SHA-256 you write into the file, which the release lists in `SHA256SUMS`. The version and the hash in the template are placeholders, so the job stops until you set them; it is not turnkey, and there is no release to point it at until the maintainer cuts one (`pnpm --filter @caotang/cli build` writes the same file).

**What it prints.** Annotations and the job log carry short quotes from your manuscript, because a finding quotes the passage it is about. On a public repository anyone can read them. If that matters, keep the repository private or run the scan with `--format text` in a step whose output you do not publish.

**No model review in CI.** CI runs the deterministic checks only. A model review there is not offered: it would need a key in the repository's secrets, which is the one place a key would leave your device, and a spend on a schedule. If it is ever added it will sit behind the per-task opt-in and call cap that recurring tasks have, with a separately scoped key and a read-only tool allowlist.

## Scripting Caotang

The agent can also run from a Node script, a CLI or CI, against a project folder, with an approval policy in place of the cards. The package is `@caotang/sdk`, and its [README](packages/sdk/README.md) has three examples: the demo provider, a read-only review with your own key, and an approve-everything run that writes the folder. Changes stay in memory until you save, `diff()` shows them first, and the key is held in memory and sent only to your provider.

## Documents

- [docs/USER-GUIDE.md](docs/USER-GUIDE.md): the guide for writers.
- [CHANGELOG.md](CHANGELOG.md): what the release contains, and its known limits.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the module map, the data model and the principles.
- [docs/architecture/](docs/architecture/): one spec per module. [agent-harness.md](docs/architecture/agent-harness.md) covers the agent's tools, and [extensibility.md](docs/architecture/extensibility.md) covers the MCP client and server.
- [docs/ROADMAP.md](docs/ROADMAP.md): what is built, what is being built, and what comes later.
- [docs/decisions.md](docs/decisions.md): the standing decisions, one line each, with who decided.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md): how to contribute, and how to report a vulnerability.

## How Caotang is built

Caotang was built with AI coding agents under the owner's direction. Every decision tagged [owner] in [docs/decisions.md](docs/decisions.md) was made by a person.

## License

Caotang is released under the MIT License. See [LICENSE](LICENSE). [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) lists the third-party packages in the builds, with their licenses. Run `node tools/third-party-notices.mjs --write` to regenerate it. A test fails when the committed copy no longer matches the lockfile.
