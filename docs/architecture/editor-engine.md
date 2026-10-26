# Editor engine — Tiptap 3.x on ProseMirror, mdast Markdown boundary (v1)

> Status: built. Tiptap 3 on ProseMirror with an mdast Markdown boundary; the round-trip corpus is fixture data in `packages/editor-audit`.
> Cross-refs: anchor ladder = [edit-anchors.md](edit-anchors.md) · bus primitives + two-lane undo rules = [command-bus.md](command-bus.md) §4/§5 · body projection = [project-format.md](project-format.md) §3 · ghost-preview loop = [agent-harness.md](agent-harness.md) §8 · runtime store = [project-format.md](project-format.md) §8.
> **Bar for this file:** an implementer can build the editor from it alone: schema (§3), handler table with loss taxonomy (§3.3), seam (§4), pipeline + dialect contract (§5), anchor bridge (§6), undo lanes (§7), ghost (§8), autosave (§9), extension set (§10), pin list (§2), fixture corpus (§5 dialect contract + §7 rule 4), diff rendering (§14).

## 1. Decision summary

**ADOPT: Tiptap 3.x (MIT core) on ProseMirror, with `@handlewithcare/remark-prosemirror` as the Markdown boundary.** ProseMirror's native toolkit (steps, decorations, changeset, history exclusion flags) is exactly what the agent stack already specced requires ([edit-anchors.md](edit-anchors.md), [agent-harness.md](agent-harness.md) §8, ghost preview); Tiptap supplies the ergonomic extension layer and funded maintenance buffer without cloud dependence (MIT core only — no Tiptap Cloud, no paid extensions). Lexical is the **documented runner-up**: its `@lexical/mdast` syntax-preserving round-trip is the one category where it objectively wins, and it stays reachable because everything model-facing here is behind the engine-agnostic `EditorApi` seam (§4).

**Rejected:** BlockNote (Notion-style card UI is wrong for manuscript prose; XL packages GPL-3.0; React-only), raw ProseMirror (Tiptap's ergonomics cost nothing we need), first-party `@tiptap/markdown` (MarkedJS token pipeline, not mdast — loses the remark extension ecosystem that inline annotations would need; see §12 D1).

The swap-to-Lexical trigger stays live: if the round-trip fidelity tests fail on supported constructs *and* `@lexical/mdast` passes the same suite, the `EditorApi` implementation is replaced, nothing above the seam changes (§11).

## 2. Version pin list

> The **policy** is the decision (exact pins, single version across `@tiptap/*`, lockfile-enforced); the numbers below are the pinned values. The lockfile and `packages/editor-audit` hold the current numbers.

| Package | Pin | License | Notes |
|---|---|---|---|
| `@tiptap/core` | **exact** 3.31.4 | MIT | Zero runtime deps; the PM stack arrives via `@tiptap/pm`. Never range-pin across the `@tiptap/*` surface (see D7). |
| `@tiptap/pm` | **same exact version as `@tiptap/core`** | MIT | Peer dep of core; wraps PM ecosystem (view ^1.42.3, model ^1.25.11, state ^1.4.4, history ^1.5.0, tables ^1.8.5, changeset ^2.4.1, …). Mixing patch versions across `@tiptap/*` packages causes npm `ERESOLVE` conflicts (ueberdosis/tiptap#7591, 2026-03). |
| StarterKit-family extensions used (§10) | same exact version as `@tiptap/core` | MIT | Single version across every `@tiptap/*` package, structurally enforced by upstream packaging: `@tiptap/starter-kit` declares its `@tiptap/extension-*` packages at the exact same version, so a mixed set cannot install. |
| `prosemirror-changeset` | **exact 2.4.4** | MIT | `@tiptap/pm` requires `^2.4.1`, so an older pin cannot co-install. Ghost-diff rendering (§8) and the v0.2 suggestion layer input. |
| `@handlewithcare/remark-prosemirror` | **exact 0.1.5** (latest; no release since 2025-01-03 — see §12 D8) | MIT | The MD boundary (§5). Same collective as the adopted suggest-changes library. Bus-factor posture: Caotang-owned handler table + vendoring escape hatch (§12 D8). |
| `unified` / `remark-parse` / `remark-stringify` / `remark-gfm` | latest micromark-class line; pin exact | MIT | remark-gfm needed for `strike` + autolinks (§3). remark-stringify options ARE the dialect contract (§5). |
| `fastest-levenshtein` | pin exact (~1 KB, zero deps) | MIT | Anchor-ladder step-3 scoring, main bundle. |
| `diff-match-patch` | pin exact; **lazy-loaded** (~30 KB gz class) | Apache-2.0 | Anchor-ladder step-4 Bitap locate + prose-diff display (§14). |
| `@handlewithcare/prosemirror-suggest-changes` | **exact** 0.1.8 (v0.2 only) | MIT | Apply-then-review alternate mode: the actively maintained MIT candidate, zero runtime deps, peers satisfied by the pinned PM set. If a needed fix exists only upstream and unreleased, **vendor the module** (small, MIT) rather than pin a git dependency (mirrors the D8 posture). |

At install, the bundle is checked for zero Tiptap Cloud/Pro fetches and every `prosemirror-*` peer range must resolve against the pinned `@tiptap/pm`.

### 2.1 Round-trip corpus

The round-trip corpus of 57 constructs is fixture data in `packages/editor-audit` (`src/corpus.ts`), run through the pinned pipeline by its tests. Its load-bearing finding is that the §3.3 handler table is not a convenience layer: without the degrade handlers a GFM table or raw HTML in a manuscript fails the load, so every construct outside the schema degrades with a named warning (§3.3).

## 3. The Caotang ProseMirror schema (v0.1)

The schema is exactly "what can be expressed in CommonMark + GFM-strike + images" — nothing more (rich-text ceiling cases render in-editor and style at compile; they are never stored as non-Markdown, [project-format.md](project-format.md) §3). No tables, no task lists, no footnotes, no HTML nodes in v0.1.

### 3.1 Nodes

| Node | Group | Content | Attrs | Markdown source |
|---|---|---|---|---|
| `doc` | — | block+ | — | body projection root ([project-format.md](project-format.md) §3) |
| `paragraph` | block | inline* | — | paragraph |
| `heading` | block | inline* | `level: 1\|2\|3\|4\|5\|6` | ATX/setext heading |
| `blockquote` | block | block+ | — | `>` blockquote |
| `bullet_list` | block | list_item+ | — | `-` / `*` / `+` list |
| `ordered_list` | block | list_item+ | `start?: number` | `1.` list |
| `list_item` | listitem | block+ | — | list item |
| `horizontal_rule` | block | — | — | `***` thematic break — **the scene separator** |
| `code_block` | block | text* | `language?: string` | fenced/indented code |
| `hard_break` | inline | — | — | two-space or `\` line break |
| `image` | inline | — | `src: string` (required), `alt?: string`, `title?: string` | image (parse+serialize only — **no insert UI in v0.1**; round-trips hand-written images losslessly) |
| `text` | inline | — | — | text |

**The Content column is a ProseMirror content expression, measured against the built schema.** `code_block: text` would not describe a schema that can be built at all (the constructor throws *"Only non-generatable nodes (text) in a required position"*), and `paragraph`/`heading: inline+` would round-trip `>`, `-` and `1.` as `> \`, `- \` and `1. \` because the required slot is filled with an empty text node. `packages/editor/test/spec-parity.test.ts` re-derives the rows from this table, so a future edit has to argue with the measurement rather than with the code.

### 3.2 Marks

| Mark | Attrs | Markdown source |
|---|---|---|
| `em` | — | `*x*` / `_x_` (serialized `_`) |
| `strong` | — | `**x**` |
| `strike` | — | `~~x~~` (GFM) |
| `code` | — | `` `x` `` |
| `link` | `href: string` (required), `title?: string` | `[text](href "title")` |

### 3.3 mdast handler table (the round-trip contract)

remark-prosemirror maps mdast ↔ PM via per-type handlers against **our** schema (`toPmNode`/`toPmMark` for parse, `fromPmNode`/`fromPmMark` for serialize). Every mdast type is classified; behavior is never silent:

| mdast type | PM mapping | Class | Behavior |
|---|---|---|---|
| `paragraph`, `text`, `blockquote` | same-name node | **exact** | lossless |
| `heading` (depth 1–6) | `heading` | **exact** | depth kept |
| `list`, `listItem`, `emphasis`, `strong`, `inlineCode`, `link`, `image`, `break`, `thematicBreak`, `code` | §3.1/§3.2 nodes/marks | **exact content** | content lossless; **syntax normalization** per §5 (list marker → `-`, fence → ` ``` `, thematicBreak → `***`) |
| `delete` (GFM) | `strike` | **exact** | `~~x~~` |
| `break` | `hard_break` | exact content | line-break style normalized (two-space) |
| `html` (raw HTML block/inline) | — | **degrade** | rendered as literal text paragraph; warning `unsupported-node` |
| `table` (GFM) | — | **degrade** | each row serialized as one paragraph line; warning `lossy-structure` |
| an inline mark **nested inside the same mark** — `emphasis` in `emphasis`, `strong` in `strong`, `delete` in `delete` | one marked run | **degrade** | the inner run's boundary is lost: the text merges into the surrounding run, so a save re-parses as a *different* document; warning `lossy-structure` |
| `footnoteDefinition` / `footnoteReference` | — | **degrade** | inline `[^n]` text kept, definition appended as paragraph; warning `unsupported-node` |
| `definition` / `linkReference` / `imageReference` | — | **degrade** | expanded to direct link/image with resolved URL; warning `lossy-attribute` |
| `listItem` with a GFM `checked` (task item) | `list_item`, checkbox dropped | **degrade** | warning `lossy-attribute`; the item's *content* stays exact per the exact-content row above |
| `code` with a fence info string that carries a `meta` | `code_block`, info-string meta dropped | **degrade** | warning `lossy-attribute`; the code's *content* stays exact per the exact-content row above |
| `yaml` | — | **never enters PM** | front matter stripped pre-parse (§5) |
| anything unknown | — | **degrade** | literal text fallback; warning `unsupported-node` |

```ts
interface LossWarning { code: 'unsupported-node' | 'lossy-attribute' | 'lossy-structure';
                        mdastType: string; position?: { line: number; column: number };
                        detail: string; }
```

**The invariant is stability, not byte-identity:** `serialize(parse(body))` is byte-identical for every **exact**-class construct, and for any doc it is *deterministic* — same input → same output bytes, so a no-op edit cycle never dirties git diffs. Degrade-class constructs are re-serialized in their degraded form after the user is warned at load (banner listing `LossWarning[]`, "save will normalize these constructs"). This is the Domternal round-trip discipline with the loss-warning codes adopted verbatim.

**The GFM task item is its own row, and it is not a second claim about `listItem`.** A plain list item is exact-content and stays in that row; a task item carries a `checked` attribute that §3.1's `list_item` has no attr slot for, and §3 says out loud that v0.1 has no task lists. So the *type* is exact and the *attribute* is lost, and the row says which. The reason it needs saying at all: `listItem` is a **known** type, so the "anything unknown" catch-all cannot see this, and the measured failure was a checklist that loaded, saved as ordinary list items, and reported nothing. Warning it is a **visibility** fix and not a schema change — a hand-built document out of §3.1's `list_item`, which has nowhere to put a checkbox, serializes to the same bytes the fixture degrades to (pinned in `test/degrade.test.ts`).

**The fence info string is the same shape of row, for the same reason.** A fence's info string is `language meta` — remark parses `js title=x` as `lang: 'js', meta: 'title=x'` — and §3.1's `code_block` has a slot for the language and **none** for the rest, so the loader keeps the language and drops `title=x`. The *type* is exact-content (the code's own text survives byte for byte) and the *attribute* is lost, so the row above says which and the load warns `lossy-attribute`. A fence with only a language warns nothing: the warning is about the part that is dropped, not about fences. The preflight measures the same thing from the other side — a round trip of such a fence reads `degrade`, because the shape it compares carries the meta and the shape that comes back does not (`packages/editor-audit/src/trace.ts`), so the instrument and this table agree on what the construct is.

**A loss is not a re-spelling, and the two are counted separately.** `LossWarning` says *you lost something*; §5's `DialectNotice` says *nothing was lost, but the spelling is not ours and a save will rewrite it*. An HTML entity belongs to the second: remark-parse decodes `&amp;` to `&` while parsing, so it never becomes an mdast node, no handler can see it, and there is no row above for it to land in. Making it a loss code would put a re-spelling in the list of things a writer lost.

**The merged inline run is a loss of *structure*, and the engine forbids preserving it.** It is easy to read as "adjacent sibling `emphasis` nodes"; measured, it is **nested** — `_gone and _struck_ together_` is one `emphasis` containing a second one — and the two shapes behave oppositely, which is the reason the row is stated as a condition and not as a type:

| input | mdast | in the document |
|---|---|---|
| `_gone and _struck_ together_` | `emphasis( text, emphasis( text ), text )` | **one** `em` run; saves as `_gone and struck together_` |
| `_a_ _b_` | `emphasis, text, emphasis` (siblings) | three runs, nothing lost |
| `_a [b _c_ d](u) e_` | `emphasis( text, link( text, emphasis, text ), text )` | **one** `em`+`link` run; saves as `_a [b c d](u) e_` — the inner emphasis is erased outright |

The reason it cannot be *prevented* rather than declared is ProseMirror's `Fragment.join`, which coalesces adjacent text nodes carrying identical mark sets — measured, three same-mark runs collapse to one at **every** construction path (`NodeType.create`, `Fragment.fromArray`, a document round trip) while `em, strong, em` survives as three, and an empty separator text node is rejected outright (`RangeError: Empty text nodes are not allowed`). **Two adjacent text runs carrying identical marks are not a document this engine can hold**, so the only available fix is to say so. The same code as `table` is deliberate and is the same shape of loss: a table's rows become paragraphs and this run's boundary disappears, and in both cases every character survives and the *structure* does not.

The condition is a comparison of mdast type names, not a mark comparison, and it is exact for exactly the three types where one type always produces one mark. It reaches any depth, not just the direct parent — the third row above is the reason, and it is why the check is a walk over the mdast rather than a handler: the library passes `(node, parent, state)` and mdast has no parent back-pointer, so a mark handler cannot see its own ancestors. **`link` is excluded on purpose**: it carries `href`/`title` (§3.2), so two links are interchangeable only when their attributes match, which is a different question. Measured consequence, recorded rather than fixed here: `[a](u)[a](u)` merges into one `[aa](u)` run, and it is **not** a loss — nothing visible changes, the target is unchanged and the rendering is identical — so it belongs to §5's re-spelling channel if it is ever counted at all, and not to this one.

## 4. `EditorApi` — the engine-agnostic seam

Defined so the documented Lexical runner-up (§11) is a real swap option: **no ProseMirror/Tiptap type leaks above this interface**. Lives in `@caotang/editor`; the Tiptap adapter implements it; the editor's acceptance bar requires the interface, not the engine, to be importable headless (Playwright drives it without a visible window).

```ts
interface EditorApi {
  mount(host: HTMLElement, opts: EditorMountOptions): Promise<EditorInstance>;
}

interface EditorMountOptions {
  docId: string;                       // binds the instance to a document
  initialBody: string;                 // body projection MD ([project-format.md](project-format.md) §3)
  readOnly?: boolean;                  // agent-driven preview states, future apply-then-review
  onChange?: () => void;               // content changed (autosave + revision pipeline, §9)
  onSelectionChange?: (sel: EditorSelection | null) => void;
  onLoadDiagnostics?: (d: LoadDiagnostics) => void;  // §3.3's array, unchanged; see below
}

interface EditorSelection { from: number; to: number; }   // body-projection char offsets (UTF-16 code units, 0-indexed, to exclusive)

interface EditorInstance {
  getContent(): string;                              // serialize current doc → body projection MD (sync; §5)
  setContent(body: string, opts?: { historyExcluded?: boolean }): Promise<void>;  // parse+replace (§5, §7)
  getSelection(): EditorSelection | null;            // null when collapsed
  captureAnchor(): TextAnchor | null;                // edit-anchors.md §2 — from selection; null when collapsed
  revealRange(sel: EditorSelection): void;           // scroll into view + select (agent "show me" affordances)
  insertAtSelection(text: string, opts?: { historyExcluded?: boolean }): void;   // `editor.insert` primitive
  replaceRange(sel: EditorSelection, text: string, opts?: { historyExcluded?: boolean }): void; // `editor.replaceRange` primitive
  ghost: GhostController;                            // §8
  wordCount(): { words: number; chars: number };     // §9
  focus(): void; destroy(): void;
}

interface LoadDiagnostics { warnings: LossWarning[]; dialect: DialectNotice[]; }  // §3.3 and §5, by reference
```

`TextAnchor` is [edit-anchors.md](edit-anchors.md) §2's interface, declared there and re-exported unchanged. `GhostController` is `{ append(delta: string): void; clear(): void }` — the two methods §8 names; the ghost *region* is §8's own work, so the seam carries its shape and not its behaviour.

- **`onLoadDiagnostics?` is the load's diagnostics half, passed through untouched**. The shape: **one argument, the parse's own `{warnings, dialect}`** — `warnings` **is** the array §3.3 produced, by reference, and the dialect channel sits beside it rather than inside it, per §5. **The carrier does not group, deduplicate or reorder:** it is the one layer a caller cannot bypass (`parse` itself refuses nothing), so interpreting the list there would make §3.3's taxonomy a function of who is listening. Grouping is a separate, explicit call for the banner, keyed `(code, mdastType, line)`, reporting how many nodes each entry merged — a writer counts constructs and the list counts nodes.
- **Coordinate bridge (the one subtle mechanism):** PM positions are node-relative; the app's single coordinate system is the body projection ([edit-anchors.md](edit-anchors.md) §2, [codex.md](codex.md) §4). The adapter maintains a **projection map**: walk the PM doc, serialize each top-level block through the §5 pipeline, and record each block's `[bodyStart, bodyEnd) → [pmFrom, pmTo)` span. Conversions are bisections over that map. Rebuilt on every doc change (linear walk of top-level blocks — cheap at per-scene scale). Anchor capture/apply correctness does **not** depend on it: anchors store `exact` text and re-verify on the body projection (ladder is the safety net); the bridge only implements `getSelection`/`revealRange`/primitives. Fixture-asserted: `bodyOffsetFromPmPos(pmFromBodyOffset(o)) === o` **at every offset inside a located run**. It does not hold over whole documents: over the round-trip corpus (§2.1), all 1164 body offsets, **443 fail the identity**, and the reverse composition fails at **293 of 1014** PM positions. What holds at every offset, in both directions, is the **retraction** stated below: applying the composition twice equals applying it once, **0 failures in 1164 and 0 in 1014**.
  - **Two mechanisms make the map match the real body, both forced by §5's dialect details.** (1) **The spans are measured against `serialize(doc)`, not against a concatenation of the blocks.** Two sibling lists serialize with an *alternated* marker — `- a\n\n* b` — so concatenating per-block serializations (`- a` + `- b`) produces a body this product never writes, and it is the one that re-parses as a single loose list. Each block's span therefore comes from serializing the document *truncated to that block*, which is what makes the spans a partition of the real body. (2) **A block span alone cannot answer `getSelection`**, which is an offset *inside* a block — so the map also records a run per **escape-free stretch of a text leaf's body spelling**, each equally long on both sides, and the conversions bisect to a run and fall back to a block. The identity therefore holds over every offset inside a located run, which is every offset a caret can occupy; a body character and a PM position are **not** in bijection once a document contains a hard break, an image, a list marker, a fence **or an escape §5 wrote on the way out**, and those offsets clamp to the nearest text position. The composition is a **retraction** — applying it twice equals applying it once — which is the property that makes a second trip through the bridge a no-op.
  - **A leaf is not always one run.** A leaf's body spelling need not have its text's length: §5 escapes on the way out — `a*b` is spelled `a\*b` — and a run that is equally long on both sides **cannot** cover the longer spelling. In the round-trip corpus (§2.1), five leaves carry an escape (`escape-bracket`, `footnote-reference`, `html-raw-block`, `html-raw-inline`, `obsidian-heading-spacing`) and **all five read a different string on the two sides**: with one run per leaf, `escape-bracket`'s run would cover `not \[a link` against the PM text `not [a link]`, so every offset after the first escape would resolve to the wrong PM position — while the retraction still held, because both conversions would be consistently wrong about the same characters. **So a leaf contributes one run per escape-free stretch of its spelling, and the stretches are separated by the backslash alone**, which is §5's syntax; the escaped character keeps a run of its own. The equal lengths, the bisections and the clamp are unchanged, and the identity holds at every offset a caret can occupy.
- **Error modes:** `mount` fails only on a bad `host` (thrown, programmer error). `setContent` parse cannot fail (Markdown is total); it can only produce `LossWarning[]` (surfaced via `onChange`-adjacent callback `onLoadDiagnostics?`). Primitives with `historyExcluded` never throw for content reasons (offsets map to nearest position; the anchor ladder is the verification layer above them). **The empty document is the case that tests totality:** §3.1's `doc` is `block+`, so an empty body projection compiles to a doc holding one empty paragraph — an empty doc would fail the library's own `check` (`Invalid content for node doc: <>`) on the most common document this product will ever open.

## 5. Markdown pipeline (load & save)

**Load** (open doc / agent apply / snapshot restore):
1. `doc.<id>.md` → strip YAML front matter ([project-format.md](project-format.md) §3 — `gray-matter`-class parse; the body projection is the remainder).
2. `unified().use(remarkParse).use(remarkGfm).use(remarkProseMirror, { schema, toPmNode, toPmMark })` → PM doc + `LossWarning[]` (banner if any). Pipeline is async (unified convention) — hence `mount`/`setContent` return Promises.

**Save** (`getContent` — autosave, exports, compile):
1. `fromProseMirror({ schema, fromPmNode, fromPmMark })` → mdast (sync).
2. `unified().use(remarkStringify, { bullet: '-', emphasis: '_', strong: '*', rule: '***', fence: '```', listItemIndent: 'one' })` → body projection. **Options are part of the spec** — they pin list markers, emphasis style, separator and fence so saves are deterministic and git diffs stay minimal.
3. Autosave path re-wraps front matter (stable key order, `>-` folded synopsis — [project-format.md](project-format.md) §3) around the body.

**Dialect contract (refined by the details and §5.1 directly below):** remark-stringify emits **one canonical spelling per option setting** — parse is lenient, serialize is canonical. Consequence, now spec'd: the byte-identical bar holds **iff input is already written in the configured dialect** (§3.3 invariant, re-read with this lens); a doc authored in a foreign dialect (e.g. `*` bullets, `**` emphasis, setext headings, `+` markers, tab-indented lists) **normalizes on first save** — specified, documented behavior, surfaced once per load as a "saving will re-style N paragraphs" banner entry (reuses the LossWarning path; count computed by parse-side dialect sniffing: any construct whose canonical form differs from its source spelling). Full fixture corpus (§3 + the round-trip gate) = the §13 D3 list: structural (ATX/setext, break variants, thematic breaks), lists (markers ×3, ordered `.`/`)`, tight/loose, task items, 3-level nesting, `listItemIndent` variants), emphasis/inline (`*`/`_`, intraword `_` safety — dialect choice matters for character names like `Kara_thal`, nested emphasis, strike-in-emphasis, backtick runs, escapes, entities), links/images (inline/autolink/bare-URL/reference+definitions/titles/angle-URLs, image alt/title/URL-quirks, **image-in-link composite**), blocks (fenced/indented code, fence-longer-than-content, nested+lazy blockquotes, GFM tables, raw HTML preserve-tier, footnotes if schema adopts), Caotang-specific (front-matter strip, `***` separator, `%%`/`@` plain text per §13-D2, no smart-punct transforms — remark applies none by default, confirmed). `listItemIndent: 'one'` **is the closed dialect choice**: (a) it is the remark upstream default — minimal deviation, cleanest fixtures; (b) 2-space nesting renders on every canonical-output reuse target that matters (Obsidian, GitHub, GitLab, VS Code — fails only Bitbucket/Pandoc, neither a Caotang target); (c) `'tab'` emits literal tab characters — least predictable across copy-paste/diff/editor contexts and the spelling Obsidian itself renders inconsistently — rejected; (d) the sample question was a dead end anyway: Obsidian inserts **4 literal spaces** for nested lists regardless of settings (verified through 1.11.7; the 1.7-era 2-space option was removed; "Indent visual width" is visual-only), so 4-space imports normalize once on first save behind the existing re-style notice — no special-casing. `'mixed'` stays the documented escalation iff the fixture corpus ever demands it. **`listItemIndent` fixtures in the corpus:** Obsidian-exported 4-space nested-list sample (normalizes to 2 on first save, notice fires once, stable thereafter); tab-character-indented sample (same); 2-space sample (byte-identical — already dialect-conformant); mixed 2/4-space document (per-list normalization counts in the re-style notice). Everything else = remark defaults as pinned above.

**Dialect-contract details. Two clarifications and one mechanism, each measured.**

1. **"One canonical spelling per option setting" is true per list *position*, not per document.** A list that directly follows another list is written with an **alternated marker**, and pinning `bullet: '-'` everywhere would be a defect rather than a fix. Measured: two byte-identical `{list, list}` mdast nodes with `bullet: '-'` serialize as `- a\n\n* b\n`; re-parsing that returns **two** lists, and re-parsing `- a\n\n- b\n` instead returns **one** loose list with two items — a different document, and a `lossy-structure` nobody declared. Ordered lists behave the same way (`1. a\n\n1) b`). The alternation is the library's (`mdast-util-to-markdown@2.1.3` `handle/list.js:36-37`) and it is the only thing that makes two sibling lists survive a round trip. So a saved file containing `* task` is the specified dialect.
2. **§3.3 gains a row for the GFM task item**, because `listItem` is a *known* type and the "anything unknown" catch-all cannot see a dropped `checked`. §3 excludes task lists ("No … task lists … in v0.1"), and a handler with no row would be a design decision dressed as a transcription.
3. **The banner's count is now computed, and it is a `DialectNotice[]` beside the `LossWarning[]`.** "Parse-side dialect sniffing" is a mechanism, not a mood: a block is counted when its canonical form differs from its source spelling, which is §5's own rule taken literally. Two consequences a caller has to know, both pinned in `test/dialect.test.ts` (what the count covers is §5.1):
   - It is **not a list of foreign constructs.** `&amp;` → `&`, a `*` bullet → `-`, a setext heading → `#`, a `&#233;` → `é` are all the same comparison, so nothing has to be added to a table when remark decides to re-spell something new.
   - It is a count of **blocks, not nodes**, and a block is compared in *document* context. Rendering a block alone said two adjacent lists were already canonical and reported **zero** for a document that changes on save.

`prosemirror-markdown` (markdown-it based, lossy on nested marks) is **reference-only** — not in the dependency tree; the mdast route sidesteps its parser artifact. First-party `@tiptap/markdown` evaluated and rejected (§12 D1).

### 5.1 The banner counts what a save writes, and names who wrote it

- **Counted means written.** Every block whose bytes a save would change is counted in the banner, list looseness and nested-list blank lines included: they are re-spellings in the same class as `* item` → `- item`. "Caused by a pinned option" exempts nothing, because the dialect *is* the option list.
- **The comparison is against what a save writes.** Each block's canonical form is the save path's own rendering of that block (the compiled document → `fromProseMirror` → the save's chain), compared with its source slice.
- **`DialectNotice` carries a `cause`** — `parse-side`, `list-spread`, `list-item-spread` or `save-side` — because "your marker is not ours" and "the product writes every list tight" are different sentences for a writer.
- **The two channels stay disjoint.** A change `LossWarning` already reports (a loss, such as the nested-emphasis collapse) is not also counted as a dialect notice.
- **Offsets come from the serializer.** One render of the document through `mdast-util-to-markdown`'s `join` extension point records each top-level block's string as it is produced, so counting is `O(n)`. The prefix algorithm (render blocks `1…i+1`, subtract `1…i`) is kept as the fallback, and the fast path answers only when it captured every block after the first and each capture is by identity the block it claims.

## 6. Selection ⇄ TextAnchor (agent-facing bridge)

- `captureAnchor()` implements [edit-anchors.md](edit-anchors.md) §2 verbatim: `from`/`to` = body-projection offsets (via §4 bridge), `exact = body.slice(from,to)` from **the serialized body** (never PM text), `prefix`/`suffix` = up to 32 context chars, `capturedRevision` = the doc's current `doc.revision` ([command-bus.md](command-bus.md) §6).
- Called at **plan time** when a `scene.draft { mode: 'rewrite_selection' }` card is created ([agent-harness.md](agent-harness.md) §3 tool 8). The anchor is plan data: previewable and user-editable in the card.
- Apply path never touches the editor live: anchor resolution runs on the body projection ([edit-anchors.md](edit-anchors.md) §3 ladder, fed by §12 D6 libraries), the resolved range goes through the bus `editor.replaceRange` primitive inside the compound apply (grant inheritance), and the editor receives the post-apply state via the store notification (§9) — the model never touches live editor positions mid-stream.

## 7. Two-lane undo

The market separates editor-undo from agent-restore completely. Caotang adopts the same two-lane model:

| Action | Lane | Mechanism |
|---|---|---|
| User keystrokes | **Lane 1 — editor-native** | `prosemirror-history` via Tiptap's history extension, engine-default coalescing. Untouched by the bus. |
| Autosave flush | neither | `doc.write` command, one bus undo group per debounce window ([command-bus.md](command-bus.md) §9) — bus-level, not editor-level. |
| Agent apply (`scene.draft`, snapshot restore, any bus text mutation) | **Lane 2 — bus undo group** | applied as **one transaction batch with `tr.setMeta('addToHistory', false)`** + `closeHistory(tr)` (see rule 1) + per-turn body snapshot ([project-format.md](project-format.md) §8). Restore = snapshot → `setContent(historyExcluded: true)`. |

Rules (all fixture-tested, §11):

1. **Agent edits are never replayed by Ctrl+Z** — they are history-excluded; the user's undo stack only ever reverts *their own* keystrokes. This preserves the checkpoint framing: "restore to before this turn" is snapshot-based and therefore immune to in-editor undo position drift.
   - **`addToHistory: false` alone does not deliver the second clause, and the second mechanism is `closeHistory`.** An excluded transaction adds no step but leaves the user's still-open event open, so the library appends the user's *next* keystroke to it. Measured on the same three transactions (`A`, an adjacent insert of `M`, `C` back at the first position): with `addToHistory: false` alone the depth after `C` is **1** and one Ctrl+Z reaches **0**, taking both keystrokes; with `closeHistory` as well the depth is **2** and one press takes one keystroke. The first is the "undo once → history empty" failure. The two metas are not redundant — they are read in different branches of the library's `applyTransaction`, so the agent's step stays out of **both** stacks.
2. **"Restore to before this turn"** (activity-log checkpoint row, [command-bus.md](command-bus.md) §5) = snapshot restore + `setContent(historyExcluded: true)`. It never travels through Lane 1.
3. **Asymmetry surfaced honestly:** edits after an agent turn, then restore-to-before-turn, discard the user's own keystrokes too. The restore confirmation states the scope explicitly: "restores the document to its state before this turn; your edits since then are included in the restore" (Claude Code's restore-code-vs-conversation menu precedent). One-line confirm, not a dialog storm.
4. **Known PM sharp edges are regression-tested** (excluded-transaction-then-undo bookkeeping, appended-transactions-during-undo, metadata lost on redo replay — the fixtures below exist because of the documented failure classes).
4a. **"Restore to before this step"** (a step of a turn, [command-bus.md](command-bus.md) §5 `undoFrom`) is the same Lane 2 mechanism: the compensations of the step and the steps after it put their snapshots back as writes, and the editor gets the result through `setContent(historyExcluded: true)`. It is snapshot-based, never replayed through the editor's history, and never travels through Lane 1.
5. Cross-doc bus-level undo stays parked (v0.2); per-doc snapshot restore covers v0.1's promise.
6. **Lane 1 survives a reload, through a journal Caotang owns.** `prosemirror-history`'s stack is not public API, so it is never serialised. The editor records each Lane 1 transaction (`{steps: tr.steps.map(s => s.toJSON()), time, composition?}`) and the writer's undo and redo (as markers), per document, in a ring that starts at a base body. The app keeps the ring in the app database (`caotang-app`, object store `editor-history`, keyed `projectId:docId`; project-format §4), written one second after the last change (at most five seconds after the first) and at once when the tab is hidden. On mount the editor parses the base body and replays the entries through public API only (`Step.fromJSON`, `tr.setTime(entry.time)`, the library's own `undo`/`redo`), so the library groups events exactly as it did (its 500 ms window reads `tr.time`). **The replay is verified**: the journal must be of this build (`version`, and a schema signature of the node and mark names, so a schema that gains marks discards old journals), every step must apply, and the replayed document must serialize to the body the editor opened with; anything else discards the journal and the editor starts with an empty history, because a wrong document is never risked for undo. A Lane 2 transaction and `resetUndoHistory` **start a new ring** at the document they leave, so after a reload Ctrl+Z never removes agent text. (In the open tab an apply that does not reach the user's text leaves Lane 1 as it was, rule 1; the journal restarts all the same.) The ring holds 3000 transactions; past that its oldest quarter is folded into the base and checked by replay. Journals are dropped with their document, with their project, and after 30 days. Undo survives a reload; a redo that was available may come back with it but is not promised. The toolbar's Undo and the Activity panel's Undo are the bus's (command-bus §5) and last for the open tab; the Source tab and Ink text are `<textarea>`s with the browser's own undo.

**Why this decided the engine choice:** `addToHistory: false` is a *documented* ProseMirror feature; Lexical has no documented per-transaction history exclusion (custom bookkeeping required). One more PM tiebreaker on top of §1.

## 8. Ghost preview (streaming integration with the harness)

- **Implementation: a separate read-only `EditorInstance`** sharing the schema, rendered as the ghost region below the focus doc inside the editor pane (visually distinct: tinted background, left border, no toolbar). **Rejected: decorations in the main editor** — streaming insertions as decorations churn the main doc's decoration set every delta and couple the ghost to live-selection state; a second instance is trivially discardable.
- Streaming: harness receives chunks → `ghost.append(delta)`; each append is a transaction with `addToHistory: false` **and `closeHistory`**, by rule 1's measured second mechanism (ghost text is never in Lane 1, and the ghost turn is a boundary in it) and never bumps `doc.revision` (nothing persisted until Apply).
- **Apply / Retry / Discard** buttons live in the agent panel card ([agent-harness.md](agent-harness.md) §8) — the ghost region itself is render-only:
  - **Apply** → harness issues the bus command (`doc.write` for draft/continue; `editor.replaceRange` after anchor resolution for rewrite_selection) → store notification → main editor `setContent(historyExcluded: true)` (Lane 2) → ghost cleared → undo group registered.
  - **Retry** → same assembled context + deterministic variant seed → ghost cleared and re-streamed. Doc untouched.
  - **Discard** → `ghost.clear()` only.
- Failure modes: stream abort → ghost shows partial text + error note, Apply disabled, Retry/Discard live (no zombie requests — gateway abort contract, [provider-gateway.md](provider-gateway.md) §3). Apply while user is mid-keystroke in the main editor: the Apply path carries `expectedRevision`; mismatch → conflict error, ghost preserved (§9).

## 9. Autosave, revisions & word counts

- **Dirty pipeline:** `onChange` → debounce **800 ms** → dispatch `doc.write {docId, body, expectedRevision}` (`issuedBy: 'user'`) → store write (one IndexedDB transaction) → `doc.revision` bump → subscribers. Plus flush on `visibilitychange`/`pagehide`/`beforeunload` ([project-format.md](project-format.md) §4). **The pending journal** (Lane 1's own history across a reload is §7 rule 6): because a flush started during teardown may never finish (IndexedDB is asynchronous, and the write has two hops: autosave to the session's state, then the persistence pass to the store), the app also writes, synchronously on those three events and once per debounce window while the writer types, the bodies the session holds that the store does not to `localStorage` under `caotang.pending.<projectId>` as `{docId, body, baseRevision, at}[]` (`baseRevision` is the store's revision for the document). An entry is removed when the persistence pass reports the store holds that body, capped at 2 MB (past it the app behaves as before and says so in the status line), and not written while the session is stopped (the unsent copy keeps those words). On open, before any editor mounts, each entry is read against the project: an equal body is dropped; the same revision with a different body never landed, so it is applied as an ordinary user `doc.write` and announced; a moved revision is offered as a new document the way a stopped tab's words are, and never written over the newer text. Flush failure → dirty flag + non-blocking "unsaved changes" indicator; next flush retries; IndexedDB atomicity makes partial writes impossible. **The body is the one the keystroke armed the window with:** the editor hands the store the text it has at that keystroke, and the store's clock writes it when the window closes. A change that is not the user's does not take the pending body without a flush first — the approval path flushes the writer's typing before it answers the approval, and a restore flushes before it takes the turn back — and whatever survives that flush is **discarded, not refused**: the app's one `setContent` call authorizes the discard (`discardUnsaved: true`) for an undo, a restore or an agent apply, and the rebase behind it drops the pending body. The flush's outcome is not checked: `flush()` never rejects (a failed write comes back as a report, not a rejection) and the approval path throws that report away, so a failed flush — or a keystroke typed between the flush and the apply — leaves the text pending and the apply takes it. The adapter's refusal (`UnsavedEditsError`) is the seam's, for a caller that does not authorize the discard, and the app's call always authorizes the discard, so it never meets one. A failed write keeps the body, records the error and arms nothing; the next edit, the next lifecycle flush or an explicit flush retries it.
- **Revision source of truth:** the bus/store, never the editor. Editor instances subscribe to store notifications and re-render from the store (command-bus §3 discipline) — agent-side edits, snapshot restores and undo-all all land in the editor through the same path (this is what makes §7 lane separation coherent).
- **Word/char counts** computed from the PM doc per revision (words = block text split on whitespace, except that a token containing a Han, kana, Thai, Lao, Khmer or Myanmar character is counted by `Intl.Segmenter` — fixed locale `und`, word-like segments — and, where the engine has no `Intl.Segmenter`, each such character counts as one word; chars = body-projection length) and written to `derived.wordCounts` (rebuildable, allowed stale — [project-format.md](project-format.md) §2). Session-target progress reads `sessions.jsonl` (appender side-effect of `doc.write`, [project-format.md](project-format.md) §1). The segmented count for those scripts is approximate: engines' dictionaries differ, so it is not promised identical across browsers or versions. Latin, Greek, Cyrillic, Hangul and Vietnamese tokens count as they always did (`well-known` and `don't` are one word, a `> ` marker is another). The editor's `wordCount()` is the store's `countBody`, so the footer, goals, filter, exporter and the agent's caps agree.
- Optimistic concurrency: autosave flushes carry the revision they were based on; a conflict (rare — single-writer app) surfaces the command-bus conflict envelope, not data loss.

## 10. v0.1 extension set & editor scope

**Tiptap extensions mounted** (single exact version, §2): StarterKit subset — Document, Paragraph, Text, Bold(`strong`), Italic(`em`), Strike, Code(inline), CodeBlock, Blockquote, BulletList, OrderedList, ListItem, HardBreak, HorizontalRule, Heading — plus Link, Image, Placeholder (empty-doc hint), Dropcursor, Gapcursor, History/UndoRedo (Lane 1; exact export name per the v3 line), CharacterCount (feeds §9). StarterKit components that don't fit the schema (tables, task lists) are disabled. Custom nodes/marks drop to raw PM APIs where Tiptap's extension API gets in the way.

**In v0.1:** autosave, word/char counts, session-target progress display, focus mode (panels hide, editor keeps state), paste as plain text + basic inline marks, `***` separator preserved, undo two-lane model, selection⇄anchor bridge, ghost region.

**Not in v0.1:** tables/task lists/footnotes (degrade per §3.3), image insert UI, inline comment/mention syntax (plain text, see §13 D2), editor mention underlining (v0.2, [codex.md](codex.md) §4), apply-then-review suggestion marks (v0.2 — library: suggest-changes 0.1.8, §2; integration contract = §15; review *display* rendering = §14 Path B; the all-accepted projection is Caotang-computed before serialization, §15), find/replace (Tiptap shipped a search-and-replace extension Aug 2026 — cheap v0.2 add, not v0.1 scope), collaborative anything.

## 11. Runner-up & switch trigger (Lexical)

`EditorApi` is the seam; a Lexical implementation would provide `getContent`/`setContent` via `@lexical/mdast`. **Trigger to switch:** the round-trip fidelity tests fail on exact-class constructs *and* `@lexical/mdast` passes the same fixture suite. Known Lexical costs that make this unlikely: no documented per-transaction history exclusion (§7 would need custom bookkeeping), no first-party changeset/suggestion layer (the apply-then-review mode would be greenfield), React-first docs. Decision authority: delegated, logged in docs/decisions.md (§12 D1) — the swap itself, if ever triggered, is re-logged.

## 12. Decisions & assumptions

| # | Decision | Authority / rationale |
|---|---|---|
| D1 | **Tiptap 3.x on ProseMirror; remark-prosemirror MD boundary** | Delegated. Rejected: Lexical (runner-up, §11 trigger — loses only on `@lexical/mdast`), BlockNote (Notion-UI fit, GPL-3.0 XL tier, React-only), raw PM (Tiptap ergonomics free). **First-party `@tiptap/markdown` also rejected**: MarkedJS-token pipeline, not mdast — loses the remark extension ecosystem (directives, GFM control) that inline annotations would need, and its round-trip is CommonMark-fidelity, not syntax-preserving; kept as documented fallback if remark-prosemirror maintenance stalls (same collective as our suggest-changes pick). |
| D2 | Schema = CommonMark core + GFM strike + image; tables/footnotes degrade with warnings | Delegated; data-loss avoidance beats schema breadth for v0.1; `LossWarning` taxonomy makes every degradation visible (§3.3). |
| D3 | **Two-lane undo** (Lane 1 PM history; Lane 2 `addToHistory:false` **+ `closeHistory`** + snapshot restore — see §7 rule 1) | Delegated. Rejected: funneling agent turns through user undo (corrupts checkpoint framing); cross-doc bus undo (parked). |
| D4 | Ghost = separate read-only editor instance, not decorations | Delegated; delta-append churn in the main doc's decoration set would couple ghost to selection state; Apply semantics cleaner (§8). |
| D5 | Anchor-ladder libraries: `fastest-levenshtein` eager (~1 KB), `diff-match-patch` lazy (~30 KB) | Delegated; steps 1–2 stay dependency-free; DMP also feeds the §14 prose-diff rendering. Rejected: fuzzysort (ranker, not similarity), natural (too heavy), hand-rolled Bitap (a solved problem the pinned module covers). |
| D6 | Round-trip bar = byte-identical for exact-class + deterministic saves everywhere | Delegated; Domternal pattern: `serialize(parse(md)) === md` testable, loss-warning codes surfaced at load. |
| D7 | Pinning policy: exact versions, one version across all `@tiptap/*`, lockfile-enforced | Delegated; peer-resolve hazard ueberdosis/tiptap#7591 (2026-03). Matrix **evidence-backed** — see §2; residue = the mechanical bundle audit (§2). |
| D8 | **remark-prosemirror bus-factor posture: pin exact 0.1.5 + Caotang-owned handler table + vendoring as the documented escape hatch** | Delegated. Evidence: 2 authors, 5 real commits (Dec 2024–May 2025), **no npm release in 20 months** (0.1.5, 2025-01-03), 3 open issues / 2 open PRs, 32★ — but sibling suggest-changes repo actively maintained (May–Aug 2026): the collective lives, the package sleeps. The handler table is Caotang code regardless (§3.3) — most drift risk lands in our tests, not theirs; `lib/` is 4 files MIT, so vendor-if-dormant is cheap. Rejected: switching to `@tiptap/markdown` on dormancy (loses the remark inline-syntax story — vendoring beats switching). The round-trip corpus (§2.1) runs through 0.1.5. |
| D9 | **Per-scene document split is mandatory, never a single-manuscript doc** | Delegated. Evidence: the PM bottleneck is **visible DOM nodes, not words** — a ~500k-word doc "loads" but stays slow until most nodes are hidden; the ProseMirror author's guidance: viewport drawing is out of scope for ProseMirror, "split your document into chapters/sections and only deal with each one at a time"; 20–30k-paragraph docs show unacceptable latency deep in the document; Tiptap React virtualization is **unsolved** (`EditorContent` owns the DOM — discussion #7273), node views render synchronously, and the 200k-word Tiptap demo is performance-by-node-count, not words. Consequences: **one editor instance = one document node, always** (project-format §3's one-file-per-node is the load-bearing decision, not an optimization); decoration budgets (mention underlining v0.2, v0.2 suggestion marks) stay per-scene by construction; `prosemirror-history` depth-100 default is per-doc and bounded (undo depth is not a growth risk); the corkboard/binder render no editor DOM, so whole-manuscript navigation never inherits the cost. Rejected: single-doc mode; virtualization work (the ProseMirror author's guidance + Tiptap's unsolved React path make the per-scene split strictly cheaper). Chromium spellcheck is a documented severe slowdown at scale — the editor ships with spellcheck off by default if fixtures confirm. |
| A1 | The §4 projection map is correct for the §3 schema | Explicit; fixture-asserted as the **retraction** `bodyOffsetFromPmPos(pmFromBodyOffset(b)) === bodyOffsetFromPmPos(pmFromBodyOffset(b))` at **every** offset. The plain identity holds only inside located runs (§4): over whole documents it holds at **721 of 1164** body offsets, failing 443. The retraction is the property the map has — **0 failures in 1164**, and 0 in 1014 the other way. The anchor ladder is the safety net regardless. |
| A2 | Tiptap core stays MIT + fully offline at 3.x | **Confirmed at policy level** — MIT core, zero runtime deps, paid surface is Cloud/AI-Toolkit/Tracked-Changes only (none in our stack); the mechanical bundle audit (§2) is the gate. |
| A3 | Per-scene documents stay far below the PM performance ceiling | Evidence-backed (realistic per-scene docs, tens of KB); manuscript-scale single-doc behavior is out of scope (D9). |
| A4 | `remark-prosemirror` async parse is acceptable in `mount`/`setContent` | Explicit; pipeline await is inside the editor boundary; bus commands are unaffected (they operate on the body projection). |

## 13. Inline syntax and dialect

| # | Decision | Authority / rationale |
|---|---|---|
| D2 | **Inline annotations stay OUTSIDE the AST in v0.1: `%%` comment/synopsis lines and name-based `@` mentions are plain text** | Delegated. Load-bearing parser fact: micromark tokenizes only strictly-known constructs — `@Kara` / `%%note` parse → PM (text) → serialize **byte-identical**, guaranteed, with **zero new remark deps**. Codex detection (codex.md §4/§10-K4) already runs on the plain-text body projection, unchanged. Editor-layer mention styling = a decoration pass keyed off the mention cache (decorations don't affect round-trip; v0.2). **Escalation path:** remark-directive (`:::` blocks / `:name[text]{attrs}`) is the documented v0.2 carrier *iff* annotations need in-file attributes (e.g. machine-readable `:note[id]{status=open}`) — with the prose-collision caveat tested against real manuscripts first (`:` and `::` occur in fiction dialogue/letters; every collision is a silent text→node transform, the class §3.3's degrade taxonomy exists to prevent). Custom mdast-util handlers rejected for v0.1 (maintenance burden, no capability above remark-directive). novelWriter's `@`-line reference design stands as the precedent. |
| D3 | **Dialect contract: canonical serialize, dialect-conformant byte-identity, first-save normalization is specified behavior** | Delegated. "Byte-identical for exact-class" now formally means: *round-trips byte-identical given dialect-conformant input, per construct class*; foreign dialects normalize on first save behind a one-time "reformatted N paragraphs" notice (reuses the load-banner reporting). The §5 fixture inventory is the round-trip test list; remark defaults adopted as canonical except `bullet: '-'` (writing-app dominant convention); **`listItemIndent`: `'one'`** — evidence-backed in §5 (remark default; 2-space renders on all reuse targets; `'tab'` rejected; Obsidian's 4-space imports normalize behind the re-style notice; four Obsidian-style fixtures join the corpus). |
| D10 | **Suggest-changes adoption finalized: `@handlewithcare/prosemirror-suggest-changes` exact 0.1.8 for the v0.2 apply-then-review mode; vendor-if-HEAD-fix escape hatch** | Delegated. Rationale: the only actively-maintained MIT candidate (commits through 2026-08-04, 26/30 recent issues closed, 60.7k dl/wk); marks architecture matches the market (Tiptap Pro Tracked Changes is marks-based too) and the evidence; zero runtime deps; peers satisfied by the pinned PM set. Rejected: `davefowler/prosemirror-suggestion-mode` (dormant 17.5 months; its text-anchored `applySuggestion` locate-by-search is *weaker* than our specced anchor ladder — adopting it would discard edit-anchors §3; its AI-feature requests open since Nov 2025); Tiptap Pro Tracked Changes (paid, proprietary, self-declared Alpha — collides with the free/OSS posture); hand-rolling (solved problem class). Per-span extra attrs = tool-call id (confirmed from both surviving candidates' designs — marks extra attrs and Tiptap's `reason` field). npm-gap posture: pin exact 0.1.8; HEAD-only fixes (incl. crash-class #34, #41/#42) → vendor the module, never a git dep (D8 symmetry). |
| D11 | **Two-path prose-diff renderer: DMP word-mode for text-vs-text previews; changeset + `simplifyChanges` for in-editor post-Apply review; zero new dependencies** | Delegated. Both mechanisms ride existing pins (DMP lazy §2/D5; changeset, §2). Rejected: new diff libraries (the DMP wiki recipe + changeset cover both paths); `diff-match-patch-line-and-word` wrapper (dormant 5 years; recipe ~15 lines). Spec: §14 (seam, tokenization, once-per-turn rule, decoration pattern, rules table, fixtures). |
| D12 | **Apply-then-review integration contract (§15): suggestions land as marks via the suggest-changes decorator; accept/reject are user bus mutations; stored bodies always hold the all-accepted projection (marks are session-ephemeral; no `ins`/`del` in stored Markdown); unresolved-at-session-end = auto-accept with a named notice + checkpoint pointer** | Delegated. **Save-path half verified against the library source (§15):** the library has no serialize path — naive serialization emits all-*pending* text (deletion-marked content still in doc), so the all-accepted projection is **Caotang-computed** (apply-all transforms on a cloned doc) before serialization; the no-`ins`/`del` guarantee holds mechanically (unknown marks dropped silently); composition with `addToHistory: false` confirmed at source level (meta copied verbatim). Rationale: keeps the on-disk file a pure Markdown projection (ownable-files principle, project-format §3); keeps autosave unblocked mid-review (a save-blocking rule would fight the autosave durability posture and surprise writers); the activity-log checkpoint remains the coarse reversal, per-span reject the fine one. Rejected: HTML `ins`/`del` serialization into stored files (contaminates the projection dialect, §5); blocking autosave during pending review (durable-safety invariant wins over review-state preservation); a separate `suggestion.*` bus command class (normal `doc.write` covers accept/reject — no new command surface, bus registry stays closed); setting `addToHistory: false` on accept/reject (they are user-visible edits and must be editor-undoable). |
| D4 | `prosemirror-recreate-transform` stays copy-if-needed, never pinned | Confirmed: no first-party npm package; only stale third-party ports (2020–2022, predating current PM APIs). `findDiffStart`/`findDiffEnd` covers the single-range snapshot-diff case. |

## 14. Prose-diff rendering

> Evidence: Two renderer paths behind one rendering seam, split by **whether ProseMirror steps exist**: previews (ghost, plan cards — text-vs-text, no steps) vs in-editor review (post-Apply — steps exist). Both ride existing pins; **zero new dependencies**. Consumed by [agent-harness.md](agent-harness.md) §8 (ghost/plan cards) and the v0.2 apply-then-review mode.

### 14.1 The seam

```ts
interface ProseDiffChunk { op: 'equal' | 'insert' | 'delete' | 'modified'; text: string; }

interface ProseDiffRenderer {
  /** Path A — text-vs-text previews (ghost card, plan-card diff blocks). */
  diffTexts(oldText: string, newText: string): ProseDiffChunk[];      // DMP word-mode (§14.2); sync, pure
  /** Path B — in-editor post-Apply review over a completed turn's steps. */
  turnChangeset(steps: Step[], oldDoc: PM.Doc, newDoc: PM.Doc): Change[];  // changeset built ONCE (§14.3)
  renderChangeset(changes: Change[], doc: PM.Doc): DecorationSet;      // §14.4 decoration pattern
}
```

Implementation is a Caotang-owned module (~100 lines total; both mechanisms come from pinned libraries). Selection rules for callers: no steps available → Path A; steps + in-editor decoration target → Path B; plan-card "modified" rows for mark/attr-only edits → card metadata, never inline decorations (§14.5 rule e).

### 14.2 Path A — DMP word mode (ghost preview + plan-card previews)

- Mechanism: `diff-match-patch` (already pinned, lazy ~30 KB — §2/D5) with the canonical word-mode recipe ([DMP wiki "Line or Word Diffs"](https://github.com/google/diff-match-patch/wiki/Line-or-Word-Diffs)): clone `diff_linesToChars` into `diff_linesToWords` (token boundary = **runs of whitespace** instead of `indexOf('\n')`), tokenize both texts into one-codepoint-per-token compact forms, `diff_main(compactOld, compactNew)`, re-inflate via `diff_charsToLines` (works unchanged for word mode), then **`diff_cleanupSemantic` always** — it snaps noisy character-level boundaries to word boundaries and merges adjacent chunks. The `diff-match-patch-line-and-word` wrapper package exists but is **rejected** (5-year-old publish, dormant; the recipe is ~15 lines over the pinned module).
- Output maps 1:1 onto `ProseDiffChunk` (`-1→delete`, `0→equal`, `1→insert`). Rendering: deletions strike-through, insertions highlighted, equals plain — ordinary inline flow inside the ghost card / plan-card diff block; **wrapping is CSS, not a diff concern** (long lines wrap naturally; no renderer-side logic).
- Why word mode, not character mode: character-mode DMP on prose produces noisy mid-word boundaries; word tokenization + `cleanupSemantic` snaps edit boundaries to words.
- Dependency discipline: DMP stays **lazy** (dynamic import at the renderer module edge — same edge as edit-anchors step 4, so one lazy chunk serves both consumers). Ghost/plan-card rendering is not on the editor mount path.

### 14.3 Path B — changeset over a completed turn (in-editor review, v0.2)

- Build `prosemirror-changeset` (pinned exact 2.4.4, per §2) `addSteps` over the **full step list of one completed agent turn**, then `simplifyChanges(changes, newDoc)` — the changeset-native word-boundary expansion ("having both insertions and deletions within a word is confusing… expand to cover the entire set of words they touch"; single-character replacement exception is documented and desired).
- **Build once per completed turn, never incrementally during streaming** — the changeset README documents that incremental `addSteps` simplification is not deterministic across build order. This is the same atomicity posture as the status cards (no partial results rendered; §8).
- Per-span `data` = **tool-call id** (the changeset `data` field on `Change` spans; same slot the marks carry — grouping accept/reject or review highlights per tool call).
- Deletion spans reference the **old doc**; the deleted text is *rendered from the span*, never stored in the doc.
- Known blind spot (documented, accepted for v0.2): changeset tracks **neither mark changes nor attribute changes** ([forum #7677](https://discuss.prosemirror.net/t/prosemirror-changeset-how-to-also-see-the-changes-in-marks-and-attrs/7677)) — mark/attr-only edits are invisible to it. Caotang's prose tools move text, so this is rare; if ever needed, recreate-transform's step-synthesis between two docs is the documented escalation (§13 D4: copy-if-needed, never pinned).

### 14.4 Decoration rendering (Path B display)

The documented ProseMirror pattern ([forum #1628](https://discuss.prosemirror.net/t/a-proposed-way-to-visualize-a-changeset/1628), working plugin code in [#3801](https://discuss.prosemirror.net/t/question-about-track-changes-with-prosemirror-changeset/3801)):

- **Insertions** → inline decorations (span styling) over the inserted ranges in the new doc.
- **Deletions** → **widget decorations** carrying the deleted slice, styled strike-through, `side: -1` (rendered before the position). Deleted text never enters the doc.
- Span `data` extraction per `ReplaceStep` via `textBetween` (the #3801 public plugin is the implementation reference).
- This is the lighter *display* path; **interactive** accept/reject-in-editor is the marks layer (suggest-changes, §2) — `revertSuggestion(id)` gives the per-span reject the ghost Apply loop (v0.1) doesn't offer. Display via changeset; interaction via marks; they are not competitors.

### 14.5 Rules (fixture-tested at the v0.2 milestone)

| # | Rule |
|---|------|
| a | Path selection: no steps → Path A; steps + in-editor target → Path B. |
| b | Changeset built **once per completed turn** from the full step list — never incrementally (build-order nondeterminism). |
| c | Path A always runs `diff_cleanupSemantic`; deletion rendering (both paths) via widget decorations from old-doc spans / DMP delete chunks — deleted text never enters the doc. |
| d | CSS-only wrapping; no renderer-side line logic. |
| e | Mark/attr-only edits render as "modified" rows in the plan card (card metadata), **not** inline decorations (changeset blind spot #7677). |
| f | Single contiguous range case (ghost-region pre-Apply diff is typically exactly this): `findDiffStart`/`findDiffEnd` (prosemirror-model, already pinned via `@tiptap/pm`) suffices instead of a full changeset. |

### 14.6 Evals/fixtures (v0.2 milestone)

Ghost preview renders a 3-paragraph rewrite as word-granular chunks with `cleanupSemantic` boundaries (no mid-word splits); plan-card diff block matches the post-Apply changeset rendering for the same edit; once-per-turn changeset determinism (two build orders → identical `Change[]`); widget-decoration deletion rendering leaves the doc text unchanged (serialize round-trip unaffected); single-character replacement stays unexpanded (simplifyChanges exception).

## 15. Apply-then-review mode (specified, not built — the gap §14's display path leaves open)

> Library decided: `@handlewithcare/prosemirror-suggest-changes` exact 0.1.8. This section spells the Caotang-side integration an implementer needs; the save-path question was **verified against the library's 0.1.8 source**; the verification fixtures are below.

**Mode surface:** a per-project editor preference (`editor.agentEditMode: 'ghost' | 'suggestions'`, default `'ghost'` — the loop stays the default; ui-modules §5 settings row, v0.2). It changes only **how an approved agent text edit lands in the editor**, never which tools run or which permissions apply.

**Entry path (`'suggestions'`):** when a confirm-class text edit is approved (ghost Apply equivalent), the harness applies the same resolved range/content through the bus, but the editor-side transaction runs with suggest-mode active (`prosemirror-suggest-changes`'s `dispatchTransaction` decorator): inserted text lands under `insertion` marks, replaced text keeps the old content under `deletion` marks. Mark extra attrs: `{ toolCallId: string }` — review UI groups accept/reject per tool call (both surviving candidates confirmed this slot).

**Review loop:** the turn's status card (agent-harness §8 lifecycle) ends in state `done` with a sub-banner "N suggestions pending review"; the editor renders suggestion decorations per the library's plugin + §14.4 display conventions. **Accept** = `applySuggestion(id)` per span or `applySuggestionsInRange` per tool call, then the same transaction pattern as any user keystroke batch — one bus `doc.write` per resolved review action (so autosave, revisions, `sessions.jsonl` appends all behave normally), no separate command type. **Reject** = `revertSuggestion(id)` — restores deleted content / removes inserted content, again through a normal `doc.write`. Accept/reject actions are **user-issued bus mutations**, one undo group per action — the checkpoint "restore to before this turn" from the original agent turn remains the coarse reversal affordance; per-span reject is the fine one.

**Save-path resolution (verified against the 0.1.8 library source):** the on-disk body always stores the **all-accepted projection** — insertion content as plain text, deletion content removed. Source-verified mechanics: **the library has no serialize path at all** — suggestion marks are ProseMirror doc state, and the doc→mdast boundary is remark-prosemirror, whose handler table silently drops marks it doesn't map. Exact consequences: (1) serializing the *live marked doc* emits the **all-pending projection** — insertion content present, deletion-marked content **also present** (it is still in the doc — content is never removed until a resolution command runs), with **zero mark syntax** (`ins`/`del` never appears — the guarantee holds *mechanically*, not by convention); (2) the all-accepted projection is therefore **Caotang-computed before serialization**: at save time, run the same transforms the library's `applySuggestions` command runs internally (`applySuggestionsToTransform` + `applyModificationsToTransform`) **on a cloned doc**, serialize the clone — no fork, no vendoring needed for this; (3) the naive failure mode is named and fixture-locked: `serialize(liveDoc)` mid-review would persist all-*pending* text — forbidden. `ins`/`del` HTML never enters stored Markdown (ownable-file purity, project-format §3); autosave is never blocked by a pending review. If the session ends with suggestions unresolved, reload shows the all-accepted text and surfaces a one-time notice: "N suggestions from the last agent turn were kept as written on reload — 'restore to before this turn' is available in the activity log." Never a silent resolution: the notice names the auto-accept and points at the existing checkpoint affordance.

**History composition (assumption A1 below):** `withSuggestChanges` copies the incoming transaction's metadata verbatim into the tracked transaction (source: `trackedTransaction.meta = originalTransaction.meta`, with an explicit preserve-original-meta comment) and maps selection/`scrolledIntoView`/`storedMarks` through the step mapping — since `prosemirror-history` reads `addToHistory: false` from transaction meta, **an agent turn batch carrying `addToHistory: false` passes through the decorator intact**: the two-lane undo model (§7) composes with the marks layer unchanged; the "if the decorator fights `addToHistory`" fallback is retired (kept only as a v0.2 preflight re-verification). Corollary: **accept/reject resolution transactions must NOT set `addToHistory: false`** — they are real doc mutations dispatched normally, user-visible and editor-undoable (Lane 1); the original turn's checkpoint snapshot remains the coarse reversal. Resolution commands set library meta `{skip: true}` so the interceptor does not re-track its own resolution.

**Save-path fixture set (v0.2):**
1. `serialize(markedDoc)` = **all-pending** text, zero mark syntax (insertions present, deletion-marked content still present).
2. `serialize(projection(markedDoc))` (Caotang-computed all-accepted clone) = **all-accepted** text, zero mark syntax.
3. Accept-all-then-save and reject-all-then-save each produce byte-identical stored bodies to a marks-free edit of the same content.
4. Unresolved-at-end reload shows the all-accepted text + the named auto-accept notice.

**Assumptions (explicit):** A1 — suggest-mode decoration/transaction interception composes with the two-lane undo model without leaking into Lane 1: confirmed at source level — the decorator copies transaction meta verbatim, so `addToHistory: false` passes through (see History composition above); the fallback path stays retired-in-reserve pending the v0.2 preflight re-verification only. A2 — mark ids survive across an autosave round-trip within one session (they must: marks live in the live PM doc between save points; unchanged). A3 — the per-scene doc scale keeps suggestion-decoration counts trivial (<100 per doc; D9's per-scene split guarantees it by construction). A4 — the library's internal apply transforms (`applySuggestionsToTransform`/`applyModificationsToTransform`) remain reachable without forking (they are command-internal but importable from the module surface; if the 0.1.8 export shape hides them, the equivalent step rewrites on a doc clone are ~40 lines of Caotang-owned code — vendor-path unchanged per D10).
