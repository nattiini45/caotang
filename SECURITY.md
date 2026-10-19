# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue.

- **GitHub:** use private vulnerability reporting on this repository. Open the **Security** tab of [nattiini45/caotang](https://github.com/nattiini45/caotang/security) and choose **Report a vulnerability**.
- **Email:** caspar@pawcommit.com.

Include what you found, the version or commit, the steps to reproduce it, and what an attacker could do with it. A proof of concept helps. If the problem involves a provider key or a project, please use a throwaway key and a sample project.

We aim to answer within a week. We will tell you whether we can reproduce the problem, keep you informed while it is fixed, and credit you in the release notes unless you would rather not be named. Please give us a reasonable time to ship a fix before you disclose the problem publicly.

## Scope

In scope:

- **The Caotang app**: the web app in `apps/desktop` and the packages it uses, including the official deployment at `caotang.app`.
- **The Caotang MCP server**: `packages/mcp-server`, run as `caotang-mcp` over HTTP or stdio.
- **The `.mcpb` bundle** built from that package.

Out of scope:

- The model providers and MCP servers you connect. Report problems with them to their operators.
- Attacks that need code already running in the Caotang page, or control of your device (see the threat model below).
- Self-hosted copies that change the code or serve it without HTTPS.
- Missing hardening that leads to no concrete exploit.

## Supported versions

Only the latest release is supported. Fixes go into the next release, not into older ones.

## Threat model in short

The full statement is in [docs/architecture/provider-gateway.md](docs/architecture/provider-gateway.md) §7 and, for MCP, [docs/architecture/extensibility.md](docs/architecture/extensibility.md) §4 and §9.

- **There is no Caotang server.** The app is static files. Projects stay in your browser, or in a folder you choose.
- **Provider calls go straight from your browser to your provider.** The agent sends requests only to the provider you configured, and to MCP servers you connected yourself. The built-in demo provider makes no network request.
- **Keys are sealed.** Provider keys and MCP bearer tokens are encrypted with AES-GCM under a non-extractable WebCrypto key, stored in IndexedDB outside the project database. Plaintext keys never go into localStorage.
- **Keys never leave with your work.** No key, token or provider address is written into a project, a bundle or an export.
- **Keys are kept out of logs.** The request log stores no request bodies, headers or keys, and error excerpts have the key removed.
- **What sealing does not protect against.** Sealing stops a stored key from being read out of browser storage, for example from a copied profile or a shared machine. It does not protect against malicious script running in the Caotang page, or against a compromised device: code in the page can use the key while Caotang is open. A web app with no backend has no stronger option; the desktop app on the roadmap will use the operating system's keychain.
- **External MCP tools are untrusted.** The MCP client is off until you turn it on. Each tool list is reviewed and pinned; a changed tool is refused until you review it again. Every external call asks for approval unless you trusted that server for reads and the tool declares itself read-only.
- **The MCP server is local.** Over HTTP it listens on `127.0.0.1` only, checks the `Host` and `Origin` headers, and requires a bearer token on every request. It is read-only unless you start it with `--allow-writes` (or the bundle's **Allow changes** setting), and each write that needs confirmation is confirmed in your MCP host. It cannot see provider keys.
- **The `.mcpb` bundle is not signed yet.** Your host will warn before installing it. Build it yourself from source if you want to check what you install.
