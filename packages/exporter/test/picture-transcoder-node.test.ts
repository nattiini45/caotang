/**
 * The Node WebP transcoder (picture-transcoder-node.ts) and the PNG writer under it (png-encode.ts): a WebP in, a PNG out that
 * `pdf-lib` embeds, scaled down to a cap and never up. The sheet's own use of it is in contact-sheet.test.ts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { unzlibSync } from 'fflate/browser';
import { describe, expect, it } from 'vitest';

import { isAnimatedWebp } from '../src/image-size.js';
import { MAX_DECODED_PIXELS, WEBP_DECODER_FILE, transcodePictureInNode, webpDecoderCandidates } from '../src/picture-transcoder-node.js';
import { encodePng, scaleToFit } from '../src/png-encode.js';
import { webpFixture, type WebpFixture } from './webp-fixtures.js';

/** A PNG's header fields and its decompressed scanlines (filter byte included). */
function readPng(png: Uint8Array): { width: number; height: number; colorType: number; rows: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(new TextDecoder().decode(png.subarray(12, 16))).toBe('IHDR');
  expect(new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4))).toBe('IEND');
  const idat = png.subarray(41, 41 + view.getUint32(33));
  expect(new TextDecoder().decode(png.subarray(37, 41))).toBe('IDAT');
  return { width: view.getUint32(16), height: view.getUint32(20), colorType: png[25] ?? 0, rows: unzlibSync(idat) };
}

describe('encodePng', () => {
  it('writes an RGB PNG for a picture with no transparent pixel, which pdf-lib reads back at its size', async () => {
    const data = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255, 130, 140, 150, 255, 160, 170, 180, 255]);
    const png = encodePng({ width: 3, height: 2, data });
    const read = readPng(png);
    expect(read).toMatchObject({ width: 3, height: 2, colorType: 2 });
    expect([...read.rows]).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 0, 100, 110, 120, 130, 140, 150, 160, 170, 180]);
    const image = await (await PDFDocument.create()).embedPng(png);
    expect([image.width, image.height]).toEqual([3, 2]);
  });

  it('writes an RGBA PNG when any pixel is transparent, keeping the alpha', async () => {
    const data = new Uint8Array([1, 2, 3, 0, 4, 5, 6, 128, 7, 8, 9, 255, 10, 11, 12, 255]);
    const png = encodePng({ width: 2, height: 2, data });
    const read = readPng(png);
    expect(read).toMatchObject({ width: 2, height: 2, colorType: 6 });
    expect([...read.rows]).toEqual([0, 1, 2, 3, 0, 4, 5, 6, 128, 0, 7, 8, 9, 255, 10, 11, 12, 255]);
    const image = await (await PDFDocument.create()).embedPng(png);
    expect([image.width, image.height]).toEqual([2, 2]);
  });
});

describe('scaleToFit', () => {
  const flat = (width: number, height: number, rgba: readonly number[]) => ({
    width,
    height,
    data: Uint8Array.from({ length: width * height * 4 }, (_, at) => rgba[at % 4] ?? 0),
  });

  it('returns a picture that is small enough, or given no cap, as it is: never scaled up', () => {
    const picture = flat(40, 20, [1, 2, 3, 255]);
    expect(scaleToFit(picture, 40)).toBe(picture);
    expect(scaleToFit(picture, 1000)).toBe(picture);
    expect(scaleToFit(picture)).toBe(picture);
  });

  it('scales the longer side to the cap and the shorter by the same ratio', () => {
    const scaled = scaleToFit(flat(400, 100, [9, 8, 7, 255]), 100);
    expect([scaled.width, scaled.height]).toEqual([100, 25]);
    expect([...scaled.data.subarray(0, 4)]).toEqual([9, 8, 7, 255]);
  });

  it('averages the pixels each new pixel covers', () => {
    const data = new Uint8Array([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255]);
    const scaled = scaleToFit({ width: 2, height: 2, data }, 1);
    expect([scaled.width, scaled.height]).toEqual([1, 1]);
    expect([...scaled.data]).toEqual([100, 100, 100, 255]);
  });

  it('weights colour by alpha, so a transparent pixel adds none', () => {
    const data = new Uint8Array([200, 0, 0, 255, 0, 255, 0, 0]);
    const scaled = scaleToFit({ width: 2, height: 1, data }, 1);
    expect([...scaled.data]).toEqual([200, 0, 0, 128]);
  });
});

describe('transcodePictureInNode', () => {
  it.each<[WebpFixture, number, number, number]>([
    ['lossy', 96, 64, 2],
    ['lossless', 80, 48, 2],
    ['alpha', 64, 64, 6],
  ])('decodes the %s fixture to a PNG of %i × %i pixels', async (file, width, height, colorType) => {
    const png = await transcodePictureInNode(webpFixture(file), 'webp');
    expect(readPng(png)).toMatchObject({ width, height, colorType });
  });

  it('keeps the colours of a lossless WebP', async () => {
    const read = readPng(await transcodePictureInNode(webpFixture('lossless'), 'webp'));
    // The first stripe is red, the next is near black: (x >> 3) + (y >> 3) even is red.
    expect([...read.rows.subarray(1, 4)]).toEqual([200, 30, 40]);
    expect([...read.rows.subarray(1 + 8 * 3, 4 + 8 * 3)]).toEqual([20, 20, 30]);
  });

  it('keeps transparency: the corner of the alpha picture is clear, its centre is not', async () => {
    const read = readPng(await transcodePictureInNode(webpFixture('alpha'), 'webp'));
    const stride = 64 * 4 + 1;
    expect(read.rows[1 + 3]).toBe(0);
    expect(read.rows[32 * stride + 1 + 32 * 4 + 3]).toBe(255);
  });

  it('scales a large picture down to the cap and no further', async () => {
    const png = await transcodePictureInNode(webpFixture('large'), 'webp', 1000);
    expect(readPng(png)).toMatchObject({ width: 1000, height: 563 });
    const small = await transcodePictureInNode(webpFixture('lossy'), 'webp', 1000);
    expect(readPng(small)).toMatchObject({ width: 96, height: 64 });
  });

  it('refuses damaged bytes, naming the problem', async () => {
    await expect(transcodePictureInNode(webpFixture('corrupt'), 'webp')).rejects.toThrow('the WebP data could not be decoded');
    await expect(transcodePictureInNode(new Uint8Array([1, 2, 3]), 'webp')).rejects.toThrow('the WebP data could not be decoded');
  });

  it('refuses an animated WebP: the decoder reads a still image only', async () => {
    expect(isAnimatedWebp(webpFixture('animated'))).toBe(true);
    expect(isAnimatedWebp(webpFixture('lossy'))).toBe(false);
    await expect(transcodePictureInNode(webpFixture('animated'), 'webp')).rejects.toThrow('the WebP is animated');
  });

  it('refuses a WebP that states more pixels than it decodes, before it decodes', async () => {
    // A VP8L header claiming 16000 × 16000 pixels, with no image data behind it.
    const bytes = new Uint8Array(30);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    bytes.set(new TextEncoder().encode('WEBPVP8L'), 8);
    bytes[20] = 0x2f;
    const packed = (15999 | (15999 << 14)) >>> 0;
    new DataView(bytes.buffer).setUint32(21, packed, true);
    expect(16000 * 16000).toBeGreaterThan(MAX_DECODED_PIXELS);
    await expect(transcodePictureInNode(bytes, 'webp')).rejects.toThrow('16000 × 16000 pixels');
  });

  it('is found beside the running module first, then in @jsquash/webp', () => {
    const moduleUrl = pathToFileURL(join(resolve('/server'), 'caotang-mcp.mjs')).href;
    const candidates = webpDecoderCandidates(moduleUrl);
    expect(candidates[0]).toBe(join(resolve('/server'), WEBP_DECODER_FILE));
    const fromCheckout = webpDecoderCandidates();
    expect(dirname(fromCheckout[0] ?? '')).toBe(resolve(__dirname, '../src'));
    expect(fromCheckout[1]?.replaceAll('\\', '/')).toMatch(/@jsquash\/webp\/codec\/dec\/webp_dec\.wasm$/);
  });
});

describe('the app does not carry the Node decoder', () => {
  const app = (path: string): string => readFileSync(resolve(__dirname, '../../../apps/desktop', path), 'utf8');

  it('depends on no decoder, draws a WebP on a canvas, and keeps a CSP that refuses WebAssembly', () => {
    expect(app('package.json')).not.toMatch(/jsquash/);
    expect(app('src/app/picture-transcoder.ts')).not.toMatch(/^import [^\n]*(?:jsquash|node:|picture-transcoder-node)/m);
    expect(app('src/app/session.ts')).toMatch(/transcodePicture: transcodePictureInBrowser/);
    expect(app('src/app/session.ts')).not.toMatch(/picture-transcoder-node/);
    expect(app('index.html')).toMatch(/script-src 'self'/);
    expect(app('index.html')).not.toMatch(/wasm-unsafe-eval/);
  });
});
