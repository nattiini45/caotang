# Contributing to Caotang

Thank you for helping. This page covers setting up, the checks a change must pass, and how changes are reviewed.

## Set up

You need:

- **Node.js** in a version the `engines` field of [package.json](package.json) allows: 22.12 or later in the 22 line, 24, or 26 and later. CI runs Node 24.
- **pnpm** in the version the `packageManager` field pins. Run `corepack enable` once and the right pnpm is used automatically.
- **A Chromium-based browser** to run the end-to-end tests and to try folder saves.

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
pnpm exec playwright install chromium   # once, for the end-to-end tests
pnpm test:e2e                           # the Playwright suite, including a production-build smoke test
```

All three must pass before a pull request is merged. CI runs the same commands on Node 24, and also packs the MCP server bundle.

CI on a pull request from a fork runs with a read-only token (`permissions: contents: read`), so a workflow run cannot change the repository. If this is your first contribution, a maintainer approves your pull request's first CI run before it starts; this is a repository setting, and it only means the checks wait a little.

Tests run against the built-in mock and demo providers. They never need a real provider key, and no test may require one. To run the end-to-end suite beside another copy of Caotang, set `CAOTANG_E2E_PORT` (see the README).

If your change adds or upgrades a dependency, regenerate the licence notices with `node tools/third-party-notices.mjs --write`; a test fails when they no longer match the lockfile.

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

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## Licence

Caotang is released under the [MIT License](LICENSE). By contributing, you agree that your contribution is licensed under the same terms, and you confirm that you have the right to contribute it.
