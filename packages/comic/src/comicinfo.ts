/**
 * `ComicInfo.xml`, version 2.0, for the CBZ export ([comics.md](../../../docs/architecture/comics.md) §5). Pure: it turns a
 * description of the book into text and knows nothing of the zip, the rasteriser or the store.
 *
 * Only the fields the spec lists are written: Title, Series, Number, Writer, Penciller, Letterer, PageCount, LanguageISO,
 * Manga and the Pages list. A field with no value is left out, never written empty, so a reader shows its own default
 * rather than a blank. The elements follow the order of the v2.0 schema.
 */

import type { Open, ReadingDirection } from './model.js';

/** The `Type` values of a `Page` element in the v2.0 schema. */
export const COMIC_INFO_PAGE_TYPES = [
  'FrontCover',
  'InnerCover',
  'Roundup',
  'Story',
  'Advertisement',
  'Editorial',
  'Letters',
  'Preview',
  'BackCover',
  'Other',
  'Deleted',
] as const;
export type ComicInfoPageType = (typeof COMIC_INFO_PAGE_TYPES)[number];

export interface ComicInfoPage {
  type?: Open<ComicInfoPageType>;
  /** Written as `DoublePage="true"`; false and absent both leave the attribute out. */
  doublePage?: boolean;
  /** Pixels of the page image in the archive. A value that is not a positive whole number is left out. */
  width?: number;
  height?: number;
}

export interface ComicInfoCreators {
  writer?: readonly string[];
  penciller?: readonly string[];
  letterer?: readonly string[];
}

export interface ComicInfoInput {
  title?: string;
  series?: string;
  number?: string | number;
  creators?: ComicInfoCreators;
  /** BCP 47 tag. One that is not well formed is left out: a reader cannot use it and the book still opens. */
  language?: string;
  /** `rtl` writes `Manga` as `YesAndRightToLeft`; any other value writes no `Manga` element, so a reader keeps its own default. */
  readingDirection?: Open<ReadingDirection>;
  /** One entry per image in the archive, in archive order. `PageCount` is its length. */
  pages: readonly ComicInfoPage[];
}

const WELL_FORMED_LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * Text for an XML 1.0 element or attribute. `& < > " '` become entities. The characters XML 1.0 cannot carry at all
 * (C0 controls other than tab and line feed, the DEL and C1 controls, U+FFFE and U+FFFF, a lone surrogate) are dropped,
 * and a carriage return is written as a character reference so a parser does not fold it into a line feed.
 */
export function escapeXml(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text.slice(index, index + 2);
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    if (code === 0x0d) out += '&#13;';
    else if (code === 0x09 || code === 0x0a) out += text[index];
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffe || code === 0xffff) continue;
    else if (code === 0x26) out += '&amp;';
    else if (code === 0x3c) out += '&lt;';
    else if (code === 0x3e) out += '&gt;';
    else if (code === 0x22) out += '&quot;';
    else if (code === 0x27) out += '&apos;';
    else out += text[index];
  }
  return out;
}

function element(name: string, value: string | undefined): string[] {
  if (value === undefined) return [];
  const text = escapeXml(value.trim());
  return text === '' ? [] : [`  <${name}>${text}</${name}>`];
}

function people(name: string, names: readonly string[] | undefined): string[] {
  const list = (names ?? []).map((entry) => escapeXml(entry.trim())).filter((entry) => entry !== '');
  return list.length === 0 ? [] : [`  <${name}>${list.join(', ')}</${name}>`];
}

function dimension(name: string, value: number | undefined): string {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? ` ${name}="${value}"` : '';
}

function pageElement(page: ComicInfoPage, index: number): string {
  const type = page.type !== undefined && (COMIC_INFO_PAGE_TYPES as readonly string[]).includes(page.type) ? ` Type="${page.type}"` : '';
  const double = page.doublePage === true ? ' DoublePage="true"' : '';
  return `    <Page Image="${index}"${type}${double}${dimension('ImageWidth', page.width)}${dimension('ImageHeight', page.height)} />`;
}

/** The text of a `ComicInfo.xml` v2.0 file for a book, with a trailing line feed. */
export function comicInfoXml(input: ComicInfoInput): string {
  const number = input.number === undefined ? undefined : String(input.number);
  const language = input.language?.trim();
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    ...element('Title', input.title),
    ...element('Series', input.series),
    ...element('Number', number),
    ...people('Writer', input.creators?.writer),
    ...people('Penciller', input.creators?.penciller),
    ...people('Letterer', input.creators?.letterer),
    `  <PageCount>${input.pages.length}</PageCount>`,
    ...(language !== undefined && WELL_FORMED_LANGUAGE.test(language) ? element('LanguageISO', language) : []),
    ...(input.readingDirection === 'rtl' ? ['  <Manga>YesAndRightToLeft</Manga>'] : []),
    ...(input.pages.length === 0 ? [] : ['  <Pages>', ...input.pages.map(pageElement), '  </Pages>']),
    '</ComicInfo>',
  ];
  return `${lines.join('\n')}\n`;
}
