# Installing Caotang for desktop

Caotang for desktop is the studio in a window of its own. These packages are **unsigned** for now, so Windows and macOS
show a warning the first time you open one; each download comes with a `SHA256SUMS` file so you can check you got what CI
built. The packages are built from this repository's source in GitHub Actions (`.github/workflows/desktop-release.yml`), and
nothing is sent anywhere except the AI provider and the MCP servers you configure yourself.

| Platform | File | Install |
| --- | --- | --- |
| Windows 10 or 11, 64-bit | `Caotang-Setup-<version>.exe` | [Windows](#windows) |
| macOS on Apple silicon or Intel | `Caotang-<version>-<arch>.dmg` | [macOS](#macos) |
| Linux, 64-bit | `Caotang-<version>.AppImage` | [Linux](#linux) |

## Where a package comes from

There is no download page yet: the app is built, but no release has been tagged. Until one is, you can have a package in either of two ways.

- **Build one from this source.** From a checkout, `pnpm install`, then `pnpm build`, then the packaging script for your platform: `pnpm --filter @caotang/desktop-shell run package:win:installer` on Windows, `package:mac-arm64` or `package:mac-x64` on a Mac, `package:linux` on Linux. Each needs the platform it packages; the files land in `apps/desktop-shell/release/` with a `SHA256SUMS` file beside them. The [development shell's README](../apps/desktop-shell/README.md) has the details, including how to run the app without packaging it.
- **Take a CI run's packages.** [`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml) builds the packages on GitHub-hosted runners, both for a `desktop-v<version>` tag and for a manual run. A manual run publishes nothing: its packages and their `SHA256SUMS` files are that run's workflow artifacts, on the run's summary page under *Artifacts*. A tag publishes the same files as the release.

Either way, the file you get is built by that workflow from this repository's source, and the hash in `SHA256SUMS` is what you compare a download against.

## What the app needs

- **One of the three platforms in the table.** Nothing else is needed to run it: the app brings the browser it is built for, so you do not need Chrome or Edge, and opening a project folder needs no browser permission and no Chromium-specific browser feature.
- **A keychain the app can use.** Provider keys and MCP tokens are kept by your operating system's own store: DPAPI on Windows, your login keychain on macOS, and libsecret or KWallet on Linux. On a Linux desktop with no keyring, the app says so at start-up and keeps the keys encrypted in its own storage instead; the keys work the same, and Settings tells you which of the two holds them.
- **Writing you can open.** A new project is an empty folder you choose. An existing project opens from the folder that holds its `caotang.json`; a folder from another app, or from a newer Caotang, is refused with a sentence rather than opened.

## Check the download first

Each package ships beside a `SHA256SUMS` file. Run the line for your platform in the folder you downloaded both files into,
and expect a line ending in `OK`:

```sh
# macOS and Linux
shasum -a 256 -c SHA256SUMS
```

```powershell
# Windows, PowerShell
Get-FileHash .\Caotang-Setup-0.1.0.exe -Algorithm SHA256
```

Compare the printed hash with the line in `SHA256SUMS` yourself on Windows; the macOS and Linux command does the comparison
for you.

## Windows

The installer shows **Windows protected your PC** the first time, because the download is not signed yet: choose **More
info**, then **Run anyway**. The installer asks where to put the program, adds a **Caotang** shortcut to the Start menu and
the desktop, and lists **Caotang for desktop** in *Settings › Apps › Installed apps*, where you can uninstall it later.

## macOS

Open the `.dmg` and drag **Caotang for desktop** into *Applications*. The first open says the app "cannot be opened because
the developer cannot be verified", because the build is not signed or notarised yet: hold Control and click the app in
*Applications*, choose **Open**, then **Open** again. If macOS only offers **Move to Bin**, allow it in *System Settings ›
Privacy & Security* with **Open Anyway**, and open the app again.

You may also see a message that the app was not checked for malicious software after that first open; the permission you
gave stays, and later opens are ordinary.

## Linux

Make the file executable, then run it:

```sh
chmod +x Caotang-0.1.0.AppImage
./Caotang-0.1.0.AppImage
```

AppImage needs FUSE. On a distribution that ships FUSE 3 only, install `libfuse2` (Debian and Ubuntu:
`sudo apt install libfuse2`) or run the file with `--appimage-extract-and-run`. The Linux package is best-effort: it is
built and its checksum published, but a failure there does not hold up a release, and it is the least tested of the three.

## What the app keeps, and what it leaves behind

Your projects are folders you choose, and the folder holds the manuscript: uninstalling the program does not touch them. A
project kept only inside the app, without a folder, lives in the app's own profile and is removed when you uninstall it, so
**Copy to a folder** first if you want to keep one. The app sends your manuscript nowhere: model requests go to the provider
you configured, with your key.

The app has no update check. To move to a newer version, install its package over this one; your projects, your project
folders and your settings stay where they are.

## If something goes wrong

Search the [issues](https://github.com/nattiini45/caotang/issues) and open one with your platform, the version in the file
name you downloaded and what happened. Security problems go through
[SECURITY.md](../SECURITY.md), not the issue tracker.
