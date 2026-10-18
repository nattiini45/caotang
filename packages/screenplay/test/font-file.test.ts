/**
 * What the two fallback fonts share (font-file.ts): cutting a subset into a font program. A failure while fontkit encodes
 * the subset must reach the caller as a rejection, so a compile fails with it instead of hanging or crashing the process.
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as fontkitModule from '@pdf-lib/fontkit';
import { describe, expect, it } from 'vitest';
import { encodeSubset } from '../src/font-file.js';

const fontkit = ((fontkitModule as unknown as { default?: typeof fontkitModule }).default ?? fontkitModule) as typeof fontkitModule;
const EMOJI_FONT = new URL('../src/fonts/NotoEmoji-Regular.ttf', import.meta.url);

type Subset = Parameters<typeof encodeSubset>[0];

/** The promise's outcome, or "pending" when it has not settled within `ms`: a hang is a failure, not a timeout. */
async function settled(promise: Promise<unknown>, ms = 2000): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms);
  });
  try {
    return await Promise.race([promise.then(() => 'resolved', (error: unknown) => error), pending]);
  } finally {
    clearTimeout(timer);
  }
}

describe('encodeSubset', () => {
  it('gives the font program of a real subset', async () => {
    const font = fontkit.create(readFileSync(EMOJI_FONT));
    const subset = font.createSubset();
    subset.includeGlyph(font.glyphForCodePoint(0x1f44d));
    const program = await encodeSubset(subset);
    expect(fontkit.create(program as Buffer).numGlyphs).toBeGreaterThanOrEqual(2);
  });

  it('rejects when the stream emits an error, instead of never settling', async () => {
    const stream = new EventEmitter();
    const subset = {
      encode: () => {},
      encodeStream: () => {
        setTimeout(() => stream.emit('error', new Error('stream failed')), 0);
        return stream;
      },
    } as unknown as Subset;
    const outcome = await settled(encodeSubset(subset));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('stream failed');
  });

  it('rejects when fontkit throws while it encodes, which it does on the next tick, outside the stream', async () => {
    const font = fontkit.create(readFileSync(EMOJI_FONT));
    const subset = font.createSubset();
    subset.includeGlyph(font.glyphForCodePoint(0x1f44d));
    (subset as unknown as { encode: () => void }).encode = () => {
      throw new Error('encode failed');
    };
    const outcome = await settled(encodeSubset(subset));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('encode failed');
  });
});
