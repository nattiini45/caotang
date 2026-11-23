# Import: Kanka campaign export (#293)

Status: **built**. Adapter `@caotang/import-kanka` over the shared zip reader ([import-read.md](import-read.md)) and XHTML walker
([import-html.md](import-html.md)); the preview is [import-preview.md](import-preview.md), the codex write is [codex.md](codex.md) §7.1.

## 1. What it reads

A Kanka **JSON** campaign export (`Settings > Export`, the zip Kanka can re-import). The Markdown export is a different thing and is
read by the Markdown import ([import-markdown.md](import-markdown.md)), not here. The layout, from Kanka's own export service:

| In the zip | What it is |
|---|---|
| `info.json` | `{ kanka_version, export_version, started }` |
| `campaign.json` | the campaign: its name and locale |
| `settings/modules.json`, `settings/custom-modules.json` | which modules are on and what the campaign calls them |
| `<module>/<name-slug>_<entityId>.json` | one entity: the module's own fields, `name`, and `entity: { … }` |
| `gallery/<imageId>.json` and `gallery/<imageId>.<ext>` | the campaign gallery |
| the entity's `image_path`, `header_image` and file paths | pictures, at the path the export names |

`entity` carries `id`, `name`, `type`, `entry` (HTML), `is_private`, `image_path`, `parent_id`, and the rows `entityTags`,
`relationships`, `posts`, `entityAttributes`, `reminders`, `mentions`, `assets`, `inventories`, `entityLocations`.

**Version gate.** `kanka_version` below **2.1** is refused with a plain message: earlier exports carry a different entity shape.
A zip with no `info.json` and no module folders is **not a Kanka export**. Nothing is fetched: Kanka's API is never called
(decision 10), the writer downloads the file first.

**Licence.** Kanka is Commons Clause. Its source was read as format documentation only; no code is copied or ported.

## 2. Entities to codex entries

Each entity becomes **one codex row offered for confirmation** and **one Research page** holding its text. The row's citation is the
page's own title line, so the entry is attached to the page the import creates.

| Kanka module | Codex type |
|---|---|
| `characters` | `character` |
| `locations` | `location` |
| `items` | `object` |
| `quests` | `subplot` |
| `organisations`, `families`, `races`, `creatures`, `abilities`, `journals`, `notes`, `events`, and any other or custom module | `lore` |

The module's own name (the campaign's word for it, from `settings/modules.json`, else the folder) and the entity's `type` become
**keywords**; its tags become keywords too, resolved through the `tags` module's own files. `is_private` becomes
`includePolicy: 'manual'`, so a private entity is never pulled into a prompt by detection alone.

## 3. The page

The page body is the entity's own text, in this order:

1. `# <name>` and one line naming the module and the entity's `type`.
2. The entity's picture, when the export carries it, then the `entry` HTML as Markdown through the shared walker.
3. **Details** — `entityAttributes` in `default_order`, as `name: value`; an attribute with no value is a subheading.
4. **Connections** — `relationships` as `target name — relation`, with the attitude when it is not nought and `(two-way)` when the
   relation is mirrored. A target the export does not carry is named by its id.
5. **Posts** — each post as a `###` section in `position` order.
6. **Life** — birth and death reminders (`type_id` 2 and 3) as calendar dates.

`[entity:123]` and `[entity:123|Label]` mentions become the entity's plain name (the label when the export does not carry the
target, else `#123`), never a link to Kanka. A mention whose target is missing is counted.

The headings above are the app's own words, not the export's: the reader takes them as `labels` (as the splitter takes its labels),
so a German writer gets **Details**, **Verbindungen** and the rest in German. The two index documents are titled the same way.

**Approximations, reported and never silent.** The codex has no typed detail fields (#221) and no relations graph (#223) in this
build, so attributes and relationships are text on the page rather than fields and typed edges. A codex entry cannot carry visual
references through `binder.importTree`, so a picture is in the page's text rather than attached to the entry.

## 4. World history and the gallery

Events (the `events` module) are lore entries like any other entity, and are also listed in one **World history** Research document
with their `date` and their name, in export order. Calendar reminders that are not a birth or a death (`type_id` 4 and 5) are listed
there under their entity's name (decision 9: one lore entry per event plus the index).

Gallery pictures no entity uses go to one **Campaign gallery** Research document, each with its name. Both documents are offered as
matter placed in Research, so the writer can move them; a campaign export is worldbuilding, not a draft.

## 5. Pictures, safety and limits

An entity picture or gallery file is read from the zip and comes in through the picture pipeline as `import:kanka-image-<n>`.
**SVG is refused** with a notice: it can carry script. A remote http(s) picture in an entry is listed as not downloaded unless the
writer turns it on (decision 10). Scripts, styles, iframes and audio/video players are removed and counted, never run.

The zip is opened with the shared caps and zip-bomb guard, the parse runs in the preview's `'self'` Worker with a timeout and the
dialog's Cancel, and every imported text — page bodies, descriptions, keywords, names — goes through `scanImport`, which lists the
hits. Nothing is written before **Import**, which commits one `binder.importTree` that one Undo takes back, pictures included.
The reader is a lazy chunk; there is no `eval`, `new Function` or WebAssembly anywhere in the chain.

## 6. What the preview shows

The proposed tree (World history, Campaign gallery), the codex rows with their type and their answer, and the report:

- **Kanka / What the campaign carried** — entities by type, private entities kept manual, keywords, posts, connections, attributes.
- **Kanka / What was approximated** — attributes and connections as text, pictures in the page rather than on the entry.
- **Kanka safety / What the import removed** — scripts, styles, players, unsafe links, refused SVG files.
- **Remote pictures / What was not downloaded**.

## 7. Tests

`packages/import-kanka/test` reads a synthetic campaign built to the layout above: two characters with a mirrored relation, an
attribute list, a private journal, posts, a birth and a death reminder, an event with a calendar reminder, a tag, a mention, a
picture, an SVG and a script. It checks the version gate, the type mapping, the mention rewrite, the page order, the world-history
index and the refusals. `apps/desktop/test` drives the source through the real reader session; `e2e/import-kanka.spec.ts` drives the
picker and Import.
