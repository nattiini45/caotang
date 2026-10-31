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

/** One run of text with the inline marks that apply to it. */
export interface Run {
  readonly text: string;
  readonly em?: boolean;
  readonly strong?: boolean;
  readonly code?: boolean;
  readonly href?: string;
  /** A hard line break; `text` is empty when this is set. */
  readonly br?: boolean;
}

export type ProseBlock =
  | { readonly kind: 'paragraph'; readonly runs: readonly Run[] }
  | { readonly kind: 'heading'; readonly depth: number; readonly runs: readonly Run[] }
  | { readonly kind: 'break' }
  | { readonly kind: 'quote'; readonly blocks: readonly ProseBlock[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly ProseBlock[])[] }
  | { readonly kind: 'code'; readonly text: string };

/** Parses one body (CommonMark, no front matter — the store strips that) into prose blocks. */
export function parseProse(body: string): ProseBlock[] {
  const tree = unified().use(remarkParse).parse(body) as Root;
  return blocksOf(tree.children);
}

function blocksOf(nodes: readonly Content[]): ProseBlock[] {
  const out: ProseBlock[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        out.push({ kind: 'paragraph', runs: runsOf(node.children, {}) });
        break;
      case 'heading':
        out.push({ kind: 'heading', depth: node.depth, runs: runsOf(node.children, {}) });
        break;
      case 'thematicBreak':
        out.push({ kind: 'break' });
        break;
      case 'blockquote':
        out.push({ kind: 'quote', blocks: blocksOf(node.children) });
        break;
      case 'list':
        out.push({
          kind: 'list',
          ordered: node.ordered === true,
          items: node.children.map((item) => blocksOf(item.children)),
        });
        break;
      case 'code':
        out.push({ kind: 'code', text: node.value });
        break;
      case 'html':
        out.push({ kind: 'paragraph', runs: [{ text: node.value }] });
        break;
      case 'definition':
        // A footnote's note (`[^1]: Marta.`) is a GFM footnote to the editor (editor-engine §3.4) and, when it is one
        // word, a link definition to this CommonMark parse. Until footnotes are rendered (#271) it is exported as the
        // text it is, so a one-word note is not dropped. Other definitions carry no prose.
        if (isFootnoteLabel(node.label)) out.push({ kind: 'paragraph', runs: [{ text: footnoteDefinitionText(node) }] });
        break;
      default:
        // Anything else a manuscript does not use carries no prose.
        break;
    }
  }
  return out;
}

/** A label written `^…`: GFM's footnote spelling, which CommonMark reads as a link label. */
function isFootnoteLabel(label: string | null | undefined): boolean {
  return typeof label === 'string' && label.startsWith('^');
}

/** A footnote note CommonMark read as a link definition, back as the line it was written as. */
function footnoteDefinitionText(node: { label?: string | null; url: string; title?: string | null }): string {
  const title = node.title === null || node.title === undefined ? '' : ` "${node.title}"`;
  return `[${node.label ?? ''}]: ${node.url}${title}`;
}

interface Marks {
  readonly em?: boolean;
  readonly strong?: boolean;
  readonly href?: string;
}

function runsOf(nodes: readonly PhrasingContent[], marks: Marks): Run[] {
  const out: Run[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ text: node.value, ...marks });
        break;
      case 'emphasis':
        out.push(...runsOf(node.children, { ...marks, em: true }));
        break;
      case 'strong':
        out.push(...runsOf(node.children, { ...marks, strong: true }));
        break;
      case 'inlineCode':
        out.push({ text: node.value, ...marks, code: true });
        break;
      case 'break':
        out.push({ text: '', br: true });
        break;
      case 'link':
        out.push(...runsOf(node.children, { ...marks, href: safeHref(node.url) }));
        break;
      case 'image':
        out.push({ text: node.alt ?? '', ...marks });
        break;
      case 'html':
        out.push({ text: node.value, ...marks });
        break;
      case 'linkReference':
        // A footnote marker (`[^1]`) whose note CommonMark read as a link definition: kept as its text (see `definition`).
        if (isFootnoteLabel(node.label)) out.push({ text: '[', ...marks }, ...runsOf(node.children, marks), { text: ']', ...marks });
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
 */
export function plainProse(blocks: readonly ProseBlock[], separator: string): string {
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
      case 'quote':
        paragraphs.push(plainProse(block.blocks, separator));
        break;
      case 'list':
        paragraphs.push(
          block.items
            .map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${plainProse(item, separator)}`)
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
