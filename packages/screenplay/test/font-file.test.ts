/**
 * Reading a font file that ships beside the module (font-file.ts). Whatever is served in a font's place must be refused
 * with what it was, not reach fontkit as a parse error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fontFileBytes } from '../src/font-file.js';

afterEach(() => vi.unstubAllGlobals());

describe('fontFileBytes', () => {
  it('reads a font file from disk and returns its bytes', async () => {
    const bytes = await fontFileBytes(new URL('../src/fonts/NotoEmoji-Regular.ttf', import.meta.url), 'emoji fallback font');
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it('refuses an HTML page served in place of a font, over HTTP', async () => {
    vi.stubGlobal('fetch', async () => new Response('<!doctype html><html></html>', { status: 200 }));
    await expect(fontFileBytes(new URL('https://app.example/assets/font.otf'), 'CJK fallback font')).rejects.toThrow(
      'CJK fallback font did not serve a font file (28 bytes, starting "<!doctype html><")',
    );
  });

  it('reports a failed response by its status', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404, statusText: 'Not Found' }));
    await expect(fontFileBytes(new URL('https://app.example/assets/font.otf'), 'CJK fallback font')).rejects.toThrow('did not load (404 Not Found)');
  });
});
