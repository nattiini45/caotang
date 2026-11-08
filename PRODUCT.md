# Caotang

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Writers of novels and other long fiction come first, including writers familiar with Scrivener's binder, corkboard, inspector and compile workflow. Caotang also supports the scripts and serials a writer makes from that work: screenplays, comics, podcasts, narrated video and newsletters. This describes the product's scope, not a promise that every format is complete; [the roadmap](docs/ROADMAP.md) records what is built. Sources: [AGENTS.md](AGENTS.md), [README.md](README.md).

## Product Purpose

Caotang is a local-first writing studio. The manuscript lives in a project folder or in the browser. A writer structures chapters and scenes, writes, keeps characters and places in a codex, checks continuity and compiles an export. An AI agent can work through the app's commands, with plans, drafts, approval and checkpoints rather than an unaccountable second editor. See [README.md](README.md) and [the writer's guide](docs/USER-GUIDE.md).

## Positioning

Bring your own provider key (BYOK), or use the built-in demo without one. There is no Caotang backend server, account, subscription, credit meter or telemetry. Caotang is static files; a writer using a paid model pays that provider directly. Project documents and metadata remain plain text; pictures and covers remain local binary assets. Agent changes go through the command bus so they are gated, logged and undoable within the checkpoint limits. Sources: [README.md](README.md), [AGENTS.md](AGENTS.md), [the project format](docs/architecture/project-format.md).

## Operating Context

Projects are local to the browser origin; there is no sync. A `.caotang` bundle moves a project between browsers or origins. Folder access needs a Chromium-based browser and a secure origin; other browsers use in-browser projects and bundles. The desktop layout starts at 960 CSS px. Narrow mode supports writing but directs desktop-only work, including the corkboard and richer compile formats, to a desktop. Emulated browser testing is not proof of real-phone support. See [README.md § Requirements](README.md#requirements) and [Self-hosting](README.md#self-hosting).

For Impeccable, use **Operate** for the app: completing a writing task outranks expression. Use **Read** for documentation and the guide: understanding the workflow is the task. Use **Persuade** for [caotang.app](https://caotang.app/), the separate landing page that sells the app. The site stays static, with no JavaScript, motion or film, per [landing.md §D, decision D2](docs/architecture/landing.md#d-static-by-decision-d2). These surface modes do not authorize changing the app's visual language.

## Capabilities and Constraints

- The agent sends the context it needs to the provider selected for the task; a model review also sends the text it reads, after approval. Nothing is sent except to the provider and MCP servers the writer configured. The demo makes no network request. Do not describe BYOK as keeping provider-bound text on the device. See [README.md § Your key and your privacy](README.md#your-key-and-your-privacy).
- Keys stay sealed in the browser, never in project files, bundles, exports or logs. Sealing protects stored keys, not against code executing inside the open page. See the same [privacy explanation](README.md#your-key-and-your-privacy) and [AGENTS.md](AGENTS.md).
- Plans and drafts wait for approval; permission modes can allow small edits at once. Recent project-changing turns have checkpoints, subject to Settings limits. Do not promise unlimited undo or approval for every individual edit. See [the guide](docs/USER-GUIDE.md).
- English (`en`) and German (`de`) are interface languages. Interface language and project/content language are separate, and switching the interface does not translate the manuscript. RTL shell mirroring remains **Preview until a native reader reviews it**; it is not a claim that an Arabic or Hebrew catalogue ships. See [i18n.md §§3, 5, 9 and D8](docs/architecture/i18n.md).
- New writers start in Modern; existing writers retain Classic until they switch. Both shells arrange the same feature tree. See [modern-interface.md §§2–4](docs/architecture/modern-interface.md).

## Brand Commitments

User-facing words are plain, whole sentences that name what the writer can do next. Preserve Caotang's own product vocabulary and the distinction between specified and built work. Sources: [AGENTS.md](AGENTS.md), [the guide](docs/USER-GUIDE.md), [the roadmap](docs/ROADMAP.md).

## Evidence on Hand

[README.md](README.md) and [the guide](docs/USER-GUIDE.md) describe the product. [Architecture specs](docs/architecture/) are its contracts; [decisions.md](docs/decisions.md) records standing decisions. [The scripted demo](e2e/demo.spec.ts) uses the demo provider, not a real-model benchmark. The landing page's product pictures are build-time stills, documented in [landing.md](docs/architecture/landing.md) and [site/REHEARSAL.md](site/REHEARSAL.md), not a live app or evidence of unsupported capabilities.

## Product Principles

1. Projects stay local: documents and metadata are plain text, and pictures are binary assets. Only configured provider and MCP requests leave the device.
2. Agent changes go through the command bus, with the writer's permissions and checkpoint limits intact.
3. Specs and code agree; a new command, tool, project-format file or setting starts in its spec.
4. Preserve the writer's existing interface and distinguish built features from future plans.

These are the standing rules in [AGENTS.md](AGENTS.md) and [modern-interface.md](docs/architecture/modern-interface.md), not new product promises.

## Accessibility & Inclusion

Modern's bar is keyboard reachability, visible two-tone focus, at least 44 × 44 CSS px controls (with the spec's inline-link exception), and at most ten default keyboard tab stops outside the page on Write, with nothing open and no notice (a radio group counts once). Text contrast is computed over actual glass layers and wallpaper extremes: 4.5:1 for normal text, 3:1 for large text, and 3:1 for the focus ring. Axe alone cannot measure glass contrast. Reduced motion, reduced transparency, higher contrast and forced-colors have explicit alternatives. Classic keeps its own density and 24 px target token; do not mistake Modern's requirements for permission to restyle Classic. Sources of truth: [modern-interface.md §§5, 9, 15](docs/architecture/modern-interface.md), [Classic tokens](apps/desktop/src/tokens/classic.css).

Translations use complete messages, locale-aware formatting, logical layout properties and isolation for writer-supplied text. Keep interface direction separate from manuscript direction. See [i18n.md](docs/architecture/i18n.md).
