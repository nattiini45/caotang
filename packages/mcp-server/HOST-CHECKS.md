# MCPB host checks

A record of running the `.mcpb` bundle in real MCPB hosts. **No row below has been run yet.** Nothing here is a pass until a person has run it, dated it and filled in the results table. Until then the bundle counts as checked and run over stdio only (see Known gaps in the [README](README.md#known-gaps)).

## Build the bundle

```sh
pnpm --filter @caotang/mcp-server run pack
```

This writes `packages/mcp-server/dist/caotang-mcp-0.1.0.mcpb`.

## Hosts

- Claude Desktop on macOS (required)
- Claude Desktop on Windows (required)
- Claude Code, installing the `.mcpb` (optional)
- MCP for Windows (optional)

## Checks, per host

Run these on each host. Tick a row only for the host and date you record in the results table below, and untick it again for the next host or release.

- [ ] Not yet run. The install dialog shows the display name, the description and the two settings, and **Allow changes** is off by default.
- [ ] Not yet run. A project folder with spaces and non-ASCII characters in its path (for example `~/Schreiben/Roman 草堂`) reaches `--project` intact.
- [ ] Not yet run. With **Allow changes** off, the host lists 7 tools and `coherence.scan` runs. Record what the server's stderr says about `CAOTANG_MCP_ALLOW_WRITES` (`is unset`, `is "true"`, `is "false"` or `is other`). The server logs the class only, never the value the host sent.
- [ ] Not yet run. With **Allow changes** on, the host lists 21 tools. A write that applies at once (`notes.append`) applies. A write that asks (`codex.write`) shows the host's confirmation dialog; declining writes nothing, accepting writes.
- [ ] Not yet run. The fonts load from `server/fonts/`: a contact-sheet export with CJK and emoji text through `export.compile` shows the characters. The WebP decoder loads from `server/webp_dec.wasm`: a contact sheet whose shot has a WebP picture draws it.
- [ ] Not yet run. Uninstalling removes the server and leaves the project folder clean, with no `.caotang-mcp.lock` left in it.
- [ ] Not yet run. A folder whose `caotang.json` is damaged (cut a copy of a project's manifest in half, keeping its `caotang.json.bak.1`) starts the server without a project. `project.recover` shows the snapshot, and with **Allow changes** on, `project.recoverApply` shows the host's dialog: it must name `caotang.json.bak.1`, the kept copy `caotang.json.corrupt-<timestamp>` and the folder lock. Declining writes nothing; accepting writes the new manifest, keeps the original, and every tool then says to restart. Remove `bak.1` and repeat: the call without `rebuild` is refused naming the loss, and `rebuild: true` shows a dialog that names the loss of folder structure and vocabulary.
- [ ] Not yet run. The Node version the host runs is recorded and meets the root `package.json` `engines` range, `^22.12.0 || ^24.0.0 || >=26.0.0`. (`server.type: node` uses the host's own Node.)

## Results

One row per run. Write `pass` or `fail` for each check, in the order above.

| Date | Host | Host version | OS | Node version | Checks 1–8 | Notes |
| ---- | ---- | ------------ | -- | ------------ | ---------- | ----- |
|      |      |              |    |              |            |       |

Keep screenshots out of the repository.

## When a host behaves differently

Document the quirk here first. The server turns writes on only for the exact value `true` in `CAOTANG_MCP_ALLOW_WRITES`. If a host sends another value for a switched-on setting, change the parser only by adding that one observed value, with a test in `test/cli.test.ts`, and never by accepting any truthy value.
