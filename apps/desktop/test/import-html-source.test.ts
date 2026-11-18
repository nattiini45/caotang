/**
 * The HTML import on the shared preview (apps/desktop/src/import-preview/html-source.ts, issue #299): the size refusal before any
 * byte is loaded, the report's safety counts, and the pictures it offers — only ones the store's strict pipeline will take, so one
 * unsupported file cannot refuse the whole import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_LIMITS } from '@caotang/import-read/zip';
import { MAX_TEXT_BYTES } from '@caotang/import-read/text';

import { pinFormatLocale } from '../src/i18n/locale.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { NO_OVERRIDES, initialSettings, type ImportPreviewSource } from '../src/import-preview/model.js';
import { htmlPreviewSource, htmlSizeRefusal, htmlZipPreviewSource } from '../src/import-preview/html-source.js';
import { createReaderSession } from '../src/import-preview/reader-session.js';
import type { ReaderOpen, ReaderRead } from '../src/import-preview/reader-protocol.js';

/** The same reader session the real Worker runs, in process, so these tests exercise real reader output in Node. */
class InProcessWorker {
  private readonly handle = createReaderSession();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor(_url: unknown, _options?: unknown) {}
  postMessage(message: { id: number } & (ReaderOpen | ReaderRead)): void {
    void this.handle(message).then(
      (result) => this.onmessage?.({ data: { id: message.id, ok: true, result } }),
      (error: unknown) => this.onmessage?.({ data: { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) } }),
    );
  }
  terminate(): void {}
}

beforeEach(() => {
  activateEnglish();
  pinFormatLocale('en-US');
  vi.stubGlobal('Worker', InProcessWorker);
});
afterEach(() => {
  activateEnglish();
  pinFormatLocale(undefined);
  vi.unstubAllGlobals();
});

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A PNG with a real signature and IHDR, which is what the store's pipeline sniffs. */
function pngOf(width = 1, height = 1): Uint8Array {
  const be = (value: number): number[] => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be(width), ...be(height), 8, 6, 0, 0, 0]);
}

async function open(html: string, fileName = 'page.html'): Promise<ImportPreviewSource> {
  const source = htmlPreviewSource(fileName, bytesOf(html));
  await source.load?.(() => {}, new AbortController().signal);
  return source;
}

describe('the HTML preview source (#299)', () => {
  it('refuses a file past its cap by name and size, before its bytes are read', () => {
    expect(htmlSizeRefusal('page.html', MAX_TEXT_BYTES, MAX_TEXT_BYTES)).toBeUndefined();
    const page = htmlSizeRefusal('page.html', MAX_TEXT_BYTES + 1, MAX_TEXT_BYTES);
    expect(page).toContain('page.html');
    expect(page).toContain('too large to import as HTML');
    // A zip is measured against the archive's own cap, not the text reader's.
    expect(htmlSizeRefusal('page.zip', MAX_TEXT_BYTES + 1, ARCHIVE_LIMITS.maxArchiveBytes)).toBeUndefined();
    expect(htmlSizeRefusal('page.zip', ARCHIVE_LIMITS.maxArchiveBytes + 1, ARCHIVE_LIMITS.maxArchiveBytes)).toContain('page.zip');
  });

  it('names a script in the head and a remote picture in its report', async () => {
    const source = await open('<html><head><script>alert(1)</script></head><body><h1>One</h1><p>The ferry.</p><img src="https://example.com/x.png" alt="x"/></body></html>');
    const lists = source.report();
    expect(lists.find((list) => list.label === 'What the import removed')?.lines.join(' ')).toContain('1 script was removed');
    expect(lists.find((list) => list.label === 'What was not downloaded')?.lines.join(' ')).toContain('1 picture on the internet was not downloaded');
  });

  it('offers only pictures the store will take, and keeps the words of the one it will not', async () => {
    const good = 'data:image/png;base64,' + Buffer.from(pngOf()).toString('base64');
    const gif = 'data:image/gif;base64,' + Buffer.from('GIF89a').toString('base64');
    const source = await open(`<html><body><img src="${good}" alt="the lamp"/><p><img src="${gif}" alt="the chart"/></p></body></html>`);
    const pictures = source.pictures();
    expect(pictures).toHaveLength(1);
    expect(pictures[0]?.alt).toBe('the lamp');
    const plan = source.plan(initialSettings(source.chips(), source.options()), NO_OVERRIDES);
    const bodies = plan.blocks.map((block) => block.text).join('\n');
    expect(bodies).toContain('the chart');
    expect(bodies).not.toContain('import:html-image-1');
    expect(plan.losses.map((loss) => loss.message).join(' ')).toContain('not a PNG, JPEG or WebP');
  });

  it('opens a web-page zip through the same source', async () => {
    const source = htmlZipPreviewSource('page.zip', bytesOf('not a zip'));
    await expect(source.load?.(() => {}, new AbortController().signal)).rejects.toThrow();
  });
});
