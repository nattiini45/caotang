/**
 * The own XHTML-to-blocks walker (#299, epic #263), shared by the HTML, EPUB, AO3, Kanka and Notion imports.
 * It reads well-formed XHTML (a Google Docs "Web page", a Ulysses/Bear/iA HTML export, a saved page) with the
 * shared XML reader — no DOM, no dependency — and emits the import block list with the structure signals the
 * splitter uses. `<script>`, `<style>`, event attributes and iframes are dropped and never run; links pass the
 * safe-href rule; `data:` and relative images are kept as refs, remote ones listed. No `eval`, `new Function`
 * or WebAssembly anywhere in the chain.
 */

import type { ImportBlock, LossWarning, Signals, Align } from '@caotang/import-core';
import { readXml, isElement, attr, type XmlElement, type XmlNode } from '@caotang/import-read/xml';

/** The HTML void elements, which a lenient export leaves unclosed; the XML reader needs them self-closed. */
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** HTML named entities the XML reader does not know, as the code point to read them as. The five XML ones stay. */
const HTML_ENTITIES: Record<string, number> = {
  nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165, brvbar: 166, sect: 167, uml: 168, copy: 169,
  ordf: 170, laquo: 171, not: 172, shy: 173, reg: 174, macr: 175, deg: 176, plusmn: 177, sup2: 178, sup3: 179,
  acute: 180, micro: 181, para: 182, middot: 183, cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188,
  frac12: 189, frac34: 190, iquest: 191, times: 215, divide: 247, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217,
  sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240,
  prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, trade: 8482, minus: 8722,
};

/** The safe-href rule the RTF reader uses: http(s) and mailto, or a relative target; no other scheme. */
export function isSafeLinkTarget(href: string): boolean {
  const target = href.replace(/[\t\n\r]/g, '').trim();
  if (/^(https?:|mailto:)/i.test(target)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(target);
}

/** Make lenient HTML readable as XML: decode HTML entities to numeric references and self-close the void elements. */
export function normaliseHtml(html: string): string {
  let out = html.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => {
    const code = HTML_ENTITIES[name];
    return code === undefined ? whole : `&#${code};`;
  });
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, (whole, tag: string, attrs: string) => {
    if (!VOID_ELEMENTS.has(tag.toLowerCase())) return whole;
    if (attrs.trimEnd().endsWith('/')) return whole;
    return `<${tag}${attrs}/>`;
  });
  return out;
}

/** A class's resolved text-align and font-weight, from the `<style>` rules. */
interface ClassStyle {
  align?: Align;
  bold?: boolean;
}

/**
 * Read the simple `.class { … }` rules a web export writes for text-align and font-weight.
 *
 * Both scans walk forward once, by index rather than by a scanning regex: a page of unclosed `<style>` tags, or of `.name` runs with
 * no brace, would make such a regex quadratic, and this reads a file the writer did not write themselves.
 */
function classStyles(html: string): Map<string, ClassStyle> {
  const styles = new Map<string, ClassStyle>();
  const lower = html.toLowerCase();
  const bodies: string[] = [];
  let at = 0;
  for (;;) {
    const open = lower.indexOf('<style', at);
    if (open < 0) break;
    const end = lower.indexOf('</style', open + 6);
    if (end < 0) break;
    const gt = lower.indexOf('>', open + 6);
    if (gt < 0 || gt > end) {
      at = open + 6;
      continue;
    }
    bodies.push(html.slice(gt + 1, end));
    at = end + 7;
  }
  const text = bodies.join('\n');
  let cursor = 0;
  while (cursor < text.length) {
    const dot = text.indexOf('.', cursor);
    if (dot < 0) break;
    let name = dot + 1;
    while (name < text.length && /[a-zA-Z0-9_-]/.test(text[name] as string)) name += 1;
    if (name === dot + 1) {
      cursor = dot + 1;
      continue;
    }
    let brace = name;
    while (brace < text.length && /\s/.test(text[brace] as string)) brace += 1;
    if (text[brace] !== '{') {
      cursor = name;
      continue;
    }
    const close = text.indexOf('}', brace + 1);
    if (close < 0) break;
    const body = text.slice(brace + 1, close);
    const key = text.slice(dot + 1, name);
    const style: ClassStyle = { ...(styles.get(key) ?? {}) };
    const align = body.match(/text-align\s*:\s*(left|center|right|justify)/i);
    if (align !== null) style.align = (align[1] ?? '').toLowerCase() as Align;
    const weight = body.match(/font-weight\s*:\s*(bold|[6-9]00)/i);
    if (weight !== null) style.bold = true;
    styles.set(key, style);
    cursor = close + 1;
  }
  return styles;
}

/** What the walker kept out, counted for the report. */
export interface HtmlDropped {
  scripts: number;
  styles: number;
  iframes: number;
  forms: number;
  eventAttrs: number;
  unsafeLinks: number;
  /** `<audio>` and `<video>` players, which an import cannot keep. */
  media: number;
}

/** A footnote reference in the text, and the note it points at, joined by their fragment. */
export interface HtmlNoteRef {
  fragment: string;
  label: string;
  blockIndex: number;
}

export interface HtmlNote {
  fragment: string;
  md: string;
}

export interface HtmlWalkResult {
  blocks: ImportBlock[];
  losses: LossWarning[];
  /** Image asset refs to their targets (`data:` URIs and relative paths), for the reader to resolve. */
  images: Map<string, string>;
  /** Remote http(s) image targets, listed as not downloaded unless the writer opts in. */
  remoteImages: string[];
  dropped: HtmlDropped;
  /** Each element `id` to the first block it produced, so a reader can address a block by fragment (an EPUB nav entry). */
  anchors: Map<string, number>;
  /** `epub:type="noteref"` links, written as `[^n]` in the text. */
  noterefs: HtmlNoteRef[];
  /** `epub:type="footnote"` asides, kept out of the text and returned as their Markdown. */
  notes: HtmlNote[];
  /** The regions `options.skip` named, each with the block index it sat before, for the reader to keep apart. */
  skipped: HtmlSkipped[];
}

/** A region the reader took out of the text: the selector that matched, where it sat, and the element itself. */
export interface HtmlSkipped {
  selector: string;
  blockIndex: number;
  element: XmlElement;
}

export type HtmlWalkError = { kind: 'not-xml'; message: string };
export type HtmlWalkOutput = { ok: true; value: HtmlWalkResult } | { ok: false; error: HtmlWalkError };

export interface HtmlWalkOptions {
  /** `Signals.sourceUnit` for the blocks, when the reader knows the page or spine item they came from. */
  unit?: string;
  /** The image refs' namespace, so two pages' pictures never share a ref. `import:html-image-` by default. */
  refPrefix?: string;
  /**
   * Regions to keep out of the text, each `.class` or `#id`: a page's own metadata, summary or notes, which a reader keeps apart
   * rather than importing twice. They come back in `skipped` with the block index they sat before.
   */
  skip?: readonly string[];
}

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'blockquote', 'ul', 'ol', 'li', 'pre', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'figure', 'figcaption']);
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'noscript', 'template', 'head', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta', 'audio', 'video']);
/** The dropped tags that are form content, counted for the report so a page's fields never leave silently. */
const FORM_TAGS = new Set(['form', 'input', 'button', 'select', 'textarea']);

/**
 * Every stylesheet the document carries: each `<style>` element and each `<link rel="stylesheet">`, in the head as well as the body.
 * The import keeps only what `classStyles` reads (alignment, bold, page breaks), so the rest is dropped and must be counted (#299).
 */
function stylesheetsIn(root: XmlNode): number {
  let count = 0;
  const walk = (node: XmlNode): void => {
    if (node.type !== 'element') return;
    const tag = node.local.toLowerCase();
    if (tag === 'style') count += 1;
    else if (tag === 'link' && (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')) count += 1;
    for (const child of node.children) walk(child);
  };
  walk(root);
  return count;
}

/**
 * Literal prose as Markdown text: the characters that would otherwise be read as markup are escaped, and a line that would start
 * a heading, a quote or a list is escaped too. The writer's own words come through as words, so `Use *literal* syntax` stays literal
 * and `[link](https://example.test)` stays text rather than becoming a link.
 */
export function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<]/g, (character) => `\\${character}`).replace(/^(\s*)([#>+-]|\d+[.)])/, '$1\\$2');
}

/**
 * A link destination that cannot change the Markdown around it. An href may contain `)` or a space, which would close the link
 * early and let the rest of the target be read as new markup — a second link the safe-href rule never saw. Those characters are
 * percent-encoded, which leaves the target the same URL.
 */
function linkDestination(href: string): string {
  return href.replace(/[\\()<>\s"'`[\]]/g, (character) => `%${(character.charCodeAt(0) ?? 0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** Whether an image target points off the file: any scheme but `data:`, or a protocol-relative `//host/path`. */
function isRemoteTarget(src: string): boolean {
  if (src.startsWith('//')) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^data:/i.test(src);
}

/**
 * Everything the document keeps out, counted once over the whole tree — the head as well as the body, and inside dropped elements
 * too. Counting during the body walk alone left a page's own `<script>` in the head unreported.
 */
function countDropped(root: XmlNode, dropped: HtmlDropped): void {
  if (root.type !== 'element') return;
  const tag = root.local.toLowerCase();
  if (tag === 'script') dropped.scripts += 1;
  else if (tag === 'iframe') dropped.iframes += 1;
  else if (FORM_TAGS.has(tag)) dropped.forms += 1;
  else if (tag === 'audio' || tag === 'video') dropped.media += 1;
  for (const attribute of root.attributes) if (/^on/i.test(attribute.local)) dropped.eventAttrs += 1;
  for (const child of root.children) countDropped(child, dropped);
}

/** Walk an XHTML page into the import block list. */
export function htmlToBlocks(html: string, options: HtmlWalkOptions = {}): HtmlWalkOutput {
  const styles = classStyles(html);
  const parsed = readXml(normaliseHtml(html));
  if (!parsed.ok) return { ok: false, error: { kind: 'not-xml', message: parsed.error.message } };

  const root = parsed.document.root;
  const body = findBody(root) ?? root;
  const state: WalkState = {
    blocks: [],
    losses: [],
    images: new Map(),
    remoteImages: [],
    dropped: { scripts: 0, styles: stylesheetsIn(root), iframes: 0, forms: 0, eventAttrs: 0, unsafeLinks: 0, media: 0 },
    styles,
    unit: options.unit ?? '',
    refPrefix: options.refPrefix ?? 'import:html-image-',
    anchors: new Map(),
    pendingAnchors: [],
    noterefs: [],
    notes: [],
    noteLabels: new Map(),
    skip: options.skip ?? [],
    skipped: [],
  };
  countDropped(root, state.dropped);
  walkChildren(body, state, {}, {});
  return {
    ok: true,
    value: {
      blocks: state.blocks,
      losses: state.losses,
      images: state.images,
      remoteImages: state.remoteImages,
      dropped: state.dropped,
      anchors: state.anchors,
      noterefs: state.noterefs,
      notes: state.notes,
      skipped: state.skipped,
    },
  };
}

interface WalkState {
  blocks: ImportBlock[];
  losses: LossWarning[];
  images: Map<string, string>;
  remoteImages: string[];
  dropped: HtmlDropped;
  styles: Map<string, ClassStyle>;
  unit: string;
  refPrefix: string;
  anchors: Map<string, number>;
  /** The ids of the elements entered since the last block, all naming the next block. */
  pendingAnchors: string[];
  noterefs: HtmlNoteRef[];
  notes: HtmlNote[];
  noteLabels: Map<string, string>;
  skip: readonly string[];
  skipped: HtmlSkipped[];
}

/** Whether an element matches one of the reader's `.class` / `#id` skip selectors. */
function skippedBy(element: XmlElement, selectors: readonly string[]): string | undefined {
  if (selectors.length === 0) return undefined;
  const classes = (attr(element, 'class') ?? '').split(/\s+/);
  const id = attr(element, 'id') ?? '';
  for (const selector of selectors) {
    if (selector.startsWith('#') ? selector.slice(1) === id : classes.includes(selector.slice(1))) return selector;
  }
  return undefined;
}

/** Add a block, giving it the ids of the elements it came from. */
function pushBlock(state: WalkState, block: ImportBlock): void {
  for (const id of state.pendingAnchors) if (!state.anchors.has(id)) state.anchors.set(id, state.blocks.length);
  state.pendingAnchors.length = 0;
  state.blocks.push(block);
}

/** An element's EPUB semantic type (`epub:type`, or the equivalent ARIA `role`). */
function semanticType(element: XmlElement): string {
  const typed =
    attr(element, 'type', 'http://www.idpf.org/2007/ops') ??
    element.attributes.find((a) => a.local === 'type' && a.prefix === 'epub')?.value ??
    attr(element, 'role');
  return (typed ?? '').trim();
}

/** The inherited inline context: whether we are inside bold/italic/a link, and the current list marker. */
interface InlineContext {
  bold?: boolean;
  italic?: boolean;
  href?: string;
}

function findBody(element: XmlElement): XmlElement | undefined {
  if (element.local === 'body') return element;
  for (const child of element.children) {
    if (isElement(child)) {
      const found = findBody(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The effective alignment and weight of a block element: its class rules, then its inline style. */
function blockStyle(element: XmlElement, state: WalkState): { align?: Align; bold?: boolean; pageBreak?: boolean } {
  let align: Align | undefined;
  let bold: boolean | undefined;
  const classes = (attr(element, 'class') ?? '').split(/\s+/).filter((name) => name !== '');
  for (const name of classes) {
    const style = state.styles.get(name);
    if (style?.align !== undefined) align = style.align;
    if (style?.bold === true) bold = true;
  }
  const inline = attr(element, 'style') ?? '';
  const alignMatch = inline.match(/text-align\s*:\s*(left|center|right|justify)/i);
  if (alignMatch !== null) align = (alignMatch[1] ?? '').toLowerCase() as Align;
  const weightMatch = inline.match(/font-weight\s*:\s*(bold|[6-9]00)/i);
  if (weightMatch !== null) bold = true;
  const pageBreak = /page-break-before\s*:\s*(always|page)/i.test(inline) || /break-before\s*:\s*page/i.test(inline);
  return { ...(align === undefined ? {} : { align }), ...(bold === undefined ? {} : { bold }), ...(pageBreak ? { pageBreak: true } : {}) };
}

function signalsOf(style: { align?: Align; bold?: boolean; pageBreak?: boolean }, unit: string): Signals | undefined {
  const signals: Signals = {
    ...(style.align === undefined ? {} : { align: style.align }),
    ...(style.bold === undefined ? {} : { allBold: style.bold }),
    ...(style.pageBreak ? { pageBreakBefore: true } : {}),
    ...(unit === '' ? {} : { sourceUnit: unit }),
  };
  return Object.keys(signals).length === 0 ? undefined : signals;
}

/** The block style a wrapper hands down: its own over what it inherited. */
interface BlockStyle {
  align?: Align;
  bold?: boolean;
  pageBreak?: boolean;
}

/** Skip the elements that must never run or show. They are counted once over the whole document, before the walk. */
function walkChildren(element: XmlElement, state: WalkState, context: InlineContext, inherited: BlockStyle): void {
  for (const child of element.children) walkNode(child, state, context, inherited);
}

function walkNode(node: XmlNode, state: WalkState, context: InlineContext, inherited: BlockStyle): void {
  if (node.type === 'text') {
    const text = node.text.replace(/\s+/g, ' ');
    if (text.trim() !== '') {
      emitPara(escapeText(text.trim()), text.trim(), state, { ...inherited });
      delete inherited.pageBreak;
    }
    return;
  }
  if (node.type !== 'element') return;
  const tag = node.local.toLowerCase();
  if (DROP_TAGS.has(tag)) return;
  const own: BlockStyle = { ...inherited, ...blockStyle(node, state) };
  // A wrapper's page break belongs to the first block it produces, so it is consumed from the shared style as well.
  const emit = (md: string, text: string, style: BlockStyle): void => {
    emitPara(md, text, state, style);
    delete inherited.pageBreak;
  };

  const id = attr(node, 'id');
  if (id !== undefined && id !== '') state.pendingAnchors.push(id);

  // A region the reader keeps apart (a page's own metadata, summary or notes) is not text: it is returned where it sat.
  const selector = skippedBy(node, state.skip);
  if (selector !== undefined) {
    state.skipped.push({ selector, blockIndex: state.blocks.length, element: node });
    // The place the region sat stays addressable by fragment: a nav entry may cut a chapter there.
    for (const pending of state.pendingAnchors) if (!state.anchors.has(pending)) state.anchors.set(pending, state.blocks.length);
    state.pendingAnchors.length = 0;
    return;
  }

  // A footnote aside is kept as a note, not as text: its reference in the prose points at it by fragment.
  const semantic = semanticType(node);
  if (semantic.split(/\s+/).includes('footnote') || semantic.split(/\s+/).includes('doc-footnote')) {
    const md = inlineText(node, state, { ...context }).md.replace(/\s+/g, ' ').trim();
    if (id !== undefined && md !== '') state.notes.push({ fragment: id, md });
    state.pendingAnchors.length = 0;
    return;
  }

  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
    const level = Number(tag.slice(1));
    const rendered = inlineText(node, state, { ...context });
    const text = rendered.text.trim();
    if (text !== '') {
      const signals = signalsOf(own, state.unit);
      pushBlock(state, { kind: 'heading', level, text, md: `${'#'.repeat(level)} ${rendered.md.trim()}`, ...(signals === undefined ? {} : { src: signals }) });
      delete own.pageBreak;
      delete inherited.pageBreak;
    }
    return;
  }
  if (tag === 'hr') {
    pushBlock(state, { kind: 'break', marker: '***' });
    return;
  }
  if (tag === 'img') {
    emitImage(node, state);
    return;
  }
  if (tag === 'br') {
    return;
  }
  if (tag === 'ul' || tag === 'ol') {
    let index = 1;
    for (const item of node.children) {
      if (!isElement(item) || item.local.toLowerCase() !== 'li') continue;
      const marker = tag === 'ul' ? '- ' : `${index}. `;
      index += 1;
      const rendered = inlineText(item, state, { ...context });
      if (rendered.md.trim() !== '') {
        emit(marker + rendered.md.trim(), rendered.text.trim(), { ...own, ...blockStyle(item, state) });
        // The list's own page break belongs to the first item it produces, not to every item; an item's own style still applies.
        delete own.pageBreak;
      }
    }
    return;
  }
  if (tag === 'blockquote') {
    const rendered = inlineText(node, state, { ...context });
    if (rendered.md.trim() !== '') emit(`> ${rendered.md.trim()}`, rendered.text.trim(), own);
    return;
  }
  if (tag === 'pre') {
    const text = textContent(node).trim();
    if (text !== '') {
      // A fence longer than any run of backticks inside, so the code cannot close its own fence and spill into markup.
      const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
      const fence = '`'.repeat(Math.max(3, longest + 1));
      emit(`${fence}\n${text}\n${fence}`, text, own);
    }
    return;
  }
  if (tag === 'table') {
    const text = tableText(node);
    if (text !== '') {
      emit(text, text, own);
      state.losses.push({ code: 'table', message: 'A table was kept as prose.' });
    }
    return;
  }
  if (BLOCK_TAGS.has(tag)) {
    // A block with block children walks them, carrying its own alignment, weight and page break down to them.
    if (hasBlockChild(node)) {
      walkChildren(node, state, context, own);
      return;
    }
    const rendered = inlineText(node, state, { ...context });
    if (rendered.md.trim() !== '') emit(rendered.md.trim(), rendered.text.trim(), own);
    return;
  }
  // An inline element at block level (a stray <span>, <a>, <strong>): render it as a paragraph.
  const rendered = inlineText(node, state, { ...context });
  if (rendered.md.trim() !== '') emit(rendered.md.trim(), rendered.text.trim(), own);
}

function hasBlockChild(element: XmlElement): boolean {
  return element.children.some((child) => isElement(child) && (BLOCK_TAGS.has(child.local.toLowerCase()) || DROP_TAGS.has(child.local.toLowerCase())));
}

function emitPara(md: string, text: string, state: WalkState, style: BlockStyle): void {
  const signals = signalsOf(style, state.unit);
  pushBlock(state, { kind: 'para', md, text: text.replace(/\s+/g, ' ').trim(), ...(signals === undefined ? {} : { src: signals }) });
  // A page break belongs to the first block a wrapper produces, not to every block under it.
  delete style.pageBreak;
}

/** An element's inline content as Markdown and as the writer's plain words, in one pass. */
interface InlineRender {
  md: string;
  text: string;
}

function inlineText(element: XmlElement, state: WalkState, context: InlineContext): InlineRender {
  let md = '';
  let text = '';
  for (const child of element.children) {
    if (child.type === 'text') {
      const raw = child.text.replace(/\s+/g, ' ');
      md += escapeText(raw);
      text += raw;
      continue;
    }
    if (child.type !== 'element') continue;
    const tag = child.local.toLowerCase();
    if (DROP_TAGS.has(tag)) continue;
    if (tag === 'br') {
      md += '\n';
      text += '\n';
      continue;
    }
    if (tag === 'img') {
      md += imageMarkdown(child, state);
      text += attr(child, 'alt') ?? '';
      continue;
    }
    if (tag === 'strong' || tag === 'b') {
      const inner = inlineText(child, state, { ...context, bold: true });
      md += inner.md.trim() === '' ? '' : `**${inner.md}**`;
      text += inner.text;
      continue;
    }
    if (tag === 'em' || tag === 'i') {
      const inner = inlineText(child, state, { ...context, italic: true });
      md += inner.md.trim() === '' ? '' : `*${inner.md}*`;
      text += inner.text;
      continue;
    }
    if (tag === 'code') {
      const inner = textContent(child);
      md += inner === '' ? '' : `\`${inner}\``;
      text += inner;
      continue;
    }
    if (tag === 'a') {
      const href = attr(child, 'href') ?? '';
      const inner = inlineText(child, state, context);
      const kind = semanticType(child).split(/\s+/);
      if (href.startsWith('#') && (kind.includes('noteref') || kind.includes('doc-noteref'))) {
        // An EPUB footnote reference becomes an inline [^n], the note itself kept apart (decision 3).
        const fragment = href.slice(1);
        let label = state.noteLabels.get(fragment);
        if (label === undefined) {
          label = String(state.noteLabels.size + 1);
          state.noteLabels.set(fragment, label);
        }
        state.noterefs.push({ fragment, label, blockIndex: state.blocks.length });
        md += `[^${label}]`;
        text += inner.text;
        continue;
      }
      if (href === '' || !isSafeLinkTarget(href)) {
        if (href !== '') state.dropped.unsafeLinks += 1;
        md += inner.md;
      } else {
        md += `[${inner.md}](${linkDestination(href)})`;
      }
      text += inner.text;
      continue;
    }
    const inner = inlineText(child, state, context);
    md += inner.md;
    text += inner.text;
  }
  return { md, text };
}

/** The plain text of an element, for code. Elements that must never show contribute nothing. */
function textContent(element: XmlElement): string {
  let out = '';
  const stack: XmlNode[] = [...element.children];
  while (stack.length > 0) {
    const node = stack.shift();
    if (node === undefined) continue;
    if (node.type === 'text') out += node.text;
    else if (node.type === 'element' && !DROP_TAGS.has(node.local.toLowerCase())) stack.unshift(...node.children);
  }
  return out;
}

/** A table as prose: a space between cells, a line between rows, so two names never run into one word. */
function tableText(element: XmlElement): string {
  const rows: string[] = [];
  const collectRows = (node: XmlElement): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      const tag = child.local.toLowerCase();
      if (DROP_TAGS.has(tag)) continue;
      if (tag === 'tr') {
        const cells: string[] = [];
        for (const cell of child.children) {
          if (!isElement(cell)) continue;
          const cellTag = cell.local.toLowerCase();
          if (cellTag !== 'td' && cellTag !== 'th') continue;
          const value = textContent(cell).replace(/\s+/g, ' ').trim();
          if (value !== '') cells.push(value);
        }
        if (cells.length > 0) rows.push(cells.join(' '));
        continue;
      }
      collectRows(child);
    }
  };
  collectRows(element);
  // A table with no rows at all still keeps its words, rather than losing them.
  if (rows.length === 0) return textContent(element).replace(/\s+/g, ' ').trim();
  return rows.join('\n');
}

function imageMarkdown(element: XmlElement, state: WalkState): string {
  const src = attr(element, 'src') ?? '';
  const alt = attr(element, 'alt') ?? '';
  if (src === '') return '';
  if (isRemoteTarget(src)) {
    state.remoteImages.push(src);
    return '';
  }
  const ref = `${state.refPrefix}${state.images.size}`;
  state.images.set(ref, src);
  return `![${alt.replace(/[\\[\]]/g, (character) => `\\${character}`)}](${ref})`;
}

function emitImage(element: XmlElement, state: WalkState): void {
  const src = attr(element, 'src') ?? '';
  const alt = attr(element, 'alt') ?? '';
  if (src === '') return;
  if (isRemoteTarget(src)) {
    state.remoteImages.push(src);
    return;
  }
  const ref = `${state.refPrefix}${state.images.size}`;
  state.images.set(ref, src);
  pushBlock(state, { kind: 'image', assetRef: ref, alt });
}
