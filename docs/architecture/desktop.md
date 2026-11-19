# Caotang for desktop

The native shell in [epic #16](https://github.com/nattiini45/caotang/issues/16) hosts the existing root-base Vite build from `apps/desktop/dist/`. The browser site, project format, storage schema and Vite output stay unchanged. This spec records the feasibility spike (#398) and the boundary for the first shell (#400); it does not describe an installable product.

## Runtime and trust boundary

- Serve the build from the fixed origin `app://caotang/`; keep that origin stable because Chromium keys storage to it. Register the scheme before Electron is ready as standard, secure and Fetch/CORS-capable. Do not bypass CSP. Serve only built assets from a fixed directory, reject other hosts and paths outside that directory, and do not start a loopback server.
- The renderer is sandboxed and context-isolated, with Node integration off and Chromium web security on. It never navigates to remote pages or creates arbitrary windows. Serve a CSP header alongside the unchanged HTML meta policy: scripts, styles and Workers are same-origin; no inline script, eval, embedded frames, objects or form submission. Deny framing with `frame-ancestors 'none'` in the header, where Chromium enforces it. Renderer data requests remain subject to Chromium's network rules; a native network proxy, filesystem and keychain are not part of the shell.
- Expose only a versioned, typed desktop bridge. With no native ports yet, this is read-only shell identification, not IPC, filesystem access or a generic Electron API. The renderer still uses its browser ports. Packaged-binary fuses and ASAR integrity belong to the packaging step (#401), not the unpacked smoke launcher.
- There is no shipped service worker in the web build. The custom scheme can support one, but the shell should not register one or enable that privilege until there is a worker to ship and its update/cache policy is specified.

## Spike results (Linux x64)

Built current main with `pnpm build`, then launched Electron **45.4.1** (Chromium **156.0.8078.100**, Node **24.22.3**) with Playwright `_electron` using `chromiumSandbox: true` under Xvfb. No application source or build output was modified.

| Surface | Observed result |
| --- | --- |
| App and lazy chunks | The writing studio rendered. Opening Settings loaded its production JS and CSS successfully. A `file://` control did not render: the existing absolute `/assets/` URLs resolved at the filesystem root. |
| Storage | A project created through the UI reappeared after terminating Electron and relaunching with the same `userData`. The app opened `caotang-app` and `caotang` in IndexedDB. A separate IDB round trip persisted; OPFS returned a directory handle and WebCrypto was available. The custom origin does not share a Chrome profile's storage. |
| Workers | The emitted import reader module Worker acknowledged opening a plain-text payload at its same-origin hashed asset URL. No blob URL or CSP exception was used. |
| CSP | Keeping the web meta policy and adding the shell header did not block the app or the lazy chunk. A test-only inline script was refused and emitted `securitypolicyviolation`. |
| Service worker | A test-only route on the privileged scheme registered a worker, took control of the page and served a synthetic Fetch response. No worker or cache was added to the web build or proposed for the shell. |
| Folder picker | `showDirectoryPicker({mode: 'readwrite'})` opened the native Linux chooser under user activation. The probe did not complete a selection or verify a write or reopen. Browser-style folder access is not evidence for the folder-first store in #402. |
| IME | A CDP composition of `ni` followed by a candidate commit produced exactly `你` in the New Project field. This is a one-field smoke, not an operating-system IME or the editor composition matrix. |

The initial probes reached the project picker in about **0.62–0.63 s** from Playwright launch on a fresh Linux profile. One near-start sample of the browser, renderer, GPU and utility processes totalled about **526 MiB RSS** (shared pages can be counted twice). Neither number is a pass against the epic's reference-machine gates: they do not use the reopened large fixture, the interactive performance mark, or proportional set size after ten minutes.

For the keychain follow-up (#404), [`@napi-rs/keyring` 2.1.2](https://www.npmjs.com/package/@napi-rs/keyring) is MIT and offers a Node-facing binding, while [`keyring` for Rust](https://github.com/open-source-cooperative/keyring-rs) is MIT OR Apache-2.0 and would require a binding maintained here. Both repositories showed recent activity at the time of the spike. Neither was installed or tested; verify packaged binaries and keychain behaviour on target platforms before choosing.
