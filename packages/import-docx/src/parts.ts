/**
 * The parts of a `.docx` beside the body (#279): styles and their `w:basedOn` chains, list numbering, relationships,
 * footnotes, endnotes, comments and the core properties. Each is read with the shared XML reader; nothing here runs.
 */

import { escapeInline, escapeLineStarts } from '@caotang/import-core';
import { attr, readXml, textOf, type XmlElement } from '@caotang/import-read/xml';

/** Word text can arrive in fragments; escape every source tilde so fragments cannot join into strike syntax. */
export function escapeDocxInline(text: string): string {
  const escaped = escapeInline(text);
  let out = '';
  for (let index = 0; index < escaped.length; index += 1) {
    const ch = escaped[index] as string;
    if (ch === '\\' && index + 1 < escaped.length) {
      out += ch + (escaped[index + 1] as string);
      index += 1;
      continue;
    }
    out += ch === '~' ? '\\~' : ch;
  }
  return out;
}

/** The WordprocessingML namespace every `w:` element is in. */
export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
/** The relationship namespace (`r:embed`, `r:id`). */
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** An element's children with a local name in the Word namespace. */
export function kids(element: XmlElement, local: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child.type === 'element' && child.local === local && child.ns === W);
}

/** The first child with a local name, or undefined. */
export function kid(element: XmlElement, local: string): XmlElement | undefined {
  return kids(element, local)[0];
}

/** `w:val` of a child, or undefined. */
export function valOf(element: XmlElement, local: string): string | undefined {
  const child = kid(element, local);
  return child === undefined ? undefined : attr(child, 'val', W);
}

/** A `w:tbl`-style on/off property: present without `w:val`, or with a value that is not false, is on. */
export function isOn(element: XmlElement | undefined, local: string): boolean {
  if (element === undefined) return false;
  const child = kid(element, local);
  if (child === undefined) return false;
  const value = attr(child, 'val', W);
  return value === undefined || (value !== '0' && value !== 'false' && value !== 'off');
}

export interface DocxStyle {
  id: string;
  name: string;
  basedOn: string | null;
  outlineLevel: number | null;
  align: 'left' | 'center' | 'right' | 'justify' | null;
  bold: boolean;
  caps: boolean;
  /** The style's font size in half-points, as Word writes it. */
  size: number | null;
  quote: boolean;
}

const ALIGN: Readonly<Record<string, DocxStyle['align']>> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', justify: 'justify' };
const QUOTE_NAMES = new Set(['quote', 'block text', 'intense quote', 'block quote', 'blockquote']);

/** `word/styles.xml`, as a map by style id. */
export function parseStyles(xml: string): Map<string, DocxStyle> {
  const styles = new Map<string, DocxStyle>();
  const parsed = readXml(xml);
  if (!parsed.ok) return styles;
  for (const element of kids(parsed.document.root, 'style')) {
    const id = attr(element, 'styleId', W);
    if (id === undefined) continue;
    const name = valOf(element, 'name') ?? id;
    const pPr = kid(element, 'pPr');
    const rPr = kid(element, 'rPr');
    const outline = pPr === undefined ? undefined : valOf(pPr, 'outlineLvl');
    const jc = pPr === undefined ? undefined : valOf(pPr, 'jc');
    const size = rPr === undefined ? undefined : valOf(rPr, 'sz');
    styles.set(id, {
      id,
      name,
      basedOn: valOf(element, 'basedOn') ?? null,
      outlineLevel: outline === undefined ? null : Number(outline) + 1,
      align: jc === undefined ? null : (ALIGN[jc] ?? null),
      bold: isOn(rPr, 'b'),
      caps: isOn(rPr, 'caps'),
      size: size === undefined ? null : Number(size),
      quote: QUOTE_NAMES.has(name.toLowerCase()),
    });
  }
  return styles;
}

/** A style with its `basedOn` chain resolved. A cycle stops at the style already seen. */
export function resolveStyle(styles: ReadonlyMap<string, DocxStyle>, id: string | undefined): DocxStyle | null {
  if (id === undefined) return null;
  const seen = new Set<string>();
  const chain: DocxStyle[] = [];
  let current = styles.get(id);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.basedOn === null ? undefined : styles.get(current.basedOn);
  }
  const first = chain[0];
  if (first === undefined) return null;
  const inherit = <T>(pick: (style: DocxStyle) => T | null, fallback: T): T => {
    for (const style of chain) {
      const value = pick(style);
      if (value !== null) return value;
    }
    return fallback;
  };
  return {
    id: first.id,
    name: first.name,
    basedOn: first.basedOn,
    outlineLevel: inherit((style) => style.outlineLevel, null),
    align: inherit((style) => style.align, null),
    bold: chain.some((style) => style.bold),
    caps: chain.some((style) => style.caps),
    size: inherit((style) => style.size, null),
    quote: chain.some((style) => style.quote),
  };
}

export interface DocxLevel {
  /** `bullet`, `decimal`, or the raw format Word wrote. */
  format: string;
  text: string;
  start: number;
}

/** `word/numbering.xml`: numId → its levels, through the abstract numbering it points at. */
export function parseNumbering(xml: string): Map<string, DocxLevel[]> {
  const levels = new Map<string, DocxLevel[]>();
  const parsed = readXml(xml);
  if (!parsed.ok) return levels;
  const abstracts = new Map<string, DocxLevel[]>();
  for (const element of kids(parsed.document.root, 'abstractNum')) {
    const id = attr(element, 'abstractNumId', W);
    if (id === undefined) continue;
    const byLevel: DocxLevel[] = [];
    for (const level of kids(element, 'lvl')) {
      const index = Number(attr(level, 'ilvl', W) ?? '0');
      byLevel[index] = {
        format: valOf(level, 'numFmt') ?? 'bullet',
        text: valOf(level, 'lvlText') ?? '',
        start: Number(valOf(level, 'start') ?? '1'),
      };
    }
    abstracts.set(id, byLevel);
  }
  for (const element of kids(parsed.document.root, 'num')) {
    const id = attr(element, 'numId', W);
    const abstract = valOf(element, 'abstractNumId');
    if (id === undefined || abstract === undefined) continue;
    levels.set(id, abstracts.get(abstract) ?? []);
  }
  return levels;
}

export interface DocxRel {
  target: string;
  /** `image`, `hyperlink`, … as the relationship type's last path segment. */
  kind: string;
  external: boolean;
}

/** `word/_rels/document.xml.rels`: relationship id → target. */
export function parseRels(xml: string): Map<string, DocxRel> {
  const rels = new Map<string, DocxRel>();
  const parsed = readXml(xml);
  if (!parsed.ok) return rels;
  for (const element of parsed.document.root.children) {
    if (element.type !== 'element' || element.local !== 'Relationship') continue;
    const id = attr(element, 'Id');
    const target = attr(element, 'Target');
    if (id === undefined || target === undefined) continue;
    const type = attr(element, 'Type') ?? '';
    rels.set(id, { target, kind: type.slice(type.lastIndexOf('/') + 1), external: (attr(element, 'TargetMode') ?? '') === 'External' });
  }
  return rels;
}

export interface DocxNote {
  id: string;
  md: string;
  author: string;
  date: string;
}

/**
 * `word/footnotes.xml`, `word/endnotes.xml` or `word/comments.xml`: each note's paragraphs as Markdown. The separator
 * and continuation notes Word writes with a negative id are not notes and are left out.
 */
export function parseNotes(xml: string, local: 'footnote' | 'endnote' | 'comment'): Map<string, DocxNote> {
  const notes = new Map<string, DocxNote>();
  const parsed = readXml(xml);
  if (!parsed.ok) return notes;
  for (const element of kids(parsed.document.root, local)) {
    const id = attr(element, 'id', W);
    if (id === undefined || Number(id) < 0) continue;
    const paragraphs: string[] = [];
    for (const paragraph of kids(element, 'p')) {
      const text = plainParagraph(paragraph);
      if (text !== '') paragraphs.push(text);
    }
    notes.set(id, {
      id,
      md: paragraphs.join('\n\n'),
      author: attr(element, 'author', W) ?? '',
      date: attr(element, 'date', W) ?? '',
    });
  }
  return notes;
}

/** A paragraph's text without its formatting: enough for a note or a comment. */
function plainParagraph(paragraph: XmlElement): string {
  let out = '';
  const walk = (element: XmlElement): void => {
    for (const child of element.children) {
      if (child.type === 'text') {
        out += escapeDocxInline(child.text);
        continue;
      }
      if (child.type !== 'element') continue;
      if (child.ns === W && (child.local === 'del' || child.local === 'instrText')) continue;
      if (child.ns === W && child.local === 'tab') {
        out += '\t';
        continue;
      }
      if (child.ns === W && child.local === 'br') {
        out += '\n';
        continue;
      }
      walk(child);
    }
  };
  walk(paragraph);
  return escapeLineStarts(out.replace(/[ \t]+/g, ' ').trim());
}

/** `docProps/core.xml`: the title and the creator. */
export function parseCore(xml: string): { title: string; author: string; language: string } {
  const parsed = readXml(xml);
  if (!parsed.ok) return { title: '', author: '', language: '' };
  const root = parsed.document.root;
  const pick = (local: string): string => {
    for (const child of root.children) {
      if (child.type === 'element' && child.local === local) return textOf(child).trim();
    }
    return '';
  };
  return { title: pick('title'), author: pick('creator'), language: pick('language') };
}
