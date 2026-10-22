/**
 * The byte checks and the WOFF unpacker both PDFs read their fonts through (font-bytes.ts): a font file is known by its first
 * bytes, an HTML page served in its place is named as such, and a WOFF unpacks to the TrueType file it wraps, within limits.
 */

import { zlibSync } from 'fflate/browser';
import { describe, expect, it } from 'vitest';
import { MAX_SFNT_BYTES, checkFontBytes, looksLikeFont, sfntFromWoff } from '../src/font-bytes.js';
import { loadCjkFontInNode, loadEmojiFontInNode } from '../src/node-loader.js';

describe('font bytes', () => {
  it('leaves bytes that are not WOFF as they are', async () => {
    const bytes = new Uint8Array([0, 1, 0, 0, 9, 9]);
    expect(await sfntFromWoff(bytes)).toBe(bytes);
  });

  it('unpacks a well-formed WOFF table to its stated length', async () => {
    const table = new Uint8Array(1000).fill(7);
    const sfnt = await sfntFromWoff(woffOf({ data: zlibSync(table), origLength: 1000 }));
    expect(sfnt.byteLength).toBe(12 + 16 + 1000);
    expect([...sfnt.subarray(28, 1028)]).toEqual([...table]);
  });

  it('refuses a WOFF that says it unpacks to more than a font may, before inflating anything', async () => {
    await expect(sfntFromWoff(woffOf({ data: zlibSync(new Uint8Array(10)), origLength: 10, totalSfntSize: MAX_SFNT_BYTES + 1 }))).rejects.toThrow(
      `the WOFF file says it unpacks to ${MAX_SFNT_BYTES + 1} bytes, more than a font may (${MAX_SFNT_BYTES})`,
    );
    // A table whose stated length is past the file's stated size: refused before it is inflated.
    await expect(sfntFromWoff(woffOf({ data: zlibSync(new Uint8Array(10)), origLength: 0xffffffff, totalSfntSize: 1024 }))).rejects.toThrow(
      'the WOFF tables unpack to more than the file says it holds',
    );
  });

  it('stops inflating a WOFF table one byte past its stated length, and refuses it', async () => {
    // A stream of about 1 KB that decodes to 1 MB, in a table that says it holds 2000 bytes.
    const bomb = zlibSync(new Uint8Array(1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(2000);
    await expect(sfntFromWoff(woffOf({ data: bomb, origLength: 2000 }))).rejects.toThrow('a WOFF table did not inflate to its stated length');
  });

  it('knows a font file by its first bytes, and names what was served in its place', async () => {
    expect(looksLikeFont(await loadCjkFontInNode())).toBe(true);
    expect(looksLikeFont(await loadEmojiFontInNode())).toBe(true);
    for (const head of [[0, 1, 0, 0], [...'OTTO'], [...'true'], [...'ttcf'], [...'wOF2']]) {
      const bytes = new Uint8Array(head.map((byte) => (typeof byte === 'number' ? byte : byte.charCodeAt(0))));
      expect(looksLikeFont(bytes)).toBe(true);
    }
    const html = new TextEncoder().encode('<!doctype html><html></html>');
    expect(looksLikeFont(html)).toBe(false);
    expect(looksLikeFont(new Uint8Array([0x77]))).toBe(false);
    expect(() => checkFontBytes(html, '/assets/NotoEmoji-Regular.woff')).toThrow(
      '/assets/NotoEmoji-Regular.woff did not serve a font file (28 bytes, starting "<!doctype html><")',
    );
    const woff = await loadCjkFontInNode();
    expect(checkFontBytes(woff, 'x')).toBe(woff);
  });
});

/** A WOFF 1.0 file with one table, whose header states what the test asks, true or not. */
function woffOf(table: { data: Uint8Array; origLength: number; totalSfntSize?: number }): Uint8Array {
  const offset = 44 + 20;
  const bytes = new Uint8Array(offset + table.data.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x774f4646);
  view.setUint32(4, 0x00010000);
  view.setUint32(8, bytes.byteLength);
  view.setUint16(12, 1);
  view.setUint32(16, table.totalSfntSize ?? 12 + 16 + table.origLength);
  view.setUint32(44, 0x74657374); // 'test'
  view.setUint32(48, offset);
  view.setUint32(52, table.data.byteLength);
  view.setUint32(56, table.origLength);
  bytes.set(table.data, offset);
  return bytes;
}

