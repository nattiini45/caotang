# AGENTS.md — Caotang

Caotang is a **local-first writing studio** for novels and long fiction: a browser app where the manuscript lives on your own machine (a project folder or the browser), an AI agent works in it under your approval, and a compile step exports Word, EPUB, Markdown, Fountain, Ink and storyboards.

There is **no backend server, no account, no telemetry**. The app is static files; the model provider is the only network dependency, plus any MCP server you connect yourself.

## Stack

| Part | Stack |
|---|---|
| Workspace | pnpm monorepo (`pnpm@12.9.1` pinned in the root `packageManager` field), `corepack enable` |
| Node | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` — **CI tests Node 22.12.0 and 24; Node 26 is allowed but not covered** |
| Language | TypeScript `^6.0.3` (strict) |
| App | React `19.3`, Vite `8.3.2` (rolldown/oxc, not esbuild) |
| Unit tests | Vitest `5.0.3` (node environment) |
| E2E | Playwright `1.63` (Chromium, Firefox and WebKit on pull requests; Firefox and WebKit nightly) |
| Lint | ESLint `9` + typescript-eslint |

Workspace globs (`pnpm-workspace.yaml`): `apps/*`, `packages/*`, `vendor/*`.

## Setup

With Node 22.12.0, first run `npm install --global corepack@0.34.3`; the bundled Corepack 0.29.4 cannot verify pnpm 12.9.1's current signing key.

```sh
corepack enable          # uses the pnpm version pinned in package.json
pnpm install
pnpm dev                 # the app at http://127.0.0.1:5173
```

A Chromium-based browser (Chrome, Edge, Brave, Arc) is needed for the end-to-end suite and for **folder** save/access — other browsers only get in-browser projects and `.caotang` bundles.

## Commands

```sh
pnpm verify              # lint + typecheck + unit tests — the pre-PR gate
pnpm lint                # eslint .
pnpm typecheck           # pnpm -r typecheck && tsc --noEmit -p tsconfig.json
pnpm test                # vitest run
pnpm test:watch          # vitest
pnpm test:e2e            # playwright test (needs a Chromium install)
pnpm build               # → apps/desktop/dist/
pnpm --filter @caotang/desktop preview   # serves the built app on :4173
pnpm --filter @caotang/desktop dev       # dev server on :5173

pnpm exec playwright install chromium     # once per machine

pnpm --filter @caotang/mcp-server build   # → packages/mcp-server/dist/caotang-mcp.mjs
pnpm --filter @caotang/mcp-server run pack # → caotang-mcp-0.1.0.mcpb

node tools/third-party-notices.mjs --write   # regenerate THIRD-PARTY-NOTICES.md
```

Gotchas that bite:

- `pnpm verify` does **not** run the pure model specs in `e2e/unit/` — they are Playwright specs, so they run under `pnpm test:e2e`.
- `pnpm test:e2e` starts its own dev server, and a second preview server on **dev port + 1000**. Set `CAOTANG_E2E_PORT` (and `CAOTANG_E2E_PREVIEW_PORT`) when running a second checkout beside another.
- **Do not add `onlyBuiltDependencies` to `pnpm-workspace.yaml`** naming a package that is not installed. `test/toolchain-floor.test.ts` asserts every allowlist entry is actually present, so an orphan entry fails that test. The allowlist belongs in `pnpm-workspace.yaml` — pnpm 12 reads it from there, not from the `pnpm` block in `package.json`, and an entry left in `package.json` makes pnpm 12 fail the install with `ERR_PNPM_IGNORED_BUILDS`. Vite 8 bundles with rolldown/oxc, so `esbuild` no longer resolves anywhere in the tree — that is why the allowlist is empty.
- `pnpm build` writes `THIRD-PARTY-NOTICES.md` into `apps/desktop/dist/`. A test fails when the committed copy drifts from the lockfile — regenerate it with the tool above whenever a dependency changes.

## Layout

```
apps/desktop/            the app (Vite + React + TS) → dist/ is build output, never edited by hand
packages/bus/            the command bus — every change goes through it
packages/codex/          codex entries (characters, places, lore, subplots)
packages/coherence/      findings and coherence checks
packages/context/        context assembly for agent requests
packages/crypto/         key hierarchy, file sealing and rollback marks for the hosted instance (specified, not built; nothing imports it)
packages/dialogue/       branching dialogue (Ink)
packages/editor/         the scene editor
packages/editor-audit/   editor audit trail
packages/exporter/       compile/export (docx, epub, md, txt, fountain, fdx, pdf, ink)
packages/furniture/      binder / corkboard furniture
packages/gateway/        provider gateway (profiles, roles, endpoints)
packages/harness/        the agent harness — its tools and its registry
packages/ids/           id helpers
packages/mcp-client/     MCP client (Streamable HTTP)
packages/mcp-server/     Caotang as an MCP server (@caotang/mcp-server)
packages/pdf-fonts/      what both PDFs share for their fallback fonts (byte checks, fontkit, CID writer, emoji)
packages/remote-store/   ArtifactFs over an encrypted remote blob store for the hosted instance (specified, not built; nothing imports it)
packages/screenplay/     Fountain screenplay model
packages/scan/           the deterministic continuity scan as a library, for a writer's own CI (@caotang/scan); no command yet
packages/sdk/            run the agent from Node against a project folder (@caotang/sdk); owns the Node folder session the MCP server shares
packages/skills/         Agent Skills folders: the SKILL.md reader, the caps, the review pin, the model's catalog
packages/store/          the project store and the manifest
packages/storyboard/     shot cards and animatics
packages/tasks/          recurring agent tasks: tasks.json, when a task is due, what a task may do (pure; the run and the history are the app's)
packages/video-prompt-pack/
vendor/noto-sans-cjk/    @caotang/font-noto-cjk
vendor/noto-emoji/       @caotang/font-noto-emoji
vendor/noto-color-emoji/ @caotang/font-noto-color-emoji (the colour emoji, compiled offline to PDF operators)
vendor/noto-sans-arabic/ @caotang/font-noto-arabic
vendor/noto-sans-hebrew/ @caotang/font-noto-hebrew
site/                    the marketing landing page (GitHub Pages root)
e2e/                     Playwright specs; e2e/unit/ holds the pure model specs
test/                    repo-level vitest guards (lockfile, toolchain floor, guide claims, …)
tools/                   third-party-notices.mjs
docs/architecture/       one spec per module — the contract
docs/decisions.md        standing decisions, one line each, with who decided
```

## Conventions

These are the project's own rules (see `CONTRIBUTING.md` and `docs/decisions.md`); they hold everywhere.

- **The specs are the contract.** `docs/architecture/*.md` and the code agree. If the code does something the spec does not say, either the code is wrong or the spec is incomplete — fix one of them **in the same pull request**. Changing behaviour a spec describes means changing the spec deliberately in the same PR and adding a line to `docs/decisions.md`.
- **A new command, tool, project-format file or setting starts in its spec.**
- **Projects stay local.** Nothing is sent anywhere except the provider and MCP servers the writer configured.
- **Keys and tokens never go into a project, a bundle, an export or a log.**
- **The agent changes the project only through the command bus**, so every change is gated, logged and undoable.
- **Project files stay plain text.** A project is a folder: `caotang.json` (manifest), `coherence.json`, `docs/` (one file per scene, `.md` / `.fountain` / `.ink`), `codex/`, `assets/`, `exports/`, `sessions.jsonl`.
- **Commits:** the subject is a plain sentence saying what is now true (`The export dialog shows a refused compile beside Compile.`), not "Fix bug". One logical change per commit.
- **Pull requests:** one change, describable in a sentence or two; say what changed, why, and how you checked it; include tests (a unit test for module behaviour, an e2e test for anything a writer sees); update the writer-facing docs (`README.md`, `docs/USER-GUIDE.md`, `CHANGELOG.md`) when behaviour changes.
- **User-facing text** is plain words, whole sentences, and names what the writer can do next.
- **Tests never need a real provider key.** They run against the built-in mock and demo providers.

## Do / Don't

**Do**

- Run `pnpm verify`, `pnpm build` and `pnpm test:e2e` before opening a PR. CI runs `pnpm verify`, the production build, bundle-size check, MCP pack and CLI build on Node 22.12.0 and 24; Chromium E2E runs on Node 24 in parallel, and a separate workflow gates PRs in Firefox and WebKit.
- Use `pnpm` — the workspace uses `workspace:*` dependencies, which npm and yarn do not resolve the same way.
- Regenerate `THIRD-PARTY-NOTICES.md` when you add or upgrade a dependency.
- Add a line to `docs/decisions.md` when you change a standing rule, and update the matching spec.

**Don't**

- Don't add `onlyBuiltDependencies` to `pnpm-workspace.yaml` naming a package that is not installed (see the gotcha above).
- Don't hand-edit `apps/desktop/dist/` — it is build output.
- Don't write a test that needs a provider API key, and don't let one reach a real provider endpoint.
- Don't put a token, a key or a session secret into a project folder, an export or a log line.
- Don't let the agent write to the project outside the command bus.
- Don't push to `main` — open a pull request.

## Environment variables

| Variable | Effect |
|---|---|
| `CAOTANG_BASE` | Build for a sub-path, e.g. `CAOTANG_BASE=/app/ pnpm build`. Default: asset paths start at `/`. |
| `CAOTANG_E2E_PORT` | Dev-server port for the Playwright suite (default 5173). Setting it also stops the suite from reusing an existing server. |
| `CAOTANG_E2E_PREVIEW_PORT` | Production-preview port (default = dev port + 1000). |
| `CAOTANG_MCP_ALLOW_WRITES` | `true` allows the MCP server to write to the project folder. |
| `CAOTANG_MCP_TOKEN` | Bearer token for the MCP server over HTTP (at least 16 characters). |

## Deploy

`.github/workflows/pages.yml` publishes [caotang.app](https://caotang.app/): the landing page in `site/` at the origin root, and the app built with `CAOTANG_BASE=/app/` at `/app/`. The build must be served from the **root of its origin** unless `CAOTANG_BASE` is used, and over **HTTPS** (WebCrypto key sealing and folder access need a secure origin). The CSP travels in the built `index.html` as a `<meta>` tag; no `_headers` file ships in the tree. For hosts that can send headers (Netlify, Cloudflare Pages), the deployer creates one — `README.md` shows the file to write.
