/**
 * How the PDF reads its two fallback fonts (screenplay.md §5.3): through the loader the host passes, with what it returns
 * checked first. Whatever is served in a font's place is refused with what it was, and a compile that gives no loader prints
 * what the font would have printed as "?" and loads nothing.
 */

import { describe, expect, it } from 'vitest';
import type { FlatBlock } from '../src/index.js';
import { createPdfRenderer, importFountainScript, layoutPdf, loadCjkFallback, loadEmojiFallback } from '../src/index.js';
import { LOADERS } from './fixtures/fonts.js';
import { text } from './fixtures/corpus.js';

function blocksOf(source: string): FlatBlock[] {
  return importFountainScript(source).nodes.map((node, i): FlatBlock => ({ kind: 'scene', docId: `d${i}`, body: (node as { body: string }).body, title: (node as { title: string }).title, number: i + 1 }));
}

const html = async (): Promise<Uint8Array> => new TextEncoder().encode('<!doctype html><html></html>');
const CJK = blocksOf(text('INT. 草堂 - DAY', '', 'She reads 草堂 aloud.'));
const EMOJI = blocksOf(text('INT. ROOM - DAY', '', 'Thumbs up 👍.'));

describe('the fallback font loaders', () => {
  it('refuse an HTML page served in the CJK font’s place, with the checkFontBytes message', async () => {
    const layout = layoutPdf(CJK, { title: 'T' });
    await expect(loadCjkFallback(layout, html)).rejects.toThrow('the CJK fallback font did not serve a font file (28 bytes, starting "<!doctype html><")');
  });

  it('refuse an HTML page served in the emoji font’s place, with the checkFontBytes message', async () => {
    const layout = layoutPdf(EMOJI, { title: 'T' });
    await expect(loadEmojiFallback(layout, html)).rejects.toThrow('the emoji fallback font did not serve a font file (28 bytes, starting "<!doctype html><")');
  });

  it('fail the render with the loader’s own error, and read the font again on the next compile', async () => {
    const layout = layoutPdf(CJK, { title: 'T' });
    let calls = 0;
    const flaky = async (): Promise<Uint8Array> => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return LOADERS.cjk();
    };
    await expect(loadCjkFallback(layout, flaky)).rejects.toThrow('offline');
    expect(await loadCjkFallback(layout, flaky)).toBeDefined();
    expect(calls).toBe(2);
  });

  it('read a font once however many compiles ask for it', async () => {
    const layout = layoutPdf(CJK, { title: 'T' });
    let calls = 0;
    const counting = async (): Promise<Uint8Array> => {
      calls += 1;
      return LOADERS.cjk();
    };
    await loadCjkFallback(layout, counting);
    await loadCjkFallback(layout, counting);
    expect(calls).toBe(1);
  });

  it('are not called for a script the Courier Prime font prints whole, nor when the host gives none', async () => {
    const latin = layoutPdf(blocksOf(text('INT. CAFÉ - DAY', '', 'Crème brûlée.')), { title: 'T' });
    const never = async (): Promise<Uint8Array> => {
      throw new Error('read a font for a Latin-only script');
    };
    expect(await loadCjkFallback(latin, never)).toBeUndefined();
    expect(await loadEmojiFallback(latin, never)).toBeUndefined();
    expect(await loadCjkFallback(layoutPdf(CJK, { title: 'T' }))).toBeUndefined();
    const blob = await createPdfRenderer().emit(CJK, { title: 'T' });
    expect(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))).not.toContain('/CIDFontType2');
  });
});
