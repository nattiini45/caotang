# Extension bundles — third-party skills, commands and suggested MCP servers, with no third-party code

> Status: **specified, not built.** Nothing in this spec runs in the current build: there is no bundle reader, no `@caotang/extensions` package, no `extension.*` command and no Settings › Extensions section. The decisions in §12 bind the work when it is cut. Issue #62; the owner's decision is "C now, B deferred" (decisions.md, MCP server and client).
> Scope: what a writer can install from someone else without Caotang running someone else's code: the bundle format, the trust model, the install, update and remove flows, and what each part does once installed.
> Cross-refs: skills (the unit a bundle wraps), review and pin = [extensibility.md](extensibility.md) §10 · MCP servers, `parseServerImport`, `checkServerUrl`, pins = extensibility.md §3/§4 · tool permission model, rules and hooks = [agent-harness.md](agent-harness.md) §4 · bus commands and `agentRisk` = [command-bus.md](command-bus.md) §9 · project layout = [project-format.md](project-format.md) §1 · the non-goal = [ARCHITECTURE.md](../ARCHITECTURE.md) §4.

## 0. What exists today, and what this waits for

- **Built:** project skills (`.agents/skills/<name>/`, reviewed in full and pinned in app settings, extensibility.md §10), MCP server import with its clamps (`parseServerImport`, `checkServerUrl`, `clampServers`), and macros as plan data (extensibility.md §10).
- **Not built, and a dependency:** lifecycle hooks (#59), slash commands and saved prompts as user-only skills (#61), the macro script phase (#57), allow/ask/deny rules (#52) and untrusted-data provenance in prompts (#54).
- **Not built here:** the hosted instance (#17), which is where a catalogue would live.

A bundle is a way to *carry* these things between writers. It adds no capability of its own, so each part works only where the feature it carries does (§2).

## 1. What a bundle is

An extension is **declarative**: Markdown and JSON, text only. Caotang never loads, evaluates or runs anything from a bundle, and a bundle holds no file the app executes. A bundle is a `.caotang-ext` zip, or the same files as a folder:

```
<name>/
  manifest.json        # §2
  README.md            # shown on the card as plain text (optional)
  skills/
    <skill-name>/
      SKILL.md         # an Agent Skills folder, byte for byte (extensibility.md §10)
      references/ …
  mcp.json             # suggested MCP servers (optional, §6)
```

**It adds no skill format.** A skill in a bundle is the same Agent Skills folder a project keeps in `.agents/skills/`, read by the same reader, with the same caps (extensibility.md §10: 64 files per skill, 256 KB per file, 2 MB per skill) and the same review. A command is a user-invocable skill (#61), not a second kind of file. Unzipping a bundle gives folders that other agents read unchanged.

## 2. The manifest

```ts
interface ExtensionManifest {
  manifestVersion: 1;                    // a newer value is refused by name, never read as 1
  name: string;                          // /^[a-z0-9][a-z0-9-]{0,63}$/, no trailing hyphen; the folder name when unzipped
  version: string;                       // semver
  title: string;                         // ≤ 80 characters, plain text
  description: string;                   // ≤ 600 characters, plain text
  author?: string;                       // ≤ 80 characters; shown as "unverified author", never as a verified identity
  caotang?: { minVersion?: string };     // honoured: an older app refuses with the version it needs
  permissions: Permission[];             // closed enum, below
}
type Permission = 'skills' | 'commands' | 'mcp' | 'hooks:check' | 'hooks:mcp' | 'macros';
```

An unknown key in `permissions`, or an unknown permission value, is refused by name. `permissions` is what the bundle asks for and what the card states; a part present without its permission is refused, and a permission without its part is shown as unused.

| Permission | v1 | What it allows |
|---|---|---|
| `skills` | **yes** | The `skills/` folders. |
| `commands` | **yes** | Skills marked user-invocable are offered as slash commands, once #61 lands. Until then the same skills install as skills. |
| `mcp` | **yes** | `mcp.json`: suggested servers, §6. |
| `hooks:check`, `hooks:mcp`, `macros` | **refused** | In the enum so a manifest written for a later build parses; installing one is refused with "`<permission>` is not supported in this build". Each is enabled by a small follow-up when #59 (hooks) or #57 phase 1 (macros) lands. **No stub `HookSpec` is invented here.** |

When hooks and rules arrive, a bundle's can only **tighten**: a hook may block or ask, never allow; a rule may be `deny` or `ask`, never `allow`; a bundle cannot change the permission mode; `hooks:mcp` may call only servers shipped in the same bundle, and only after the writer has enabled and pinned them (§6).

## 3. Install is a human reading the whole bundle

1. **From a local file or folder only.** The writer picks it in Settings › Extensions. There is no catalogue, no URL install, no download, no telemetry, and the agent cannot reach any of it. A catalogue waits for the hosted instance (#17).
2. **The reader checks before anything is shown.** Limits are counted on **decompressed bytes**: text only, **2 MB** decompressed, files that are not valid UTF-8 refused, at most **50 skills** per bundle, at most **20 installed extensions**. The zip reader refuses `..` and absolute paths, drive letters and backslashes, symlinks, duplicate entries, entries that collide after case folding or Unicode normalisation, and any entry over its cap (the skill cap-and-path rules of extensibility.md §10 apply, a zip-slip refusal included). A refusal names the cap or the entry and installs nothing.
3. **The card.** A plain-language summary comes first ("3 skills, 1 command, 1 suggested MCP server; asks for: skills, commands, mcp"), then the whole bundle as **plain text**: the manifest, the README, every file of every skill, `mcp.json`. No Markdown or HTML rendering, no remote image is fetched, an HTML comment is shown as text, and bidirectional controls, zero-width and other invisible Unicode are made visible and counted, as the skill review card does. The author is shown as **"unverified author"**: there is no signature in v1.
4. **Nothing is active until a human clicks Install.** An unclicked bundle is not read by the model, not in any list, and not offered to a command. The click installs the bundle in **app scope**.
5. **The pin.** The app computes a SHA-256 over the canonical manifest plus the sorted list of `path` and `sha256` of every file, from the **raw bytes**. A hash named in the manifest is never read or trusted. The pin is kept in **app settings**. It is re-checked on every load; a mismatch makes the extension inactive until reviewed again.
6. **Update.** Installing a bundle with an installed name and a different pin shows a **diff card** (files added, removed and changed, each as text). The old version **stays active** until the writer approves the update. A lower `version` is shown as a downgrade, not refused.
7. **Remove** is one click. The installed skills stay readable on disk where the app keeps them; removing deletes the pin and the extension's own state, never a project's files.
8. **A shipped `known-bad.json`** lists pins (and name and version pairs) of bundles the maintainers withdrew. It is **data in the release**, fetched by nothing; an installed or offered bundle on it is refused or deactivated and the card says why. It narrows what installs and never grants anything.

## 4. Commands on the bus

`extension.install`, `extension.setEnabled` and `extension.remove` are bus commands with `issuedBy: 'user'` only and `agentRisk: 'never'` (command-bus.md §9). None is a harness tool, none is on the primitive allowlist, and none is offered over `caotang-mcp`. **The agent never installs, enables or removes an extension**, and a bundle's text cannot ask it to (extensibility.md §4 rule 7 applies to this pack format, as it said it would). The agent may suggest in its report that the writer install one.

## 5. What the model sees

An extension's text is **prompt content from a third party**. It is provenance-marked as untrusted data in prompts (#54), counted against a combined context cap with the skills catalog (extensibility.md §10: 1,500 tokens, descriptions cut first), and subject to the same review, pin and `agentRisk` rules as a project skill. It does not change permissions or approvals, and `allowed-tools` is read the way §10 reads it (shown, not enforced, and it could only narrow).

**Precedence** when names collide is project, then extension, then personal skills; a collision is **reported** on the card and in the Extensions list, never resolved silently.

## 6. Suggested MCP servers

`mcp.json` lists servers the bundle suggests, in the shape `parseServerImport` reads (extensibility.md §3.2). Each entry goes through `parseServerImport` and `checkServerUrl` like a pasted import, and then:

- it is created **disabled**, and the card says so;
- a token, a header or `trustReads` field is **refused**, never ignored: a bundle carries no credential and cannot trust a server's reads;
- it **never overwrites** an existing server's key or URL; a clash is reported and the entry is skipped;
- it has **no pre-seeded tool pins**: the writer enables it, and it runs the normal connect, review and pin flow (extensibility.md §3.4, §4).

The MCP master switch and the 20-server cap are unchanged.

## 7. Project scope (a later slice)

The first slice is app scope. A project may later carry `.agents/extensions/<name>/` (project-format.md §1; reserved now, and loaders ignore it today). **A project may carry an extension but never the consent:** the reviewed pin lives in app settings only, so a shared project cannot approve its own extension. An unreviewed carried extension shows a banner, "This project includes an extension you have not reviewed", and not a silent inactivity.

## 8. Claude Code plugin import (a later slice)

Importing a Claude Code plugin maps **skills and commands only**. It drops and lists on the card as skipped: `allowed-tools`, `!` shell injection, agents, shell hooks, stdio MCP servers and LSP servers. What remains is an ordinary bundle and goes through §3.

## 9. Code slicing (not started)

- **Slice 1**, when #60 merges: a headless `@caotang/extensions` package (manifest, `readBundle`, pin, install-card model, known-bad) with a restricted-imports lint (no store, gateway, vault, DOM, Worker or `eval`), fixtures and vitest.
- **Slice 2:** the three bus commands, a tolerant app-settings slice, Settings › Extensions with the diff card, precedence with the clash report, and a Playwright spec that runs in CI only.
- **Follow-ups, each gated on its own dependency:** hooks (#59), macros (#57 phase 1), bundle rules (#52), project scope (§7), Claude plugin import (§8).

## 10. Evals (when built)

A bundle with each refusal in §3 step 2 (zip-slip, symlink, duplicate and case-colliding entry, non-UTF-8 file, over a cap) installs nothing; a changed byte changes the pin and deactivates the extension; an update keeps the old version active until approved; a manifest with an unknown permission, a newer `manifestVersion` or `hooks:check` is refused by name; an MCP entry with a token field is refused and one that names an existing key is skipped; the agent has no tool that reaches `extension.*`; and the CSP is byte-identical with and without extensions installed.

## 11. What stays out

- **Third-party code in the app.** No Worker, iframe, `eval`, WebAssembly or dynamic `import()` of anything a bundle holds. A plugin system in that sense stays a non-goal (ARCHITECTURE §4).
- **Sandboxed JS plugins (option B) are deferred, not rejected.** They are revisited together with #57 phase 2 (the QuickJS macro sandbox): both need the same CSP change (`'wasm-unsafe-eval'` and a frame or worker source), a versioned public API and a review story. Until then the CSP is not touched by anything in this spec.
- Signed bundles, a catalogue, update checks and install from a URL.

## 12. Decisions

| # | Decision | Authority / rationale |
|---|---|---|
| E1 | Option C now: declarative bundles, no third-party code in the app; option B deferred with #57 phase 2 | **[owner]**, #62. |
| E2 | `.caotang-ext` zip or folder: `manifest.json`, standard `SKILL.md` folders, optional `mcp.json`; no new skill format | Delegated 2026-10-22. A bundle wraps skills; other agents read the folders unchanged. |
| E3 | v1 permissions are skills, commands and suggested MCP servers; `hooks:check`, `hooks:mcp` and `macros` are in the enum and refused until their feature lands; bundle hooks and rules only tighten | Delegated 2026-10-22. Does not block on #59 or #57 and invents no stub `HookSpec`. |
| E4 | Trust model: full-text card, whole-bundle SHA-256 pin from raw bytes in app settings, diff card on update, MCP disabled on arrival, no tokens, known-bad list, clamps (20 extensions, 50 skills, 2 MB, text only) | **[owner]** (shape) and delegated 2026-10-22 (the hardening list). |
| E5 | Local file or folder only; no catalogue, URL install, download or telemetry | Delegated 2026-10-22. A catalogue waits for #17. |
| E6 | `extension.install`, `.setEnabled` and `.remove` are user-only, `agentRisk: 'never'` | Delegated 2026-10-22. |
| E7 | App scope first; a project may carry an extension, never the consent | Delegated 2026-10-22. |
| E8 | Extension text is untrusted third-party prompt content (#54), under a combined context cap | Delegated 2026-10-22. |
| E9 | The CSP is not changed by any bundle work; `frame-src 'none'` is its own commit that does not depend on this spec | Delegated 2026-10-22. |
