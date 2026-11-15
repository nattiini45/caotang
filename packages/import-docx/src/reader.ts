/**
 * The Word reader (#279, epic #263): a `.docx` read into the import block list on the shared zip and XML layer.
 * An own reader by decision 1 — no mammoth, no second zip library, and a reject mode for tracked changes. Nothing
 * here runs, fetches or evaluates; pandoc and mammoth were behavioural references only and no code is copied.
 */

import type { ImportAsset, ImportBlock, ImportComment, ImportDocument, ImportFootnote, LossWarning, Signals } from '@caotang/import-core';
import { attr, readXml, textOf, type XmlElement } from '@caotang/import-read/xml';
import { openZip, type ImportArchive } from '@caotang/import-read/zip';

import {
  R,
  W,
  isOn,
  kid,
  kids,
  parseCore,
  parseNotes,
  parseNumbering,
  parseRels,
  parseStyles,
  resolveStyle,
  valOf,
  type DocxLevel,
  type DocxNote,
  type DocxRel,
  type DocxStyle,
} from './parts.js';

export type TrackedMode = 'accept' | 'reject' | 'keep';

export interface DocxOptions {
  /** What to do with insertions and deletions. `accept` by default. */
  tracked?: TrackedMode;
  /** Underline as italics (the default), or dropped and counted. */
  underlineAs?: 'italic' | 'none';
  /** Bring the pictures in. On by default. */
  images?: boolean;
  /** Comments as scene notes. On by default. */
  comments?: boolean;
  /** `Signals.sourceUnit` for a file in a batch. */
  unit?: string;
  /** The picture refs' namespace, so two files' pictures never share a ref. */
  refPrefix?: string;
}

export interface DocxChanges {
  insertions: number;
  deletions: number;
  moves: number;
  /** Paragraph marks that were inserted or deleted: counted, never merged. */
  paragraphMarks: number;
}

export interface DocxDropped {
  underline: number;
  smallCaps: number;
  fonts: number;
  colours: number;
  highlighting: number;
  indents: number;
  unsafeLinks: number;
  textBoxes: number;
  /** EMF or WMF pictures, listed and skipped. */
  emf: number;
  /** SVG pictures, refused by the registry's rule. */
  svg: number;
  /** Paragraphs of a generated table of contents, kept out of the chapters. */
  toc: number;
}

export interface DocxImport {
  document: ImportDocument;
  title: string;
  author: string;
  language: string;
  assetData: Map<string, Uint8Array>;
  changes: DocxChanges;
  dropped: DocxDropped;
  /** Deletions kept for the notes, in `keep` mode, by the block they sat in. */
  deletions: { blockIndex: number; text: string }[];
  remoteImages: string[];
}

export type DocxError =
  | { kind: 'not-docx' }
  | { kind: 'archive'; message: string }
  | { kind: 'not-xml'; message: string }
  | { kind: 'empty' };

export type DocxResult = { ok: true; value: DocxImport } | { ok: false; error: DocxError };

const EMPTY_DROPPED: DocxDropped = { underline: 0, smallCaps: 0, fonts: 0, colours: 0, highlighting: 0, indents: 0, unsafeLinks: 0, textBoxes: 0, emf: 0, svg: 0, toc: 0 };
const EMPTY_CHANGES: DocxChanges = { insertions: 0, deletions: 0, moves: 0, paragraphMarks: 0 };

const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const HEADING_NAME = /^(heading|überschrift|titre|título|titolo|heading)\s*([1-9])$/i;
const TITLE_NAMES = new Set(['title', 'titel', 'titre', 'título', 'titolo', '标题']);

/** The safe-href rule the other readers use: http(s), mailto, or a relative target. */
function safeHref(href: string): boolean {
  const target = href.replace(/[\t\n\r]/g, '').trim();
  if (/^(https?:|mailto:)/i.test(target)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(target);
}

/** Every descendant element with a local name, in document order. */
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

interface RunStyle {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: boolean;
  caps: boolean;
  size: number | null;
}

const PLAIN: RunStyle = { bold: false, italic: false, strike: false, underline: false, caps: false, size: null };

function runStyle(rPr: XmlElement | undefined, dropped: DocxDropped): RunStyle {
  if (rPr === undefined) return PLAIN;
  if (isOn(rPr, 'smallCaps')) dropped.smallCaps += 1;
  if (kid(rPr, 'rFonts') !== undefined) dropped.fonts += 1;
  if (kid(rPr, 'color') !== undefined) dropped.colours += 1;
  if (kid(rPr, 'highlight') !== undefined) dropped.highlighting += 1;
  const size = valOf(rPr, 'sz');
  return {
    bold: isOn(rPr, 'b'),
    italic: isOn(rPr, 'i'),
    strike: isOn(rPr, 'strike'),
    underline: isOn(rPr, 'u'),
    caps: isOn(rPr, 'caps'),
    size: size === undefined ? null : Number(size),
  };
}

/** Text wrapped in the Markdown its runs asked for. */
function emphasise(text: string, style: RunStyle, underlineAs: 'italic' | 'none'): string {
  if (text === '' || text.trim() === '') return text;
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  const tail = /\s*$/.exec(text)?.[0] ?? '';
  let core = text.slice(lead.length, text.length - tail.length);
  if (style.strike) core = `~~${core}~~`;
  if (style.bold) core = `**${core}**`;
  if (style.italic || (style.underline && underlineAs === 'italic')) core = `*${core}*`;
  return `${lead}${core}${tail}`;
}

interface WalkState {
  options: Required<Pick<DocxOptions, 'tracked' | 'underlineAs' | 'images' | 'comments'>> & { unit: string | undefined; refPrefix: string };
  styles: Map<string, DocxStyle>;
  numbering: Map<string, DocxLevel[]>;
  rels: Map<string, DocxRel>;
  footnotes: Map<string, DocxNote>;
  endnotes: Map<string, DocxNote>;
  comments: Map<string, DocxNote>;
  blocks: ImportBlock[];
  losses: LossWarning[];
  notes: ImportFootnote[];
  commentList: ImportComment[];
  assets: ImportAsset[];
  assetData: Map<string, Uint8Array>;
  imageTargets: Map<string, string>;
  remoteImages: string[];
  changes: DocxChanges;
  dropped: DocxDropped;
  deletions: { blockIndex: number; text: string }[];
  sizes: number[];
  /** Each paragraph's own median run size, by the block index it will get. */
  paragraphSizes: Map<number, number>;
  /** A `w:br w:type="page"` inside the paragraph being read. */
  pageBreakInRuns: boolean;
  noteIndex: number;
  imageIndex: number;
  /** The comment ranges open at this point, by id, with the text they have anchored so far. */
  openComments: Map<string, { start: number; text: string }>;
  tocDepth: number;
}

/** The runs of a paragraph, as Markdown, with the notes and pictures they carry. */
function renderRuns(element: XmlElement, state: WalkState, inherited: RunStyle, deleting: boolean): string {
  let out = '';
  for (const child of element.children) {
    if (child.type === 'text') {
      out += deleting ? '' : child.text;
      continue;
    }
    if (child.type !== 'element') continue;
    const local = child.ns === W ? child.local : '';
    if (local === 'r') {
      const rPr = kid(child, 'rPr');
      const style = runStyle(rPr, state.dropped);
      if (style.size !== null) state.sizes.push(style.size);
      if (style.underline) state.dropped.underline += 1;
      let text = '';
      for (const part of child.children) {
        if (part.type === 'text') {
          text += part.text;
          continue;
        }
        if (part.type !== 'element') continue;
        const name = part.ns === W ? part.local : '';
        if (name === 't' || name === 'delText') text += textOf(part);
        else if (name === 'tab') text += '\t';
        else if (name === 'br') {
          if (attr(part, 'type', W) === 'page') state.pageBreakInRuns = true;
          else text += '\n';
        }
        else if (name === 'noBreakHyphen') text += '-';
        else if (name === 'softHyphen') text += '';
        else if (name === 'instrText') text += '';
        else if (name === 'footnoteReference' || name === 'endnoteReference') {
          const id = attr(part, 'id', W) ?? '';
          const note = name === 'footnoteReference' ? state.footnotes.get(id) : state.endnotes.get(id);
          if (note !== undefined) {
            state.noteIndex += 1;
            const label = String(state.noteIndex);
            text += `[^${label}]`;
            state.notes.push({ blockIndex: state.blocks.length, label, md: note.md });
          }
        } else if (name === 'commentReference') {
          const id = attr(part, 'id', W) ?? '';
          const note = state.comments.get(id);
          const open = state.openComments.get(id);
          if (note !== undefined && state.options.comments) {
            const anchored = open?.text ?? '';
            const who = [note.author, note.date.slice(0, 10)].filter((part2) => part2 !== '').join(', ');
            const quote = anchored === '' ? '' : `> “${anchored}”\n\n`;
            state.commentList.push({ blockIndex: state.blocks.length, md: `${quote}${note.md}${who === '' ? '' : `\n\n— ${who}`}` });
          }
          state.openComments.delete(id);
        } else if (name === 'drawing' || name === 'pict' || name === 'object') {
          text += imageOf(part, state);
        } else if (name === 'txbxContent') {
          state.dropped.textBoxes += 1;
          state.losses.push({ code: 'text-box', message: 'A text box was read as a paragraph.', blockIndex: state.blocks.length });
          for (const paragraph of kids(part, 'p')) text += renderRuns(paragraph, state, inherited, deleting);
        }
      }
      out += deleting ? '' : emphasise(text, { ...style, bold: style.bold || inherited.bold, italic: style.italic || inherited.italic, caps: style.caps || inherited.caps }, state.options.underlineAs);
      for (const open of state.openComments.values()) open.text += text;
      continue;
    }
    if (local === 'ins' || local === 'moveTo') {
      state.changes.insertions += 1;
      if (local === 'moveTo') state.changes.moves += 1;
      if (state.options.tracked === 'reject') continue;
      out += renderRuns(child, state, inherited, deleting);
      continue;
    }
    if (local === 'del' || local === 'moveFrom') {
      state.changes.deletions += 1;
      if (local === 'moveFrom') state.changes.moves += 1;
      if (state.options.tracked === 'accept') continue;
      const text = renderRuns(child, state, inherited, false);
      if (state.options.tracked === 'keep') {
        if (text.trim() !== '') state.deletions.push({ blockIndex: state.blocks.length, text });
        continue;
      }
      out += text;
      continue;
    }
    if (local === 'hyperlink') {
      const id = attr(child, 'id', R);
      const rel = id === undefined ? undefined : state.rels.get(id);
      const text = renderRuns(child, state, inherited, deleting);
      if (rel === undefined || !safeHref(rel.target)) {
        if (rel !== undefined) state.dropped.unsafeLinks += 1;
        out += text;
        continue;
      }
      out += text.trim() === '' ? text : `[${text}](${rel.target})`;
      continue;
    }
    if (local === 'commentRangeStart') {
      const id = attr(child, 'id', W) ?? '';
      state.openComments.set(id, { start: state.blocks.length, text: '' });
      continue;
    }
    if (local === 'commentRangeEnd') continue;
    if (local === 'pPr' || local === 'proofErr' || local === 'bookmarkStart' || local === 'bookmarkEnd') continue;
    out += renderRuns(child, state, inherited, deleting);
  }
  return out;
}

/** A drawing or a legacy picture: its ref, or nothing when it cannot come in. */
function imageOf(element: XmlElement, state: WalkState): string {
  const blip = descendants(element, 'blip')[0] ?? descendants(element, 'imagedata')[0];
  if (blip === undefined) return '';
  const id = attr(blip, 'embed', R) ?? attr(blip, 'id', R);
  const rel = id === undefined ? undefined : state.rels.get(id);
  if (rel === undefined) return '';
  const docPr = descendants(element, 'docPr')[0];
  const alt = docPr === undefined ? '' : (attr(docPr, 'descr') ?? attr(docPr, 'title') ?? '');
  if (/^https?:/i.test(rel.target)) {
    if (!state.remoteImages.includes(rel.target)) state.remoteImages.push(rel.target);
    return '';
  }
  if (/\.svgz?$/i.test(rel.target)) {
    state.dropped.svg += 1;
    state.losses.push({ code: 'image-unreadable', message: 'An SVG picture was refused, because it can carry script.', blockIndex: state.blocks.length });
    return '';
  }
  if (/\.(emf|wmf)$/i.test(rel.target)) {
    state.dropped.emf += 1;
    state.losses.push({ code: 'image-unreadable', message: 'A Windows metafile picture (EMF or WMF) was left out.', blockIndex: state.blocks.length });
    return '';
  }
  if (!PICTURE.test(rel.target)) return '';
  const ref = `${state.options.refPrefix}${(state.imageIndex += 1)}`;
  state.assets.push({ ref, name: rel.target.slice(rel.target.lastIndexOf('/') + 1) });
  state.imageTargets.set(ref, rel.target);
  if (!state.options.images) return '';
  return `![${alt}](${ref})`;
}

/** A paragraph's own properties: its style, its numbering, its breaks. */
function paragraphSignals(paragraph: XmlElement, state: WalkState, md: string): { signals: Signals; heading: number | null; list: string | null; quote: boolean; pageBreak: boolean; toc: boolean } {
  const pPr = kid(paragraph, 'pPr');
  const styleId = pPr === undefined ? undefined : valOf(pPr, 'pStyle');
  const style = resolveStyle(state.styles, styleId);
  const rPr = pPr === undefined ? undefined : kid(pPr, 'rPr');
  if (rPr !== undefined && (kid(rPr, 'ins') !== undefined || kid(rPr, 'del') !== undefined)) state.changes.paragraphMarks += 1;
  const outline = pPr === undefined ? undefined : valOf(pPr, 'outlineLvl');
  const jc = pPr === undefined ? undefined : valOf(pPr, 'jc');
  const align = jc === undefined ? (style?.align ?? null) : jc === 'both' ? 'justify' : jc === 'center' ? 'center' : jc === 'right' ? 'right' : 'left';
  const name = style?.name ?? '';
  const named = HEADING_NAME.exec(name.trim());
  const level = outline !== undefined ? Number(outline) + 1 : (style?.outlineLevel ?? (named === null ? null : Number(named[2])));
  const isTitle = TITLE_NAMES.has(name.trim().toLowerCase());
  const heading = level !== null && level >= 1 && level <= 6 ? level : isTitle ? 1 : null;

  const numPr = pPr === undefined ? undefined : kid(pPr, 'numPr');
  let list: string | null = null;
  if (numPr !== undefined) {
    const numId = valOf(numPr, 'numId') ?? '';
    const ilvl = Number(valOf(numPr, 'ilvl') ?? '0');
    const levels = state.numbering.get(numId) ?? [];
    const format = levels[ilvl]?.format ?? 'bullet';
    list = `${'  '.repeat(Math.max(0, ilvl))}${format === 'bullet' ? '-' : '1.'} `;
  }
  if (pPr !== undefined && kid(pPr, 'ind') !== undefined) state.dropped.indents += 1;
  const pageBreak = isOn(pPr, 'pageBreakBefore');
  const toc = state.tocDepth > 0 || descendants(paragraph, 'instrText').some((field) => /\bTOC\b/i.test(field.children.map((child) => (child.type === 'text' ? child.text : '')).join('')));
  const signals: Signals = {
    ...(name === '' ? {} : { styleName: name }),
    ...(heading === null ? {} : { outlineLevel: heading }),
    ...(align === null ? {} : { align }),
    ...(style?.bold === true && md.trim() !== '' ? { allBold: true } : {}),
    ...(style?.caps === true ? { allCaps: true } : {}),
    ...(pageBreak ? { pageBreakBefore: true } : {}),
    ...(state.options.unit === undefined ? {} : { sourceUnit: state.options.unit }),
    ...(toc ? { toc: true } : {}),
  };
  return { signals, heading, list, quote: style?.quote === true, pageBreak, toc };
}

/** Read one opened `.docx` archive. */
export async function readDocxArchive(archive: ImportArchive, options: DocxOptions = {}): Promise<DocxResult> {
  const documentEntry = archive.entry('word/document.xml');
  if (documentEntry === undefined) return { ok: false, error: { kind: 'not-docx' } };
  const read = await archive.read('word/document.xml');
  if (!read.ok) return { ok: false, error: { kind: 'archive', message: read.error.message } };
  const parsed = readXml(read.value);
  if (!parsed.ok) return { ok: false, error: { kind: 'not-xml', message: parsed.error.message } };

  const textOfPart = async (path: string): Promise<string> => {
    const entry = archive.entry(path);
    if (entry === undefined) return '';
    const bytes = await archive.read(path);
    if (!bytes.ok) return '';
    return new TextDecoder().decode(bytes.value);
  };

  const state: WalkState = {
    options: {
      tracked: options.tracked ?? 'accept',
      underlineAs: options.underlineAs ?? 'italic',
      images: options.images ?? true,
      comments: options.comments ?? true,
      unit: options.unit,
      refPrefix: options.refPrefix ?? 'import:docx-image-',
    },
    styles: parseStyles(await textOfPart('word/styles.xml')),
    numbering: parseNumbering(await textOfPart('word/numbering.xml')),
    rels: parseRels(await textOfPart('word/_rels/document.xml.rels')),
    footnotes: parseNotes(await textOfPart('word/footnotes.xml'), 'footnote'),
    endnotes: parseNotes(await textOfPart('word/endnotes.xml'), 'endnote'),
    comments: parseNotes(await textOfPart('word/comments.xml'), 'comment'),
    blocks: [],
    losses: [],
    notes: [],
    commentList: [],
    assets: [],
    assetData: new Map(),
    imageTargets: new Map(),
    remoteImages: [],
    changes: { ...EMPTY_CHANGES },
    dropped: { ...EMPTY_DROPPED },
    deletions: [],
    sizes: [],
    paragraphSizes: new Map(),
    pageBreakInRuns: false,
    noteIndex: 0,
    imageIndex: 0,
    openComments: new Map(),
    tocDepth: 0,
  };

  const body = kid(parsed.document.root, 'body');
  if (body === undefined) return { ok: false, error: { kind: 'not-docx' } };

  let emptyRun = 0;
  const push = (block: ImportBlock): void => {
    state.blocks.push(block);
    emptyRun = 0;
  };

  const paragraph = (element: XmlElement): void => {
    const sizeStart = state.sizes.length;
    state.pageBreakInRuns = false;
    const md = renderRuns(element, state, PLAIN, false).replace(/[ \t]+/g, ' ').trim();
    const own = state.sizes.slice(sizeStart).sort((a, b) => a - b);
    if (own.length > 0) state.paragraphSizes.set(state.blocks.length, own[Math.floor(own.length / 2)] ?? 0);
    const { signals, heading, list, quote, pageBreak, toc } = paragraphSignals(element, state, md);
    if (toc) state.dropped.toc += 1;
    if (md === '') {
      emptyRun += 1;
      const previous = state.blocks[state.blocks.length - 1];
      if (previous !== undefined && (previous.kind === 'para' || previous.kind === 'heading' || previous.kind === 'break')) {
        state.blocks[state.blocks.length - 1] = { ...previous, src: { ...(previous.src ?? {}), emptyAfter: emptyRun } };
      }
      if (pageBreak || state.pageBreakInRuns) push({ kind: 'pagebreak' });
      return;
    }
    const withEmpty: Signals = emptyRun === 0 ? signals : { ...signals, emptyBefore: emptyRun };
    if ((pageBreak || state.pageBreakInRuns) && state.blocks.length > 0) push({ kind: 'pagebreak' });
    const images = descendants(element, 'blip').length + descendants(element, 'imagedata').length;
    if (images > 0 && md.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim() === '') {
      const ref = state.assets[state.assets.length - 1]?.ref;
      const alt = /!\[([^\]]*)\]/.exec(md)?.[1] ?? '';
      if (ref !== undefined) {
        push({ kind: 'image', assetRef: ref, alt });
        return;
      }
    }
    if (heading !== null) {
      push({ kind: 'heading', level: heading, text: md.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'), md: `${'#'.repeat(heading)} ${md}`, src: withEmpty });
      return;
    }
    const body = list !== null ? `${list}${md}` : quote ? `> ${md}` : md;
    push({ kind: 'para', md: body, text: md, src: withEmpty });
  };

  const table = (element: XmlElement): void => {
    const rows = kids(element, 'tr');
    state.losses.push({ code: 'table', message: `A table of ${rows.length} rows was read as paragraphs.`, blockIndex: state.blocks.length, count: rows.length });
    for (const row of rows) {
      const cells = kids(row, 'tc').map((cell) => kids(cell, 'p').map((p) => renderRuns(p, state, PLAIN, false).trim()).filter((text) => text !== '').join(' '));
      const md = cells.filter((cell) => cell !== '').join(' — ');
      if (md !== '') push({ kind: 'para', md, text: md, src: { ...(state.options.unit === undefined ? {} : { sourceUnit: state.options.unit }) } });
    }
  };

  const walk = (element: XmlElement): void => {
    for (const child of element.children) {
      if (child.type !== 'element' || child.ns !== W) continue;
      if (child.local === 'p') {
        paragraph(child);
        continue;
      }
      if (child.local === 'tbl') {
        table(child);
        continue;
      }
      if (child.local === 'sdt') {
        const gallery = descendants(child, 'docPartGallery')[0];
        const isToc = gallery !== undefined && (attr(gallery, 'val', W) ?? '') === 'TOC';
        if (isToc) state.tocDepth += 1;
        const content = kid(child, 'sdtContent');
        if (content !== undefined) walk(content);
        if (isToc) state.tocDepth -= 1;
        continue;
      }
      if (child.local === 'sectPr') continue;
      walk(child);
    }
  };
  walk(body);

  // The document's median run size, so a paragraph's relative size means something.
  const sorted = [...state.sizes].sort((a, b) => a - b);
  const median = sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0);
  if (median > 0) {
    for (const [index, own] of state.paragraphSizes) {
      const block = state.blocks[index];
      if (block === undefined || (block.kind !== 'para' && block.kind !== 'heading')) continue;
      const ratio = Math.round((own / median) * 100) / 100;
      if (ratio === 1) continue;
      state.blocks[index] = { ...block, src: { ...(block.src ?? {}), fontSizeRel: ratio } };
    }
  }

  const assetData = new Map<string, Uint8Array>();
  for (const [ref, target] of state.imageTargets) {
    const path = target.startsWith('/') ? target.slice(1) : `word/${target.replace(/^\.\//, '')}`;
    const bytes = await archive.read(path);
    if (!bytes.ok) {
      state.losses.push({ code: 'image-unreadable', message: `The picture “${target}” is not in the file.` });
      continue;
    }
    assetData.set(ref, bytes.value);
    const asset = state.assets.find((entry) => entry.ref === ref);
    if (asset !== undefined) asset.bytes = bytes.value.length;
  }

  const core = parseCore(await textOfPart('docProps/core.xml'));
  const document: ImportDocument = {
    blocks: state.blocks,
    footnotes: state.notes,
    comments: state.commentList,
    assets: state.assets.filter((asset) => assetData.has(asset.ref)),
    losses: state.losses,
    metadata: {
      ...(core.title === '' ? {} : { title: core.title }),
      ...(core.author === '' ? {} : { author: core.author }),
      ...(core.language === '' ? {} : { language: core.language }),
    },
  };
  if (state.blocks.length === 0) return { ok: false, error: { kind: 'empty' } };

  return {
    ok: true,
    value: {
      document,
      title: core.title,
      author: core.author,
      language: core.language,
      assetData,
      changes: state.changes,
      dropped: state.dropped,
      deletions: state.deletions,
      remoteImages: state.remoteImages,
    },
  };
}

/** Read a `.docx`'s bytes: the zip is opened with the shared caps and zip-bomb guard. */
export async function readDocx(bytes: Uint8Array, options: DocxOptions = {}): Promise<DocxResult> {
  const archive = await openZip(bytes);
  if (!archive.ok) return { ok: false, error: { kind: 'archive', message: archive.error.message } };
  return readDocxArchive(archive.value, options);
}

/**
 * A zip **of** `.docx` files (a Sudowrite or NovelCrafter project export): one unit per file, so the splitter makes a
 * chapter per file, and each file's pictures keep their own refs.
 */
export async function readDocxZip(bytes: Uint8Array, options: DocxOptions = {}): Promise<DocxResult> {
  const outer = await openZip(bytes);
  if (!outer.ok) return { ok: false, error: { kind: 'archive', message: outer.error.message } };
  const files = outer.value.entries.filter((entry) => /\.docx$/i.test(entry.path)).map((entry) => entry.path);
  if (files.length === 0) return { ok: false, error: { kind: 'not-docx' } };

  const merged: DocxImport = {
    document: { blocks: [], footnotes: [], comments: [], assets: [], losses: [], metadata: {} },
    title: '',
    author: '',
    language: '',
    assetData: new Map(),
    changes: { ...EMPTY_CHANGES },
    dropped: { ...EMPTY_DROPPED },
    deletions: [],
    remoteImages: [],
  };
  for (const [index, path] of files.entries()) {
    const bytesIn = await outer.value.read(path);
    if (!bytesIn.ok) continue;
    const inner = await openZip(bytesIn.value);
    if (!inner.ok) continue;
    const read = await readDocxArchive(inner.value, { ...options, unit: path, refPrefix: `import:docx-image-${index + 1}-` });
    if (!read.ok) continue;
    const offset = merged.document.blocks.length;
    merged.document.blocks.push(...read.value.document.blocks);
    merged.document.footnotes?.push(...(read.value.document.footnotes ?? []).map((note) => ({ ...note, blockIndex: note.blockIndex + offset })));
    merged.document.comments?.push(...(read.value.document.comments ?? []).map((note) => ({ ...note, blockIndex: note.blockIndex + offset })));
    merged.document.assets?.push(...(read.value.document.assets ?? []));
    merged.document.losses?.push(...(read.value.document.losses ?? []).map((loss) => ({ ...loss, ...(loss.blockIndex === undefined ? {} : { blockIndex: loss.blockIndex + offset }) })));
    for (const [ref, data] of read.value.assetData) merged.assetData.set(ref, data);
    for (const key of Object.keys(merged.changes) as (keyof DocxChanges)[]) merged.changes[key] += read.value.changes[key];
    for (const key of Object.keys(merged.dropped) as (keyof DocxDropped)[]) merged.dropped[key] += read.value.dropped[key];
    merged.deletions.push(...read.value.deletions.map((deletion) => ({ ...deletion, blockIndex: deletion.blockIndex + offset })));
    for (const target of read.value.remoteImages) if (!merged.remoteImages.includes(target)) merged.remoteImages.push(target);
    if (merged.title === '') merged.title = read.value.title;
    if (merged.author === '') merged.author = read.value.author;
    if (merged.language === '') merged.language = read.value.language;
  }
  if (merged.document.blocks.length === 0) return { ok: false, error: { kind: 'empty' } };
  return { ok: true, value: merged };
}
