# EPUB metadata floor

> Status: built.

> The writer edits these fields in the Project panel (ui-modules §5.5), each through its own command (`project.rename`, `project.setMetadata`, `project.importAsset`). The identifier is stored in its `urn:uuid:` form, the author is a field of its own, and the gate is pinned (below, "The epubcheck gate").

## The floor: four new manifest slots (v0.2, additive in format v1 — no `formatVersion` bump)

```json
{
  "project": {
    "id": "p_9XK2M4Q7RZ",
    "name": "The Lighthouse Keeper",
    "language": "en",                    // NEW — BCP-47 tag; see L1 below
    "identifier": {                      // NEW — the EPUB unique-identifier floor; see L2
      "uuid": "urn:uuid:3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d",
      "isbn": null                       // optional; set once the writer has one
    },
    "coverAssetId": "a_7RQK2M9T4X"      // NEW — optional; null = no cover (§3a emitter omits the property)
  }
}
```

| Field | Type / domain | Contract |
|---|---|---|
| `project.language` | BCP-47 language tag that `Intl` reads (project-format §2), non-empty | **Spec-floor REQUIRED.** Source of `dc:language`. Default derivation at project create: `Intl.Locale(navigator.language).language` (the language subtag only — `en`, not `en-US`; multi-value is out of scope — one `dc:language` element v1). Editable in the **Project panel** (ui-modules §5.5). An older project is given a language from the app locale once, on open, and it is written back. Loader tolerance: absent = derive-on-save from the app locale with a one-time notice (never blocks load, never blocks export — see fallback row). |
| `project.identifier.uuid` | `urn:uuid:` string | **Spec-floor REQUIRED.** Generated once at project create (`crypto.randomUUID()`, lowercase URN form `urn:uuid:…`), stored in the manifest, **never regenerated** — EPUB 3.3's maximal-persistence rule (§5.5.2: no new identifiers on minor revisions). The per-project `project.id` (`p_…`) is *not* reused: it is app-internal, not a URI, and its instability across a rebuild-from-front-matter recovery (project-format §5) would violate persistence. Emitted as `<dc:identifier id="pub-id">urn:uuid:…</dc:identifier>` with `package/@unique-identifier="pub-id"`. Never user-editable in v0.2 (an ISBN is the user-visible identifier channel). |
| `project.identifier.isbn` | `urn:isbn:` string \| null | Optional second `<dc:identifier>` (spec: "MAY specify additional identifiers"; identifiers should be fully qualified URIs — `urn:isbn:` form, §5.5.2) refined with `<meta refines="#isbn-id" property="identifier-type" scheme="onix:codelist5">15</meta>` per the spec's worked example. Writer-set in the Project panel (ui-modules §5.5). Stored as `urn:isbn:` in ISBN-13 form: a writer's ISBN-10 is converted, and a value that is not an ISBN is refused. `null`/absent = omitted from the OPF entirely (no placeholder values — epubcheck and retailers both reject junk identifiers). |
| `project.author` | string, optional | The byline. It is the `dc:creator` of the EPUB and the creator of the DOCX (exporter.md §2). Absent or empty means the export carries no byline (the `author` key of project-format §2). |
| `project.coverAssetId` | asset id (`a_…`) or null | Optional. References a file in the project `assets/` directory (storyboard.md §2.2's asset store — **reused, no second image store**); set in the Project panel's Cover field (ui-modules §5.5). The image is a PNG, JPEG or WebP up to 16 MB, judged by its leading bytes, and `project.importAsset` writes it. Emitter: copied into the EPUB as `OEBPS/cover.<ext>`, `<item id="cover-image" href="cover.<ext>" media-type="…" properties="cover-image"/>` in the manifest, and `<meta name="cover" content="cover-image"/>` (legacy-Apple convention, harmless to modern readers). Import from an external file = `project.importAsset` (storyboard §3.1 pattern). No automatic cover *generation* ever — an absent cover emits a spec-valid EPUB with no cover property. |
| `dcterms:modified` | *(not stored)* | **Emitter-computed at pack time** (`new Date().toISOString()` truncated to `YYYY-MM-DDTHH:MM:SSZ` — spec's date-time form): "last date/time the EPUB was modified" is a property of the *artifact*, not the *project*; storing it in the manifest would be a second truth of the wrong thing (project-format §3 doctrine). Never rendered anywhere else. |

**When an older project's identifier is stored.** A project that predates the identifier is given one when it opens (`backfillProjectIdentity`), and the identifier is then the one the book carries, so it must reach the store before a second open could mint another. The hosts differ on when that happens, and the difference is the test of persistence (above):
- **The desktop** saves a browser project on the open that follows the backfill (`ProjectSession`'s own first write), so the identifier is stored before any compile. A folder open writes the backfill back to the folder during the open, unless another program holds the folder (its MCP server's lock); a write that is skipped or fails is named in the open's notice, which says the next open may make another set.
- **The MCP server** does not save on open, so the minted identifier is in memory until the folder is saved. The first save is either a write or a compile that succeeds, and a successful EPUB compile is one: the book it writes carries the identifier that the same save stores. A compile that fails writes no book, and no identifier leaves the server. A server stopped before any save mints a new identifier when it next opens, which is safe for the books it has not written.

**Rejected alternatives:**
- *Random per-export UUID* — violates the spec's persistence rule; retailers dedupe on the unique identifier, so re-exporting a revised book would fragment its retail record.
- *Reusing `project.id` as the EPUB identifier* — not a URN, not spec-advised ("absolute-URL strings or URNs"; app-internal ids leak app structure into interchange), and unstable under recovery (above).
- *Storing `dcterms:modified` in the manifest* — wrong layer; it changes per artifact, the manifest is the project's truth (the compile log already records per-artifact timestamps, §2 stage 4).
- *A second `covers[]` manifest array or binder-node flag* — `assets/` + one asset id is the same mechanism codex `attachments` and `ShotMeta.image` already use; a parallel store would fork asset handling.
- *Retail-specific export files (Vellum's per-retailer EPUBs)* — out of scope; the floor targets spec validity + epubcheck 0-errors, and retailer-specific quirk handling is a post-v0.2 recipe-options problem, not metadata.

**Retail-distribution gap (recorded, honest):** the floor above yields an **epubcheck-clean EPUB 3.3** (the §3a acceptance gate as specced). Retail *acceptance* adds requirements the Caotang manifest deliberately does not own: per-retailer cover dimension minimums (Apple ≥1400 px, KDP ≥2560×1600 recommended, etc. — a moving retail target, out of the manifest's scope and out of epubcheck's checks; the exporter's compile log carries a generic "cover below common retail minimums" info line when below 1400 px short side); Kobo/B&N/Apple-specific metadata (series, contributors) beyond `dc:creator`/ISBN is optional DC the templates can add later; Apple's strictness is *validation*-driven (epubcheck 0-errors satisfies it) plus its 4-million-pixel interior-image cap, which a scene-per-file XHTML layout is nowhere near. These are **recipe/template concerns for the v0.2 polish pass**, not schema work — the manifest floor above is complete for epubcheck 0-errors.

**Fixture additions (the §3a acceptance corpus gains):** (1) zero-config minimal book — uuid auto, language derived, no cover, no isbn → epubcheck 0 errors, 4 required metadata elements emitted; (2) ISBN present → both identifiers + the `refines` meta emitted, `unique-identifier` still points at the uuid; (3) cover asset set → `properties="cover-image"` item + legacy `<meta name="cover">` present, image copied; (4) absent cover → no cover-image property, no warning; (5) `dcterms:modified` changes between two packs of the same manifest while `dc:identifier` is byte-identical (persistence check); (6) language change propagates to `dc:language` + chapter XHTML `xml:lang`.

**The epubcheck gate, pinned.** The §3a acceptance gate is epubcheck. `packages/exporter/test/epub-epubcheck.test.ts` runs it over the fixture corpus, which the list above extends, and the corpus must pass it with **zero errors**. The validator is `@likecoin/epubcheck-ts`, pinned exact at **0.7.0** (BSD-3-Clause from that version). It is a devDependency of `@caotang/exporter` only, so it does not ship in the app.

**Decision class:** delegated; the UUID-persistence choice and the assets-reuse choice are the two non-trivial picks.