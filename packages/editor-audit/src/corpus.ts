/**
 * The §5 / §13 fixture corpus, for the Tiptap preflight.
 *
 * Transcribed from [editor-engine.md] §5's dialect-contract paragraph, which
 * enumerates the groups as: structural, lists, emphasis/inline,
 * links/images, blocks, Caotang-specific — plus the four Obsidian-spacing
 * samples and §13 D2's `%%` / `@` plain-text guarantee.
 *
 * Each entry carries the group it belongs to so §2's result table is grouped
 * the way the spec groups it. `expect` is the spec's *claim* for the
 * construct; the measurement in `trace.ts` is the *fact*, and a claim that
 * disagrees with the fact is a finding, not a test failure to be updated.
 *
 * **What `expect` counts is loss, not spelling.** §3.3's own table puts
 * `heading`, `list`, `emphasis`, `strong`, `link`, `code`, `break` and
 * `thematicBreak` in the exact column, with the note *"content lossless;
 * syntax normalization per §5"*, and it says outright that *"a loss is not a
 * re-spelling, and the two are counted separately"*. So a `*` bullet list, a
 * setext heading and an HTML entity are all **`exact`**: their content
 * survives and only their spelling is normalized, and the spelling is §5's
 * dialect banner's business. An entry is **`degrade`** when the construct
 * itself is degraded — a table, raw HTML, a footnote, a reference, a task
 * item, a nested emphasis inside an emphasis — and **`lost`** when the
 * content is gone.
 */

export interface CorpusEntry {
  name: string;
  group: string;
  input: string;
  /**
   * §3.3's class for the construct, per the spec's table: `exact` when the
   * content survives the round trip (spelling may be normalized), `degrade`
   * when the construct itself is degraded, `lost` when the content is gone.
   */
  expect: 'exact' | 'degrade' | 'lost';
  /** The §5 note this fixture pins, quoted from the spec where it matters. */
  note?: string;
}

/* --- structural (§5: ATX/setext, break variants, thematic breaks) --------- */
export const STRUCTURAL: CorpusEntry[] = [
  { name: 'paragraph', group: 'structural', input: 'A plain paragraph.', expect: 'exact' },
  { name: 'atx-heading-1', group: 'structural', input: '# Title', expect: 'exact' },
  { name: 'atx-heading-3', group: 'structural', input: '### Third level', expect: 'exact' },
  { name: 'setext-heading', group: 'structural', input: 'Setext\n======', expect: 'exact',
    note: 'setext parses to heading depth 1; serialize is canonical ATX — a re-spelling (§5), not a loss' },
  { name: 'thematic-break-stars', group: 'structural', input: '***', expect: 'exact',
    note: '§3.1 horizontal_rule — the scene separator' },
  { name: 'thematic-break-dashes', group: 'structural', input: '---', expect: 'exact',
    note: 'canonical rule is `***` (§5 stringify `rule` option) — a re-spelling, not a loss' },
  { name: 'hard-break-two-space', group: 'structural', input: 'line one  \nline two', expect: 'exact' },
  { name: 'hard-break-backslash', group: 'structural', input: 'line one\\\nline two', expect: 'exact',
    note: '§3.3 break: line-break style normalized (two-space) — a re-spelling, not a loss' },
  { name: 'blockquote', group: 'structural', input: '> quoted', expect: 'exact' },
  { name: 'blockquote-nested', group: 'structural', input: '> outer\n> > inner', expect: 'exact' },
  { name: 'blockquote-lazy', group: 'structural', input: '> first\ncontinued lazily', expect: 'exact',
    note: 'lazy continuation is not a distinct mdast construct — the text is kept, so a re-spelling, not a loss' },
];

/* --- lists (§5: markers ×3, ordered . / ), tight/loose, task, 3-level) --- */
export const LISTS: CorpusEntry[] = [
  { name: 'bullet-dash', group: 'lists', input: '- one\n- two', expect: 'exact',
    note: 'canonical bullet per §5 `bullet: "-"`' },
  { name: 'bullet-star', group: 'lists', input: '* one\n* two', expect: 'exact',
    note: 'marker normalized to `-` — a re-spelling (§5), not a loss' },
  { name: 'bullet-plus', group: 'lists', input: '+ one\n+ two', expect: 'exact',
    note: 'marker normalized to `-` — a re-spelling (§5), not a loss' },
  { name: 'ordered-dot', group: 'lists', input: '1. one\n2. two', expect: 'exact' },
  { name: 'ordered-paren', group: 'lists', input: '1) one\n2) two', expect: 'exact',
    note: 'delimiter normalized to `.` — a re-spelling (§5), not a loss' },
  { name: 'ordered-start-3', group: 'lists', input: '3. three\n4. four', expect: 'exact',
    note: '§3.1 ordered_list `start?: number`' },
  { name: 'list-loose', group: 'lists', input: '- one\n\n- two', expect: 'exact' },
  { name: 'list-nested-3-level', group: 'lists',
    input: '- level one\n  - level two\n    - level three', expect: 'exact',
    note: '§5 `listItemIndent: "one"`' },
  { name: 'list-tab-indented', group: 'lists', input: '- one\n\t- nested', expect: 'exact',
    note: 'tab indentation is not canonical; §5 rejects `listItemIndent: "tab"` — a re-spelling, not a loss' },
  { name: 'list-task-item', group: 'lists', input: '- [ ] undone\n- [x] done', expect: 'degrade',
    note: '§3.3: task lists are NOT in the v0.1 schema' },
];

/* --- emphasis / inline (§5: star/underscore, intraword, nesting, strike, backticks) --- */
export const INLINE: CorpusEntry[] = [
  { name: 'emphasis-underscore', group: 'inline', input: '_emphasized_', expect: 'exact',
    note: 'canonical per §5 `emphasis: "_"`' },
  { name: 'emphasis-star', group: 'inline', input: '*emphasized*', expect: 'exact',
    note: 'normalized to `_` — a re-spelling (§5), not a loss' },
  { name: 'strong-double-star', group: 'inline', input: '**strong**', expect: 'exact',
    note: '§5 `strong: "*"` is a single asterisk — this is a real spec question; the content is exact (§3.3)' },
  { name: 'intraword-underscore', group: 'inline', input: 'Kara_thal', expect: 'exact',
    note: '§5: intraword `_` safety — a character name must not become em' },
  { name: 'nested-emphasis', group: 'inline', input: '_outer **inner** outer_', expect: 'exact' },
  { name: 'strike-in-emphasis', group: 'inline', input: '_gone and _struck_ together_', expect: 'degrade' },
  { name: 'strike-gfm', group: 'inline', input: '~~struck~~', expect: 'exact',
    note: '§3.3 `delete` → `strike`, needs remark-gfm' },
  { name: 'inline-code', group: 'inline', input: '`code`', expect: 'exact',
    note: '§3.2 `code` is a MARK for inline code' },
  { name: 'backtick-run-double', group: 'inline', input: '`` a ` b ``', expect: 'exact' },
  { name: 'escape-bracket', group: 'inline', input: 'not \\[a link\\]', expect: 'exact' },
  { name: 'entity', group: 'inline', input: '&amp; stays literal', expect: 'exact',
    note: 'remark applies no smart-punct transforms by default (§5) — the entity is decoded, which is a re-spelling, not a loss' },
];

/* --- links / images (§5 incl. the image-in-link composite) --------------- */
export const LINKS: CorpusEntry[] = [
  { name: 'link-inline', group: 'links', input: '[text](https://example.com)', expect: 'exact' },
  { name: 'link-title', group: 'links', input: '[text](https://example.com "Title")', expect: 'exact',
    note: '§3.2 link `title?: string`' },
  { name: 'link-angle-url', group: 'links', input: '[text](<https://example.com/a b>)', expect: 'exact',
    note: 'the angle-bracket URL survives the round trip — a re-spelling, not a loss' },
  { name: 'link-autolink', group: 'links', input: '<https://example.com>', expect: 'exact',
    note: 'GFM autolink — the link survives, so a re-spelling, not a loss' },
  { name: 'link-bare-url', group: 'links', input: 'https://example.com', expect: 'exact',
    note: 'GFM autolink literal — the link survives, so a re-spelling, not a loss' },
  { name: 'link-reference', group: 'links',
    input: '[text][ref]\n\n[ref]: https://example.com', expect: 'degrade',
    note: '§3.3: expanded to a direct link, warning lossy-attribute' },
  { name: 'image-basic', group: 'links', input: '![alt](img.png)', expect: 'exact',
    note: '§3.1 image, parse+serialize only — no insert UI in v0.1' },
  { name: 'image-title', group: 'links', input: '![alt](img.png "Title")', expect: 'exact' },
  { name: 'image-in-link', group: 'links', input: '[![alt](img.png)](https://example.com)', expect: 'exact',
    note: '§5 names this composite explicitly' },
  { name: 'image-reference', group: 'links',
    input: '![alt][ref]\n\n[ref]: img.png', expect: 'degrade',
    note: '§3.3: expanded to a direct image' },
];

/* --- blocks (§5: fenced/indented code, long fence, tables, raw HTML) ------ */
export const BLOCKS: CorpusEntry[] = [
  { name: 'code-fenced', group: 'blocks', input: '```js\nconst a = 1;\n```', expect: 'exact',
    note: '§3.1 code_block `language?: string`' },
  { name: 'code-fence-no-lang', group: 'blocks', input: '```\nplain\n```', expect: 'exact' },
  { name: 'code-fence-longer-than-content', group: 'blocks', input: '````\n```\n````', expect: 'exact',
    note: 'canonical fence is three backticks (§5) — a re-spelling, not a loss' },
  { name: 'code-indented', group: 'blocks', input: '    indented code', expect: 'exact',
    note: 'indented code is not a fenced construct — the code survives, so a re-spelling, not a loss' },
  { name: 'table-gfm', group: 'blocks',
    input: '| a | b |\n| --- | --- |\n| 1 | 2 |', expect: 'degrade',
    note: '§3.3: tables degrade, each row one paragraph line, warning lossy-structure' },
  { name: 'html-raw-block', group: 'blocks', input: '<div>raw</div>', expect: 'degrade',
    note: '§3.3: rendered as literal text paragraph, warning unsupported-node' },
  { name: 'html-raw-inline', group: 'blocks', input: 'text with <span>html</span> inside', expect: 'degrade' },
  { name: 'footnote-reference', group: 'blocks',
    input: 'Text[^1]\n\n[^1]: The note.', expect: 'degrade',
    note: '§3.3: footnotes degrade' },
];

/* --- Caotang-specific (§5 dialect contract + §13 D2) ------------------------ */
export const CAOTANG: CorpusEntry[] = [
  { name: 'scene-separator', group: 'caotang', input: 'Before.\n\n***\n\nAfter.', expect: 'exact',
    note: 'the `***` scene separator must survive a load/save cycle' },
  { name: 'percent-comment-line', group: 'caotang', input: '%% a synopsis comment', expect: 'exact',
    note: '§13 D2: `%%` is plain text in v0.1 — byte-identical is the whole point' },
  { name: 'at-mention', group: 'caotang', input: 'Ask @Kara about it.', expect: 'exact',
    note: '§13 D2: `@` mentions are plain text in v0.1' },
  { name: 'no-smart-punct', group: 'caotang', input: '"quoted" -- dash ... ellipsis', expect: 'exact',
    note: '§5: remark applies no smart-punct transforms by default' },
  { name: 'front-matter-strip', group: 'caotang',
    input: 'The body.', expect: 'exact',
    note: '§5 step 1 strips YAML front matter BEFORE the pipeline, and @caotang/store owns that — so the corpus takes the body projection only. Recorded separately: feeding raw front matter straight into remark-prosemirror does NOT strip it (see `FRONT_MATTER_NOT_STRIPPED`).' },
];

/* --- Obsidian spacing samples ------------------------------------------- */
export const OBSIDIAN_SPACING: CorpusEntry[] = [
  { name: 'obsidian-4space-nested', group: 'obsidian',
    input: '- one\n    - nested four-space', expect: 'exact',
    note: 'Obsidian 4-space imports normalize behind the re-style notice — a re-spelling, not a loss' },
  { name: 'obsidian-loose-list', group: 'obsidian',
    input: '- one\n\n  paragraph in item', expect: 'exact' },
  { name: 'obsidian-blank-line-list', group: 'obsidian',
    input: '- one\n\n- two', expect: 'exact' },
  { name: 'obsidian-heading-spacing', group: 'obsidian',
    input: '#Title\n\nno space after hash', expect: 'exact',
    note: 'Obsidian spacing sample — the paragraph survives, so a re-spelling, not a loss' },
];

export const CORPUS: CorpusEntry[] = [
  ...STRUCTURAL,
  ...LISTS,
  ...INLINE,
  ...LINKS,
  ...BLOCKS,
  ...CAOTANG,
  ...OBSIDIAN_SPACING,
];

/**
 * §2's **named findings**, as data the suite asserts on.
 *
 * Each is a place where 0.1.5's real behaviour differs from what
 * [editor-engine.md] writes, measured 2026-10-01. They are exported rather
 * than left in prose so that a change which fixes one of them fails exactly
 * the assertion that recorded it — the shape used for the `fflate` hazard. A finding recorded only in a markdown table is a claim.
 */
import { CANONICAL_STRINGIFY_OPTIONS } from './handlers.js';

export const FINDINGS = {
  /**
   * §5 writes the stringify options as `{ rule: '***', fence: '```' }`.
   * `mdast-util-to-markdown` accepts a single *character* for each and
   * expands it to the three-character form itself, so passing the output
   * spelling throws on the first thematic break or fenced code block in a
   * document. Measured: `rule: '*'` → `***`, `fence: '`'` → ` ``` ` — the
   * spec's intent, reachable with one character instead of three.
   */
  stringifyOptionsAreOutputSpellings: {
    spec: "{ rule: '***', fence: '```' }",
    reality: "single character required; '***' and '```' throw",
    used: CANONICAL_STRINGIFY_OPTIONS,
  },

  /**
   * §5 step 2 names only `remarkStringify` on the save chain. GFM's
   * `delete` node is emitted by `fromPmMark('delete')` for §3.2's `strike`
   * mark, and remark-stringify throws `Cannot handle unknown node `delete``
   * unless `remark-gfm` is on the chain too — gfm registers the *serializer*,
   * and having it on the parse chain does not help.
   */
  gfmRequiredOnSerializeChain: {
    spec: 'unified().use(remarkStringify, { … })',
    reality: 'remark-gfm must also be on the save chain or `strike` throws',
  },

  /**
   * §3.3's last row: "anything unknown → degrade, literal text fallback;
   * warning `unsupported-node`". The library's `unknown` fallback **throws**
   * (`unknown markdown node: <type>`), so a degrade handler is not optional
   * for any type the corpus does not register — it is the only thing standing
   * between a GFM table and a failed load.
   */
  unknownTypesThrowNotDegrade: {
    spec: 'degrade, literal text fallback',
    reality: 'throws `unknown markdown node: <type>`',
    observed: ['table', 'footnoteReference', 'imageReference'],
  },

  /**
   * Block-level raw HTML: the library's default handler parses the value with
   * `hast-util-from-html` and, finding no handler, returns a bare **text**
   * node. §3.1's `doc` is `block+`, so the text node is invalid content and
   * `createAndFill` throws `Invalid content for node doc`. §3.3 wants a
   * literal text *paragraph* — which is exactly what is missing.
   */
  blockHtmlProducesInvalidText: {
    spec: 'literal text paragraph',
    reality: 'throws `Invalid content for node doc` — the default emits inline text where block+ is required',
  },

  /**
   * `inlineCode` and `code` are the two mdast types that carry `value` rather
   * than `children`, and all four exported factories assume `children`.
   * Measured consequence: `fromPmMark('inlineCode')` emits
   * `{type:'inlineCode', children:[…]}`, remark-stringify reads the absent
   * `node.value`, and `` `code` `` serializes to `` `` `` — the content is
   * silently lost with no error. Both leaves are hand-written in handlers.ts.
   */
  valueCarryingLeavesNeedHandWrittenHandlers: {
    spec: 'toPmNode / toPmMark / fromPmNode / fromPmMark cover the table',
    reality: 'inlineCode and code carry `value`; the factories emit `children` and the content is lost silently',
  },

  /**
   * §5 says front matter is stripped before the pipeline. True, and the
   * consequence is worth stating: fed raw front matter, the pipeline does NOT
   * strip it — `---` becomes a thematic break and `title: X` becomes a setext
   * heading. The `yaml: ignore` entry in the library only covers an mdast
   * `yaml` node, which remark-parse never produces without a front-matter
   * plugin. @caotang/store's strip is load-bearing, not belt-and-braces.
   */
  frontMatterStripIsLoadBearing: {
    spec: '§5 step 1 strips YAML front matter before parse',
    reality: 'the pipeline does not strip it; `---\\ntitle: X\\n---` becomes `***\\n\\n## title: X`',
  },
} as const;
