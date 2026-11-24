# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue.

- **GitHub:** use private vulnerability reporting on this repository. Open the **Security** tab of [nattiini45/caotang](https://github.com/nattiini45/caotang/security) and choose **Report a vulnerability**.
- **Contact:** PawCommit Studio.

Include what you found, the version or commit, the steps to reproduce it, and what an attacker could do with it. A proof of concept helps. If the problem involves a provider key or a project, please use a throwaway key and a sample project.

We aim to answer within a week. We will tell you whether we can reproduce the problem, keep you informed while it is fixed, and credit you in the release notes unless you would rather not be named. Please give us a reasonable time to ship a fix before you disclose the problem publicly.

## Scope

In scope:

- **The Caotang app**: the web app in `apps/desktop` and the packages it uses, including the official deployment at `caotang.app`.
- **Caotang for desktop**: the Electron app in `apps/desktop-shell`, and the packages built from this repository for it.
- **The Caotang MCP server**: `packages/mcp-server`, run as `caotang-mcp` over HTTP or stdio.
- **The `.mcpb` bundle** built from that package.

Out of scope:

- The model providers and MCP servers you connect. Report problems with them to their operators.
- Attacks that need code already running in the Caotang page, or control of your device (see the security model below).
- Self-hosted copies that change the code or serve it without HTTPS.
- Missing hardening that leads to no concrete exploit.

## Supported versions

Only the latest release is supported. Fixes go into the next release, not into older ones.

## The security model

There is no Caotang server. The app is static files plus, in the desktop app, one native process on your own computer. This section says what that process is allowed to do, what guards it, and what is not true yet. The full specs are [provider-gateway.md](docs/architecture/provider-gateway.md) §7, [extensibility.md](docs/architecture/extensibility.md) §4 and §9 for MCP, and [desktop.md](docs/architecture/desktop.md) for everything the desktop app adds.

### In the browser

- **Projects stay on your machine.** They live in the browser's own storage, or in a folder you choose with Chrome, Edge or another Chromium browser. A hosted instance with end-to-end encrypted storage is a roadmap spec, [hosted.md](docs/architecture/hosted.md), and is not built.
- **Provider calls go straight from your browser to your provider.** The agent sends requests only to the provider you configured, and to MCP servers you connected yourself. The built-in demo provider makes no network request.
- **Keys are sealed, and the page never writes one into your work.** Provider keys and MCP bearer tokens are encrypted with AES-GCM under a non-extractable WebCrypto key, stored in IndexedDB outside the project database. Plaintext keys never go into localStorage, and no key, token or provider address is written into a project, a bundle or an export.
- **Keys are kept out of logs.** The request log stores no request bodies, headers or keys, and error excerpts have the key removed.
- **What sealing does not protect against.** Sealing stops a stored key from being read out of browser storage, for example from a copied profile or a shared machine. It does not protect against malicious script running in the Caotang page, or against a compromised device: code in the page can use the key while Caotang is open. This is why the desktop app keeps keys elsewhere, below.

### In the desktop app

The desktop app is the same studio in an Electron window. It adds a main process, and every capability below is reachable only through one narrow, versioned preload bridge; there is no generic Electron or IPC API on the page.

**The window is a sandboxed renderer on a fixed origin.** The page is served from `app://caotang/` out of the app's own build directory, with no `file://` and no loopback web server. The window runs with Chromium's sandbox on, `contextIsolation: true`, Node integration off and Chromium's web security on. It never navigates to a remote page and cannot open one: every frame navigation, redirect and new window is refused. A CSP header travels with every response beside the unchanged HTTP meta policy — scripts, styles and Workers same-origin, no inline script, no `eval`, no frames, no objects, no form submission, `frame-ancestors 'none'` — and the only response paths are the built assets, the notices file and `index.html`. Clipboard writes are the only permission the page is ever granted. The packaged binary turns off Electron's Node mode, `NODE_OPTIONS` and the inspector, loads the app only from its ASAR archive, and refuses to start if that archive does not match the integrity data written into the executable. The shell refuses to run with `--no-sandbox`.

**Only the studio's own top frame reaches the native side.** One guard, [`ipc-guard.mts`](apps/desktop-shell/src/ipc-guard.mts), answers every channel: the calling frame must have no parent and its address must be the entry page. A frame inside the page, another origin, and a page that navigated away all get nothing.

**The provider port is not a general fetcher.** In the desktop app the main process makes the provider and MCP requests, because a page cannot send a key it never holds and cannot read a provider that refuses a browser's preflight. That port is a rule, not a `curl`: [`native-egress.ts`](packages/gateway/src/native-egress.ts) allows https to an origin the app already has configured, read from your saved profiles **before each call** rather than at start-up; plain http only to a `local` entry, which is an MCP server on a loopback address or a provider profile whose address is a loopback literal, and never to any other address even when an entry says `local`; no credentials in the address; five methods only (GET, POST, PUT, PATCH, DELETE), the ones a model call or a listing uses; at most 32 headers and 32 KiB of them, a 24 MiB request body, and a response counted as it streams with a 64 MiB cap; header names that describe the connection rather than the request (`host`, `content-length`, `transfer-encoding` and the like) refused, and a header value with a line break in it refused. A redirect is never followed — the 3xx goes back to the page — because following one would turn the allowlist into a starting point. A model server on your own computer is one of those `local` entries: the app calls it from the main process too, and a key the server asks for reaches it as the key, never as the page's handle, which a server would have read as a literal token and refused.

**A call you stop sends nothing.** Every call is registered as stoppable before the operating system opens the seal on its key, and the request is checked again once the secret arrives and before it goes out, so a stop that lands during that wait ends the call and a stop a moment later still keeps it from leaving. A call stopped while its key was being opened is reported as `aborted`, never as whatever the key did on the way out. A call the page stops is stopped in the main process, and so is every call a window leaves behind by closing, reloading or navigating away.

**Keys are sealed by the operating system's store, and the page never reads one.** Windows DPAPI, the macOS login keychain, or libsecret/KWallet on Linux, through Electron's `safeStorage`. The vault is one file in the app profile, `native-key-vault.json`, holding one entry per key id, where each entry is the sealed secret together with the address it was entered for; every change rewrites that whole file once, so a key is never stored without its address and never has an address without its key, and a write that fails leaves neither. [`os-vault.ts`](packages/gateway/src/keys/os-vault.ts) is the rule. The page's channels are `available`, `put`, `putReplacement`, `putHeaders`, `remove`, `has`, `revision`, `restore`, `headers` and `keyState` — there is no read among them, and the shell's own suite asserts that list. The page stores a key or the header values that go beside it, naming the address it is for in that same write, and learns whether an entry holds nothing, a key or headers alone, which revision it is at, and the extra header values you typed beside it; it never gets the secret back.

- **A key reaches a request as a handle that becomes a secret.** The page's key store answers a reveal with `caotang-key:<id>` and writes that handle where the key would go. The main process swaps it for the secret only for an address that key was configured for; a handle at any other origin is refused rather than sent. So script in the page can use a stored key while the app is open, and cannot carry one away — the difference the browser vault cannot offer.
- **A key belongs to the address it was entered for, and the page cannot move it.** The port rebuilds the addresses it will send to on every request from the vault's own entries, so a page can name a key's id inside a request and cannot say where that id belongs. A `put` for an id this computer already holds at another address is refused as `bound` rather than rebinding it: the writer is told the key is kept for another address and to enter it again for this one. The one write that does move a key is `putReplacement`, which the profile form makes when the writer types the key again for an endpoint they changed, so a secret already stored is never pointed at a new address. An address is a bare origin — https anywhere, and plain http only on this computer — and a key with no address is denied rather than sent anywhere, because there is no rule that reads "no address" as "any address".
- **A key an older build stored has no address, and stays denied.** A record written before addresses were kept holds its keys without one, and no page call gives an existing secret an address, since a page that could name one could point a writer's key at a server of its own. The port refuses every request that names such an entry until the writer enters the key again for the endpoint the profile names, which places it in one write, and Settings names that profile as one without a usable key. No shipped build has such keys.
- **A profile that authenticates with its own headers keeps no key.** The generic endpoint preset reaches a service that wants its own headers rather than a bearer key, and a profile saved that way is sealed as an empty key plus at least one header — a payload the vault refuses only when it holds neither. Such a profile answers no key at all: its calls carry their own headers and no key, the same shape the browser's vault stores.
- **A provider that echoes a key cannot put one in the log.** The secret is attached in the main process, so the page's own redaction would never see it. The answer's bytes are scrubbed of every secret attached to that call as they stream back, across chunk boundaries, before the page receives one. The pass reads the answer once, longest secret first, and never rescans a replacement it wrote — which is what keeps it finite when a key is a single character that also occurs in the word replacing it.
- **A write can be undone without a read.** The vault remembers the entry the last write of an id replaced — the sealed secret and the address it was written for — and `restore` puts that pair back in one write of the file, so the MCP client's "store the new token, update the server, put the old one back if that is refused" works against a store it cannot read. An undo can only put back a pair that was stored as a pair, so a restore never carries an older key to the address a newer one was entered for, and a removal drops the undo with the key, so a removed secret cannot come back at any address.
- **Migration writes, verifies, deletes.** On first open with a keychain, each key an earlier build sealed in the browser's IndexedDB vault is opened by the store that holds it, written to the keychain with the address its own record names, read back, and only then removed from the browser. A key the browser's store cannot open stays where it is, and the app says which profiles have none instead of opening as though nothing were missing. So does a credential whose record is gone or whose address does not parse. One MCP token reference that two servers name at two addresses is one entry's worth of token: it is placed for the first server in the settings' own order, and the second is refused rather than handed a token saved for another address.

**A machine with no usable keychain falls back, and says so.** Chromium on Linux falls back to a built-in key that is the same on every machine, which is obfuscation rather than encryption; the vault treats that backend as no keychain at all. There, keys stay in the browser's WebCrypto vault, Settings says the keys are in this browser rather than in the computer's keychain, and a start-up notice says the same.

**The project's own MCP server is the app's, and one writer at a time.** The app can serve the open project over MCP: it forks the same bundle the `.mcpb` ships as an Electron utility process, on a port the operating system picks, with 192 bits of base64url token minted per start, held in the main process and handed to the page once because your next step is to paste it into another program. It is not written into a project, an export or a log, and it ends with the run. The page names a folder **id**, never a path, and the shell resolves it through the grant list every folder channel uses, so the server cannot be pointed at a directory you never opened. Writes are off until you turn on **Allow changes**, and changing that setting restarts the server. While Caotang saves, the app pauses the server (`POST /control/pause` with the same token) and a write tool is refused rather than queued — as is `coherence.scan`, the one read whose answer the server appends to the folder's `coherence.json`, on a server that may write; a read-only server still answers it. The pause is a barrier: it answers only once every write the server had already admitted has released, so a save never runs while the server is still persisting a file, and the save's own digest check stays the backstop for a change from anywhere else. A pause that cannot be confirmed — refused, unanswered, or outlasting the app's wait — stops the save and asks you instead of writing beside a server that may still accept writes, so you can still choose to save once you have answered, and a pause the app stopped waiting for is let go with `POST /control/cancel` so the folder is not left paused. The last resume of a save makes the server read the folder again before it answers, so a host is never answered from the project as it was before the save.

**Deep links name a grant, never a path.** `caotang://project/<id>` is the whole grammar, and the id must be a folder this profile has already been granted — one you opened with the picker or one listed under **Recent project folders**. Another route, a query, a fragment, a user, a port, or an id this profile does not know is refused. A folder handed over by your file manager or a command line is accepted only when it is an absolute path to a readable directory that holds a `caotang.json`, and the app's own paths are never treated as a folder. [`links.mts`](apps/desktop-shell/src/links.mts) is the only place either rule is written.

**Your work stays on your computer.** Projects are folders you choose, or the browser's storage; the app does not upload them anywhere. There is no account, no subscription, no telemetry and no analytics: the studio's only network dependency is the provider you configured, plus any MCP server you connected yourself. [README.md](README.md) states the same in one line — "There are no accounts, no subscriptions, no credit meters and no Caotang server" — and the desktop app has no update check: it never asks for, downloads or installs one.

### What this does not cover

- **Script in the page.** A key can be used while the app is open, by code from a provider's answer, an MCP tool's result or a malicious skill. Caotang marks outside text for the model, and no app can make a model immune to text written to mislead it.
- **Your device.** Malware, a keylogger, a stolen unlocked computer. The keychain protects a key at rest, not a machine someone else is using.
- **The other end.** Providers and MCP servers you configure are outside this model; their own policies and security apply.
- **An unsigned download.** Nothing yet proves that a package you have is the one CI built, unless you check it yourself (below). Signing and notarisation are later work.

### What is not verified

- **`safeStorage` on a real Windows, macOS or KDE desktop.** The vault's rules are tested with a scripted sealer; the shell's suite proves the channels the page gets. The Linux runner the suite runs on has no keyring, so the fallback path is the one that runs in CI.
- **The app's own MCP server on anything but Linux x64.** `utilityProcess` forking the bundle has been run under Xvfb only, and the bridge's clipboard permission that the copy buttons use has not been checked on a real desktop. No packaged build has started a server yet.
- **The menus, deep links, Save dialog and tray** are covered by the shell's suite on Linux; Windows and macOS behaviour for the child process and for code signing is unchecked.
- **The packages themselves.** They are unsigned, no tag has been cut, and there is no release page yet.

### How to check each claim

Every statement above is a rule in a file you can read, and most of them have a test:

| Claim | Where to look |
| --- | --- |
| The renderer's sandbox, CSP and fixed origin | [`main.mts`](apps/desktop-shell/src/main.mts) — the `webPreferences` block, the CSP array and the response path check |
| Only the top frame reaches the native side | [`ipc-guard.mts`](apps/desktop-shell/src/ipc-guard.mts), used by every channel |
| The provider port's rule, and a stopped call that sends nothing | [`native-egress.ts`](packages/gateway/src/native-egress.ts) and its test, [`native-egress.test.ts`](packages/gateway/test/native-egress.test.ts); a launched app proves the rule in [`egress.spec.ts`](apps/desktop-shell/test/egress.spec.ts) and the stop in [`egress-cancel.test.ts`](apps/desktop-shell/test/egress-cancel.test.ts) |
| Keys sealed by the OS store, each with its address, no read channel, and a headers-only profile | the address's own rule in [`key-origin.ts`](packages/gateway/src/keys/key-origin.ts), the vault in [`os-vault.ts`](packages/gateway/src/keys/os-vault.ts) and [`vault.mts`](apps/desktop-shell/src/vault.mts), and `apps/desktop-shell/test/vault.spec.ts`, which asserts the channel list; `packages/gateway/test/os-vault.test.ts`, `vault-payload.test.ts` and `key-origin.test.ts` hold the rest |
| The MCP server's token, writes-off default, pause and reload | [`mcp.mts`](apps/desktop-shell/src/mcp.mts), [`gate.ts`](packages/mcp-server/src/gate.ts), [`folder.ts`](packages/sdk/src/folder.ts) for the reload, and `apps/desktop-shell/test/mcp-host.spec.ts` |
| Deep links name a grant id | [`links.mts`](apps/desktop-shell/src/links.mts) and `apps/desktop-shell/test/os-integration.spec.ts` |

To check them yourself:

1. **Read the rules.** The files above are small and each one starts with the rule it keeps.
2. **Run the tests:** `pnpm install && pnpm --filter @caotang/desktop-shell test:smoke`. This builds the studio and the shell and runs the shell's suite, which includes the egress, vault, MCP and OS-integration specs. On Linux, run it under `xvfb-run -a` with a host that supports the Chromium sandbox.
3. **Build a package from source and compare it with a download:** `pnpm --filter @caotang/desktop-shell run package:linux`, and on each platform the matching `package:*` script. Then check a download's hash against the `SHA256SUMS` file published beside it: `shasum -a 256 -c SHA256SUMS`, or `Get-FileHash -Algorithm SHA256` on Windows.
4. **Watch the network.** With the demo provider, the app makes no request at all. With a provider configured, its requests go to that provider's address and nowhere else; a proxy or a firewall on your machine shows the same thing.
