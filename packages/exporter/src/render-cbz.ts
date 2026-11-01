/**
 * The CBZ — [comics.md](../../../docs/architecture/comics.md) §5, `cbz`. A zip of one JPEG per page, named by page number so that any
 * reader that sorts names reads them in order, and a `ComicInfo.xml` v2.0 built by `@caotang/comic`'s `comicInfoXml`, which escapes every
 * field. The pictures are the page raster's (./comic-raster.ts); nothing here draws.
 *
 * `fflate/browser` is imported on demand, as the EPUB and the spreadsheets do (render-epub.ts says why).
 */

import { comicInfoXml, type ComicInfoInput, type ReadingDirection } from '@caotang/comic';
import type { ZipOptions } from 'fflate/browser';

import type { ComicRasterPage } from './comic-raster.js';

export const COMIC_INFO_FILE = 'ComicInfo.xml';

export interface CbzInput {
  readonly title: string;
  /** The project's title, when the book is one part of it. Left out when it is the book's own title. */
  readonly series?: string;
  readonly author?: string;
  /** A BCP 47 tag. */
  readonly language?: string;
  readonly readingDirection: ReadingDirection | string;
  readonly pages: readonly ComicRasterPage[];
  /** The time every entry is stamped with, so one compile writes one file. */
  readonly mtime: Date;
}

/** `0001.jpg`: the page number to four digits, or as many as the book needs when it has more than 9,999 pages. */
export function cbzPageName(number: number, count: number): string {
  const width = Math.max(4, String(count).length);
  return `${String(number).padStart(width, '0')}.jpg`;
}

/** The `ComicInfo.xml` of a book: its title, series, writer, language, direction and one `Page` per image, the first of them the cover. */
export function cbzComicInfo(input: CbzInput): string {
  const info: ComicInfoInput = {
    title: input.title,
    ...(input.series === undefined || input.series.trim() === input.title.trim() ? {} : { series: input.series }),
    ...(input.author === undefined || input.author.trim() === '' ? {} : { creators: { writer: [input.author] } }),
    ...(input.language === undefined ? {} : { language: input.language }),
    readingDirection: input.readingDirection,
    pages: input.pages.map((page, index) => ({ type: index === 0 ? 'FrontCover' : 'Story', width: page.width, height: page.height })),
  };
  return comicInfoXml(info);
}

/** The archive's bytes. The pictures are already compressed, so they are stored; the XML is deflated. */
export async function renderCbz(input: CbzInput): Promise<Uint8Array> {
  if (input.pages.length === 0) throw new Error('the book has no page to put in the archive');
  const { zipSync, strToU8 } = await import('fflate/browser');
  const mtime = input.mtime;
  const files: Record<string, [Uint8Array, ZipOptions]> = {};
  for (const page of input.pages) files[cbzPageName(page.number, input.pages.length)] = [page.bytes, { level: 0, mtime }];
  files[COMIC_INFO_FILE] = [strToU8(cbzComicInfo(input)), { level: 9, mtime }];
  return zipSync(files, { mtime });
}
