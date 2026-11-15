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

/** Read the simple `.class { … }` rules a web export writes for text-align and font-weight. */
function classStyles(html: string): Map<string, ClassStyle> {
  const styles = new Map<string, ClassStyle>();
  const styleText = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1] ?? '').join('\n');
  for (const rule of styleText.matchAll(/\.([a-zA-Z0-9_-]+)\s*\{([^}]*)\}/g)) {
    const name = rule[1] ?? '';
    const body = rule[2] ?? '';
    const style: ClassStyle = { ...(styles.get(name) ?? {}) };
    const align = body.match(/text-align\s*:\s*(left|center|right|justify)/i);
    if (align !== null) style.align = (align[1] ?? '').toLowerCase() as Align;
    const weight = body.match(/font-weight\s*:\s*(bold|[6-9]00)/i);
    if (weight !== null) style.bold = true;
    styles.set(name, style);
  }
  return styles;
}

/** What the walker kept out, counted for the report. */
export interface HtmlDropped {
  scripts: number;
  styles: number;
  iframes: number;
  eventAttrs: number;
  unsafeLinks: number;
}

export interface HtmlWalkResult {
  blocks: ImportBlock[];
  losses: LossWarning[];
  /** Image asset refs to their targets (`data:` URIs and relative paths), for the reader to resolve. */
  images: Map<string, string>;
  /** Remote http(s) image targets, listed as not downloaded unless the writer opts in. */
  remoteImages: string[];
  dropped: HtmlDropped;
}

export type HtmlWalkError = { kind: 'not-xml'; message: string };
export type HtmlWalkOutput = { ok: true; value: HtmlWalkResult } | { ok: false; error: HtmlWalkError };

export interface HtmlWalkOptions {
  /** `Signals.sourceUnit` for the blocks, when the reader knows the page or spine item they came from. */
  unit?: string;
  /** The image refs' namespace, so two pages' pictures never share a ref. `import:html-image-` by default. */
  refPrefix?: string;
}

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'blockquote', 'ul', 'ol', 'li', 'pre', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'figure', 'figcaption']);
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'noscript', 'template', 'head', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta']);

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
    dropped: { scripts: 0, styles: 0, iframes: 0, eventAttrs: 0, unsafeLinks: 0 },
    styles,
    unit: options.unit ?? '',
    refPrefix: options.refPrefix ?? 'import:html-image-',
  };
  walkChildren(body, state, {});
  return { ok: true, value: { blocks: state.blocks, losses: state.losses, images: state.images, remoteImages: state.remoteImages, dropped: state.dropped } };
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

/** Count and skip the elements that must never run or show. */
function dropElement(element: XmlElement, state: WalkState): void {
  const tag = element.local.toLowerCase();
  if (tag === 'script') state.dropped.scripts += 1;
  else if (tag === 'style') state.dropped.styles += 1;
  else if (tag === 'iframe') state.dropped.iframes += 1;
  for (const attribute of element.attributes) {
    if (/^on/i.test(attribute.local)) state.dropped.eventAttrs += 1;
  }
}

function walkChildren(element: XmlElement, state: WalkState, context: InlineContext): void {
  for (const child of element.children) walkNode(child, state, context);
}

function walkNode(node: XmlNode, state: WalkState, context: InlineContext): void {
  if (node.type === 'text') {
    const text = node.text.replace(/\s+/g, ' ');
    if (text.trim() !== '') emitPara(text, state, {});
    return;
  }
  if (node.type !== 'element') return;
  const tag = node.local.toLowerCase();
  if (DROP_TAGS.has(tag)) {
    dropElement(node, state);
    return;
  }
  // Count event attributes on any kept element too.
  for (const attribute of node.attributes) if (/^on/i.test(attribute.local)) state.dropped.eventAttrs += 1;

  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
    const level = Number(tag.slice(1));
    const text = inlineText(node, state, { ...context }).trim();
    if (text !== '') state.blocks.push({ kind: 'heading', level, text, md: `${'#'.repeat(level)} ${text}`, ...(signalsOf(blockStyle(node, state), state.unit) === undefined ? {} : { src: signalsOf(blockStyle(node, state), state.unit) }) });
    return;
  }
  if (tag === 'hr') {
    state.blocks.push({ kind: 'break', marker: '***' });
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
      const text = inlineText(item, state, { ...context }).trim();
      if (text !== '') emitPara(marker + text, state, blockStyle(item, state));
    }
    return;
  }
  if (tag === 'blockquote') {
    const text = inlineText(node, state, { ...context }).trim();
    if (text !== '') emitPara(`> ${text}`, state, blockStyle(node, state));
    return;
  }
  if (tag === 'pre') {
    const text = textContent(node).trim();
    if (text !== '') emitPara(`\`\`\`\n${text}\n\`\`\``, state, blockStyle(node, state));
    return;
  }
  if (tag === 'table') {
    const text = textContent(node).replace(/\s+/g, ' ').trim();
    if (text !== '') {
      emitPara(text, state, blockStyle(node, state));
      state.losses.push({ code: 'table', message: 'A table was kept as prose.' });
    }
    return;
  }
  if (BLOCK_TAGS.has(tag)) {
    // A block with block children walks them; a block with only inline content becomes one paragraph.
    if (hasBlockChild(node)) {
      walkChildren(node, state, context);
      return;
    }
    const text = inlineText(node, state, { ...context }).trim();
    if (text !== '') emitPara(text, state, blockStyle(node, state));
    return;
  }
  // An inline element at block level (a stray <span>, <a>, <strong>): render it as a paragraph.
  const text = inlineText(node, state, { ...context }).trim();
  if (text !== '') emitPara(text, state, blockStyle(node, state));
}

function hasBlockChild(element: XmlElement): boolean {
  return element.children.some((child) => isElement(child) && (BLOCK_TAGS.has(child.local.toLowerCase()) || DROP_TAGS.has(child.local.toLowerCase())));
}

function emitPara(md: string, state: WalkState, style: { align?: Align; bold?: boolean; pageBreak?: boolean }): void {
  const text = md.replace(/[*_`>#[\]()!-]/g, '').replace(/\s+/g, ' ').trim();
  const signals = signalsOf(style, state.unit);
  state.blocks.push({ kind: 'para', md, text, ...(signals === undefined ? {} : { src: signals }) });
}

/** Render an element's inline content as Caotang-dialect Markdown. */
function inlineText(element: XmlElement, state: WalkState, context: InlineContext): string {
  let out = '';
  for (const child of element.children) {
    if (child.type === 'text') {
      out += child.text.replace(/\s+/g, ' ');
      continue;
    }
    if (child.type !== 'element') continue;
    const tag = child.local.toLowerCase();
    if (DROP_TAGS.has(tag)) {
      dropElement(child, state);
      continue;
    }
    if (tag === 'br') {
      out += '\n';
      continue;
    }
    if (tag === 'img') {
      out += imageMarkdown(child, state);
      continue;
    }
    if (tag === 'strong' || tag === 'b') {
      const inner = inlineText(child, state, { ...context, bold: true });
      out += inner.trim() === '' ? '' : `**${inner}**`;
      continue;
    }
    if (tag === 'em' || tag === 'i') {
      const inner = inlineText(child, state, { ...context, italic: true });
      out += inner.trim() === '' ? '' : `*${inner}*`;
      continue;
    }
    if (tag === 'code') {
      const inner = textContent(child);
      out += inner === '' ? '' : `\`${inner}\``;
      continue;
    }
    if (tag === 'a') {
      const href = attr(child, 'href') ?? '';
      const inner = inlineText(child, state, context);
      if (href === '' || !isSafeLinkTarget(href)) {
        if (href !== '') state.dropped.unsafeLinks += 1;
        out += inner;
      } else {
        out += `[${inner}](${href})`;
      }
      continue;
    }
    out += inlineText(child, state, context);
  }
  return out;
}

/** The plain text of an element, for tables and code. */
function textContent(element: XmlElement): string {
  let out = '';
  const stack: XmlNode[] = [...element.children];
  while (stack.length > 0) {
    const node = stack.shift();
    if (node === undefined) continue;
    if (node.type === 'text') out += node.text;
    else if (node.type === 'element') stack.unshift(...node.children);
  }
  return out;
}

function imageMarkdown(element: XmlElement, state: WalkState): string {
  const src = attr(element, 'src') ?? '';
  const alt = attr(element, 'alt') ?? '';
  if (src === '') return '';
  if (/^https?:/i.test(src)) {
    state.remoteImages.push(src);
    return '';
  }
  const ref = `${state.refPrefix}${state.images.size}`;
  state.images.set(ref, src);
  return `![${alt}](${ref})`;
}

function emitImage(element: XmlElement, state: WalkState): void {
  const src = attr(element, 'src') ?? '';
  const alt = attr(element, 'alt') ?? '';
  if (src === '') return;
  if (/^https?:/i.test(src)) {
    state.remoteImages.push(src);
    return;
  }
  const ref = `${state.refPrefix}${state.images.size}`;
  state.images.set(ref, src);
  state.blocks.push({ kind: 'image', assetRef: ref, alt });
}
