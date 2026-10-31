/**
 * [editor-engine.md] §10 — the v0.1 Tiptap extension set, aligned to §3's schema.
 *
 * ## Why this is more than an import list
 *
 * §10 names the extensions that mount the editor, and §3 names the schema they
 * have to build. The two do not agree on spelling. `@tiptap/core` builds its
 * schema from whatever extensions it is given (`getSchemaByResolvedExtensions`),
 * and the stock names are `bulletList`, `listItem`, `bold`, `italic`, `codeBlock`,
 * `horizontalRule` and `hardBreak`. Every one of those names is read by the §3.3
 * handler table and by `serialize`, so an editor built from the stock set would
 * hand the save path a document it cannot write. `schema.ts` says the same thing
 * about StarterKit: it is not what builds this schema.
 *
 * So each extension below is renamed to §3's name and given §3's content
 * expression, group, attributes and mark rank. `test/tiptap-schema.test.ts`
 * compares the schema this set builds against `caotangSchema` and fails on the first
 * divergence, in the direction the contract gives: the code is wrong until the
 * spec says otherwise.
 *
 * ## The overrides, and the one divergence that is kept on purpose
 *
 * - **Mark rank.** §3.2's order is `em, strong, strike, code, link` and it is
 *   load-bearing: a text run carrying `em` and `strong` is nested in the order its
 *   marks sort into, so the rank decides whether a save writes `_**x**_` or
 *   `**_x_**`. Tiptap sorts extensions by `priority`, and `Link` defaults higher than
 *   everything else, so `Link` is lowered and the rest keep the order they are listed in.
 * - **`link`** takes §3.2's `href` as *required* (`isRequired`, so no default is
 *   written into the spec) and `title` as optional; Tiptap's own `target`, `rel`
 *   and `class` are rendering attributes this schema does not carry. It is not
 *   inclusive, so typing at the end of a link does not extend it.
 * - **`code`** excludes only itself, which is what ProseMirror does when a mark
 *   names no exclusions, and what §3.2 implies by saying nothing. Tiptap's code mark
 *   excludes every other mark, which would make `**`a`**` lose its strong on load,
 *   and it sets the mark's `code` flag, which §3 does not. The exclusion is written
 *   as `'code'` rather than left `undefined`: an undefined override falls back to
 *   the parent's `'_'` in `@tiptap/core`, which is the failure the parity test caught.
 * - **`image`** is inline with `src` required and only `alt` and `title` as
 *   attributes, where Tiptap defaults to a block with `width` and `height` too.
 * - **`list_item`** takes §3.1's content `block+` and its `listitem` group, where
 *   Tiptap requires a leading paragraph. Not defining, as §3.1 does not say so.
 * - **`ordered_list`** carries `start` only, not Tiptap's `type`.
 * - **The one kept divergence: the list group.** §3.1 says `block`. The live lists
 *   are `block list`, because `isList` in `@tiptap/core` decides whether a node is a
 *   list by looking for the group name `list`, and the toggle-list commands depend
 *   on that. The group is a superset that still contains `block`, so every content
 *   expression that says `block` still matches a list, and the parity test asserts
 *   membership rather than the string. The divergence is named where it is asserted.
 *
 * ## What is not in the schema, and why it is not a gap
 *
 * The interactive extensions — history, the list keymap, drop and gap cursors and
 * the placeholder — contribute behaviour and no node or mark. The read-only ghost
 * preview (§8) takes the same schema without them: it shares the document model,
 * not the keymap, and it has no undo lane for anything to enter.
 *
 * **And the one that is not here at all: the character count.** §10 named
 * "CharacterCount (feeds §9)", and nothing fed §9 from it. §9's counts are
 * computed by the store's `countBody` over the body projection — one rule, with
 * one implementation, which `test/tiptap-adapter.test.ts` pins ("wordCount is
 * the store's count of the body, not a second copy of its rule") and
 * `packages/store`'s own tests pin again.
 *
 * CharacterCount was the **second** rule and a different one: it counts the PM
 * text, so it misses the body projection's blockquote marker that §9's reading
 * counts (`> quoted` → 2 words). Its storage was never read, so the number on
 * screen was `countBody`'s and the plugin's was discarded — while it
 * recomputed both figures over the whole document on every transaction, on the
 * hot path, for a value nobody displayed. §10's parenthetical is the one line
 * of the spec this change leaves to be corrected.
 *
 * Node names in the list are §3.1's. Lane 1's history is `UndoRedo` from
 * `@tiptap/extensions` (extension name `undoRedo`), and its depth and coalescing
 * window are the library defaults, 100 steps and 500 ms, which §7 calls the engine
 * default.
 */
import { Extension } from '@tiptap/core';
import type { Extensions } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import Blockquote from '@tiptap/extension-blockquote';
import Bold from '@tiptap/extension-bold';
import BulletList from '@tiptap/extension-bullet-list';
import Code from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Heading from '@tiptap/extension-heading';
import HorizontalRule from '@tiptap/extension-horizontal-rule';
import Image from '@tiptap/extension-image';
import Italic from '@tiptap/extension-italic';
import Link from '@tiptap/extension-link';
import ListItem from '@tiptap/extension-list-item';
import ListKeymap from '@tiptap/extension-list-keymap';
import OrderedList from '@tiptap/extension-ordered-list';
import Paragraph from '@tiptap/extension-paragraph';
import Strike from '@tiptap/extension-strike';
import Text from '@tiptap/extension-text';
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from '@tiptap/extensions';
import { plainPasteHtml } from './paste.js';
import { DEFAULT_EDITOR_LABELS, type EditorLabels } from './labels.js';
import { EDIT_PICTURE_EVENT, aloneImages, createImageView } from './image-view.js';
import { isAppLocalSource } from './local-source.js';
import type { PictureController } from './pictures.js';
import { CaotangProvenance } from './provenance-plugin.js';
import { slashMenu } from './slash-menu.js';

/** §3.1's list item name. Tiptap's list extensions look it up by option, not by name. */
const LIST_ITEM = 'list_item';

export { isAppLocalSource } from './local-source.js';

/**
 * §10's paste policy (§10 names it as a v0.1 scope item). The transform runs on the HTML
 * before ProseMirror parses it, so no block or image the clipboard carries reaches the
 * schema. Only the focus document pastes, so the ghost does not carry it.
 */
const CaotangPaste = Extension.create({
  name: 'caotangPaste',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('caotangPaste'),
        props: { transformPastedHTML: plainPasteHtml },
      }),
    ];
  },
});

/**
 * Everything a picture needs beyond the node: the files a drop or a paste carries, the slash menu, the mark on an image that is
 * alone in its paragraph, and Enter on a selected picture to open its settings.
 */
const CaotangPictures = (controller: PictureController, labels: EditorLabels): Extension =>
  Extension.create({
    name: 'caotangPictures',
    addProseMirrorPlugins() {
      return [
        ...controller.plugins(),
        aloneImages(),
        slashMenu(controller, labels),
        new Plugin({
          key: new PluginKey('caotangPictureKeys'),
          props: {
            handleKeyDown(view, event) {
              const { selection } = view.state;
              if (event.key !== 'Enter' || !('node' in selection)) return false;
              const picked = (selection as { node: { type: { name: string } } }).node;
              if (picked.type.name !== 'image') return false;
              view.nodeDOM(selection.from)?.dispatchEvent(new Event(EDIT_PICTURE_EVENT));
              return true;
            },
          },
        }),
      ];
    },
  });

/**
 * Which instance the set is for. `focus` is the editable document and carries the
 * interactive extensions; `ghost` is the read-only preview (§8) and carries only
 * what shapes the document.
 */
export type CaotangRole = 'focus' | 'ghost';

export interface CaotangExtensionOptions {
  /** Default `focus`. */
  role?: CaotangRole;
  /** The empty-document hint (§10's Placeholder). Focus only. */
  placeholder?: string;
  /** The editor's own words; the app passes its translated set, and the package's English defaults fill any it leaves out. */
  labels?: Partial<EditorLabels>;
  /**
   * The pictures the editor may show and insert (`createPictureController`). Without it an app-local image is an `<img>` the page
   * resolves itself, and there is no insert path: the headless callers and the ghost take that.
   */
  pictures?: PictureController;
}

/**
 * The §10 set, aligned to §3. Returns a fresh array of fresh extension instances on
 * every call, because two editors must not share one configured instance.
 */
export const caotangExtensions = (options: CaotangExtensionOptions = {}): Extensions => {
  const role: CaotangRole = options.role ?? 'focus';
  const labels: EditorLabels = { ...DEFAULT_EDITOR_LABELS, ...options.labels };
  // The schema-shaping half. Its order is the mark rank: `Italic` precedes `Bold`
  // and `Strike` precedes `Code`, because the list is what the stable priority sort
  // keeps. Changing this order changes which way nested marks save.
  const pictures = options.pictures;
  const shape: Extensions = [
    // The source-provenance map (source-provenance.ts) rides on the document; it is never rendered.
    Document.extend({
      addAttributes() {
        return { provenance: { default: undefined, rendered: false, parseHTML: () => undefined } };
      },
    }),
    Paragraph,
    Text,
    Heading,
    Blockquote,
    BulletList.extend({ name: 'bullet_list', defining: true }).configure({ itemTypeName: LIST_ITEM }),
    OrderedList.extend({
      name: 'ordered_list',
      defining: true,
      addAttributes() {
        return { start: { default: 1 } };
      },
    }).configure({ itemTypeName: LIST_ITEM }),
    ListItem.extend({ name: LIST_ITEM, group: 'listitem', content: 'block+', defining: false }),
    HorizontalRule.extend({ name: 'horizontal_rule' }),
    CodeBlock.extend({ name: 'code_block' }),
    HardBreak.extend({ name: 'hard_break' }),
    Italic.extend({ name: 'em' }),
    Bold.extend({ name: 'strong' }),
    Strike,
    Code.extend({ name: 'code', code: false, excludes: 'code' }),
    Link.extend({
      // Lowered below the default so it ranks after `code`, as §3.2 lists it.
      priority: 50,
      inclusive: false,
      addAttributes() {
        return { href: { isRequired: true }, title: { default: null }, prov: { default: undefined, rendered: false, parseHTML: () => undefined } };
      },
    }).configure({ openOnClick: false, autolink: false, linkOnPaste: false }),
    Image.extend({
      addAttributes() {
        return {
          src: { isRequired: true },
          alt: { default: null },
          title: { default: null },
          prov: { default: undefined, rendered: false, parseHTML: () => undefined },
        };
      },
      // With a picture port the view resolves the bytes, so a picture the project holds shows and one it does not has a placeholder.
      ...(pictures === undefined ? {} : { addNodeView: () => createImageView({ port: pictures.port, labels }) }),
      // Tiptap's default renders `<img src>` for every source, and the browser fetches
      // that source when the view is shown. Only app-local sources become an image here;
      // the rest render as their alt text, which is inert (`isAppLocalSource`).
      renderHTML({ HTMLAttributes }) {
        const src = typeof HTMLAttributes['src'] === 'string' ? HTMLAttributes['src'] : '';
        if (isAppLocalSource(src)) return ['img', HTMLAttributes];
        const alt = typeof HTMLAttributes['alt'] === 'string' ? HTMLAttributes['alt'] : '';
        return ['span', { class: 'caotang-image-placeholder' }, alt.length > 0 ? alt : labels.image];
      },
    }).configure({ inline: true }),
  ];
  if (role === 'ghost') return shape;
  return [
    ...shape,
    CaotangProvenance,
    ListKeymap.configure({
      listTypes: [{ itemName: LIST_ITEM, wrapperNames: ['bullet_list', 'ordered_list'] }],
    }),
    Dropcursor,
    Gapcursor,
    Placeholder.configure({ placeholder: options.placeholder ?? labels.placeholder }),
    UndoRedo,
    CaotangPaste,
    ...(pictures === undefined ? [] : [CaotangPictures(pictures, labels)]),
  ];
};
