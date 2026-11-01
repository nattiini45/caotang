# Translating Caotang

Caotang's interface is written in English, and English is the authoritative source. A translation is one gettext file per language,
`apps/desktop/src/i18n/locales/<language>/messages.po`. This page is how to add or improve one. It covers the interface only: the
architecture specs stay in English, and the manuscript, the codex and everything a writer types are never translated.

The contract is in [docs/architecture/i18n.md](docs/architecture/i18n.md). This page is the contributor's path through it.

## Current German translation

The German interface and user guide are **machine-assisted translations and have not been reviewed by a native speaker**. Catalogue coverage and placeholder checks are not linguistic acceptance. The interface picker carries the same notice. The draft uses formal or neutral **Sie** wording and a shared glossary; a native reviewer should check meaning, tone, grammar, expansion and the actual screens before the notice is removed. Corrections follow the ordinary PO-file path below.

## The path

1. **Fork and clone**, then `corepack enable && pnpm install`.
2. **Extract the current messages** so your file matches the source:
   `pnpm exec lingui extract --clean --workers 1`
3. **Edit the `.po` file** for your language. Fill in `msgstr`; leave `msgid` alone. A new language also needs its tag in
   `lingui.config.ts` (`locales`), a row in `apps/desktop/src/i18n/catalogues.ts` and a loader in `apps/desktop/src/i18n/runtime.ts`;
   ask in the pull request and a maintainer will do that wiring with you.
4. **Run the checks**: `node tools/check-translations.mjs --write-stats`. It extracts again and compares, compiles every message,
   checks that your placeholders match the English ones, and rewrites `locales/stats.json`. Fix what it reports; missing translations
   are not an error.
5. **Look at it running**: `pnpm dev`, then Settings › Appearance. A language below 95 % is marked Preview; below 60 % it is hidden
   unless you add `?pseudo=1` in a development build.
6. **Open a pull request** with the `.po` file and `stats.json`. A second reader of the language reviews meaning and placeholders, not
   only the completion figure.

To see what the release will say about your language: `node tools/translation-report.mjs` (completion per language and credits from Git).

## What to translate, and how

- **Whole sentences.** Each message is one sentence a writer reads. Translate it as a sentence; do not rebuild it from pieces.
- **Named placeholders.** `{title}`, `{count}` and the like are values the app fills in. Keep every placeholder, with its exact name.
  The checker fails a translation that drops, renames or adds one. A name may move in the sentence.
- **Plurals and selects.** `{count, plural, one {…} other {…}}` carries the forms your language needs. Add the categories your language
  uses (`few`, `many`, …); keep `other`.
- **Context.** The comment above a message (`#.`) tells you where it appears and which values are the writer's own words. A value marked
  as writer content is shown in isolation; never translate it.
- **Do not translate** writer content, file names, code, keyboard key names the app draws, or messages marked model-facing (they are not
  in the catalogue).
- **Direction.** A right-to-left language mirrors the shell; if a message holds a directional arrow, use the one that points the way your
  language reads. A right-to-left interface ships as Preview until a native reader of that language has reviewed it.

## When the English changes

A message's id is its English text, so editing an English sentence makes a new message and retires the old one. After you rebase,
run the extract command again: the new sentence arrives untranslated and the old one goes to the obsolete section. A message marked
`fuzzy` is a guess waiting for review: it is **not shipped**; the app shows that message in English until someone confirms it and
removes the flag. Lingui compiles a fuzzy entry like any other, so the checker refuses a fuzzy entry that still has text: review it
and remove the flag, or empty it so it falls back to English. Nothing ever shows a message id to a writer.

## Translating the user guide

The catalogues above cover the app's own words. The writer's guide, [docs/USER-GUIDE.md](docs/USER-GUIDE.md), is English and
authoritative, and a translation of it lives at `docs/i18n/<language>/USER-GUIDE.md` (i18n.md §9.3). The German guide is machine-assisted and not native-reviewed, like the catalogue. English remains authoritative; a missing or stale
translation falls back to English rather than blocking the guide.

1. **Copy the guide** to `docs/i18n/<language>/USER-GUIDE.md` and translate it, headings included. Never edit the English original.
2. **Stamp the source markers**: `node tools/guide-sections.mjs --stamp <language>`. This writes `<!-- source: <hash> -->` under
   every heading — the first 8 hex characters of the SHA-256 of the English section, heading line included. Re-run it after every
   rebase; it rewrites the markers in place.
3. **Check it**: `node tools/guide-sections.mjs --locale <language>` prints the plain report — one line per section, `current`,
   `stale`, `renamed` or `missing`. Add `--check` to make the command exit non-zero when a section is stale or renamed, so a release
   can state the truth about each section; a `missing` section never fails, because the app falls back to the English section.
4. **Mark stale sections visibly**: `node tools/guide-sections.mjs --mark-stale --locale <language>` inserts a notice inside every
   stale or renamed section without changing its old source marker, and removes notices from sections that are current again. The
   plain report remains non-failing; the notice makes drift visible to a reader of the translated guide too.
5. **Refresh help links**: `node tools/guide-sections.mjs --write-status` writes `apps/desktop/src/i18n/guide-status.json`. Only
   current sections appear, with their translated anchors. Run the guide-section and desktop guide-link tests after changing it.

A **stale** section means the English changed since you translated it — a renamed heading counts, because the hash covers the
heading line. Re-translate the section and re-run `--stamp`. A **renamed** section means its marker names a different English
section, usually because sections shifted; check the order, then re-run `--stamp`. The tool never invents a marker: a section
without a well-formed one reports `missing`.

The in-app help link uses the generated table: it points at the translated section when its marker matches the English and at the English
section otherwise. `resolveGuideSection` in `tools/guide-sections.mjs` provides the same rule for rendered sections; `guide-links.ts`
provides the browser href.

## Releases and credits

Translation work follows the source at release time, not every feature edit: the maintainers freeze the English source for a release,
announce it, and merge translations that match that snapshot. `node tools/translation-report.mjs --release <version>` prints the table
and the credits for the release notes. Credits come from Git history of your language's folder, so commit under the name you want shown.

Picker gates (decision D5): 95 % or more is listed plainly, 60–94 % is listed as Preview, below 60 % is hidden. A language that was
already listed stays listed down to 55 %, and a language a writer has selected is always visible to them so they can switch away.

## Hosted translation (not active)

A hosted translation service is not in use. When a third language exists and the maintainers separately approve a service and its
repository access, the prepared Weblate Libre component mapping is: name `Caotang interface`; file format `gettext PO`; file mask
`apps/desktop/src/i18n/locales/*/messages.po`; monolingual source `apps/desktop/src/i18n/locales/en/messages.po`; source language
English; repository branch `translations`; new translations committed by Weblate and merged into the release source through a reviewed
pull request. This is a configuration mapping only: no component, remote, bot or permission has been created. Eligibility,
availability and pricing of any service are checked again at that point; none is promised here. Release credits are generated from
Git by `node tools/translation-report.mjs --release <version>` rather than maintained in a second hand-written list.
