# Roadmap

Caotang is built in the open, one milestone at a time. This page says what exists, what is being built now, and what comes later. It promises no dates.

The design behind each item is in [architecture/](architecture/), and the decisions are in [decisions.md](decisions.md).

## Built

The first release (0.1.0) is a complete writing studio that runs in the browser:

- **Projects** stored in the browser, as a folder on disk (Chrome and Edge), or as a `.caotang` bundle. Folder saves check the folder first and ask before replacing anything another program changed. A project remembers its folder, so reopening it is one click.
- **Binder, corkboard, inspector and editor.** Chapters and scenes, index cards, synopsis and notes, a Markdown editor that saves as you type, word counts, a daily target and focus mode.
- **Codex** of characters, places, objects and lore, with aliases, include policies and a list of where each name appears.
- **The agent.** Plans you approve or edit, draft previews you apply or discard, and a checkpoint for each turn you can restore, and a live task list of the turn in the agent header. A big plan can run in the background, one call at a time, and be reviewed when it is ready. A running turn can be stopped, steered with a note, or followed by queued messages. Native tool calling is used where the model supports it.
- **Providers.** Bring your own key. Presets for 28 providers, among them Anthropic, OpenAI, Google Gemini, xAI, Mistral, DeepSeek, OpenRouter, Groq and Together, fill in the address and authentication, and three of them (Ollama, LM Studio and llama.cpp) are models running on your own computer; any other OpenAI-compatible endpoint can be added by hand, and a built-in demo provider needs no key. Three wire formats are spoken: OpenAI Chat Completions, OpenAI Responses and Anthropic Messages. The Chat, Drafting and Background roles can each run on their own profile, model and thinking level.
- **Skills.** Reusable writing instructions for the agent, kept in the project as standard Agent Skills folders. You read and approve each one before the agent is told about it, and a change asks again. The agent loads one when your request fits. Scripts in a skill are never run. Reading a skill's other files, limiting the agent to a skill's allowed tools and skills shared across projects wait for demand.
- **Findings.** A quick consistency scan against the codex and your scene declarations, including who learns and who knows each fact you track, and a model review that runs only after you approve its plan.
- **Export** to Word, EPUB, Markdown and plain text, for the whole manuscript or a part, with saved recipes.
- **Screen and media.** Screenplay scenes in Fountain (with Final Draft import and export, and a paginated PDF), branching dialogue in Ink, storyboards with shot cards and a PDF contact sheet, and video prompt packs for several video models. The dialogue table and the shot list export as CSV or as a spreadsheet (`.xlsx`). Both PDFs print Arabic, Persian, Urdu and Hebrew (not yet checked by a reader of the language, and without marks or a mirrored page).
- **Non-UTF-8 files.** A document whose file is not UTF-8 opens into a review: Caotang detects the likely encoding, previews the text, and converts the file only when you choose to, keeping the original bytes as a backup.
- **Filters and goals.** Saved binder filters, project goals with deadline pacing, weekly and monthly goals that reset on the day you choose, a sprint timer and a writing history.
- **SDK.** Run the agent from a Node script, a CLI or CI against a project folder, with an approval policy in place of the cards, a diff before anything is saved, and the provider key held in memory ([packages/sdk/README.md](../packages/sdk/README.md)).
- **MCP.** Connect external Model Context Protocol servers to the agent, under per-call approval. Caotang also ships its own MCP server, so other AI tools can read a project folder and, if you allow it, change it with confirmation.

The app is live at [caotang.app/app](https://caotang.app/app/), with a landing page at [caotang.app](https://caotang.app/). The [user guide](USER-GUIDE.md) describes all of it, and its last section lists what is not in this build yet.

## Next

No milestone is in progress right now. The next one is chosen from the list below. Smaller work between milestones closes the known limits in the [changelog](../CHANGELOG.md), such as checking Final Draft files against Final Draft itself.

## Later

Each of these is its own milestone, designed when its turn comes.

- **Desktop app (Tauri).** For writers who would rather not run Caotang in a browser tab. Native folder storage, the operating system's keychain for keys, stdio MCP servers, and the providers a browser cannot reach.
- **Hosted instance** at `caotang.pawcommit.com`. Sign up with email, Google or GitHub; projects stored end-to-end encrypted so the operator cannot read them; a relay for providers browsers cannot reach. The local-only version at `caotang.app` stays as it is.
- **More background work.** A coherence review the writer queues, a gateway limiter that serves the agent before a background task, and a Web Worker for the heavy checks if they are measured to slow typing.
- **Mobile app**, reaching your projects on the hosted instance.
- **Signed MCP bundle.** The `.mcpb` bundle ships unsigned today. It will be signed once the bundling tool produces signed bundles that hosts accept.

## Not planned

- Accounts, subscriptions or credit meters in the local version.
- Telemetry or analytics.
- Video generation inside Caotang. It writes prompt packs; you generate video in your own tool with your own account.

## Suggest something

Open an issue on [github.com/nattiini45/caotang](https://github.com/nattiini45/caotang). A feature that fits the principles above (local-first, your own key, plain-text files, an agent that works through the app's own commands) has the best chance.
