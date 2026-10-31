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

/** Parses one body (CommonMark, no front matter — the store strips that) into prose blocks. */
export function parseProse(body: string): ProseBlock[] {
  const tree = unified().use(remarkParse).parse(body) as Root;
  return blocksOf(tree.children, definitionsOf(tree));
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

function blocksOf(nodes: readonly Content[], definitions: Definitions): ProseBlock[] {
  const out: ProseBlock[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        out.push(...paragraphBlocks(runsOf(node.children, {}, definitions)));
        break;
      case 'heading':
        out.push({ kind: 'heading', depth: node.depth, runs: runsOf(node.children, {}, definitions) });
        break;
      case 'thematicBreak':
        out.push({ kind: 'break' });
        break;
      case 'blockquote':
        out.push({ kind: 'quote', blocks: blocksOf(node.children, definitions) });
        break;
      case 'list':
        out.push({
          kind: 'list',
          ordered: node.ordered === true,
          items: node.children.map((item) => blocksOf(item.children, definitions)),
        });
        break;
      case 'code':
        out.push({ kind: 'code', text: node.value });
        break;
      case 'html':
        out.push({ kind: 'paragraph', runs: [{ text: node.value }] });
        break;
      default:
        // Definitions and anything else a manuscript does not use carry no prose.
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

interface Marks {
  readonly em?: boolean;
  readonly strong?: boolean;
  readonly href?: string;
}

function runsOf(nodes: readonly PhrasingContent[], marks: Marks, definitions: Definitions): Run[] {
  const out: Run[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ text: node.value, ...marks });
        break;
      case 'emphasis':
        out.push(...runsOf(node.children, { ...marks, em: true }, definitions));
        break;
      case 'strong':
        out.push(...runsOf(node.children, { ...marks, strong: true }, definitions));
        break;
      case 'inlineCode':
        out.push({ text: node.value, ...marks, code: true });
        break;
      case 'break':
        out.push({ text: '', br: true });
        break;
      case 'link':
        out.push(...runsOf(node.children, { ...marks, href: safeHref(node.url) }, definitions));
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
      case 'html':
        out.push({ text: node.value, ...marks });
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

/** The plain text of a run list: marks dropped, hard breaks as newlines. */
export function plainRuns(runs: readonly Run[]): string {
  return runs.map((run) => (run.br === true ? '\n' : run.text)).join('');
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
export function plainProse(blocks: readonly ProseBlock[], separator: string, pictures: 'placeholder' | 'drop' = 'placeholder'): string {
  const paragraphs: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
        paragraphs.push(plainRuns(block.runs));
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
        paragraphs.push(plainProse(block.blocks, separator, pictures));
        break;
      case 'list':
        paragraphs.push(
          block.items
            .map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${plainProse(item, separator, pictures)}`)
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
