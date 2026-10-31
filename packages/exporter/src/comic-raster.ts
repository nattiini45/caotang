/**
 * The page raster the CBZ and the fixed-layout EPUB share — [comics.md](../../../docs/architecture/comics.md) §5 and D12.
 *
 * Drawing a comic page to pixels needs a canvas and the lettering `FontFace`s, which only a browser has, so this file owns no pixels: it
 * owns the *port* a host draws through and the rules the pages are drawn under. The app supplies the port (`apps/desktop/src/media/comic-raster.ts`);
 * Node, the CLI, the SDK and the MCP server supply none, and a compile of either format refuses there before anything is reserved
 * (`ComicRasterUnavailableError`). **No Node rasterizer exists, and this port is not a seam for one** (D12).
 *
 * The rules are the port's contract, kept here so they are tested without a browser:
 *
 * - the port's fonts are ready before the first page is asked for;
 * - pages are drawn one at a time, in page order: a page is asked for only after the one before has come back, so a book of a hundred
 *   pages never holds a hundred drawings in flight;
 * - a cancelled run asks for no further page, discards the one in flight and returns nothing, so there is no partial file to offer.
 */

import type { ComicBookSettings, ComicPage } from '@caotang/comic';

/** The page height a raster is drawn at, in pixels. Every page size at this height is a few million pixels, well under the canvas area cap of iOS before 18. */
export const COMIC_RASTER_HEIGHT_PX = 1988;

/** The type a `.cbz` is served as. */
export const CBZ_MIME = 'application/vnd.comicbook+zip';

/** The image type of a rasterised page, and the quality it is encoded at. */
export const COMIC_RASTER_MIME = 'image/jpeg';
export const COMIC_RASTER_QUALITY = 0.9;

export interface ComicRasterPageRequest {
  readonly page: ComicPage;
  readonly settings: ComicBookSettings;
  /** The page's place in the book, from 1, and the book's page count. */
  readonly number: number;
  readonly count: number;
  readonly heightPx: number;
  /** The project's language (a BCP 47 tag): capitals are made in it. */
  readonly language: string;
  /** The bytes of one picture by asset id, or `null` when they cannot be read. A rejection is read as `null` too. */
  readonly readPicture: (assetId: string) => Promise<Uint8Array | null>;
  readonly signal: AbortSignal;
}

/** One page drawn: a JPEG, its size in pixels, and what the compile log should say about it. */
export interface ComicRasterPage {
  readonly number: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  readonly notes: readonly string[];
}

export interface ComicRasterizer {
  /** Resolves when the lettering faces are loaded and a page can be drawn in them. Called once per run, before the first page. */
  ready(signal: AbortSignal): Promise<void>;
  /** Draws one page. At most one call is in flight at a time. */
  drawPage(request: ComicRasterPageRequest): Promise<ComicRasterPage>;
}

/** A run that was cancelled. Callers read this as a choice, not a failure: nothing is offered and nothing is logged as broken. */
export class ComicRasterCancelledError extends Error {
  constructor() {
    super('the comic export was cancelled, so no file was made');
    this.name = 'ComicRasterCancelledError';
  }
}

export interface RasterizeBookOptions {
  readonly rasterizer: ComicRasterizer;
  readonly settings: ComicBookSettings;
  readonly pages: readonly { readonly page: ComicPage }[];
  readonly language: string;
  readonly readPicture: ComicRasterPageRequest['readPicture'];
  readonly heightPx?: number;
  readonly signal?: AbortSignal;
  /** Called after each page comes back, with how many are done. */
  readonly onPage?: (done: number, count: number) => void;
}

export interface RasterizedBook {
  readonly pages: readonly ComicRasterPage[];
  readonly notes: readonly string[];
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ComicRasterCancelledError();
}

/** Draws every page of a book through the port, one at a time and in order. Resolves with every page, or rejects with nothing drawn. */
export async function rasterizeComicBook(options: RasterizeBookOptions): Promise<RasterizedBook> {
  const signal = options.signal ?? new AbortController().signal;
  const count = options.pages.length;
  if (count === 0) throw new Error('the book has no page to draw');
  const heightPx = options.heightPx ?? COMIC_RASTER_HEIGHT_PX;
  throwIfCancelled(signal);
  await options.rasterizer.ready(signal);
  const drawn: ComicRasterPage[] = [];
  const notes: string[] = [];
  for (const [index, entry] of options.pages.entries()) {
    throwIfCancelled(signal);
    const number = index + 1;
    const raster = await options.rasterizer.drawPage({
      page: entry.page,
      settings: options.settings,
      number,
      count,
      heightPx,
      language: options.language,
      readPicture: options.readPicture,
      signal,
    });
    // A page that finishes after the writer cancelled is thrown away: the answer to a cancel is no file, never a short one.
    throwIfCancelled(signal);
    if (raster.bytes.length === 0 || !Number.isSafeInteger(raster.width) || !Number.isSafeInteger(raster.height) || raster.width < 1 || raster.height < 1) {
      throw new Error(`page ${number} was drawn without an image, so the export was stopped`);
    }
    drawn.push({ ...raster, number });
    notes.push(...raster.notes);
    options.onPage?.(number, count);
  }
  return { pages: drawn, notes };
}
