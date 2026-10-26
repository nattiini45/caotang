# Contributing to Caotang

Thank you for helping. This page covers setting up, the checks a change must pass, and how changes are reviewed.

## Set up

You need:

- **Node.js** in a version the `engines` field of [package.json](package.json) allows: 22.12 or later in the 22 line, 24, or 26 and later. CI tests the 22.12.0 floor and Node 24; Node 26 is allowed but not covered.
- **pnpm** in the version the `packageManager` field pins. Run `corepack enable` once and the right pnpm is used automatically. With Node 22.12.0, first update Corepack to 0.34.3 (`npm install --global corepack@0.34.3`); the bundled Corepack 0.29.4 cannot verify pnpm's current signing key.
- **A Chromium-based browser** to run the end-to-end tests locally and to try folder saves. Firefox and WebKit are optional locally; CI gates pull requests in all three engines and also runs Firefox/WebKit nightly.

Then:

```sh
git clone https://github.com/nattiini45/caotang.git
cd caotang
pnpm install
pnpm dev        # the app at http://127.0.0.1:5173
```

## Check your change

```sh
pnpm verify                             # lint, typecheck and the unit tests
pnpm build                              # the production build in apps/desktop/dist/
pnpm exec playwright install chromium      # once, for the pull-request end-to-end tests
pnpm test:e2e                              # Chromium suite, including a production-build smoke test
pnpm exec playwright install firefox webkit # optional, for the nightly cross-browser suite
CAOTANG_E2E_BROWSERS=all pnpm exec playwright test --project=webkit
```

These checks must pass before a pull request is merged. CI runs `pnpm verify`, the production build, bundle-size check, MCP pack and CLI build on Node 22.12.0 and 24; the Node 22.12 leg verifies the pinned pnpm tarball's SHA-512 before installing it directly, while Node 24 uses Corepack. Chromium E2E runs on Node 24 in parallel. A separate workflow runs Firefox and WebKit E2E on every pull request and nightly, two shards per browser, then merges their reports into one HTML report.

CI on a pull request from a fork runs with a read-only token (`permissions: contents: read`), so a workflow run cannot change the repository. If this is your first contribution, a maintainer approves your pull request's first CI run before it starts; this is a repository setting, and it only means the checks wait a little.

Tests run against the built-in mock and demo providers. They never need a real provider key, and no test may require one. The real-key provider round (`e2e/provider-smoke.spec.ts`) is separate and opt-in: it skips without keys, and in CI it runs only when a maintainer dispatches the `provider-smoke` workflow from `main`, never on a pull request. To run the end-to-end suite beside another copy of Caotang, set `CAOTANG_E2E_PORT` (see the README).

If your change adds or upgrades a dependency, regenerate the licence notices with `node tools/third-party-notices.mjs --write`; a test fails when they no longer match the lockfile.

### Bundle size

After `pnpm build`, run `node tools/check-bundle-size.mjs`. It prints every JS chunk (raw and gzip) and fails when a chunk is over 500 kB and not on its allow-list, when an allow-listed chunk is over its own cap (fontkit, one library that loads only for CJK and emoji text in a PDF, may reach 750 kB), when the first load (the entry and what `index.html` preloads with it) is over its gzip budget, or when all JS is over its ceiling. CI runs it right after the build. Vite's own 500 kB warning is turned down to the highest cap, so this script is the gate.

The numbers are in one object, `BUDGET`, at the top of `tools/check-bundle-size.mjs`. A heavy library that only some writers use (the MCP SDK, the Ink compiler, docx, fontkit) is loaded where it is used, not in the first paint. Code that compiles Ink needs the compiler loaded first: a Node entry awaits `loadInkCompiler()` before it opens a project, the vitest setup file (`test/setup-ink-compiler.ts`) does it for tests, and `compileInk` throws `InkCompilerNotLoaded` until it has. If your change makes the build grow past a number, load the new code on use if you can. If it cannot be, raise the number in the same change: build, run the script, put the new size plus about 5% in `BUDGET`, and say why in the commit. An allow-list entry is debt, and the script fails once its chunk is back under 500 kB, so remove the entry then.

### PDF validation

CI's `pdf-validate` job checks both PDFs the app writes with tools other than the ones that wrote them. To run it yourself after changing a PDF writer:

```sh
CAOTANG_PDF_OUT=/tmp/pdfs pnpm exec vitest run packages/exporter/test/pdf-write-corpus.test.ts   # writes the corpus and expected.json
node tools/pdf-validate/check.mjs /tmp/pdfs                                                       # structure, fonts and pdf.js
node tools/pdf-validate/check.mjs /tmp/pdfs --external                                            # also qpdf, Poppler, Ghostscript and MuPDF
```

The corpus test writes nothing without `CAOTANG_PDF_OUT`, so `pnpm verify` is unchanged. The external tools are CI-only (`apt-get install qpdf poppler-utils ghostscript mupdf-tools`) and never ship; a tool that is not installed fails the run, and `--external=pdftotext,qpdf` runs just those named. None of this is a check in Acrobat or on paper.

### XLSX interop

CI's `office-interop` job opens the `.xlsx` files the app writes in openpyxl and in LibreOffice. To run it yourself after changing `render-xlsx.ts` or one of the tables it writes:

```sh
CAOTANG_XLSX_OUT=/tmp/xlsx pnpm exec vitest run packages/exporter/test/xlsx-write-corpus.test.ts   # writes the corpus and expected.json
python3 tools/office-interop/check_xlsx.py /tmp/xlsx --skip-libreoffice                             # package parts and openpyxl
python3 tools/office-interop/check_xlsx.py /tmp/xlsx                                                # also LibreOffice (soffice on PATH)
```

The corpus test writes nothing without `CAOTANG_XLSX_OUT`, so `pnpm verify` is unchanged. The checker needs `pip install openpyxl==3.1.5`, and LibreOffice is CI-only (`apt-get install libreoffice-calc`); a missing `soffice` fails the run unless you pass `--skip-libreoffice`. Excel and Numbers cannot run in CI: the by-hand list and its results table are in [docs/testing/office-interop.md](docs/testing/office-interop.md).

## Prompts and evals

Every text Caotang sends a model that is not the writer's own is pinned, so a change to it is a change you review. Two goldens hold them, and both are rewritten on purpose with `CAOTANG_UPDATE_GOLDEN=1`:

- **The prompt manifest** (`packages/harness/test/golden/prompt-manifest.json` and `.md`) holds the hash and the full text of the planner prompts, the draft roles, the review prompts and every tool description. If you reword a tool's description and its meaning changes, bump its `descriptionVersion` in the same change; the test fails naming the tool when the text changes and the version does not, and the rewrite refuses until you bump it.
- **The golden tasks** (`packages/harness/test/golden-tasks/`) replay a cassette per task through the mock gateway, with no key and no network. A prompt, a tool description or a context change that alters a request fails the replay with the message and character that changed. If the change is meant, record again (`CAOTANG_UPDATE_GOLDEN=1 corepack pnpm vitest run packages/harness/test/golden-tasks`), read the cassette diff the way you read a golden, and say in the pull request why the requests moved. A re-record is reviewed like a golden change, never waved through.

The cassettes in the repository are synthetic: a person wrote the model's answers, and their header says so. Do not describe them as evidence about any model. Recording from a real model and a model benchmark are not built yet; when they are they run on your machine with your own `CAOTANG_SMOKE_*` keys and never in CI.

A pull request that adds or changes a cassette checks that: the header names the task and says `synthetic` when a person wrote the answers; no key, token or manuscript text that is not a fixture is in it; the task's checks fail when the answer is made worse (the test file shows one); and the diff of the cassette matches the prompt change it is there for.

## The specs are the contract

Each module is specified in [docs/architecture/](docs/architecture/), and the code and the spec agree:

- If the code does something the spec does not say, either the code is wrong or the spec is incomplete. Fix one of them in the same pull request.
- To change behaviour that a spec describes, change the spec deliberately, in the same pull request, and add or update the line in [docs/decisions.md](docs/decisions.md) that records the rule and why.
- A new command, tool, file in the project format, or setting starts in its spec.

Some rules hold everywhere, and a change that breaks one needs a strong case:

- Projects stay local, and nothing is sent anywhere except to the provider and MCP servers the writer configured.
- Keys and tokens never go into a project, a bundle, an export or a log.
- The agent changes the project only through the command bus, so every change is gated, logged and undoable.
- Project files stay plain text.

## Commits

Write each commit subject as a plain sentence that says what is now true, for example:

```
The export dialog shows a refused compile beside Compile.
```

Not "Fix bug" or "Update exporter". Use the body for the reason, when the subject does not make it obvious. One logical change per commit.

## Pull requests

- Keep a pull request to one change you can describe in a sentence or two.
- Say what changed, why, and how you checked it. Link the issue if there is one.
- Include tests: a unit test for module behaviour, an end-to-end test for anything a writer sees.
- Update the docs a writer reads ([README.md](README.md), [docs/USER-GUIDE.md](docs/USER-GUIDE.md), [CHANGELOG.md](CHANGELOG.md)) when behaviour changes. Tests check that the guide lists no built feature as missing.
- Write user-facing text in plain words, in whole sentences, and name what the writer can do next.
- Every pull request is reviewed before it is merged. Expect questions, and expect to be asked to split a large change.

For a large change, open an issue first so the design can be agreed before you build it.

## Releasing

Only maintainers release. A release is a tag; a workflow builds everything else.

1. Set the same version in `packages/mcp-server/package.json`, `packages/mcp-server/manifest.json` and `server.json` (including the version in its `identifier` URL), and give `CHANGELOG.md` a section with that version as its heading. The release notes are that section.
2. Tag the commit `v<version>` and push the tag. `.github/workflows/release.yml` stops unless the tag matches those three versions, then runs `pnpm verify`, packs the bundle, builds the command line and creates the release with `caotang-mcp-<version>.mcpb`, `caotang.mjs` and `SHA256SUMS`. The continuity-scan workflow template (`docs/ci/continuity-scan.yml`) pins `caotang.mjs` by the hash in `SHA256SUMS`.
3. Put the hash of the `.mcpb` from `SHA256SUMS` in `fileSha256` in `server.json`, which holds a zero placeholder until then, and commit it. Then publish the entry with `mcp-publisher login github` and `mcp-publisher publish`. The registry does not check the hash; clients do, before they install.

The bundle is not signed.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## Licence

Caotang is released under the [MIT License](LICENSE). By contributing, you agree that your contribution is licensed under the same terms, and you confirm that you have the right to contribute it.
