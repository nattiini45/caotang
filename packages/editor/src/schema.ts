/**
 * The §3 Caotang ProseMirror schema — **the editor's own schema**, transcribed
 * from [editor-engine.md] §3.1 (nodes) and §3.2 (marks).
 *
 * ## Why this file is a second copy, on purpose
 *
 * `packages/editor-audit/src/schema.ts` is a byte-for-byte transcription of the
 * same two tables, written as the minimum surface the preflight fixture
 * corpus needs in order to run at all. The two are **kept apart deliberately**,
 * and:
 *
 * - **The audit may not import this file.** A gate that imports the code it
 *   gates has no state in which it can report a defect — and the audit's entire
 *   product is a divergence report. §2.1 already refuses that shape for the pin
 *   guard (*"a guard that parsed §2 and compared it to the manifest would only
 *   prove §2 is self-consistent"*).
 * - **This file may not import the audit's.** The dependency runs product ← test
 *   only: `test/schema-parity.test.ts` is the one place both are visible, and it
 *   compares them **behaviourally** (names, attrs, content expressions) and never
 *   by `===`, which a shared object would pass by construction.
 *
 * Two `Schema` instances in one tree is correct, not a compromise. The editor audit
 * has the same shape where it asserts the two `fflate` builds are *different
 * objects*, and the duplication is the maintenance cost that buys the audit the
 * only capability it needs: the ability to report the product wrong.
 *
 * ## Every value here is §3.1/§3.2's, and the guard that says so
 *
 * `test/spec-parity.test.ts` reads the two tables **out of the spec file** and
 * compares them to this schema — names, groups, content expressions and attrs.
 * Three values in that comparison found a divergence on the guard's first run,
 * and all three were resolved in the direction the contract gives ("if code and
 * spec disagree, the code is wrong until proven otherwise"), recorded in
 * docs/decisions.md:
 *
 * 1. **`list_item` declares §3.1's `listitem` group.** Nothing in §3.1/§3.2's
 *    content expressions uses it yet (`bullet_list`/`ordered_list` name the *type*
 *    `list_item`, not the group), so this costs nothing and stops a future
 *    `listitem+` expression from silently matching nothing.
 * 2. **`image.src` and `link.href` carry no default**, because §3.1 and §3.2
 *    mark them *required*. A `default: null` makes an attr optional in
 *    ProseMirror whatever the prose says, so the transcription was not faithful:
 *    with a default, `create()` accepts an image node with no `src` at all.
 * 3. **`paragraph`/`heading` are `inline*` and `code_block` is `text*`**, where
 *    a literal reading of §3.1 would be `inline+` and `text`. Both are measured,
 *    and neither is a preference:
 *    - `code_block: 'text'` is **not a ProseMirror schema at all** — the
 *      constructor throws *"Only non-generatable nodes (text) in a required
 *      position (in content expression 'text')"*. Read literally, §3.1 made
 *      the product unbuildable.
 *    - `inline+` builds, and loads a bare `#` — because `createAndFill` fills
 *      the required slot with an empty **text** node. That filled text node is
 *      what breaks the round trip: measured, `>` came back as `> \` + `>` and a
 *      one-item list came back as `- \`. So `inline+` moves three constructs
 *      that Markdown actually contains out of §3.3's exact class, and the
 *      corpus never saw it because it holds no empty-container entry.
 *    `test/spec-parity.test.ts` re-derives both measurements from the spec
 *    cells, so the correction cannot quietly become the code's own opinion.
 */
import { Schema } from '@tiptap/pm/model';

export const caotangSchema = new Schema({
  nodes: {
    // `block+ footnote_definition*`: the notes are the document's tail and nothing
    // else may follow them, which is GFM's canonical spelling (definitions at the
    // end) held by the schema rather than by the save (#270).
    doc: { content: 'block+ footnote_definition*' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
      defining: true,
    },
    blockquote: { group: 'block', content: 'block+', defining: true },
    // §3.1 names the two list nodes `bullet_list` / `ordered_list`, NOT
    // Tiptap's `bulletList` / `orderedList`. §3.1 is the contract, the §3.3
    // handler table is keyed on these names, and Tiptap's StarterKit is not what
    // builds this schema (that is §10's extension set, and it lands with §4's
    // adapter, not here).
    bullet_list: { group: 'block', content: 'list_item+', defining: true },
    ordered_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { start: { default: 1 } },
      defining: true,
    },
    list_item: { group: 'listitem', content: 'block+' },
    horizontal_rule: { group: 'block' },
    code_block: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      attrs: { language: { default: null } },
    },
    hard_break: { group: 'inline', inline: true, selectable: false },
    image: {
      group: 'inline',
      inline: true,
      draggable: true,
      attrs: {
        // §3.1: `src: string` **(required)**, `alt?`, `title?`. No `default` on
        // `src` is how ProseMirror spells "required" — a default makes the attr
        // optional at runtime however the table is worded.
        src: {},
        alt: { default: null },
        title: { default: null },
      },
    },
    // #270: GFM footnotes. The reference is an inline atom that shows its label; the
    // definition is a block that only the document's tail may hold (see `doc`).
    // `label` is the writer's own spelling (`1`, `note`), required because a
    // footnote without one cannot be written. Numeric labels re-flow to their
    // position (`footnotes.ts`); named ones are kept.
    footnote_reference: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: { label: {} },
    },
    footnote_definition: {
      content: 'block+',
      defining: true,
      isolating: true,
      attrs: { label: {} },
    },
    text: { group: 'inline' },
  },
  marks: {
    em: {},
    strong: {},
    strike: {},
    code: {},
    link: {
      attrs: {
        // §3.2: `href: string` (required), `title?: string`.
        href: {},
        title: { default: null },
      },
      inclusive: false,
    },
  },
});
