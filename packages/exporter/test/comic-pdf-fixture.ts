/**
 * The comic PDF corpus: two books drawn from one set of pictures. The left-to-right book has a six-panel page that carries the seven balloon
 * kinds, a picture, a crop, a JPEG, a missing picture, a borderless panel that runs into the bleed and an off-panel tail, and an A4 page whose
 * balloon cannot hold its text. The right-to-left book holds a manga page with Han, Hebrew and Arabic lettering and a page of mixed
 * Latin and Cyrillic with the capital sharp s.
 */

import type { Balloon, ComicBookSettings, Panel, Rect } from '@caotang/comic';
import { DEFAULT_BOOK_SETTINGS, templateRects } from '@caotang/comic';

import { encodePng } from '../src/png-encode.js';
import type { ComicPdfBook } from '../src/render-comic-pdf.js';

export const ART_PORTRAIT = 'a_ARTPORTRAIT';
export const ART_LANDSCAPE = 'a_ARTLANDSCAPE';
export const ART_JPEG = 'a_ARTJPEG0001';
export const ART_MISSING = 'a_ARTMISSING01';

/** Four coloured quarters with a white cross and a dark frame, so a crop and its placement can be seen on the page. */
function quarters(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  const colours = [
    [235, 120, 90],
    [90, 160, 235],
    [120, 200, 120],
    [240, 205, 90],
  ];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const quarter = (y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1);
      let [r, g, b] = colours[quarter] as number[];
      const onCross = Math.abs(x - width / 2) < 2 || Math.abs(y - height / 2) < 2;
      const onFrame = x < 3 || y < 3 || x >= width - 3 || y >= height - 3;
      if (onCross) [r, g, b] = [255, 255, 255];
      if (onFrame) [r, g, b] = [40, 40, 60];
      data.set([r as number, g as number, b as number, 255], at);
    }
  }
  return encodePng({ width, height, data });
}

/** An 8 x 8 baseline JPEG, whole, so a reader that decodes it finds nothing to warn about. */
export const JPEG = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKgAAQf/2Q=='), (c) => c.charCodeAt(0));

export const PICTURES: ReadonlyMap<string, Uint8Array> = new Map([
  [ART_PORTRAIT, quarters(200, 300)],
  [ART_LANDSCAPE, quarters(300, 150)],
  [ART_JPEG, JPEG],
]);

export const readPicture = async (assetId: string): Promise<Uint8Array | null> => PICTURES.get(assetId) ?? null;

let counter = 0;
const balloon = (kind: string, text: string, rect: Rect, extra: Partial<Balloon> = {}): Balloon => ({ id: `bl_${String((counter += 1)).padStart(10, '0')}`, kind, text, rect, ...extra });
const panel = (rect: Rect, extra: Partial<Panel> = {}, balloons: Balloon[] = []): Panel => ({ id: `pn_${String((counter += 1)).padStart(10, '0')}`, rect, balloons, ...extra });

/** Inside a panel rect: a rectangle at fractions of it, in live-area space. */
const within = (rect: Rect, fx: number, fy: number, fw: number, fh: number): Rect => [rect[0] + rect[2] * fx, rect[1] + rect[3] * fy, rect[2] * fw, rect[3] * fh];
const at = (rect: Rect, fx: number, fy: number): [number, number] => [rect[0] + rect[2] * fx, rect[1] + rect[3] * fy];

const settings = (extra: Partial<ComicBookSettings> = {}): ComicBookSettings => ({ ...DEFAULT_BOOK_SETTINGS, ...extra }) as ComicBookSettings;

/** The six-panel page: the seven balloon kinds, art with a crop, a JPEG, a missing picture, an empty frame, bleed and an off-panel tail. */
export function sixPanelPage(): ComicPdfBook['pages'][number] {
  const r = templateRects('grid-6', { size: 'us-comic' });
  const [p1, p2, p3, p4, p5, p6] = r as [Rect, Rect, Rect, Rect, Rect, Rect];
  return {
    id: 'n_PAGESIX0001',
    page: {
      size: 'us-comic',
      layout: 'grid-6',
      panels: [
        panel(p1, { assetId: ART_PORTRAIT, crop: [0.1, 0.1, 0.8, 0.8], border: 'thin' }, [
          balloon('speech', 'Where **were** you?! I waited ALL night.', within(p1, 0.05, 0.05, 0.6, 0.28), { tail: at(p1, 0.35, 0.62) }),
          balloon('caption', 'Meanwhile, at the docks...', within(p1, 0.04, 0.82, 0.92, 0.14)),
        ]),
        panel(p2, { assetId: ART_JPEG, border: 'bold' }, [
          balloon('thought', 'I wonder if she knows...', within(p2, 0.08, 0.06, 0.58, 0.3), { tail: at(p2, 0.3, 0.7) }),
          balloon('whisper', "Don't wake the baby.", within(p2, 0.42, 0.62, 0.5, 0.26), { tail: at(p2, 0.55, 0.45) }),
        ]),
        panel(p3, { assetId: ART_MISSING, border: 'thin' }, [
          balloon('shout', 'STOP!', within(p3, 0.12, 0.1, 0.5, 0.34), { tail: at(p3, 0.8, 0.8) }),
          balloon('radio', 'Base to unit three, come in. Over.', within(p3, 0.1, 0.56, 0.8, 0.32), { tail: at(p3, 0.9, 0.97) }),
        ]),
        panel(p4, { border: 'thin' }, [
          balloon('sfx', 'KRAKOOM', within(p4, 0.08, 0.3, 0.84, 0.4)),
          balloon('speech', 'Who said that?', within(p4, 0.05, 0.04, 0.5, 0.18), { tail: [p4[0] - 0.08, p4[1] + 0.05], offPanel: true }),
        ]),
        panel(p5, { assetId: ART_LANDSCAPE, border: 'none' }, [
          balloon('speech', 'This panel\nbleeds off the\nleft and bottom.', within(p5, 0.3, 0.12, 0.45, 0.45), { tail: at(p5, 0.45, 0.85) }),
        ]),
        panel(p6, { assetId: ART_PORTRAIT, crop: [0, 0, 1, 0.5], border: 'none' }, [
          balloon('speech', 'One **very important** word, then **another long emphasised phrase** that wraps over lines.', within(p6, 0.08, 0.08, 0.7, 0.5), { tail: at(p6, 0.5, 0.9) }),
        ]),
      ],
    },
  };
}

/** An A4 page whose second balloon holds more text than it can at the smallest size. */
export function overflowPage(): ComicPdfBook['pages'][number] {
  const [top, bottom] = templateRects('2-tier', { size: 'a4' }) as [Rect, Rect];
  return {
    id: 'n_PAGEOVER001',
    page: {
      size: 'a4',
      layout: '2-tier',
      panels: [
        panel(top, { border: 'thin' }, [balloon('speech', 'A short line that fits.', within(top, 0.2, 0.2, 0.5, 0.3), { tail: at(top, 0.5, 0.8) })]),
        panel(bottom, { border: 'thin' }, [
          balloon('speech', 'This balloon is far too small for the long speech it is asked to hold, and the writer should be told so before anything goes to print.', within(bottom, 0.3, 0.3, 0.16, 0.1), { tail: at(bottom, 0.6, 0.8) }),
        ]),
      ],
    },
  };
}

/** A manga page: Han, Hebrew, Arabic and Latin lettering, read right to left. */
export function mangaPage(): ComicPdfBook['pages'][number] {
  const r = templateRects('tier-1-2', { size: 'manga-b5', direction: 'rtl' });
  const [a, b, c] = r as [Rect, Rect, Rect];
  return {
    id: 'n_PAGEMANGA01',
    page: {
      size: 'manga-b5',
      layout: 'tier-1-2',
      panels: [
        panel(a, { assetId: ART_LANDSCAPE, border: 'thin' }, [
          balloon('speech', '今日はどこへ行くの？ **早く**しなさい！', within(a, 0.1, 0.1, 0.5, 0.4), { tail: at(a, 0.4, 0.8) }),
          balloon('caption', '東京、午前七時', within(a, 0.04, 0.84, 0.5, 0.12)),
        ]),
        panel(b, { border: 'thin' }, [balloon('speech', 'שלום עולם, מה שלומך היום?', within(b, 0.1, 0.1, 0.8, 0.3), { tail: at(b, 0.5, 0.8) })]),
        panel(c, { border: 'thin' }, [balloon('speech', 'مرحبا بالعالم 123 and HELLO', within(c, 0.1, 0.1, 0.8, 0.3), { tail: at(c, 0.5, 0.8) })]),
      ],
    },
  };
}

/** A page of Latin lettering the first face cannot draw in full: Cyrillic, Greek, the capital sharp s and an emoji. */
export function mixedPage(): ComicPdfBook['pages'][number] {
  const [a] = templateRects('splash', { size: 'letter' }) as [Rect];
  return {
    id: 'n_PAGEMIXED01',
    page: {
      size: 'letter',
      layout: 'splash',
      panels: [
        panel(a, { border: 'thin' }, [
          balloon('speech', 'Straße and ẞ, Привет, Ωμεγα. 🎬', within(a, 0.15, 0.1, 0.7, 0.2), { tail: at(a, 0.5, 0.6) }),
          balloon('speech', 'तुम कहाँ हो?', within(a, 0.15, 0.4, 0.5, 0.15), { tail: at(a, 0.4, 0.7) }),
        ]),
      ],
    },
  };
}

export const LTR_BOOK: ComicPdfBook = {
  title: 'The Dock',
  settings: settings({ readingDirection: 'ltr', pageSize: 'us-comic' }),
  pages: [sixPanelPage(), overflowPage()],
};

export const RTL_BOOK: ComicPdfBook = {
  title: 'Tōkyō',
  settings: settings({ readingDirection: 'rtl', pageSize: 'manga-b5', esszett: true }),
  pages: [mangaPage(), mixedPage()],
};
