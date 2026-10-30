# `@caotang/cli` — the `caotang` command

`caotang agent` runs one turn of Caotang's agent on a project folder and exits: from a terminal, a Makefile, a cron job or CI. It is [`@caotang/sdk`](../sdk/README.md) with flags. `caotang scan` runs the deterministic continuity checks on a folder with no model and no key ([`@caotang/scan`](../scan/src/index.ts); the flags and exit codes are in the [README](../../README.md#continuity-checks-in-ci)). The design is [agent-harness.md](../../docs/architecture/agent-harness.md) §4 and §11, and the flags and exit codes are in the [README](../../README.md#caotang-from-the-command-line).

```sh
pnpm --filter @caotang/cli build          # writes dist/caotang.mjs, dist/fonts/ and dist/webp_dec.wasm

node dist/caotang.mjs agent -p "Check the manuscript for continuity problems." --mock --project ~/Writing/my-novel
node dist/caotang.mjs agent --help
node dist/caotang.mjs scan --project ~/Writing/my-novel --format github --fail-on warning
node dist/caotang.mjs mcp serve --project ~/Writing/my-novel      # the MCP server, as caotang-mcp serve
```

`dist/caotang.mjs` is one file: the workspace packages and the MCP SDK are inlined, so it runs with a plain `node`. The PDFs' fallback fonts (CJK in Regular and Bold, emoji, Arabic, Hebrew, Devanagari) are read from `fonts/` beside it, and so is the WebP decoder, `webp_dec.wasm`, which draws a WebP picture on a contact sheet; copy the folder and that file with the bundle. `caotang-mcp` stays the bin of `@caotang/mcp-server` and of the `.mcpb` bundle.

## Rules the code keeps

- **Read-only by default.** `--permission` defaults to `read-only`; nothing is written without `--write`, and the diff is printed instead.
- **The key is not a flag.** It is read once from the environment variable `--key-env` names (default `CAOTANG_API_KEY`) and handed to the SDK's in-memory key store. A flag named `--key`, `--api-key` and the like is refused by name, and the value is never echoed. A line that carries the key anyway is replaced before it is written.
- **Stdout carries the chosen format and nothing else.** Every write to it goes through `io.stdout` in `src/run-agent.ts`; progress and diagnostics go to stderr.
- **The scan reads unless told to write.** `caotang scan` opens the folder through a port whose writes all fail, so without `--write` the folder is byte-identical afterwards; with `--write` it holds the folder's lock. Without `--write`, `--summary` must name a file outside the folder. It takes no provider, no key and no network.
- **One table for the mode names.** `src/policy.ts` maps `read-only`, `auto` and `approve-all` to the SDK's policies. When the interactive permission modes land, renaming them is a change to that table.

## Files

| File | What it is |
|---|---|
| `src/agent-args.ts` | `parseAgentArgs`: the flags, checked, as a pure function. |
| `src/policy.ts` | The permission mode to SDK policy table. |
| `src/run-agent.ts` | `runAgent(argv, io)`: open the folder, run the turn, write the result, return the exit code. |
| `src/output.ts` | `ExitCode`, `AgentResultJson` and `StreamLine`, and the report to exit-code mapping. |
| `src/diff-print.ts` | The changed files as one unified diff. |
| `src/scan-args.ts` | `parseScanArgs`: the scan's flags, checked, as a pure function. |
| `src/run-scan.ts` | `runScanCommand(argv, io)`: open the folder read-only, run `@caotang/scan`, print the format, write `--summary`, return the exit code. |
| `src/cli.ts`, `src/bin.ts` | The `agent`, `scan` and `mcp` router, and the process wiring (arguments, environment, streams, signals). |

The tests are Vitest: the parser as a table, the command in process against the demo provider and a scripted endpoint, and the scan in process over a copy of `test/fixtures/continuity-project`, and the built bundle as a child process (`test/binary.test.ts`). SIGINT and SIGTERM are tested in process, by aborting the signal the bin would abort; the bin's own wiring of them is not run as a child process (Windows has no signals to send).
