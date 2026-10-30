# Roadmap

Caotang is built in the open, one milestone at a time. This page says what exists, what is being built now, and what comes later. It promises no dates.

The design behind each item is in [architecture/](architecture/), and the decisions are in [decisions.md](decisions.md).

## Built

The first release (0.1.0) is a complete writing studio that runs in the browser:

- **Projects** stored in the browser, as a folder on disk (Chrome and Edge), or as a `.caotang` bundle. Folder saves check the folder first and ask before replacing anything another program changed. A project remembers its folder, so reopening it is one click.
- **Binder, corkboard, inspector and editor.** Chapters and scenes, index cards, synopsis and notes, a Markdown editor that saves as you type, word counts, a daily target and focus mode.
- **Codex** of characters, places, objects and lore, with aliases, include policies and a list of where each name appears.
- **The agent.** Plans you approve or edit, draft previews you apply or discard, and a checkpoint for each turn you can restore, and a live task list of the turn in the agent header. A big plan can run in the background, one call at a time, and be reviewed when it is ready. The agent can hand a long reading to a built-in helper (a Reader or a General agent) that reads in a context of its own and suggests changes without making them. A running turn can be stopped, steered with a note, or followed by queued messages. Native tool calling is used where the model supports it. A task you want again and again, a scan each Monday or a read of the day's changes, can be saved with a schedule and is offered when it is due; a continuity scan can start by itself. A trace of each turn’s prompts, replies, tool calls and timings, kept only in the open tab and exported on request.
- **Review in place.** An agent edit can be kept and marked word by word instead of replacing the text: a review bar to accept or reject each change from the keyboard, and the same on the turn's card. Opt-in, in Settings › Writing; the draft preview stays the default.
- **Providers.** Bring your own key. Presets for 28 providers, among them Anthropic, OpenAI, Google Gemini, xAI, Mistral, DeepSeek, OpenRouter, Groq and Together, fill in the address and authentication, and three of them (Ollama, LM Studio and llama.cpp) are models running on your own computer; any other OpenAI-compatible endpoint can be added by hand, and a built-in demo provider needs no key. Three wire formats are spoken: OpenAI Chat Completions, OpenAI Responses and Anthropic Messages. The Chat, Drafting and Background roles can each run on their own profile, model and thinking level.
- **Skills.** Reusable writing instructions for the agent, kept in the project as standard Agent Skills folders. You read and approve each one before the agent is told about it, and a change asks again. The agent loads one when your request fits. Scripts in a skill are never run. Reading a skill's other files, limiting the agent to a skill's allowed tools and skills shared across projects wait for demand.
- **Findings.** A quick consistency scan against the codex and your scene declarations, including who learns and who knows each fact you track, and a model review that runs only after you approve its plan.
- **Export** to Word, EPUB, Markdown and plain text, for the whole manuscript or a part, with saved recipes.
- **Screen and media.** Screenplay scenes in Fountain (with Final Draft import and export, and a paginated PDF), branching dialogue in Ink, storyboards with shot cards and a PDF contact sheet, and video prompt packs for several video models. The dialogue table and the shot list export as CSV or as a spreadsheet (`.xlsx`). Both PDFs print Arabic, Persian, Urdu and Hebrew (not yet checked by a reader of the language, and without marks or a mirrored page), and Han characters in the forms of the project's language (Japanese, Korean, Traditional Chinese, Hong Kong or Simplified Chinese).
- **Non-UTF-8 files.** A document whose file is not UTF-8 opens into a review: Caotang detects the likely encoding, previews the text, and converts the file only when you choose to, keeping the original bytes as a backup.
- **Filters and goals.** Saved binder filters, project goals with deadline pacing, weekly and monthly goals that reset on the day you choose, a sprint timer and a writing history.
- **SDK.** Run the agent from a Node script, a CLI or CI against a project folder, with an approval policy in place of the cards, a diff before anything is saved, and the provider key held in memory ([packages/sdk/README.md](../packages/sdk/README.md)).
- **Command line.** Run the agent on a project folder from a terminal or a script, read-only unless you say otherwise. `caotang scan` runs the continuity checks on a folder with no model and no key, and a GitHub Actions template is provided for a writer's nightly run (not turnkey until a release carries `caotang.mjs`).
- **MCP.** Connect external Model Context Protocol servers to the agent, under per-call approval. Caotang also ships its own MCP server, so other AI tools can read a project folder and, if you allow it, change it with confirmation.

The app is live at [caotang.app/app](https://caotang.app/app/), with a landing page at [caotang.app](https://caotang.app/). The [user guide](USER-GUIDE.md) describes all of it, and its last section lists what is not in this build yet.

## Next

No milestone is in progress right now. The next one is chosen from the list below. Smaller work between milestones closes the known limits in the [changelog](../CHANGELOG.md), such as checking Final Draft files against Final Draft itself.

## Later

Each of these is its own milestone, designed when its turn comes.

- **Saved prompts as commands.** Your own `/name` commands: a saved prompt kept in the project as a skill, with arguments, a plan template (macro) as a command, and the prompts of connected MCP servers in the same list. The nine built-in commands are in the first release's agent panel; these three are the part that waits.
- **Extension bundles.** Skills, commands and suggested MCP servers from someone else, as plain Markdown and JSON in a `.caotang-ext` file you install yourself after reading all of it. They run no code. Specified, not built: see [extensions.md](architecture/extensions.md).
- **Desktop app (Tauri).** For writers who would rather not run Caotang in a browser tab. Native folder storage, the operating system's keychain for keys, stdio MCP servers, and the providers a browser cannot reach.
- **Hosted instance** at `caotang.pawcommit.com`. Sign up with email, Google or GitHub; projects stored end-to-end encrypted so the operator cannot read them; a relay for providers browsers cannot reach. The local-only version at `caotang.app` stays as it is. Specified, not built: see [hosted.md](architecture/hosted.md).
- **Tasks with the window closed.** Recurring tasks run only while the project is open in a visible tab. Still to build: a model task that starts by itself once you have allowed it for that task, with its results waiting for your review; `caotang tasks` for a scheduler of your own; and runs from the desktop app's tray with the window closed.
- **More background work.** A coherence review the writer queues, a gateway limiter that serves the agent before a background task, and a Web Worker for the heavy checks if they are measured to slow typing.
- **Seeing and shaping the next request.** A meter under the Intent box that shows the next request's size against the budget and the model's window as you type and as a turn grows, its prompt preview for the planner call, and `@` pins and **Leave out of this request** for one request (issue #69). The plan card's window check and cost, and every layer budget in Settings › Context, are built.
- **More helper agents.** Several helpers reading at once, one per chapter; and helpers with a role of their own, such as a drafter, a critic and a continuity checker. Each builds on the helpers that exist now.
- **Pictures.** Sketches, photos and inspiration attached to the project, a chapter, a scene or a paragraph; pictures placed in prose and carried into EPUB, Word and Markdown; handwritten pages turned into text you review. Specified, not built: see [pictures.md](architecture/pictures.md).
- **Comics.** Comic books with pages, panels and balloons, written from a comic script or page first, exported as a comic PDF or a CBZ. Specified, not built: see [comics.md](architecture/comics.md).
- **Timeline.** The story on a timeline of story days, reading order, or both, including prologues before day 0 and epilogues years later; every change you make on it is a proposal you review and apply as one undo step. Specified, not built: see [timeline.md](architecture/timeline.md).
- **Interface languages.** Menus, panels and messages in your language, set apart from the language you write in, starting with German; numbers and dates in your locale; a mirrored interface for right-to-left languages, as a preview until a native reader has checked it. The groundwork is built: while the interface is English, numbers and dates follow your system's region when your system is set to English and read as US English otherwise, and your codex names sort by the project's language. The rest is specified, not built: see [i18n.md](architecture/i18n.md).
- **AV scripts.** Podcasts, radio and audio drama, and narrated video, written as one linear timed script: segments, speakers, music and effect cues, and a duration on every line, declared by you or estimated from a speech rate you set. Compiles to a VO script for the recording session, show notes with chapters, a transcript, a teleprompter, WebVTT captions and a podcast feed. Specified, not built: see [av-script.md](architecture/av-script.md).
- **Web publishing.** A slug, a publish date, tags and a canonical address on any document, and compile targets for the web: a self-contained HTML article, an RSS feed and an Atom feed. Caotang writes the files; you host them. Specified, not built: see [web-publishing.md](architecture/web-publishing.md).
- **Mobile app**, reaching your projects on the hosted instance. The first step is built: below 960 px the web app has a narrow layout (a drawer for the binder, a sheet for the inspector, 44 px targets, "Open on desktop" for the views a phone leaves out), checked in an emulated browser only. Still to build, each its own milestone: an installable app-shell web app (manifest, icons, a small service worker), offline edits and sync once the hosted instance exists, and a native shell for the app stores only if the web app falls short.
- **More of the agent for outside tools.** Synopses, continuity findings, the review, shots and prompts as a brief and an apply for the connected tool's own model, as scenes and dialogue have, once what they write can be kept safely; and a run of several changes from an outside tool staged as one change you confirm and undo once.
- **Signed MCP bundle.** The `.mcpb` bundle ships unsigned today. It will be signed once the bundling tool produces signed bundles that hosts accept.

## Not planned

- Accounts, subscriptions or credit meters in the local version. (Run limits the writer sets on their own key are not meters: Caotang counts nothing it charges for.)
- Telemetry or analytics.
- Third-party code running inside the app (a plugin system). Extension bundles carry text only; sandboxed plugins are deferred, not ruled out.
- Video generation inside Caotang. It writes prompt packs; you generate video in your own tool with your own account.

## Suggest something

Open an issue on [github.com/nattiini45/caotang](https://github.com/nattiini45/caotang). A feature that fits the principles above (local-first, your own key, plain-text files, an agent that works through the app's own commands) has the best chance.
