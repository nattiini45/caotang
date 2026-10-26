/**
 * Final Draft's XML — [screenplay.md §5.2](../../../docs/architecture/screenplay.md).
 *
 * Import is the v0.1-of-track half. Every paragraph is typed, so the import is mechanical:
 * FDX paragraphs become the element model, the element model becomes Fountain text, and
 * the Fountain importer maps that onto sections and scenes. Emit is the v0.2-of-track half,
 * and it is written to D11's answer: typed paragraphs, the title
 * page, `SceneProperties` Length and Page where pagination computed them, scene numbers kept
 * verbatim from the heading, and the page-number header layer from the paginator's pages.
 * Revision marks, locked pages and their colours are never emitted, since the model stores none.
 *
 * The scene-number attribute and the header element are the two encodings D11 calls
 * implementation-time residue. Their source read (Screenplain's FDX writer, rsdoiel/fdx) is not
 * complete, so both are unverified against a Final Draft file (a known gap). Import reads `Number` and
 * `<TitlePage>`, and is tested on XML written in this repo only: what Final Draft shows of either is not confirmed.
 *
 * FDX is a flat, machine-written format with no entities beyond the five predefined ones
 * and numeric references, so it is read here with a small reader rather than a parser
 * dependency (the vendor-if-dormant posture).
 *
 * The reader looks forward only. A pattern that matches a tag and its closing tag looks for the closing tag from every
 * tag it meets, so a file whose closing tags are missing — a truncated download, a save that ran out of room — would be
 * read in quadratic time. The scans below move forward only, so the cost is linear in the size of the file.
 */

import { printedText, sceneNumberOf, stripSceneNumber } from './classify.js';
import { importFountainScript, type ImportedScript } from './import.js';
import { paginate, sceneLengths } from './paginate.js';
import { parseFountain } from './parse.js';
import { serialiseFountain } from './serialise.js';
import type { FlatBlock } from './flat-block.js';
import type { ScreenplayElement } from './types.js';
import { renderFountain, type FountainRenderOptions } from './render-fountain.js';

export const FDX_MIME = 'application/xml';

/** One `<Paragraph>` as read from the file. */
export interface FdxParagraph {
  readonly type: string;
  readonly text: string;
  readonly alignment: string | null;
  /** From `SceneProperties Length`, in eighths of a page. Null when absent. */
  readonly lengthEighths: number | null;
  /** The index of the `DualDialogue` container this paragraph sits in, or null. */
  readonly container: number | null;
  /** From the `Number` attribute, trimmed. Null when absent or blank. */
  readonly number: string | null;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Whether a code point may name a character in an XML document (XML 1.0's `Char` production): tab, line feed and
 * carriage return, the printable range, and the astral planes. A surrogate, a control character and U+FFFE and U+FFFF
 * may not, so a reference to one of them names no character the file could hold.
 */
function isXmlChar(code: number): boolean {
  if (code === 0x9 || code === 0xa || code === 0xd) return true;
  if (code < 0x20) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  if (code === 0xfffe || code === 0xffff) return false;
  return code <= 0x10ffff;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#')) {
      const code = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // A reference that names no character XML allows stays as it was written, as an unknown entity does.
      return isXmlChar(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/([A-Za-z:]+)="([^"]*)"/g)) {
    out[m[1] ?? ''] = decodeEntities(m[2] ?? '');
  }
  return out;
}

/** A word character, which is what the `\b` after a tag name reads. */
const WORD_CHAR = /[A-Za-z0-9_]/;

/** One opening tag and the closing tag that ends it. */
interface TagMatch {
  /** Where the opening tag starts. */
  readonly start: number;
  /** The `>` that ends the opening tag. */
  readonly tagEnd: number;
  /** Where the closing tag starts. */
  readonly close: number;
  /** Where the closing tag ends. */
  readonly end: number;
}

/** The indexes of every occurrence of `needle` in `source`, in order. */
function occurrencesOf(source: string, needle: string): number[] {
  const found: number[] = [];
  let at = source.indexOf(needle);
  while (at >= 0) {
    found.push(at);
    at = source.indexOf(needle, at + needle.length);
  }
  return found;
}

/**
 * The tags in `source` that have a closing tag, in order.
 *
 * A pattern that matches an opening tag and its closing tag looks for the closing tag from every opening tag it
 * meets, so a file whose closing tags are missing — a truncated download, a save that ran out of room — is read in
 * quadratic time. This scan looks forward only: the next opening tag, then the `>` that ends it, then the closing tag
 * after that, and never back. The cost is linear in the size of the file, whether or not the closing tags are there.
 */
function scanTags(source: string, name: string, closeTag: string): TagMatch[] {
  const closes = occurrencesOf(source, closeTag);
  const matches: TagMatch[] = [];
  let closeAt = 0;
  let tagEnd = 0;
  let at = 0;
  while (true) {
    const start = source.indexOf(name, at);
    if (start < 0) break;
    at = start + 1;
    // The tag name ends where the next character is not a word character, which is what `\b` after a tag name means.
    const after = source[start + name.length];
    if (after !== undefined && WORD_CHAR.test(after)) continue;
    if (tagEnd < start + name.length) tagEnd = start + name.length;
    while (tagEnd < source.length && source[tagEnd] !== '>') tagEnd += 1;
    if (tagEnd >= source.length) break;
    while (closeAt < closes.length) {
      const close = closes[closeAt];
      if (close === undefined || close > tagEnd) break;
      closeAt += 1;
    }
    const close = closes[closeAt];
    if (close === undefined) break;
    matches.push({ start, tagEnd, close, end: close + closeTag.length });
    at = close + closeTag.length;
  }
  return matches;
}

/**
 * Removes the self-closing `<name …/>` tags from `source`. A tag ends at its first `>`, so a tag is self-closing when
 * the character before that `>` is a slash.
 */
function stripSelfClosing(source: string, name: string): string {
  const cuts: [number, number][] = [];
  let tagEnd = 0;
  let at = 0;
  while (true) {
    const start = source.indexOf(name, at);
    if (start < 0) break;
    at = start + 1;
    const after = source[start + name.length];
    if (after !== undefined && WORD_CHAR.test(after)) continue;
    if (tagEnd < start + name.length) tagEnd = start + name.length;
    while (tagEnd < source.length && source[tagEnd] !== '>') tagEnd += 1;
    if (tagEnd >= source.length) break;
    if (source[tagEnd - 1] === '/') {
      cuts.push([start, tagEnd + 1]);
      at = tagEnd + 1;
    }
  }
  if (cuts.length === 0) return source;
  let out = '';
  let last = 0;
  for (const [from, to] of cuts) {
    out += source.slice(last, from);
    last = to;
  }
  return out + source.slice(last);
}

/**
 * XML folds a line end to a line feed (XML 1.0 §2.11), and a byte order mark is not content. A file Final Draft or
 * a Windows editor saved can carry either, so the reader sees the folded text.
 */
function normaliseXml(xml: string): string {
  const text = xml.startsWith('﻿') ? xml.slice(1) : xml;
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/** A paragraph and where its opening tag starts in the text it was read from. */
interface LocatedParagraph {
  readonly start: number;
  readonly paragraph: FdxParagraph;
}

/** Reads the paragraphs of `source`, which has its self-closing paragraphs removed already. */
function readParagraphs(source: string): LocatedParagraph[] {
  const containers: [number, number][] = [];
  for (const match of scanTags(source, '<DualDialogue', '</DualDialogue>')) {
    containers.push([match.start, match.end]);
  }
  const paragraphs: LocatedParagraph[] = [];
  let containerAt = 0;
  for (const match of scanTags(source, '<Paragraph', '</Paragraph>')) {
    const start = match.start;
    const attrs = attributes(source.slice(start + '<Paragraph'.length, match.tagEnd));
    const body = stripSelfClosing(source.slice(match.tagEnd + 1, match.close), '<Text');
    const text = scanTags(body, '<Text', '</Text>')
      .map((text) => decodeEntities(body.slice(text.tagEnd + 1, text.close)))
      .join('');
    const scene = /<SceneProperties\b([^>]*)>/.exec(body);
    const length = scene !== null ? Number.parseInt(attributes(scene[1] ?? '').Length ?? '', 10) : Number.NaN;
    const number = (attrs.Number ?? '').trim();
    // The containers are in order and do not overlap, so one pointer finds the container of each paragraph.
    while (containerAt < containers.length && (containers[containerAt]?.[1] ?? 0) <= start) containerAt += 1;
    const container = containers[containerAt];
    paragraphs.push({
      start,
      paragraph: {
        type: attrs.Type ?? 'Action',
        text,
        alignment: attrs.Alignment ?? null,
        lengthEighths: Number.isFinite(length) ? length : null,
        container: container !== undefined && container[0] <= start ? containerAt : null,
        number: number === '' ? null : number,
      },
    });
  }
  return paragraphs;
}

/**
 * Reads the paragraphs of an FDX document in order, with their container and scene length. The paragraphs of the
 * title page and of the page header are not script paragraphs and are left out; `parseFdxTitlePage` reads the first.
 */
export function parseFdxParagraphs(xml: string): FdxParagraph[] {
  // Self-closing paragraphs carry no text and would otherwise swallow the next paragraph's body.
  const source = stripSelfClosing(normaliseXml(xml), '<Paragraph');
  const apart = [
    ...scanTags(source, '<TitlePage', '</TitlePage>'),
    ...scanTags(source, '<HeaderAndFooter', '</HeaderAndFooter>'),
  ].sort((a, b) => a.start - b.start);
  let apartAt = 0;
  const kept: FdxParagraph[] = [];
  for (const { start, paragraph } of readParagraphs(source)) {
    while (apartAt < apart.length && (apart[apartAt]?.end ?? 0) <= start) apartAt += 1;
    const region = apart[apartAt];
    if (region === undefined || region.start > start) kept.push(paragraph);
  }
  return kept;
}

/** The credit lines a title page opens its author with. */
const CREDIT_LINES: ReadonlySet<string> = new Set(['written by', 'by', 'screenplay by', 'story by', 'teleplay by', 'a screenplay by']);

/** `Key: value` as the exporter writes a title-page entry, or null when the text does not open with a key. */
function labelled(text: string): { key: string; value: string } | null {
  const colon = text.indexOf(':');
  if (colon <= 0 || colon > 40) return null;
  const key = text.slice(0, colon).trim();
  if (!/^[A-Za-z][A-Za-z ]*$/.test(key)) return null;
  return { key, value: text.slice(colon + 1).trim() };
}

/**
 * Reads the `<TitlePage>` of an FDX document into title-page entries, best effort: Final Draft's title page is free
 * layout, so only what can be named is. A `Key: value` paragraph, which is how `renderFdx` writes an entry, keeps its
 * key. A credit line (`Written by`) gives the Credit and the line after it the Author, the first other line is the
 * Title, a line with `draft` in it is the Draft date, and every other line goes to Notes. Null when there is no
 * title page or it holds no text.
 */
export function parseFdxTitlePage(xml: string): Record<string, string> | null {
  const source = stripSelfClosing(normaliseXml(xml), '<Paragraph');
  const page = scanTags(source, '<TitlePage', '</TitlePage>')[0];
  if (page === undefined) return null;
  const entries: Record<string, string> = {};
  const add = (key: string, value: string): void => {
    entries[key] = key in entries ? `${entries[key]}\n${value}` : value;
  };
  const notes: string[] = [];
  let credited = false;
  let authorNext = false;
  for (const { paragraph } of readParagraphs(source.slice(page.tagEnd + 1, page.close))) {
    const text = paragraph.text.trim();
    if (text === '') continue;
    const entry = labelled(text);
    const phrase = entry?.key ?? text.replace(/:$/, '');
    if (CREDIT_LINES.has(phrase.toLowerCase())) {
      credited = true;
      add('Credit', phrase);
      if (entry !== null && entry.value !== '') add('Author', entry.value);
      else authorNext = true;
    } else if (entry !== null) {
      add(entry.key, entry.value);
    } else if (authorNext) {
      add('Author', text);
      authorNext = false;
    } else if (/\bdraft\b/i.test(text) && text.length <= 60) {
      add('Draft date', text);
    } else if (!credited && !('Title' in entries)) {
      add('Title', text);
    } else {
      notes.push(text);
    }
  }
  if (notes.length > 0) add('Notes', notes.join('\n'));
  return Object.keys(entries).length > 0 ? entries : null;
}

/** FDX paragraph types to elements. The second cue of a dual-dialogue pair takes the dual marker. */
function fdxElements(paragraphs: readonly FdxParagraph[], notices: string[]): ScreenplayElement[] {
  const elements: ScreenplayElement[] = [];
  const cuesSeen = new Map<number, number>();
  for (const p of paragraphs) {
    const text = p.text.trim();
    if (text === '') continue;
    switch (p.type) {
      case 'Scene Heading': {
        // The number goes where Fountain keeps it, unless the heading carries one already or this one could not be read back.
        const numbered = p.number !== null && !p.number.includes('#') && !p.number.includes('\n') && sceneNumberOf(text) === null;
        elements.push({ type: 'scene_heading', text: numbered ? `${text} #${p.number}#` : text, forced: false });
        break;
      }
      case 'Action':
      case 'Shot':
        elements.push({ type: 'action', text });
        break;
      case 'General':
        elements.push(p.alignment === 'Center' ? { type: 'centered', text } : { type: 'action', text });
        break;
      case 'Character': {
        let dual = false;
        if (p.container !== null) {
          const seen = (cuesSeen.get(p.container) ?? 0) + 1;
          cuesSeen.set(p.container, seen);
          dual = seen > 1;
        }
        elements.push(dual ? { type: 'character', text, dual: true } : { type: 'character', text });
        break;
      }
      case 'Parenthetical':
        elements.push({ type: 'parenthetical', text: text.startsWith('(') ? text : `(${text})` });
        break;
      case 'Dialogue':
        elements.push({ type: 'dialogue', text });
        break;
      case 'Transition':
        elements.push({ type: 'transition', text, forced: false });
        break;
      default:
        notices.push(`Paragraph type "${p.type}" imported as action.`);
        elements.push({ type: 'action', text });
    }
  }
  return elements;
}

/**
 * Imports an FDX script. The paragraphs become Fountain, then the Fountain importer maps
 * them onto scenes. Each scene takes the `SceneProperties Length` of its own heading.
 */
export function importFdx(xml: string): ImportedScript {
  const notices: string[] = [];
  const paragraphs = parseFdxParagraphs(xml);
  const elements = fdxElements(paragraphs, notices);
  const script = importFountainScript(serialiseFountain(elements));
  const lengths = paragraphs.filter((p) => p.type === 'Scene Heading' && p.text.trim() !== '').map((p) => p.lengthEighths);
  let next = 0;
  const nodes = script.nodes.map((node) => {
    if (node.kind !== 'scene' || node.heading === null) return node;
    const lengthEighths = lengths[next] ?? null;
    next += 1;
    return { ...node, lengthEighths };
  });
  return { titlePage: parseFdxTitlePage(xml) ?? script.titlePage, nodes, notices: [...notices, ...script.notices] };
}

export interface FdxRenderResult {
  readonly xml: string;
  /** What was left out, in order: never silent (screenplay.md §5.2, D11). */
  readonly notes: readonly string[];
}

/** One `<Paragraph>` line. `attrs` is a string of attributes, each with its leading space. */
function paragraphXml(type: string, text: string, properties: string, attrs: string): string {
  return `<Paragraph Type="${type}"${attrs}>${properties}<Text>${escapeXml(text)}</Text></Paragraph>`;
}

/**
 * Renders the flattened blocks as an FDX document, to D11's emit set.
 * Annotations do not print, so each paragraph carries its printed text (`printedText`).
 */
export function renderFdx(blocks: readonly FlatBlock[], opts: FountainRenderOptions): FdxRenderResult {
  const fountain = renderFountain(blocks, opts);
  const parsed = parseFountain(fountain.text);
  // Pagination supplies the SceneProperties Length and Page, and the header's page numbers: D11 emits
  // only what has been computed.
  const pages = paginate(parsed.elements, { titlePage: false });
  const lengths = new Map(sceneLengths(pages).map((s) => [s.scene, s] as const));
  const notes = [...fountain.notes];

  const titleEntries = parsed.elements.find((el) => el.type === 'title_page');
  const titleXml: string[] = [];
  if (titleEntries !== undefined && titleEntries.type === 'title_page') {
    const paragraphs = Object.entries(titleEntries.entries).map(
      ([key, value]) => `      ${paragraphXml('Action', `${key}: ${value}`, '', ' Alignment="Center"')}`,
    );
    titleXml.push('  <TitlePage>', '    <Content>', ...paragraphs, '    </Content>', '  </TitlePage>');
  }

  const body: string[] = [];
  let scene = 0;
  let sequentialDual = false;
  for (const el of parsed.elements) {
    const text = 'text' in el ? printedText(el.text) : '';
    switch (el.type) {
      case 'scene_heading': {
        const length = lengths.get(scene);
        const printed = printedText(el.text);
        const number = sceneNumberOf(printed);
        const properties = length !== undefined ? `<SceneProperties Length="${length.lengthEighths}" Page="${length.page}"/>` : '';
        // The number is kept verbatim from the heading. Its attribute name is unverified (a known gap).
        const attrs = number !== null ? ` Number="${escapeXml(number)}"` : '';
        body.push(paragraphXml('Scene Heading', stripSceneNumber(printed), properties, attrs));
        scene += 1;
        break;
      }
      case 'action':
        if (text !== '') body.push(paragraphXml('Action', text.replace(/\n/g, ' '), '', ''));
        break;
      case 'character':
        if (el.dual === true) sequentialDual = true;
        if (text !== '') body.push(paragraphXml('Character', text, '', ''));
        break;
      case 'parenthetical':
        if (text !== '') body.push(paragraphXml('Parenthetical', text, '', ''));
        break;
      case 'dialogue':
        if (text !== '') body.push(paragraphXml('Dialogue', text.replace(/\n/g, ' '), '', ''));
        break;
      case 'transition':
        if (text !== '') body.push(paragraphXml('Transition', text, '', ''));
        break;
      case 'centered':
        if (text !== '') body.push(paragraphXml('General', text, '', ' Alignment="Center"'));
        break;
      // Sections, synopses, notes, boneyards and page breaks are never emitted (screenplay.md §2.2, §5.2).
      default:
        break;
    }
  }
  if (sequentialDual) {
    notes.push('Dual dialogue written as sequential paragraphs: the DualDialogue container is not emitted.');
  }

  // The page-number layer (D11). Page 1 carries no number (screenplay.md §5.3), so the first numbered page is 2.
  const firstNumbered = pages.find((page) => page.number >= 2)?.number ?? 2;
  const xml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<FinalDraft DocumentType="Script" Template="No" Version="3">',
    ...titleXml,
    '  <Content>',
    ...body.map((line) => `    ${line}`),
    '  </Content>',
    `  <HeaderAndFooter FirstPage="${firstNumbered}">`,
    '    <Header>',
    '      <Paragraph Alignment="Right"><DynamicLabel Type="Page"/></Paragraph>',
    '    </Header>',
    '  </HeaderAndFooter>',
    '</FinalDraft>',
  ].join('\n');
  return { xml: `${xml}\n`, notes };
}

export interface FdxRenderer {
  emit(blocks: readonly FlatBlock[], opts: FountainRenderOptions): Promise<Blob>;
}

export function createFdxRenderer(): FdxRenderer {
  return {
    async emit(blocks, opts) {
      const { xml } = renderFdx(blocks, opts);
      return new Blob([xml], { type: FDX_MIME });
    },
  };
}
