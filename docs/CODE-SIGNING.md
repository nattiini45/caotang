# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

> Status: being prepared (#409). Caotang for desktop (epic #16) is not released yet. Its Windows builds will be signed this way once SignPath Foundation accepts the project; until then they ship unsigned with SHA-256 checksums (#401). Signing is switched off in CI until then (`SIGNPATH_ENABLED` below).

## What is signed

- Only the Windows builds of **Caotang for desktop**: the installer and the `Caotang.exe` it installs.
- Only binaries built by this repository's own GitHub Actions workflow ([`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml)) on GitHub-hosted runners, from the public source at the tagged commit. Nothing built on a personal machine is signed.
- Every signed file carries the product name **Caotang** and the release's version as its product version, and SignPath enforces both ([`.signpath/artifact-configuration.xml`](../.signpath/artifact-configuration.xml)).
- Binaries from other open-source projects that ship inside the installer, such as Electron's and Chromium's libraries, are not signed with this certificate. They are included as their projects publish them.
- The browser app at [caotang.app/app](https://caotang.app/app/), the MCP server bundle (`.mcpb`) and the command-line bundle are not signed by SignPath.

## Team roles

| Role | Who | What it means |
|---|---|---|
| Authors (committers) | [@nattiini45](https://github.com/nattiini45) | May change the source code without a further review. |
| Reviewers | [@nattiini45](https://github.com/nattiini45) | Reviews every pull request from anyone who is not an author before it is merged. |
| Approvers | [@nattiini45](https://github.com/nattiini45) | Approves each signing request by hand in SignPath, release by release. |

Everyone in these roles uses multi-factor authentication on GitHub and on SignPath.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

- Caotang has no account, no telemetry and no Caotang server.
- When you add an AI provider (bring your own key), the text a request needs is sent to that provider only, using your key. Each provider's own privacy policy applies to what you send it.
- MCP connections go only to the servers you configure yourself, and their own policies apply.
- If the desktop app ever checks for updates, the check will be described here and can be switched off before it is turned on.

## Releases and approval

1. A version tag starts the desktop release workflow, which builds the packages from source in CI and uploads them as workflow artifacts.
2. With signing enabled, the workflow submits the Windows artifact to SignPath. The request waits until an approver approves it by hand in SignPath; nothing is signed automatically.
3. SignPath checks that the artifact came from this repository's workflow, signs it and returns it to the workflow.

## Uninstalling

The Windows installer registers an uninstaller: remove Caotang in *Settings › Apps › Installed apps* (or *Control Panel › Programs and Features*). Your projects are folders you chose and are not removed.

## Turning signing on (maintainers)

The signing job in `desktop-release.yml` runs only when the repository variable `SIGNPATH_ENABLED` is `true`. Before setting it:

- the SignPath project exists and its artifact configuration is `.signpath/artifact-configuration.xml`;
- the repository variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG` and `SIGNPATH_SIGNING_POLICY_SLUG` (and, if not the default, `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`) are set;
- the secret `SIGNPATH_API_TOKEN` (a SignPath submitter token) is stored in the `code-signing` environment.

Report a file signed with this certificate that breaks this policy to support@signpath.io, and a security problem in Caotang through [SECURITY.md](../SECURITY.md).
