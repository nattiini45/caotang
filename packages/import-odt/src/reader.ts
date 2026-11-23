/**
 * The OpenDocument reader (#298, epic #263): an `.odt` package or a flat `.fodt` read into the import block list on
 * the shared zip and XML layer. An own reader, as for Word: odf-kit was a reference only, and no GPL or AGPL code is
 * used or copied. Nothing here runs, fetches or evaluates.
 */

import type { ImportAsset, ImportBlock, ImportComment, ImportDocument, ImportFootnote, LossWarning, Signals } from '@caotang/import-core';
import { escapeInline, escapeLineStarts } from '@caotang/import-core';
import { attr, readXml, textOf, type XmlElement, type XmlNode } from '@caotang/import-read/xml';
import { openZip, type ImportArchive } from '@caotang/import-read/zip';

export type OdtTrackedMode = 'accept' | 'reject' | 'keep';

export interface OdtOptions {
  tracked?: OdtTrackedMode;
  underlineAs?: 'italic' | 'none';
  images?: boolean;
  comments?: boolean;
  unit?: string;
  refPrefix?: string;
}

export interface OdtChanges {
  insertions: number;
  deletions: number;
}

export interface OdtDropped {
  underline: number;
  fonts: number;
  colours: number;
  indents: number;
  unsafeLinks: number;
  textBoxes: number;
  svg: number;
  otherPictures: number;
}

export interface OdtImport {
  document: ImportDocument;
  title: string;
  author: string;
  language: string;
  assetData: Map<string, Uint8Array>;
  changes: OdtChanges;
  dropped: OdtDropped;
  deletions: { blockIndex: number; text: string }[];
  remoteImages: string[];
}

export type OdtError = { kind: 'not-odt' } | { kind: 'archive'; message: string } | { kind: 'not-xml'; message: string } | { kind: 'empty' };
export type OdtResult = { ok: true; value: OdtImport } | { ok: false; error: OdtError };

const EMPTY_DROPPED: OdtDropped = { underline: 0, fonts: 0, colours: 0, indents: 0, unsafeLinks: 0, textBoxes: 0, svg: 0, otherPictures: 0 };
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;

/** Children with a local name, whatever prefix the file chose. */
function kids(element: XmlElement, local: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child.type === 'element' && child.local === local);
}
const kid = (element: XmlElement, local: string): XmlElement | undefined => kids(element, local)[0];

/** Every descendant with a local name, in document order. */
function descendants(element: XmlElement, local: string): XmlElement[] {
  const found: XmlElement[] = [];
  const stack: XmlElement[] = [element];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const child of current.children) {
      if (child.type !== 'element') continue;
      if (child.local === local) found.push(child);
      stack.push(child);
    }
  }
  return found;
}

/** The first descendant with a local name, searched breadth-first so the nearest wins. */
function firstDescendant(element: XmlElement, local: string): XmlElement | undefined {
  const queue: XmlElement[] = [element];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const child of current.children) {
      if (child.type !== 'element') continue;
      if (child.local === local) return child;
      queue.push(child);
    }
  }
  return undefined;
}

interface OdtStyle {
  name: string;
  parent: string | null;
  align: 'left' | 'center' | 'right' | 'justify' | null;
  bold: boolean | null;
  italic: boolean | null;
  strike: boolean | null;
  underline: boolean | null;
  caps: boolean | null;
  pageBreak: boolean | null;
  quote: boolean;
  /** The style names a font, a colour or an indent, none of which the reader keeps. */
  font: boolean;
  colour: boolean;
  indent: boolean;
}

const ALIGN: Readonly<Record<string, OdtStyle['align']>> = { start: 'left', end: 'right', left: 'left', center: 'center', right: 'right', justify: 'justify' };
const QUOTE = /quote|quotation|zitat|citation/i;

/** Every `style:style` in a styles or content part, by name. */
function collectStyles(root: XmlElement, into: Map<string, OdtStyle>): void {
  for (const element of descendants(root, 'style')) {
    const name = attr(element, 'name');
    if (name === undefined) continue;
    const paragraph = kid(element, 'paragraph-properties');
    const text = kid(element, 'text-properties');
    const align = paragraph === undefined ? undefined : attr(paragraph, 'text-align');
    const weight = text === undefined ? undefined : attr(text, 'font-weight');
    const underline = text === undefined ? undefined : attr(text, 'text-underline-style');
    const fontStyle = text === undefined ? undefined : attr(text, 'font-style');
    const lineThrough = text === undefined ? undefined : attr(text, 'text-line-through-style');
    const transform = text === undefined ? undefined : attr(text, 'text-transform');
    const breakBefore = paragraph === undefined ? undefined : attr(paragraph, 'break-before');
    into.set(name, {
      name,
      parent: attr(element, 'parent-style-name') ?? null,
      align: align === undefined ? null : (ALIGN[align] ?? null),
      bold: weight === undefined ? null : weight === 'bold' || Number(weight) >= 600,
      italic: fontStyle === undefined ? null : fontStyle === 'italic',
      strike: lineThrough === undefined ? null : lineThrough !== 'none',
      underline: underline === undefined ? null : underline !== 'none',
      caps: transform === undefined ? null : transform === 'uppercase',
      pageBreak: breakBefore === undefined ? null : breakBefore === 'page',
      quote: QUOTE.test(name),
      font: text !== undefined && (attr(text, 'font-name') !== undefined || attr(text, 'font-family') !== undefined),
      colour: text !== undefined && (attr(text, 'color') !== undefined || attr(text, 'background-color') !== undefined),
      indent: paragraph !== undefined && (attr(paragraph, 'margin-left') !== undefined || attr(paragraph, 'margin-right') !== undefined || attr(paragraph, 'text-indent') !== undefined),
    });
  }
}

/** The names of `text:list-style` styles whose first level numbers its items. */
function collectListStyles(root: XmlElement, into: Set<string>): void {
  for (const element of descendants(root, 'list-style')) {
    const name = attr(element, 'name');
    if (name !== undefined && kid(element, 'list-level-style-number') !== undefined) into.add(name);
  }
}

/** A style with its parents resolved; a cycle stops at the name already seen. */
function resolve(styles: ReadonlyMap<string, OdtStyle>, name: string | undefined): OdtStyle | null {
  if (name === undefined) return null;
  const chain: OdtStyle[] = [];
  const seen = new Set<string>();
  let current = styles.get(name);
  while (current !== undefined && !seen.has(current.name)) {
    seen.add(current.name);
    chain.push(current);
    current = current.parent === null ? undefined : styles.get(current.parent);
  }
  const first = chain[0];
  if (first === undefined) return null;
  return {
    name: first.name,
    parent: first.parent,
    align: chain.find((style) => style.align !== null)?.align ?? null,
    bold: chain.find((style) => style.bold !== null)?.bold ?? null,
    italic: chain.find((style) => style.italic !== null)?.italic ?? null,
    strike: chain.find((style) => style.strike !== null)?.strike ?? null,
    underline: chain.find((style) => style.underline !== null)?.underline ?? null,
    caps: chain.find((style) => style.caps !== null)?.caps ?? null,
    pageBreak: chain.find((style) => style.pageBreak !== null)?.pageBreak ?? null,
    quote: chain.some((style) => style.quote),
    font: chain.some((style) => style.font),
    colour: chain.some((style) => style.colour),
    indent: chain.some((style) => style.indent),
  };
}

/** A changed region: what was inserted or deleted, and its text. */
interface Region {
  kind: 'insertion' | 'deletion';
  text: string;
}

function safeHref(href: string): boolean {
  const target = href.replace(/[\t\n\r]/g, '').trim();
  if (/^(https?:|mailto:)/i.test(target)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(target);
}

function emphasise(text: string, style: { bold: boolean; italic: boolean; strike: boolean; underline: boolean }, underlineAs: 'italic' | 'none'): string {
  if (text.trim() === '') return text;
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  const tail = /\s*$/.exec(text)?.[0] ?? '';
  let core = text.slice(lead.length, text.length - tail.length);
  if (style.strike) core = `~~${core}~~`;
  if (style.bold) core = `**${core}**`;
  if (style.italic || (style.underline && underlineAs === 'italic')) core = `*${core}*`;
  return `${lead}${core}${tail}`;
}

interface State {
  styles: Map<string, OdtStyle>;
  regions: Map<string, Region>;
  options: Required<Pick<OdtOptions, 'tracked' | 'underlineAs' | 'images' | 'comments'>> & { unit: string | undefined; refPrefix: string };
  blocks: ImportBlock[];
  losses: LossWarning[];
  notes: ImportFootnote[];
  comments: ImportComment[];
  assets: ImportAsset[];
  imageTargets: Map<string, string>;
  orderedLists: Set<string>;
  /** A flat document's pictures, decoded from the frame's own base64. */
  inlineImages: Map<string, Uint8Array>;
  remoteImages: string[];
  changes: OdtChanges;
  dropped: OdtDropped;
  deletions: { blockIndex: number; text: string }[];
  noteIndex: number;
  imageIndex: number;
  /** Inside an insertion the writer rejected: its text is not read. */
  suppressed: number;
  /** The annotation open at this point, with the text it anchors. */
  annotation: { text: string } | null;
  /** Inside a note, annotation or cell body, whose text is not the paragraph's own. */
  inBody: number;
}

/** The inline content of a paragraph or a span, as Markdown. */
function inline(node: XmlNode, state: State, inherited: { bold: boolean; italic: boolean; strike: boolean; underline: boolean }): string {
  if (node.type === 'text') {
    if (state.suppressed === 0 && state.inBody === 0 && state.annotation !== null) state.annotation.text += node.text;
    return state.suppressed > 0 ? '' : escapeInline(node.text);
  }
  const local = node.local;
  if (state.suppressed > 0 && local !== 'change-start' && local !== 'change-end') return '';
  if (local === 'span') {
    const style = resolve(state.styles, attr(node, 'style-name'));
    if (style !== null) {
      if (style.underline === true) state.dropped.underline += 1;
      if (style.font) state.dropped.fonts += 1;
      if (style.colour) state.dropped.colours += 1;
      if (style.indent) state.dropped.indents += 1;
    }
    const merged = {
      bold: style?.bold ?? inherited.bold,
      italic: style?.italic ?? inherited.italic,
      strike: style?.strike ?? inherited.strike,
      underline: style?.underline ?? inherited.underline,
    };
    const text = children(node, state, merged);
    return state.suppressed > 0 ? '' : emphasise(text, merged, state.options.underlineAs);
  }
  if (local === 's') return ' '.repeat(Number(attr(node, 'c') ?? '1'));
  if (local === 'tab') return '\t';
  if (local === 'line-break') return '\n';
  if (local === 'soft-page-break') return '';
  if (local === 'a') {
    const href = attr(node, 'href') ?? '';
    const text = children(node, state, inherited);
    if (!safeHref(href)) {
      state.dropped.unsafeLinks += 1;
      return text;
    }
    return text.trim() === '' ? text : `[${text}](${href})`;
  }
  if (local === 'note') {
    const body = kid(node, 'note-body');
    const md = body === undefined ? '' : kids(body, 'p').map((p) => plain(p, state)).filter((text) => text !== '').join('\n\n');
    state.noteIndex += 1;
    const label = String(state.noteIndex);
    state.notes.push({ blockIndex: state.blocks.length, label, md });
    return `[^${label}]`;
  }
  if (local === 'annotation') {
    const creator = firstDescendant(node, 'creator');
    const date = firstDescendant(node, 'date');
    const md = kids(node, 'p').map((p) => plain(p, state)).filter((text) => text !== '').join('\n\n');
    if (state.options.comments && md !== '') {
      const who = [creator === undefined ? '' : textOf(creator).trim(), date === undefined ? '' : textOf(date).trim().slice(0, 10)].filter((part) => part !== '').join(', ');
      const anchored = state.annotation?.text ?? '';
      state.comments.push({ blockIndex: state.blocks.length, md: `${anchored === '' ? '' : `> “${anchored}”\n\n`}${md}${who === '' ? '' : `\n\n— ${who}`}` });
    }
    return '';
  }
  if (local === 'change') {
    const region = state.regions.get(attr(node, 'change-id') ?? '');
    if (region === undefined) return '';
    if (region.kind === 'insertion') {
      state.changes.insertions += 1;
      return state.options.tracked === 'reject' ? '' : region.text;
    }
    state.changes.deletions += 1;
    if (state.options.tracked === 'reject') return region.text;
    if (state.options.tracked === 'keep' && region.text.trim() !== '') state.deletions.push({ blockIndex: state.blocks.length, text: region.text });
    return '';
  }
  if (local === 'change-start') {
    const region = state.regions.get(attr(node, 'change-id') ?? '');
    if (region?.kind === 'insertion') {
      state.changes.insertions += 1;
      if (state.options.tracked === 'reject') state.suppressed += 1;
    } else if (region?.kind === 'deletion') {
      state.changes.deletions += 1;
      if (state.options.tracked === 'keep' && region.text.trim() !== '') state.deletions.push({ blockIndex: state.blocks.length, text: region.text });
      if (state.options.tracked !== 'reject') state.suppressed += 1;
    }
    return '';
  }
  if (local === 'change-end') {
    if (state.suppressed > 0) state.suppressed -= 1;
    return '';
  }
  if (local === 'frame' || local === 'image') {
    const box = firstDescendant(node, 'text-box');
    return box === undefined ? image(node, state) : textBox(box, state);
  }
  if (local === 'text-box') return textBox(node, state);
  if (local === 'tracked-changes' || local === 'sequence-decls' || local === 'bookmark' || local === 'bookmark-start' || local === 'bookmark-end') return '';
  return children(node, state, inherited);
}

function children(element: XmlElement, state: State, inherited: { bold: boolean; italic: boolean; strike: boolean; underline: boolean }): string {
  let out = '';
  for (const child of element.children) out += inline(child, state, inherited);
  return out;
}

const PLAIN = { bold: false, italic: false, strike: false, underline: false };

/** A paragraph's text without its Markdown: for a note or an annotation. */
function plain(paragraph: XmlElement, state: State): string {
  state.inBody += 1;
  const text = children(paragraph, state, PLAIN).replace(/[ \t]+/g, ' ').trim();
  state.inBody -= 1;
  return text;
}

/** A text box's paragraphs as flat text, counted and reported. */
function textBox(element: XmlElement, state: State): string {
  state.dropped.textBoxes += 1;
  state.losses.push({ code: 'text-box', message: 'A text box was read as a paragraph.', blockIndex: state.blocks.length });
  return kids(element, 'p').map((p) => plain(p, state)).filter((text) => text !== '').join(' ');
}

/** A frame's picture: its ref, or nothing when it cannot come in. */
function image(element: XmlElement, state: State): string {
  const drawImage = element.local === 'image' ? element : firstDescendant(element, 'image');
  if (drawImage === undefined) return '';
  const href = attr(drawImage, 'href') ?? '';
  const hasBinary = firstDescendant(element, 'binary-data') !== undefined;
  if (href === '' && !hasBinary) return '';
  const desc = firstDescendant(element, 'desc') ?? firstDescendant(element, 'title');
  const alt = desc === undefined ? '' : textOf(desc).trim();
  if (/^https?:/i.test(href)) {
    if (!state.remoteImages.includes(href)) state.remoteImages.push(href);
    return '';
  }
  if (/^data:/i.test(href)) return '';
  if (/\.svgz?$/i.test(href)) {
    state.dropped.svg += 1;
    state.losses.push({ code: 'image-unreadable', message: 'An SVG picture was refused, because it can carry script.', blockIndex: state.blocks.length });
    return '';
  }
  if (!PICTURE.test(href) && !hasBinary) {
    state.dropped.otherPictures += 1;
    state.losses.push({ code: 'image-unreadable', message: `A picture in a format Caotang does not keep (“${href}”) was left out.`, blockIndex: state.blocks.length });
    return '';
  }
  const ref = `${state.options.refPrefix}${(state.imageIndex += 1)}`;
  state.assets.push({ ref, name: href === '' ? `${ref}.png` : href.slice(href.lastIndexOf('/') + 1) });
  const binary = firstDescendant(element, 'binary-data');
  if (binary !== undefined) {
    const bytes = base64Bytes(textOf(binary));
    if (bytes !== null) state.inlineImages.set(ref, bytes);
  } else {
    state.imageTargets.set(ref, href);
  }
  return state.options.images ? `![${alt}](${ref})` : '';
}

/** A flat document's picture, kept as base64 inside the frame. */
function base64Bytes(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, '');
  if (clean === '') return null;
  try {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Read the content part of an ODF document. */
function readContent(root: XmlElement, state: State): void {
  collectStyles(root, state.styles);
  collectListStyles(root, state.orderedLists);
  for (const region of descendants(root, 'changed-region')) {
    const id = attr(region, 'id');
    if (id === undefined) continue;
    const insertion = kid(region, 'insertion');
    const deletion = kid(region, 'deletion');
    const kind = insertion !== undefined ? 'insertion' : deletion !== undefined ? 'deletion' : null;
    if (kind === null) continue;
    const body = insertion ?? deletion;
    const text = body === undefined ? '' : kids(body, 'p').map((p) => plain(p, state)).join(' ').trim();
    state.regions.set(id, { kind, text });
  }

  const body = firstDescendant(root, 'text') ?? firstDescendant(root, 'body');
  if (body === undefined) return;

  let emptyRun = 0;
  const push = (block: ImportBlock): void => {
    state.blocks.push(block);
    emptyRun = 0;
  };

  const paragraph = (element: XmlElement, listPrefix: string | null): void => {
    const style = resolve(state.styles, attr(element, 'style-name'));
    if (style !== null) {
      if (style.font) state.dropped.fonts += 1;
      if (style.colour) state.dropped.colours += 1;
      if (style.indent) state.dropped.indents += 1;
    }
    const before = state.blocks.length;
    state.annotation = { text: '' };
    const md = children(element, state, { bold: style?.bold === true, italic: style?.italic === true, strike: style?.strike === true, underline: style?.underline === true }).replace(/[ \t]+/g, ' ').trim();
    const anchored = state.annotation.text;
    state.annotation = null;
    // The annotation's own text is what it anchors; the paragraph's text without the note is close enough and is what the writer sees.
    if (anchored === '' && state.comments.length > 0 && state.comments[state.comments.length - 1]?.blockIndex === before && md !== '') {
      const last = state.comments[state.comments.length - 1];
      if (last !== undefined && !last.md.startsWith('>')) state.comments[state.comments.length - 1] = { ...last, md: `> “${md}”\n\n${last.md}` };
    }
    const outline = attr(element, 'outline-level');
    const heading = element.local === 'h' ? Math.min(6, Math.max(1, Number(outline ?? '1'))) : null;
    const pageBreak = style?.pageBreak === true || kid(element, 'soft-page-break') !== undefined;
    if (md === '') {
      emptyRun += 1;
      const previous = state.blocks[state.blocks.length - 1];
      if (previous !== undefined && (previous.kind === 'para' || previous.kind === 'heading')) {
        state.blocks[state.blocks.length - 1] = { ...previous, src: { ...(previous.src ?? {}), emptyAfter: emptyRun } };
      }
      if (pageBreak) push({ kind: 'pagebreak' });
      return;
    }
    const signals: Signals = {
      ...(style === null ? {} : { styleName: style.name }),
      ...(heading === null ? {} : { outlineLevel: heading }),
      ...(style?.align === null || style === null ? {} : { align: style.align }),
      ...(style?.bold === true ? { allBold: true } : {}),
      ...(style?.caps === true ? { allCaps: true } : {}),
      ...(pageBreak ? { pageBreakBefore: true } : {}),
      ...(state.options.unit === undefined ? {} : { sourceUnit: state.options.unit }),
      ...(emptyRun === 0 ? {} : { emptyBefore: emptyRun }),
    };
    if (pageBreak && state.blocks.length > 0) push({ kind: 'pagebreak' });
    if (md.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim() === '' && state.assets.length > 0) {
      const images = [...md.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)];
      if (images.length > 0) {
        for (const m of images) push({ kind: 'image', assetRef: m[2] ?? '', alt: m[1] ?? '' });
        return;
      }
    }
    if (heading !== null) {
      push({ kind: 'heading', level: heading, text: md.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'), md: `${'#'.repeat(heading)} ${md}`, src: signals });
      return;
    }
    const safe = escapeLineStarts(md);
    const text = listPrefix !== null ? `${listPrefix}${safe}` : style?.quote === true ? `> ${safe}` : safe;
    push({ kind: 'para', md: text, text: md, src: signals });
  };

  const walk = (element: XmlElement, depth: number, ordered: boolean): void => {
    for (const child of element.children) {
      if (child.type !== 'element') continue;
      if (child.local === 'p' || child.local === 'h') {
        paragraph(child, null);
        continue;
      }
      if (child.local === 'list') {
        const named = attr(child, 'style-name');
        walk(child, depth + 1, named === undefined ? ordered : state.orderedLists.has(named));
        continue;
      }
      if (child.local === 'list-item') {
        const prefix = `${'  '.repeat(Math.max(0, depth - 1))}${ordered ? '1.' : '-'} `;
        for (const inner of child.children) {
          if (inner.type !== 'element') continue;
          if (inner.local === 'p' || inner.local === 'h') paragraph(inner, prefix);
          else if (inner.local === 'list') walk(inner, depth + 1, ordered);
        }
        continue;
      }
      if (child.local === 'table') {
        const rows = kids(child, 'table-row');
        state.losses.push({ code: 'table', message: `A table of ${rows.length} rows was read as paragraphs.`, blockIndex: state.blocks.length, count: rows.length });
        for (const row of rows) {
          const cells = kids(row, 'table-cell').map((cell) => kids(cell, 'p').map((p) => plain(p, state)).filter((text) => text !== '').join(' '));
          const md = cells.filter((cell) => cell !== '').join(' — ');
          if (md !== '') push({ kind: 'para', md, text: md, src: state.options.unit === undefined ? {} : { sourceUnit: state.options.unit } });
        }
        continue;
      }
      if (child.local === 'soft-page-break') {
        push({ kind: 'pagebreak' });
        continue;
      }
      if (child.local === 'frame' || child.local === 'image') {
        const box = firstDescendant(child, 'text-box');
        if (box !== undefined) {
          const md = textBox(box, state);
          if (md !== '') push({ kind: 'para', md, text: md, src: state.options.unit === undefined ? {} : { sourceUnit: state.options.unit } });
        } else {
          const md = image(child, state);
          if (md !== '') push({ kind: 'para', md, text: '', src: state.options.unit === undefined ? {} : { sourceUnit: state.options.unit } });
        }
        continue;
      }
      if (child.local === 'tracked-changes' || child.local === 'sequence-decls') continue;
      walk(child, depth, ordered);
    }
  };
  walk(body, 0, false);
}

/** Read an opened `.odt` package. */
export async function readOdtArchive(archive: ImportArchive, options: OdtOptions = {}): Promise<OdtResult> {
  if (archive.entry('content.xml') === undefined) return { ok: false, error: { kind: 'not-odt' } };
  const read = await archive.read('content.xml');
  if (!read.ok) return { ok: false, error: { kind: 'archive', message: read.error.message } };
  const parsed = readXml(read.value);
  if (!parsed.ok) return { ok: false, error: { kind: 'not-xml', message: parsed.error.message } };

  const partText = async (path: string): Promise<string> => {
    if (archive.entry(path) === undefined) return '';
    const bytes = await archive.read(path);
    return bytes.ok ? new TextDecoder().decode(bytes.value) : '';
  };

  const state = newState(options);
  const stylesXml = await partText('styles.xml');
  if (stylesXml !== '') {
    const styles = readXml(stylesXml);
    if (styles.ok) {
      collectStyles(styles.document.root, state.styles);
      collectListStyles(styles.document.root, state.orderedLists);
    }
  }
  readContent(parsed.document.root, state);

  const assetData = new Map<string, Uint8Array>();
  for (const [ref, target] of state.imageTargets) {
    const bytes = await archive.read(target.replace(/^\.\//, ''));
    if (!bytes.ok) {
      state.losses.push({ code: 'image-unreadable', message: `The picture “${target}” is not in the file.` });
      continue;
    }
    assetData.set(ref, bytes.value);
    const asset = state.assets.find((entry) => entry.ref === ref);
    if (asset !== undefined) asset.bytes = bytes.value.length;
  }

  const meta = await metaOf(await partText('meta.xml'));
  for (const [ref, bytes] of state.inlineImages) assetData.set(ref, bytes);
  return finish(state, assetData, meta);
}

function newState(options: OdtOptions): State {
  return {
    styles: new Map(),
    regions: new Map(),
    options: {
      tracked: options.tracked ?? 'accept',
      underlineAs: options.underlineAs ?? 'italic',
      images: options.images ?? true,
      comments: options.comments ?? true,
      unit: options.unit,
      refPrefix: options.refPrefix ?? 'import:odt-image-',
    },
    blocks: [],
    losses: [],
    notes: [],
    comments: [],
    assets: [],
    imageTargets: new Map(),
    orderedLists: new Set(),
    inlineImages: new Map(),
    remoteImages: [],
    changes: { insertions: 0, deletions: 0 },
    dropped: { ...EMPTY_DROPPED },
    deletions: [],
    noteIndex: 0,
    imageIndex: 0,
    suppressed: 0,
    annotation: null,
    inBody: 0,
  };
}

async function metaOf(xml: string): Promise<{ title: string; author: string; language: string }> {
  if (xml === '') return { title: '', author: '', language: '' };
  const parsed = readXml(xml);
  if (!parsed.ok) return { title: '', author: '', language: '' };
  const pick = (local: string): string => {
    const found = firstDescendant(parsed.document.root, local);
    return found === undefined ? '' : textOf(found).trim();
  };
  return { title: pick('title'), author: pick('initial-creator') || pick('creator'), language: pick('language') };
}

function finish(state: State, assetData: Map<string, Uint8Array>, meta: { title: string; author: string; language: string }): OdtResult {
  if (state.blocks.length === 0) return { ok: false, error: { kind: 'empty' } };
  const document: ImportDocument = {
    blocks: state.blocks,
    footnotes: state.notes,
    comments: state.comments,
    deletions: state.deletions,
    assets: state.assets.filter((asset) => assetData.has(asset.ref)),
    losses: state.losses,
    metadata: {
      ...(meta.title === '' ? {} : { title: meta.title }),
      ...(meta.author === '' ? {} : { author: meta.author }),
      ...(meta.language === '' ? {} : { language: meta.language }),
    },
  };
  return {
    ok: true,
    value: { document, title: meta.title, author: meta.author, language: meta.language, assetData, changes: state.changes, dropped: state.dropped, deletions: state.deletions, remoteImages: state.remoteImages },
  };
}

/** Read an `.odt`'s bytes, or a flat `.fodt`'s: the bytes say which. */
export async function readOdt(bytes: Uint8Array, options: OdtOptions = {}): Promise<OdtResult> {
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (zipped) {
    const archive = await openZip(bytes);
    if (!archive.ok) return { ok: false, error: { kind: 'archive', message: archive.error.message } };
    return readOdtArchive(archive.value, options);
  }
  const parsed = readXml(bytes);
  if (!parsed.ok) return { ok: false, error: { kind: 'not-xml', message: parsed.error.message } };
  const root = parsed.document.root;
  if (root.local !== 'document') return { ok: false, error: { kind: 'not-odt' } };
  const state = newState(options);
  readContent(root, state);
  // A flat document keeps its pictures as base64 inside the frame, and its metadata beside the body.
  const assetData = new Map<string, Uint8Array>(state.inlineImages);
  for (const asset of state.assets) {
    const bytes = assetData.get(asset.ref);
    if (bytes !== undefined) asset.bytes = bytes.length;
  }
  const meta = firstDescendant(root, 'meta');
  const pick = (local: string): string => {
    const found = meta === undefined ? undefined : firstDescendant(meta, local);
    return found === undefined ? '' : textOf(found).trim();
  };
  return finish(state, assetData, { title: pick('title'), author: pick('initial-creator') || pick('creator'), language: pick('language') });
}
