/**
 * The app's comic page raster (apps/desktop/src/media/comic-raster.ts), driven through the exporter's page loop over a host that records instead
 * of drawing: no canvas, no font and no decoder exist here, so what is pinned is everything the raster decides — that the fonts are ready before
 * the first page, that one page is drawn at a time and its pictures are decoded and released within it, that a cancel stops the run and discards
 * the page in flight, that the page is drawn at 1988 px from the page editor's own geometry, which text is drawn in which face, and what the
 * compile log is told. The pixels themselves are the one thing not checked here (see the PR's unverified list).
 */

import { describe, expect, it } from 'vitest';

import { BANGERS_FAMILY, COMIC_NEUE_FAMILY, DEFAULT_BOOK_SETTINGS, type ComicBookSettings, type ComicPage } from '@caotang/comic';
import { COMIC_RASTER_HEIGHT_PX, ComicRasterCancelledError, rasterizeComicBook } from '@caotang/exporter';

import { createComicRasterizer, fontFor, ptToPx, startsRightToLeft, type ComicRasterHost, type RasterContext, type RasterImage } from '../src/media/comic-raster.js';

const SETTINGS = { ...DEFAULT_BOOK_SETTINGS, pageSize: 'us-comic', capsTransform: true } as ComicBookSettings;
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const PICTURE = Uint8Array.from([1, 2, 3, 4]);

/** A 2D context that records what is drawn. Text is measured at half the font's pixel size per character, so lines break and fit as they would. */
class RecordingContext {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  lineJoin = '';
  lineCap = '';
  font = '';
  direction = '';
  textAlign = '';
  textBaseline = '';
  readonly texts: { text: string; font: string; style: string; x: number; y: number }[] = [];
  readonly images: { x: number; y: number; width: number; height: number }[] = [];
  readonly fills: { style: string; rect: number[] }[] = [];
  readonly strokes: string[] = [];
  readonly counts = { save: 0, restore: 0 };

  save(): void {
    this.counts.save += 1;
  }
  restore(): void {
    this.counts.restore += 1;
  }
  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  rect(): void {}
  clip(): void {}
  ellipse(): void {}
  setLineDash(): void {}
  fill(): void {}
  stroke(): void {
    this.strokes.push(this.strokeStyle);
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.fills.push({ style: this.fillStyle, rect: [x, y, width, height] });
  }
  strokeRect(): void {
    this.strokes.push(this.strokeStyle);
  }
  drawImage(_source: unknown, x: number, y: number, width: number, height: number): void {
    this.images.push({ x, y, width, height });
  }
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, font: this.font, style: this.fillStyle, x, y });
  }
  measureText(text: string): { width: number; fontBoundingBoxAscent: number; fontBoundingBoxDescent: number } {
    const size = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 10);
    return { width: [...text].length * size * 0.5, fontBoundingBoxAscent: size * 0.9, fontBoundingBoxDescent: size * 0.25 };
  }
}

interface Rig {
  readonly host: ComicRasterHost;
  readonly events: string[];
  readonly surfaces: { width: number; height: number; context: RecordingContext }[];
  readonly decoded: { closed: boolean; bytes: Uint8Array }[];
  inFlight: number;
  maxInFlight: number;
  encoded: Uint8Array;
  onEncode?: () => void;
  decodeResult: 'picture' | 'null' | 'throw';
}

function rig(): Rig {
  const state: Rig = {
    events: [],
    surfaces: [],
    decoded: [],
    inFlight: 0,
    maxInFlight: 0,
    encoded: JPEG_BYTES,
    decodeResult: 'picture',
    host: undefined as never,
  };
  const host: ComicRasterHost = {
    loadFaces: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      state.events.push('faces');
    },
    createSurface: (width, height) => {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const context = new RecordingContext();
      state.surfaces.push({ width, height, context });
      state.events.push(`surface ${state.surfaces.length}`);
      return {
        context: context as unknown as RasterContext,
        encode: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          state.onEncode?.();
          state.inFlight -= 1;
          return state.encoded;
        },
      };
    },
    decodePicture: async (bytes): Promise<RasterImage | null> => {
      state.events.push('decode');
      if (state.decodeResult === 'throw') throw new Error('bad data');
      if (state.decodeResult === 'null') return null;
      const record = { closed: false, bytes };
      state.decoded.push(record);
      return {
        width: 200,
        height: 300,
        source: {} as CanvasImageSource,
        close: () => {
          record.closed = true;
          state.events.push('close');
        },
      };
    },
  };
  return Object.assign(state, { host });
}

const speech = (text: string, extra: Record<string, unknown> = {}) => ({ id: 'bl_0000000001', kind: 'speech', text, rect: [0.1, 0.1, 0.5, 0.25], ...extra });

function pageOf(balloons: Record<string, unknown>[] = [speech('Where **were** you?')], assetId: string | null = 'a_PICTURE0001'): ComicPage {
  return {
    size: 'us-comic',
    layout: 'splash',
    panels: [{ id: 'pn_0000000001', rect: [0, 0, 1, 1], border: 'thin', ...(assetId === null ? {} : { assetId }), balloons }],
  } as unknown as ComicPage;
}

async function run(r: Rig, pages: ComicPage[], extra: Partial<Parameters<typeof rasterizeComicBook>[0]> = {}) {
  return rasterizeComicBook({
    rasterizer: createComicRasterizer(r.host),
    settings: SETTINGS,
    pages: pages.map((page) => ({ page })),
    language: 'en',
    readPicture: async (assetId) => (assetId === 'a_MISSING0001' ? null : PICTURE),
    ...extra,
  });
}

describe('the page loop over the raster', () => {
  it('has the faces ready before the first surface exists, and draws one page at a time', async () => {
    const r = rig();
    const drawn = await run(r, [pageOf(), pageOf(), pageOf()]);
    expect(r.events[0]).toBe('faces');
    expect(r.events.indexOf('faces')).toBeLessThan(r.events.indexOf('surface 1'));
    expect(r.maxInFlight).toBe(1);
    expect(r.surfaces).toHaveLength(3);
    expect(drawn.pages.map((page) => page.number)).toEqual([1, 2, 3]);
  });

  it('draws each page at 1988 px tall, the width of its trim size, as a JPEG', async () => {
    const r = rig();
    const { pages } = await run(r, [pageOf()]);
    expect(pages[0]?.height).toBe(COMIC_RASTER_HEIGHT_PX);
    expect(r.surfaces[0]?.height).toBe(1988);
    // US comic trim, 6.625 x 10.25 in.
    expect(r.surfaces[0]?.width).toBe(Math.round((6.625 / 10.25) * 1988));
    expect(pages[0]?.bytes).toEqual(JPEG_BYTES);
  });

  it('decodes a page\'s picture once however many panels use it, releases it when the page is done, and decodes it again for the next page', async () => {
    const r = rig();
    const twoPanels = {
      size: 'us-comic',
      panels: [
        { id: 'pn_0000000001', rect: [0, 0, 1, 0.5], assetId: 'a_PICTURE0001', balloons: [] },
        { id: 'pn_0000000002', rect: [0, 0.5, 1, 0.5], assetId: 'a_PICTURE0001', balloons: [] },
      ],
    } as unknown as ComicPage;
    await run(r, [twoPanels, twoPanels]);
    expect(r.decoded).toHaveLength(2);
    expect(r.decoded.every((entry) => entry.closed)).toBe(true);
    expect(r.events.filter((event) => event !== 'faces')).toEqual(['surface 1', 'decode', 'close', 'surface 2', 'decode', 'close']);
  });

  it('draws the picture inside the panel on a white page', async () => {
    const r = rig();
    await run(r, [pageOf([])]);
    const context = r.surfaces[0]?.context as RecordingContext;
    expect(context.fills[0]).toEqual({ style: '#ffffff', rect: [0, 0, r.surfaces[0]?.width, 1988] });
    expect(context.images).toHaveLength(1);
    expect(context.images[0]?.width).toBeGreaterThan(0);
  });
});

describe('a cancel', () => {
  it('stops the run, draws no further page, and releases the page in flight', async () => {
    const r = rig();
    const controller = new AbortController();
    r.onEncode = () => controller.abort();
    await expect(run(r, [pageOf(), pageOf(), pageOf()], { signal: controller.signal })).rejects.toThrow(ComicRasterCancelledError);
    expect(r.surfaces).toHaveLength(1);
    expect(r.decoded.every((entry) => entry.closed)).toBe(true);
  });

  it('stops while the pictures are being decoded', async () => {
    const r = rig();
    const controller = new AbortController();
    const decode = r.host.decodePicture;
    (r.host as { decodePicture: typeof decode }).decodePicture = async (bytes) => {
      const image = await decode(bytes);
      controller.abort();
      return image;
    };
    await expect(run(r, [pageOf(), pageOf()], { signal: controller.signal })).rejects.toThrow(ComicRasterCancelledError);
    expect(r.surfaces).toHaveLength(1);
    expect(r.decoded.every((entry) => entry.closed)).toBe(true);
  });
});

describe('the lettering', () => {
  it('draws the stored words in capitals in Comic Neue, bold-italic where the writer emphasised, and in ink', async () => {
    const r = rig();
    await run(r, [pageOf()]);
    const texts = (r.surfaces[0]?.context as RecordingContext).texts;
    expect(texts.map((entry) => entry.text).join('')).toBe('WHERE WERE YOU?');
    expect(texts.every((entry) => entry.font.includes(`"${COMIC_NEUE_FAMILY}"`))).toBe(true);
    const emphasised = texts.find((entry) => entry.text.includes('WERE'));
    expect(emphasised?.font).toContain('italic 700');
    expect(texts.every((entry) => entry.style === '#0f0f0f')).toBe(true);
  });

  it('draws a sound effect in Bangers', async () => {
    const r = rig();
    await run(r, [pageOf([{ id: 'bl_0000000002', kind: 'sfx', text: 'BOOM', rect: [0.2, 0.4, 0.5, 0.2] }])]);
    const texts = (r.surfaces[0]?.context as RecordingContext).texts;
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((entry) => entry.font.includes(`"${BANGERS_FAMILY}"`))).toBe(true);
  });

  it('draws nothing for a balloon with no text, and lets the capitals policy off', async () => {
    const r = rig();
    await run(r, [pageOf([speech('   ')])]);
    expect((r.surfaces[0]?.context as RecordingContext).texts).toEqual([]);
    const off = rig();
    await run(off, [pageOf([speech('Where were you?')])], { settings: { ...SETTINGS, capsTransform: false } });
    expect((off.surfaces[0]?.context as RecordingContext).texts.map((entry) => entry.text).join('')).toBe('Where were you?');
  });

  it('draws a right-to-left line from its right edge, in the right direction', async () => {
    const r = rig();
    await run(r, [pageOf([speech('שלום עולם')])]);
    const context = r.surfaces[0]?.context as RecordingContext;
    expect(context.direction).toBe('rtl');
    expect(context.texts.length).toBeGreaterThan(0);
  });

  it('draws a balloon that cannot hold its text at the floor size in red, and says which one', async () => {
    const r = rig();
    const long = 'This is far too much to say in one small balloon. '.repeat(20);
    const { notes } = await run(r, [pageOf([speech(long, { rect: [0.1, 0.1, 0.1, 0.03] })])]);
    expect(notes.join('\n')).toMatch(/comic page 1, panel 1, balloon 1: the text does not fit at 4\.5 pt/);
    expect((r.surfaces[0]?.context as RecordingContext).strokes).toContain('#d91a1a');
  });
});

describe('the pictures', () => {
  it('draws a panel whose picture cannot be read as a grey frame and says so', async () => {
    const r = rig();
    const { notes } = await run(r, [pageOf([], 'a_MISSING0001')]);
    expect(notes.join('\n')).toContain('comic page 1: image a_MISSING0001 could not be read');
    expect((r.surfaces[0]?.context as RecordingContext).fills.some((fill) => fill.style === '#e6e6e6')).toBe(true);
  });

  it('draws a picture the browser cannot decode, or that throws, as a grey frame and says so', async () => {
    for (const mode of ['null', 'throw'] as const) {
      const r = rig();
      r.decodeResult = mode;
      const { notes } = await run(r, [pageOf([])]);
      expect(notes.join('\n')).toContain('is not a picture this browser can read');
      expect((r.surfaces[0]?.context as RecordingContext).fills.some((fill) => fill.style === '#e6e6e6')).toBe(true);
    }
  });

  it('draws a panel with no picture with only its frame', async () => {
    const r = rig();
    await run(r, [pageOf([], null)]);
    expect(r.decoded).toHaveLength(0);
    expect((r.surfaces[0]?.context as RecordingContext).images).toHaveLength(0);
  });
});

describe('the encoder', () => {
  it('refuses a browser that did not give a JPEG, rather than packing the wrong type', async () => {
    const r = rig();
    r.encoded = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    await expect(run(r, [pageOf()])).rejects.toThrow('did not encode the page as a JPEG');
  });
});

describe('fontFor, startsRightToLeft and ptToPx', () => {
  it('names the face, weight and style the canvas font needs, with a system stack behind it', () => {
    expect(fontFor('regular', 20)).toBe(`400 20px "${COMIC_NEUE_FAMILY}", "Comic Sans MS", sans-serif`);
    expect(fontFor('italic', 20)).toContain('italic 400');
    expect(fontFor('bold', 20)).toContain('700 20px');
    expect(fontFor('bold-italic', 20)).toContain('italic 700');
    expect(fontFor('sfx', 20.123)).toBe(`400 20.12px "${BANGERS_FAMILY}", Impact, sans-serif`);
  });

  it('reads the first letter of a line for its direction', () => {
    expect(startsRightToLeft('שלום')).toBe(true);
    expect(startsRightToLeft('مرحبا')).toBe(true);
    expect(startsRightToLeft('Hello')).toBe(false);
    expect(startsRightToLeft('123 שלום')).toBe(true);
    expect(startsRightToLeft('123')).toBe(false);
  });

  it('turns points into pixels at a scale of pixels per millimetre', () => {
    expect(ptToPx(72, 1)).toBeCloseTo(25.4, 6);
    expect(ptToPx(10, 2)).toBeCloseTo((10 * 25.4 * 2) / 72, 6);
  });
});
