# Web publishing — publish metadata and the web compile targets

> Status: 🧭 **specified, not built.** No publish metadata field, `html` recipe or feed writer exists in the current build; the decisions in §7 bind the work when it is cut.
> Scope: per-document publish metadata in the manifest, and three compile targets — a self-contained HTML article, an RSS 2.0 feed and an Atom feed. **No hosting, no deploy, no account, no analytics**: Caotang writes files into `exports/` and the writer publishes them.
> Cross-refs: the compile pipeline and the closed recipe shape = [exporter.md](exporter.md) §2/§3 · the manifest's unknown-tolerance rule = [project-format.md](project-format.md) §6 · the podcast feed that rides these writers = [av-script.md](av-script.md) §5 · the media-track rule (new kinds, exporters and tools, never a fork) = [media-track.md](media-track.md) §0 · the plain-text artifact rule = [../decisions.md](../decisions.md).

## 1. Fit

A newsletter, a blog post and a longform article are the same compile Caotang already runs — select a subset, order it, render it through a template — with a different target and a little more metadata per document. This is **not** a new document kind, not a new node type and not a new package: it is one unknown-tolerant manifest field and three entries in the exporter's closed format enum.

What is genuinely missing today is that a writer cannot say, per document, what its address is, when it was published, and whether it is still a draft; and a compile cannot emit a whole folder as a feed.

### 1.1 Evidence

| # | Convention or pain point (evidence) | How the design follows it |
|---|---|---|
| W1 | YAML front matter is the universal per-document metadata block. Jekyll **requires** it for a file to be processed at all, and its predefined variables are `layout`, `permalink`, `published`, `date`, `category`/`categories`, `tags` (jekyllrb.com/docs/front-matter) | The field names follow Jekyll's, but the values live in the manifest, not in the body (§2, WD1). The `html` writer can emit a front-matter block for a generator that expects one (§3); front matter from the `md` writer is a later phase, not part of this plan. |
| W2 | Hugo's documented set is much larger: `title`, `date`, `publishDate`, `expiryDate`, `draft`, `slug`, `url`, `aliases`, `description`, `summary`, `keywords`, `weight`, `layout`, `type`, `outputs`, `params`, `resources`, `sitemap`, `translationKey`, `menus` (gohugo.io/content-management/front-matter) | `publish` takes only the intersection a writer sets by hand. The rest is generator-specific and belongs in a recipe's `options`, not the manifest (YAGNI). |
| W3 | A canonical link consolidates duplicate URLs, **must be absolute**, and every syndicated copy should point at the original (developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) | `canonical` is written as `<link rel="canonical">` in `html` and as the item's `<link>` in a feed. A relative value is refused at save, not resolved and not silently emitted (§2, WD3). |
| W4 | Atom is the IETF standard: every feed and entry needs `id`, `title` and `updated`, dates are RFC 3339, and `application/atom+xml` is IANA-registered. RSS 2.0 is frozen, its `description` is ambiguous between summary and full text, its dates are RFC 822, and `application/rss+xml` is **not** IANA-registered (RFC 4287, datatracker.ietf.org/doc/html/rfc4287) | Both are emitted: `rss` for reach, `atom` for strictness (§3, WD2). A podcast feed is always RSS 2.0, because Apple Podcasts requires it ([av-script.md](av-script.md) §5). |
| W5 | RSS 2.0 requires only `title`, `link` and `description` on a channel, and at least one of `title` or `description` on an item; `enclosure` carries exactly `url`, `length` and `type`; `guid` has an `isPermaLink` attribute defaulting to `true`; `pubDate` is an RFC 822 date (rssboard.org/rss-specification) | The feed writer emits that minimum plus what the metadata supplies, and invents nothing. A document with no `publishedAt` is a draft and is omitted from a feed rather than dated with the compile instant (§3). |

## 2. Model

No new package. Publish metadata is an unknown-tolerant field on a document node, beside `synopsis` and `keywords`, following the same additivity argument as every other media-track field ([project-format.md](project-format.md) §6):

```ts
tree[].publish?: {
  slug?: string;          // the address segment; absent = derived from the title, as the md writer already derives headings
  publishedAt?: string;   // RFC 3339. Absent = a draft: it compiles into a preview but is omitted from a feed (WD4)
  tags?: string[];        // free vocabulary, like the binder's keywords; no closed list
  canonical?: string;     // absolute https URL, or refused at save (W3)
  description?: string;   // the summary a feed item and a link preview show
  layout?: string;        // a static-site generator's template name, passed through untouched and never interpreted
}
```

**Draft has exactly one definition: a document is a draft when `publishedAt` is absent.** There is no separate flag, so no document can be both dated and a draft, or undated and published. To take a published document back to draft, the writer clears its date.

Unknown keys load tolerantly and are kept in memory ([project-format.md](project-format.md) §6). Nothing here may hold a key, a token or a session secret — the manifest's existing rule, restated because a `canonical` URL invites one.

`publish` is set by **one new command, `binder.setPublish`**, beside `binder.setMeta` and `binder.setSynopsis`: a patch of the fields it names, validated as a whole (a relative `canonical` refuses the whole patch), one undo step. It moves the pinned command count in `packages/store/test/commands.test.ts` by one, and `publish` gets an entry in the manifest writer's `OPTIONAL_NODE_FIELDS` (`packages/store/src/manifest-json.ts`) so the value is written back on every save.

A feed recipe's `includeRootIds` selects the folder whose children become items, exactly as an EPUB recipe selects chapters: **no new selection machinery and no new recipe command**. Feeds are set through the existing `recipe.save`, and the item order is the binder order the compile already uses.

## 3. Formats

| Format | Behaviour |
|---|---|
| `html` | One self-contained HTML file per document, rendered over the existing mdast stage the EPUB emitter already uses ([exporter.md](exporter.md) §3a) — no new dependency. Semantic article markup (`<article>`, `<h1>`–`<h6>`, `<time datetime>`), styles in a `<style>` block, **no `<script>`**, so a host's Content-Security-Policy is not provoked. `<link rel="canonical">` when `canonical` is set; `<meta name="description">` from `description`. Recipe options: `frontMatter` (emit a YAML block for a generator), `standalone` (a full document) or `fragment` (a partial for a site template), `css` (a recipe-supplied stylesheet id). |
| `rss` | RSS 2.0 (W5). Channel `title` and `description` from the recipe's folder (its title and synopsis) and `link` from the recipe's `siteUrl` option; one `<item>` per non-draft document in binder order, with `<title>`, `<link>` (the `canonical`, else omitted — an item with no address gets no `<link>` rather than a wrong one), `<description>`, `<pubDate>` as RFC 822 converted from `publishedAt`, and `<guid isPermaLink="false">` built from the document's stable node id so it never changes when a slug does. `atom:updated` is not emitted; this is RSS. |
| `atom` | RFC 4287 (W4). Feed `id` is the recipe's `siteUrl` option, `title` the folder title, `updated` the newest entry's instant. One `<entry>` per non-draft document with the required `id` (`<siteUrl>#<node id>`, built from the stable node id so a slug change does not make a new entry, WD5), `title` and `updated` (its `publishedAt`), plus `<link rel="alternate">`, `<summary>` and `<content type="html">` — Atom's typed content removes the RSS `description` ambiguity, which is the reason to offer it. |

**Both feeds need the recipe option `siteUrl`**: the absolute `https` address of the site the feed belongs to, which is RSS 2.0's required channel `<link>` and Atom's required feed `id`. When it is absent or not absolute `https`, the compile refuses that feed with a sentence saying what to type, rather than writing a feed without a required element. `siteUrl` is never used to resolve a relative `canonical` (WD3).

All three join `EXPORT_FORMATS`, appended so the frozen order holds ([exporter.md](exporter.md) §3). **None is binary**, so `BINARY_FORMATS` is untouched and `ArtifactFs`, which is string-only, can hold all three — unlike DOCX, EPUB, XLSX and the two PDFs. None is a media-track format either: they compile through the prose pipeline, so `MEDIA_FORMATS` is untouched.

XML is written by a Caotang-owned emitter with an escaping helper, on the same reasoning as the EPUB emitter: a small frozen-spec writer beats a dependency, and the bundle gate (`tools/check-bundle-size.mjs`) is not moved.

## 4. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A writer publishes a feed whose `<link>` points nowhere, because no `canonical` was set | High | An item with no `canonical` gets no `<link>`; the compile log names the documents it skipped and why, in the writer's words. Never a guessed URL. |
| A generator's front-matter dialect drifts from what Caotang emits | Medium | `frontMatter` emits only W1's Jekyll-predefined names, which are the stable subset; anything generator-specific stays in the writer's own template. |
| Feed output is treated as a publishing service | Certain | §5 says plainly that Caotang writes files and the writer hosts them. No deploy, no FTP, no API push, no analytics — the same posture as the video prompt pack, which writes prompts and does not render video. |

## 5. Non-goals

Hosting, deploying, FTP, SFTP and any push to a platform API. Subscriber lists, paywalls, open tracking and analytics — Caotang counts nothing it charges for and nothing it does not. Email sending. A site generator: Caotang emits files a generator or a host can serve, and does not become one. Image hosting for a newsletter's pictures, which stay in the project's `assets/` and are referenced by the address the writer publishes them at ([pictures.md](pictures.md) §2.1).

## 6. Phased plan

Milestone **Web publishing**, epic #207. Issues: W1 #217, W2 #218, W3 #219, W4 #220. Every feature issue updates `docs/USER-GUIDE.md`, `CHANGELOG.md` and `docs/ROADMAP.md` in the same pull request and flips this spec's status line for what it builds. The AV script track's `podcast-rss` ([av-script.md](av-script.md) §5, S7 #214) extends W4's feed writer rather than writing a second one.

| # | Title | Scope | Done when | Needs |
|---|---|---|---|---|
| W1 | `docs(architecture): specify web publishing` | This spec; the ARCHITECTURE §2 row and the decisions.md lines | Spec merged | — |
| W2 | `feat(store): per-document publish metadata` | `tree[].publish`, its `OPTIONAL_NODE_FIELDS` entry, the `binder.setPublish` command and the command-count update, the `canonical` refusal, unknown-tolerant load, an inspector section | A slug, a date, tags and a canonical address persist and survive a reload; a relative canonical is refused with a sentence that says what to type instead | W1 |
| W3 | `feat(export): a standalone HTML article` | `render-html.ts` over the mdast stage, format registration, recipe options | An exported article opens in a browser with semantic headings, a `<time>` element, the canonical link and no script | W2 |
| W4 | `feat(export): RSS and Atom feeds` | `render-feed.ts`, both formats, the `siteUrl` recipe option and its refusal, the draft rule, the compile-log skip lines | A folder of documents compiles to a feed that the W3C validator accepts; a draft is omitted; an item with no canonical has no link | W2 |

## 7. Decisions

Numbered with a `WD` prefix, so a reference is never ambiguous between §6's plan items (W) and these decisions (WD).

| # | Decision | Rejected alternative and why |
|---|---|---|
| WD1 | **Publish metadata lives in the manifest**, not as YAML front matter in the document body. The `html` writer may emit a front-matter block for a generator (§3); the `md` writer does not in this plan. | Front matter in the body: it would make the body a second source of truth for data the manifest already holds, and the editor's lossless-Markdown contract would have to learn a new block type it must never drop. |
| WD2 | **Both `rss` and `atom`.** | RSS only: Atom is the IETF standard, the only one of the two with an IANA-registered media type and an unambiguous typed content element. Atom only: podcast platforms require RSS 2.0, and reach matters more than strictness for a blog. |
| WD3 | **A relative `canonical` is refused at save, never resolved.** | Resolving it against the feed recipe's `siteUrl`: that is a feed's address, not a document's, a document can be compiled by recipes with different addresses, and guessing would write a wrong absolute URL into every syndicated copy — the exact harm W3's guidance exists to prevent. |
| WD4 | **A document with no `publishedAt` is a draft and is omitted from a feed**, rather than dated with the compile instant. | Dating it now: a feed item's date is a promise to a reader about when the work appeared, and stamping the compile time makes every re-export reorder the feed. |
| WD5 | **The feed's `<guid>` is the stable node id with `isPermaLink="false"`, not the canonical URL.** | The URL as the guid: a slug change would then look like a new episode to every aggregator, which is the failure Apple's "a GUID never changes" rule exists to prevent. |

## 8. Sources

jekyllrb.com/docs/front-matter · gohugo.io/content-management/front-matter · developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls · datatracker.ietf.org/doc/html/rfc4287 · rssboard.org/rss-specification (mirrored at cyber.harvard.edu/rss/rss.html) · validator.w3.org/feed. The RSS-versus-Atom comparison beyond what RFC 4287 itself states comes from secondary sources and is not relied on for specifics.
