/**
 * The body as a small block model — the mdast stage the renderers share.
 *
 * [exporter.md §3a](../../../docs/architecture/exporter.md) builds the EPUB chapters
 * "from the mdast stage (remark mdast → XHTML … same AST the MD renderer consumes)",
 * and the DOCX and TXT renderers need the same structure. So the body is parsed once
 * with the parser the editor already pins (`unified` + `remark-parse`, CommonMark),
 * and this module reduces that tree to the handful of constructs a manuscript uses:
 * paragraphs, headings, thematic breaks, quotes, lists, code, and inline emphasis,
 * strong, code and links. Everything else keeps its text and loses its markup.
 *
 * GFM footnotes (editor-engine §3.4) are a construct of their own, not prose markup:
 * a `[^1]` marker parses to a `footnoteReference` node and becomes a run that carries
 * the note's identifier (`Run.noteId`), and each `[^1]: …` definition parses to a
 * `footnoteDefinition` whose blocks are collected beside the body's — `ParsedProse.notes`
 * — for the renderer to place where its format keeps notes. A marker nothing defines
 * is not a footnote in GFM, so it stays the text `[^1]`; a definition nothing marks is
 * not reachable as a note either, so it is written as the `[^1]: …` text it is, as it
 * was before footnotes were rendered. The parse is the same `remark-gfm` pin the
 * editor's loader uses, so an export reads a marker exactly as the editor wrote it.
 *
 * ## Two rules a renderer can rely on
 *
 * - **Raw HTML is text.** An `html` node becomes a run of literal text, so a
 *   manuscript that contains `<script>` is shown as that text and never as markup.
 * - **Only web and mail links survive.** A `javascript:` or relative target is
 *   dropped to its text, because a book is not a web page and an EPUB reader will
 *   not follow a relative link into a file that is not in the package.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Content, PhrasingContent, Root } from 'mdast';
import { placementCaptionOf } from '@caotang/pictures';

/**
 * A picture placed in the body, as the Markdown spelling carries it (pictures.md §3): the
 * destination as written, the alt slot and the title slot. The title slot may hold the
 * versioned placement suffix of pictures.md §2.2.1, which `decodePlacementTitle` reads.
 */
export interface ImageRef {
  readonly url: string;
  readonly alt: string;
  readonly title: string | null;
}

/** One run of text with the inline marks that apply to it. */
export interface Run {
  readonly text: string;
  readonly em?: boolean;
  readonly strong?: boolean;
  readonly code?: boolean;
  readonly href?: string;
  /** A hard line break; `text` is empty when this is set. */
  readonly br?: boolean;
  /** Set on the run an inline `image` node becomes; `blocksOf` lifts it out as a `figure` block. */
  readonly image?: ImageRef;
  /**
   * Set on the run a footnote marker (`[^1]`) becomes: the identifier of the note in `ParsedProse.notes`, which the
   * renderer replaces with its own marker (a `w:footnoteReference`, an `epub:type="noteref"` link, a `[1]`). A marker
   * whose note the body does not define stays literal text, so this is set only where a note exists.
   */
  readonly noteId?: string;
}

export type ProseBlock =
  | { readonly kind: 'paragraph'; readonly runs: readonly Run[] }
  | { readonly kind: 'heading'; readonly depth: number; readonly runs: readonly Run[] }
  | { readonly kind: 'break' }
  | { readonly kind: 'quote'; readonly blocks: readonly ProseBlock[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly ProseBlock[])[] }
  | { readonly kind: 'code'; readonly text: string }
  // A picture of its own block: the paragraph held only the image, or the image sat inside a
  // sentence and is exported as a block figure (pictures.md §3).
  | { readonly kind: 'figure'; readonly image: ImageRef };

/**
 * A body's blocks beside its footnotes: `notes` maps a definition's identifier — the GFM-normalized label, which is
 * also what `Run.noteId` carries — to the blocks the note is written as. Only the definitions a marker names are here;
 * one nothing references was already written back into `blocks` as the text it is.
 */
export interface ParsedProse {
  readonly blocks: readonly ProseBlock[];
  readonly notes: ReadonlyMap<string, readonly ProseBlock[]>;
}

/**
 * Parses one body (CommonMark + the GFM constructs the editor stores — front matter is the store's, already stripped)
 * into prose blocks and the body's footnotes.
 */
export function parseProse(body: string): ParsedProse {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as Root;
  const definitions = definitionsOf(tree);
  const referenced = referencedNotesOf(tree);
  const notes = new Map<string, readonly ProseBlock[]>();
  const blocks = blocksOf(tree.children, definitions, referenced, notes);
  return { blocks, notes };
}

/** The identifiers every `footnoteReference` in the tree marks, so the definitions they name are collected as notes. */
function referencedNotesOf(tree: Root): ReadonlySet<string> {
  const found = new Set<string>();
  const walk = (nodes: readonly Content[]): void => {
    for (const node of nodes) {
      if (node.type === 'footnoteReference') {
        found.add((node as { identifier: string }).identifier);
      } else if (node.type === 'footnoteDefinition') {
        // A marker inside a note is still a marker: its note is collected and placed with the others.
        walk((node as { children: Content[] }).children);
      } else if ('children' in node) {
        walk(node.children as readonly Content[]);
      }
    }
  };
  walk(tree.children);
  return found;
}

/** The reference definitions of a body by identifier: a reference-style picture takes its destination and title from one. */
type Definitions = ReadonlyMap<string, { readonly url: string; readonly title: string | null }>;

function definitionsOf(tree: Root): Definitions {
  const found = new Map<string, { url: string; title: string | null }>();
  const walk = (nodes: readonly Content[]): void => {
    for (const node of nodes) {
      if (node.type === 'definition') {
        // The first definition of a label wins, as CommonMark says.
        if (!found.has(node.identifier)) found.set(node.identifier, { url: node.url, title: node.title ?? null });
      } else if ('children' in node) {
        walk(node.children as readonly Content[]);
      }
    }
  };
  walk(tree.children);
  return found;
}

function blocksOf(
  nodes: readonly Content[],
  definitions: Definitions,
  referenced: ReadonlySet<string>,
  notes: Map<string, readonly ProseBlock[]>,
): ProseBlock[] {
  const out: ProseBlock[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        out.push(...paragraphBlocks(runsOf(node.children, {}, definitions, referenced)));
        break;
      case 'heading':
        out.push({ kind: 'heading', depth: node.depth, runs: runsOf(node.children, {}, definitions, referenced) });
        break;
      case 'thematicBreak':
        out.push({ kind: 'break' });
        break;
      case 'blockquote':
        out.push({ kind: 'quote', blocks: blocksOf(node.children, definitions, referenced, notes) });
        break;
      case 'list':
        out.push({
          kind: 'list',
          ordered: node.ordered === true,
          items: node.children.map((item) => blocksOf(item.children, definitions, referenced, notes)),
        });
        break;
      case 'code':
        out.push({ kind: 'code', text: node.value });
        break;
      case 'html':
        out.push({ kind: 'paragraph', runs: [{ text: node.value }] });
        break;
      case 'footnoteDefinition': {
        const definition = node as { identifier: string; label?: string | null; children: Content[] };
        if (referenced.has(definition.identifier)) {
          notes.set(definition.identifier, blocksOf(definition.children, definitions, referenced, notes));
        } else {
          // A definition nothing marks cannot be a note — no marker links to it — so it is written as the
          // `[^1]: …` text it is, the same shape the model gave before footnotes rendered.
          out.push({ kind: 'paragraph', runs: [{ text: unmarkedNoteText(definition) }] });
        }
        break;
      }
      case 'definition':
        // A footnote's note written on one word (`[^1]: Marta.`) is a link definition to the CommonMark parse, as it
        // was before the GFM plugin could see it: kept as the text it is so the word is not dropped. Other
        // definitions carry no prose.
        if (isFootnoteLabel(node.label)) out.push({ kind: 'paragraph', runs: [{ text: footnoteDefinitionText(node) }] });
        break;
      default:
        // Anything else a manuscript does not use carries no prose.
        break;
    }
  }
  return out;
}

/**
 * One paragraph's runs as blocks: a picture run becomes a `figure` block of its own, and the
 * text around it stays paragraphs, so an image inside a sentence is tolerated and exported as a
 * block figure (pictures.md §3). A paragraph that held only the image yields the figure alone.
 */
function paragraphBlocks(runs: readonly Run[]): ProseBlock[] {
  const out: ProseBlock[] = [];
  let paragraph: Run[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) out.push({ kind: 'paragraph', runs: paragraph });
    paragraph = [];
  };
  for (const run of runs) {
    if (run.image !== undefined) {
      flush();
      out.push({ kind: 'figure', image: run.image });
    } else {
      paragraph.push(run);
    }
  }
  flush();
  return out;
}

/** A label written `^…`: GFM's footnote spelling, which CommonMark reads as a link label. */
function isFootnoteLabel(label: string | null | undefined): boolean {
  return typeof label === 'string' && label.startsWith('^');
}

/**
 * A footnote note CommonMark read as a link definition, rebuilt as a `[label]: url "title"` line from what the parse kept:
 * the note's words, though not necessarily the exact spacing or quoting it was written with.
 */
function footnoteDefinitionText(node: { label?: string | null; url: string; title?: string | null }): string {
  const title = node.title === null || node.title === undefined ? '' : ` "${node.title}"`;
  return `[${node.label ?? ''}]: ${node.url}${title}`;
}

/** An unmarked note as its written line, `[^label]: the note` — multi-paragraph notes keep their words, one space apart. */
function unmarkedNoteText(definition: { label?: string | null; children: readonly Content[] }): string {
  const text = definition.children.map((block) => plainBlocks([block])).join(' ');
  return `[^${definition.label ?? ''}]:${text === '' ? '' : ` ${text}`}`;
}

/** The plain text of a small block list — words only, for rebuilding an unmarked note's line. */
function plainBlocks(blocks: readonly Content[]): string {
  const walk = (nodes: readonly { type: string; value?: string; children?: readonly unknown[] }[]): string[] =>
    nodes.flatMap((node) => {
      if (node.type === 'text' || node.type === 'inlineCode') return [node.value ?? ''];
      if (node.type === 'footnoteReference') return [`[^${(node as { label?: string }).label ?? ''}]`];
      return walk((node.children ?? []) as readonly { type: string; value?: string; children?: readonly unknown[] }[]);
    });
  return walk(blocks as readonly { type: string; value?: string; children?: readonly unknown[] }[]).join('');
}

interface Marks {
  readonly em?: boolean;
  readonly strong?: boolean;
  readonly href?: string;
}

function runsOf(nodes: readonly PhrasingContent[], marks: Marks, definitions: Definitions, referenced: ReadonlySet<string>): Run[] {
  const out: Run[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ text: node.value, ...marks });
        break;
      case 'emphasis':
        out.push(...runsOf(node.children, { ...marks, em: true }, definitions, referenced));
        break;
      case 'strong':
        out.push(...runsOf(node.children, { ...marks, strong: true }, definitions, referenced));
        break;
      case 'inlineCode':
        out.push({ text: node.value, ...marks, code: true });
        break;
      case 'break':
        out.push({ text: '', br: true });
        break;
      case 'link':
        out.push(...runsOf(node.children, { ...marks, href: safeHref(node.url) }, definitions, referenced));
        break;
      case 'image':
        out.push({ text: node.alt ?? '', image: { url: node.url, alt: node.alt ?? '', title: node.title ?? null }, ...marks });
        break;
      case 'imageReference': {
        const target = definitions.get(node.identifier);
        const alt = node.alt ?? '';
        out.push(
          target === undefined
            ? { text: alt, ...marks }
            : { text: alt, image: { url: target.url, alt, title: target.title }, ...marks },
        );
        break;
      }
      case 'footnoteReference': {
        const marker = node as { identifier: string; label?: string | null };
        if (referenced.has(marker.identifier)) {
          out.push({ text: '', noteId: marker.identifier, ...marks });
        } else {
          // A marker no definition names is not a footnote in GFM: it stays the text it is.
          out.push({ text: `[${marker.label ?? `^${marker.identifier}`}]`, ...marks });
        }
        break;
      }
      case 'html':
        out.push({ text: node.value, ...marks });
        break;
      case 'linkReference':
        // A footnote marker (`[^1]`) that CommonMark read as a link reference — one-word notes parse as link
        // definitions, not footnoteDefinitions: always kept as its text, whatever it resolves to (see `definition`).
        if (isFootnoteLabel(node.label)) {
          out.push({ text: '[', ...marks }, ...runsOf(node.children, marks, definitions, referenced), { text: ']', ...marks });
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/** A link target a book may carry: http(s) and mailto only. Anything else keeps its text and loses its target. */
export function safeHref(url: string): string | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  if (scheme === null) return undefined;
  return /^(https?|mailto)$/i.test(scheme[1] ?? '') ? url : undefined;
}

/**
 * The marker a run's `noteId` is written as in plain text — `[1]` for the first note met, as TXT needs. The renderer
 * keeps the numbering: it hands in a function that answers each identifier with its marker, so a paragraph's marker
 * and the note it names agree.
 */
export type NoteMarker = (noteId: string) => string;

/** The plain text of a run list: marks dropped, hard breaks as newlines, note markers through `marker` when given. */
export function plainRuns(runs: readonly Run[], marker?: NoteMarker): string {
  return runs.map((run) => (run.br === true ? '\n' : run.noteId !== undefined ? (marker?.(run.noteId) ?? '') : run.text)).join('');
}

/**
 * Plain text for the TXT renderer: paragraphs separated by a blank line, a
 * thematic break as `separator`, lists as `- ` or `1. ` lines, code as written.
 * Emphasis markers are gone; the words are what a plain-text reader needs.
 *
 * A figure becomes the `[Picture: caption]` line when `pictures` is `placeholder`
 * (the default), and nothing when it is `drop` (pictures.md §4): the caption is the
 * decoded placement caption, or the alt text when the placement has no caption.
 */
export function plainProse(
  blocks: readonly ProseBlock[],
  separator: string,
  pictures: 'placeholder' | 'drop' = 'placeholder',
  marker?: NoteMarker,
): string {
  const paragraphs: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
        paragraphs.push(plainRuns(block.runs, marker));
        break;
      case 'break':
        paragraphs.push(separator);
        break;
      case 'figure': {
        if (pictures === 'placeholder') {
          const caption = placementCaptionOf(block.image.title);
          paragraphs.push(`[Picture: ${caption !== '' ? caption : block.image.alt}]`);
        }
        break;
      }
      case 'quote':
        paragraphs.push(plainProse(block.blocks, separator, pictures, marker));
        break;
      case 'list':
        paragraphs.push(
          block.items
            .map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${plainProse(item, separator, pictures, marker)}`)
            .join('\n'),
        );
        break;
      case 'code':
        paragraphs.push(block.text);
        break;
    }
  }
  return paragraphs.filter((paragraph) => paragraph.length > 0).join('\n\n');
}
