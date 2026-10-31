/**
 * The app's `ProcessPicture` on a real canvas (apps/desktop/src/app/picture-transcoder.ts, `processPictureInBrowser`) and its HEIC
 * conversion. `packages/pictures/test/process.test.ts` pins the rules both hosts share; `packages/exporter/test/picture-process-node.test.ts`
 * pins Node. This spec runs the browser's own decoder, resizer and encoders: EXIF orientation 1 to 8 on pictures whose corners
 * differ, resize on decode, flattening, a valid all-white picture against a dead canvas, and every refusal.
 *
 * The transcoder and `e2e/picture-page.ts` are imported into the page from the dev server, as e2e/snapshot-eviction.spec.ts does.
 * No test here can decode a real HEIC photo: Chromium has no HEIC decoder, so the conversion's success path runs against a
 * stand-in `createImageBitmap`, and what Safari does with a real photo is not claimed.
 */

import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import type * as Transcoder from '../apps/desktop/src/app/picture-transcoder.js';
import { readPictureHeader, sniffPicture } from '../packages/pictures/src/index.js';
import type { PictureProfile } from '../packages/pictures/src/index.js';
import type * as PagePictures from './picture-page.js';

const fs = (path: string): string => `/@fs/${fileURLToPath(new URL(path, import.meta.url)).replaceAll('\\', '/').replace(/^\/+/, '')}`;
const TRANSCODER_URL = fs('../apps/desktop/src/app/picture-transcoder.ts');
const HELPERS_URL = fs('./picture-page.ts');

const profile = (patch: Partial<PictureProfile> = {}): PictureProfile => ({
  maxEdge: 4096,
  output: 'jpeg',
  jpegQuality: 0.9,
  flattenAlpha: true,
  stripMetadata: true,
  ...patch,
});

/** Where each stored corner lands (top left, top right, bottom left of the stored picture) for each EXIF orientation. */
const CORNER_HOMES: Record<number, { swapped: boolean; tl: string; tr: string; bl: string }> = {
  1: { swapped: false, tl: 'TL', tr: 'TR', bl: 'BL' },
  2: { swapped: false, tl: 'TR', tr: 'TL', bl: 'BR' },
  3: { swapped: false, tl: 'BR', tr: 'BL', bl: 'TR' },
  4: { swapped: false, tl: 'BL', tr: 'BR', bl: 'TL' },
  5: { swapped: true, tl: 'TL', tr: 'BL', bl: 'TR' },
  6: { swapped: true, tl: 'TR', tr: 'BR', bl: 'TL' },
  7: { swapped: true, tl: 'BR', tr: 'TR', bl: 'BL' },
  8: { swapped: true, tl: 'BL', tr: 'TL', bl: 'BR' },
};

function pointOf(home: string, width: number, height: number, near: number): [number, number] {
  return [home.endsWith('L') ? near : width - 1 - near, home.startsWith('T') ? near : height - 1 - near];
}

function close(actual: readonly number[] | undefined, expected: readonly number[], tolerance: number): void {
  for (let i = 0; i < 3; i += 1) expect(Math.abs((actual?.[i] ?? -999) - (expected[i] ?? 0))).toBeLessThanOrEqual(tolerance);
}

interface Outcome {
  readonly bytes: number[];
  readonly mime: string;
  readonly width: number;
  readonly height: number;
}

async function openPage(page: Page): Promise<void> {
  await page.goto('/');
}

interface Run {
  readonly source: { readonly kind: 'corners'; readonly columns: number; readonly rows: number; readonly cell: number; readonly type: 'image/png' | 'image/jpeg'; readonly orientation?: number };
  readonly profile: PictureProfile;
  readonly points: readonly (readonly [number, number])[];
}

/** Paints the source on a canvas, runs it through the app's transcoder, and samples the result through the browser's decoder. */
async function transcode(page: Page, run: Run): Promise<{ outcome: Outcome; sampled: PagePictures.Sampled }> {
  return page.evaluate(
    async ({ transcoderUrl, helpersUrl, run: job }) => {
      const transcoder = (await import(/* @vite-ignore */ transcoderUrl)) as typeof Transcoder;
      const helpers = (await import(/* @vite-ignore */ helpersUrl)) as typeof PagePictures;
      let bytes = await helpers.paintCorners(job.source.columns, job.source.rows, job.source.cell, job.source.type);
      if (job.source.orientation !== undefined) bytes = helpers.withOrientation(bytes, job.source.orientation);
      const result = await transcoder.processPictureInBrowser({ bytes, mime: job.source.type, width: 1, height: 1 }, job.profile);
      const sampled = await helpers.sample(result.bytes, job.points);
      return { outcome: { bytes: [...result.bytes], mime: result.mime, width: result.width, height: result.height }, sampled };
    },
    { transcoderUrl: TRANSCODER_URL, helpersUrl: HELPERS_URL, run },
  );
}

test.describe('processPictureInBrowser', () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page);
  });

  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`turns a JPEG with orientation ${orientation} the right way up, at the display size`, async ({ page }) => {
      const home = CORNER_HOMES[orientation]!;
      const [w, h] = home.swapped ? [32, 48] : [48, 32];
      const homes = [home.tl, home.tr, home.bl];
      const { outcome, sampled } = await transcode(page, {
        source: { kind: 'corners', columns: 3, rows: 2, cell: 16, type: 'image/jpeg', orientation },
        profile: profile({ output: 'jpeg' }),
        points: homes.map((corner) => pointOf(corner, w, h, 6)),
      });
      expect([outcome.width, outcome.height]).toEqual([w, h]);
      expect([sampled.width, sampled.height]).toEqual([w, h]);
      expect(outcome.mime).toBe('image/jpeg');
      close(sampled.colors[0], [255, 0, 0], 45);
      close(sampled.colors[1], [0, 255, 0], 45);
      close(sampled.colors[2], [0, 0, 255], 45);
    });
  }

  test('resizes on decode and turns a picture stored on its side: orientation 6, 96 x 64 to a 24 pixel edge', async ({ page }) => {
    const { outcome, sampled } = await transcode(page, {
      source: { kind: 'corners', columns: 3, rows: 2, cell: 32, type: 'image/jpeg', orientation: 6 },
      profile: profile({ maxEdge: 24 }),
      points: [pointOf('TR', 16, 24, 2), pointOf('BR', 16, 24, 2), pointOf('TL', 16, 24, 2)],
    });
    expect([outcome.width, outcome.height]).toEqual([16, 24]);
    expect([sampled.width, sampled.height]).toEqual([16, 24]);
    close(sampled.colors[0], [255, 0, 0], 50);
    close(sampled.colors[1], [0, 255, 0], 50);
    close(sampled.colors[2], [0, 0, 255], 50);
  });

  test('never makes a picture larger, and writes the format the profile asks for', async ({ page }) => {
    const png = await transcode(page, {
      source: { kind: 'corners', columns: 3, rows: 2, cell: 5, type: 'image/png' },
      profile: profile({ output: 'png', maxEdge: 1600 }),
      points: [[1, 1]],
    });
    expect([png.outcome.width, png.outcome.height, png.outcome.mime]).toEqual([15, 10, 'image/png']);
    const bytes = Uint8Array.from(png.outcome.bytes);
    expect(sniffPicture(bytes)).toMatchObject({ ok: true, mime: 'image/png' });
    expect(readPictureHeader(bytes, 'image/png')).toMatchObject({ ok: true, width: 15, height: 10 });
    close(png.sampled.colors[0], [255, 0, 0], 0);

    const jpeg = await transcode(page, {
      source: { kind: 'corners', columns: 3, rows: 2, cell: 5, type: 'image/png' },
      profile: profile({ output: 'jpeg', maxEdge: 1600 }),
      points: [],
    });
    expect([jpeg.outcome.width, jpeg.outcome.height, jpeg.outcome.mime]).toEqual([15, 10, 'image/jpeg']);
    expect(sniffPicture(Uint8Array.from(jpeg.outcome.bytes))).toMatchObject({ ok: true, mime: 'image/jpeg' });
  });

  test('shrinks the long edge of a PNG and keeps its proportions', async ({ page }) => {
    const { outcome } = await transcode(page, {
      source: { kind: 'corners', columns: 10, rows: 5, cell: 40, type: 'image/png' },
      profile: profile({ output: 'png', maxEdge: 100 }),
      points: [],
    });
    expect([outcome.width, outcome.height]).toEqual([100, 50]);
  });

  test('flattens transparency onto white for a JPEG, and for a PNG only when asked', async ({ page }) => {
    const read = (flattenAlpha: boolean, output: 'png' | 'jpeg') =>
      page.evaluate(
        async ({ transcoderUrl, helpersUrl, flatten, out }) => {
          const transcoder = (await import(/* @vite-ignore */ transcoderUrl)) as typeof Transcoder;
          const helpers = (await import(/* @vite-ignore */ helpersUrl)) as typeof PagePictures;
          const bytes = await helpers.paint(16, 16, 'image/png', (context) => {
            context.fillStyle = 'rgb(200,0,0)';
            context.fillRect(8, 0, 8, 16);
          });
          const result = await transcoder.processPictureInBrowser(
            { bytes, mime: 'image/png', width: 16, height: 16 },
            { maxEdge: 4096, output: out, jpegQuality: 0.9, flattenAlpha: flatten, stripMetadata: true },
          );
          return helpers.sample(result.bytes, [[2, 8], [12, 8]]);
        },
        { transcoderUrl: TRANSCODER_URL, helpersUrl: HELPERS_URL, flatten: flattenAlpha, out: output },
      );
    const flat = await read(true, 'png');
    expect(flat.colors[0]).toEqual([255, 255, 255, 255]);
    expect(flat.colors[1]).toEqual([200, 0, 0, 255]);
    const kept = await read(false, 'png');
    expect(kept.colors[0]?.[3]).toBe(0);
    const jpeg = await read(false, 'jpeg');
    expect(jpeg.colors[0]?.slice(0, 3).every((v) => v > 240)).toBe(true);
  });

  test('keeps a picture that really is white: a valid white result is not a failed decode', async ({ page }) => {
    const result = await page.evaluate(
      async ({ transcoderUrl, helpersUrl }) => {
        const transcoder = (await import(/* @vite-ignore */ transcoderUrl)) as typeof Transcoder;
        const helpers = (await import(/* @vite-ignore */ helpersUrl)) as typeof PagePictures;
        const bytes = await helpers.paint(40, 30, 'image/png', (context) => {
          context.fillStyle = '#fff';
          context.fillRect(0, 0, 40, 30);
        });
        const out = await transcoder.processPictureInBrowser(
          { bytes, mime: 'image/png', width: 40, height: 30 },
          { maxEdge: 20, output: 'jpeg', jpegQuality: 0.9, flattenAlpha: true, stripMetadata: true },
        );
        return { width: out.width, height: out.height, seen: await helpers.sample(out.bytes, [[3, 3], [15, 10]]) };
      },
      { transcoderUrl: TRANSCODER_URL, helpersUrl: HELPERS_URL },
    );
    expect([result.width, result.height]).toEqual([20, 15]);
    for (const color of result.seen.colors) close(color, [255, 255, 255], 2);
  });

  test('hands back the stored bytes when a preserve profile has nothing to change', async ({ page }) => {
    const same = await page.evaluate(
      async ({ transcoderUrl, helpersUrl }) => {
        const transcoder = (await import(/* @vite-ignore */ transcoderUrl)) as typeof Transcoder;
        const helpers = (await import(/* @vite-ignore */ helpersUrl)) as typeof PagePictures;
        const bytes = helpers.withOrientation(await helpers.paintCorners(2, 2, 8, 'image/jpeg'), 6);
        const out = await transcoder.processPictureInBrowser(
          { bytes, mime: 'image/jpeg', width: 16, height: 16 },
          { maxEdge: 4096, output: 'preserve', jpegQuality: 0.9, flattenAlpha: false, stripMetadata: false },
        );
        return { same: out.bytes === bytes, width: out.width, height: out.height };
      },
      { transcoderUrl: TRANSCODER_URL, helpersUrl: HELPERS_URL },
    );
    expect(same).toEqual({ same: true, width: 16, height: 16 });
  });
});

test.describe('processPictureInBrowser refusals', () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page);
  });

  /** Runs the transcoder on bytes the page builds, and reports what it threw. */
  async function refusalFor(page: Page, build: 'garbage' | 'svg' | 'heic' | 'huge' | 'corrupt' | 'dead-canvas' | 'no-jpeg'): Promise<PagePictures.Caught | undefined> {
    return page.evaluate(
      async ({ transcoderUrl, helpersUrl, kind }) => {
        const transcoder = (await import(/* @vite-ignore */ transcoderUrl)) as typeof Transcoder;
        const helpers = (await import(/* @vite-ignore */ helpersUrl)) as typeof PagePictures;
        const text = (s: string): Uint8Array => new TextEncoder().encode(s);
        let bytes: Uint8Array;
        if (kind === 'garbage') bytes = Uint8Array.from([1, 2, 3, 4, 5, 6]);
        else if (kind === 'svg') bytes = text('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
        else if (kind === 'heic') bytes = Uint8Array.from([0, 0, 0, 24, ...text('ftypheic'), 0, 0, 0, 0, ...text('mif1heic')]);
        else if (kind === 'huge') {
          // A PNG header that states 10,000 x 5,001 pixels and nothing else: 50,000,000 and one row.
          const png = await helpers.paint(4, 4, 'image/png', () => undefined);
          bytes = png.slice();
          const view = new DataView(bytes.buffer);
          view.setUint32(16, 10_000);
          view.setUint32(20, 5_001);
        } else if (kind === 'corrupt') {
          const png = await helpers.paint(40, 40, 'image/png', (context) => {
            context.fillStyle = 'rgb(10,200,30)';
            context.fillRect(0, 0, 40, 40);
          });
          bytes = png.slice(0, png.length - 30);
        } else {
          bytes = await helpers.paintCorners(2, 2, 8, 'image/png');
        }
        const spec = { maxEdge: 4096, output: 'jpeg' as const, jpegQuality: 0.9, flattenAlpha: true, stripMetadata: true };
        if (kind === 'dead-canvas') {
          // A canvas that was allocated and silently holds nothing, as over a browser's size limit.
          const proto = OffscreenCanvasRenderingContext2D.prototype;
          const original = proto.getImageData;
          proto.getImageData = function (this: OffscreenCanvasRenderingContext2D, ...args: Parameters<typeof original>) {
            return new ImageData(Math.max(1, args[2]), Math.max(1, args[3]));
          } as typeof original;
          try {
            return await helpers.caught(() => transcoder.processPictureInBrowser({ bytes, mime: 'image/png', width: 16, height: 16 }, spec));
          } finally {
            proto.getImageData = original;
          }
        }
        if (kind === 'no-jpeg') {
          // A browser that cannot write JPEG answers with a PNG.
          const proto = OffscreenCanvas.prototype;
          const original = proto.convertToBlob;
          proto.convertToBlob = function (this: OffscreenCanvas, options?: ImageEncodeOptions) {
            return original.call(this, { ...options, type: 'image/png' });
          };
          try {
            return await helpers.caught(() => transcoder.processPictureInBrowser({ bytes, mime: 'image/png', width: 16, height: 16 }, spec));
          } finally {
            proto.convertToBlob = original;
          }
        }
        return helpers.caught(() => transcoder.processPictureInBrowser({ bytes, mime: 'image/png', width: 1, height: 1 }, spec));
      },
      { transcoderUrl: TRANSCODER_URL, helpersUrl: HELPERS_URL, kind: build },
    );
  }

  const cases: readonly [Parameters<typeof refusalFor>[1], string][] = [
    ['garbage', 'unsupported-format'],
    ['svg', 'unsupported-format'],
    ['heic', 'heic-unavailable'],
    ['huge', 'too-many-pixels'],
    ['corrupt', 'decode-failed'],
    ['dead-canvas', 'decode-failed'],
    ['no-jpeg', 'encode-failed'],
  ];
  for (const [kind, code] of cases) {
    test(`refuses ${kind} with the code ${code} and a remedy`, async ({ page }) => {
      const error = await refusalFor(page, kind);
      expect(error).toMatchObject({ name: 'PictureRefusal', code });
      expect(error?.remedy).toBeTruthy();
    });
  }

  test('the dead canvas says so, rather than blaming the picture', async ({ page }) => {
    expect((await refusalFor(page, 'dead-canvas'))?.message).toMatch(/canvas/i);
  });
});

test.describe('convertHeicInBrowser', () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page);
  });

  const heicOf = (width: number, height: number): number[] => {
    const text = (s: string): number[] => [...new TextEncoder().encode(s)];
    const u32 = (n: number): number[] => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    return [0, 0, 0, 24, ...text('ftypheic'), 0, 0, 0, 0, ...text('mif1heic'), ...u32(20), ...text('ispe'), 0, 0, 0, 0, ...u32(width), ...u32(height)];
  };

  test('refuses with the remedy where the browser has no HEIC decoder, and refuses what is not HEIC', async ({ page }) => {
    const outcome = await page.evaluate(
      async ({ transcoderUrl, helpersUrl, heic }) => {
        const transcoder = (await import(/* @vite-ignore */ transcoderUrl)) as typeof Transcoder;
        const helpers = (await import(/* @vite-ignore */ helpersUrl)) as typeof PagePictures;
        const none = await helpers.caught(() => transcoder.convertHeicInBrowser(Uint8Array.from(heic)));
        const png = await helpers.caught(async () => transcoder.convertHeicInBrowser(await helpers.paintCorners(2, 2, 4, 'image/png')));
        return { none, png };
      },
      { transcoderUrl: TRANSCODER_URL, helpersUrl: HELPERS_URL, heic: heicOf(4032, 3024) },
    );
    expect(outcome.none).toMatchObject({ name: 'PictureRefusal', code: 'heic-unavailable' });
    expect(outcome.none?.remedy).toMatch(/JPEG/);
    expect(outcome.png).toMatchObject({ name: 'PictureRefusal', code: 'unsupported-format' });
  });

  test('refuses a HEIC over 50,000,000 pixels without asking the browser to decode it', async ({ page }) => {
    const outcome = await page.evaluate(
      async ({ transcoderUrl, helpersUrl, heic }) => {
        const transcoder = (await import(/* @vite-ignore */ transcoderUrl)) as typeof Transcoder;
        const helpers = (await import(/* @vite-ignore */ helpersUrl)) as typeof PagePictures;
        const original = globalThis.createImageBitmap;
        let decoded = 0;
        globalThis.createImageBitmap = ((...args: Parameters<typeof original>) => {
          decoded += 1;
          return original(...args);
        }) as typeof original;
        try {
          const error = await helpers.caught(() => transcoder.convertHeicInBrowser(Uint8Array.from(heic)));
          return { error, decoded };
        } finally {
          globalThis.createImageBitmap = original;
        }
      },
      { transcoderUrl: TRANSCODER_URL, helpersUrl: HELPERS_URL, heic: heicOf(10_000, 5_001) },
    );
    expect(outcome.error).toMatchObject({ code: 'too-many-pixels' });
    expect(outcome.decoded).toBe(0);
  });

  test('writes a JPEG at quality 0.9 when the browser decodes the HEIC (stand-in decoder)', async ({ page }) => {
    const outcome = await page.evaluate(
      async ({ transcoderUrl, helpersUrl, heic }) => {
        const transcoder = (await import(/* @vite-ignore */ transcoderUrl)) as typeof Transcoder;
        const helpers = (await import(/* @vite-ignore */ helpersUrl)) as typeof PagePictures;
        const original = globalThis.createImageBitmap;
        const png = await helpers.paintCorners(3, 2, 16, 'image/png');
        globalThis.createImageBitmap = ((source: ImageBitmapSource, ...rest: unknown[]) => {
          const blob = source as Blob;
          const real = blob.type === 'image/heic' ? new Blob([png as BlobPart], { type: 'image/png' }) : blob;
          return (original as (...a: unknown[]) => Promise<ImageBitmap>)(real, ...rest);
        }) as typeof original;
        try {
          const result = await transcoder.convertHeicInBrowser(Uint8Array.from(heic));
          return { bytes: [...result.bytes], mime: result.mime, width: result.width, height: result.height, seen: await helpers.sample(result.bytes, [[4, 4]]) };
        } finally {
          globalThis.createImageBitmap = original;
        }
      },
      { transcoderUrl: TRANSCODER_URL, helpersUrl: HELPERS_URL, heic: heicOf(48, 32) },
    );
    expect([outcome.mime, outcome.width, outcome.height]).toEqual(['image/jpeg', 48, 32]);
    expect(sniffPicture(Uint8Array.from(outcome.bytes))).toMatchObject({ ok: true, mime: 'image/jpeg' });
    close(outcome.seen.colors[0], [255, 0, 0], 45);
  });
});
