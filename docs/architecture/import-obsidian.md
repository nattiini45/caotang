# import-obsidian — the Obsidian vault and Longform reader

Status: built (#281, epic #263): reader, Worker, preview, UI, guides and e2e. Package `@caotang/import-obsidian`.

## 1. What it reads

Obsidian is a local-first notebook: a vault is a folder of Markdown notes plus `.obsidian/` config. The Longform plugin writes a
manuscript as an index note whose `longform:` front matter lists its scenes in order, optionally nested into Parts. This reader is
an adapter over the Markdown reader ([import-markdown.md](import-markdown.md)): it resolves Obsidian's syntax, names the Longform
index, classifies codex notes, and hands the manuscript to the Markdown reader. It reads a vault folder or a zip of one. No DOM, no
third-party dependencies; it runs on the main thread, in a `'self'` Worker and in Node.

## 2. The syntax it resolves

- Wikilinks `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]` become their display text (the alias, else the note
  name without a heading or block anchor). Caotang's name-based mention index then links codex names automatically.
- Embeds `![[image.png|300]]` become picture tokens the vault reader resolves; `![[Other Note]]` is named as a note embed.
- `%%comments%%` (inline or across lines) become notes, never dropped. `==highlights==` keep their text and drop the markers, counted.
- Callouts `> [!type]` stay blockquotes with a labelled type. A trailing `^block-id` is stripped, counted.
- `#tags` become keywords; a heading (`# Word`) is left alone. `aliases:` front matter is kept for the codex entry.
- Dataview fields (`Key:: value` on its own line, `[key:: v]` / `(key:: v)` inline) become metadata; own-line fields leave the prose,
  inline ones keep their rendered value.
- Fenced code and inline code are never rewritten.

## 3. The vault

`.obsidian/`, `.trash/`, templates, `.canvas` and `.base` are skipped and listed. Attachments resolve by shortest unique path across
the vault, honouring `.obsidian/app.json`'s `attachmentFolderPath` (`""` root, `"./"` the note's folder, `"./sub"` a subfolder, a named
folder). Codex notes are classified by folder (`Characters/`, `Locations/`, `Items/`…), a `type:`/`category:` property, or a `#character`
tag, into the codex types (character, location, object, lore, subplot, other); the preview lists them as rows to confirm or fix.

## 4. Longform

The index note's `longform:` block names its `format` (scenes or single), `title`, `draftNumber`, `sceneFolder`, ordered `scenes:` and
`ignoredFiles`. Several drafts keep the highest `draftNumber`. Nested scene lists keep their depth as nested folders (decision 2),
instead of flattening. `format: single` goes to the splitter.

## 5. The preview and the commit

The reader runs in the preview's `'self'` Worker host (reader-host.ts) under the archive caps, with a timeout and Cancel. The shared
preview shows the proposed binder, the codex rows and a losses report; nothing is written until **Import**, which commits one
`binder.importTree` (pictures and codex included), and one Undo takes all of it back. Every imported text goes through the import
injection scan.
