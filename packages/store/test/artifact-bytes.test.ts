/**
 * Binary files through the artifact port.
 *
 * The DOCX and EPUB renderers write their output under `exports/` through
 * `ArtifactFs`, so the port has to carry bytes. The contract is the text
 * contract's, with two differences: a binary read of a text file gives its UTF-8
 * bytes, and a text read of a binary file is refused rather than decoded lossily.
 */

import { describe, expect, it } from 'vitest';
import { MemoryArtifactFs, ArtifactNotFoundError, joinPath } from '../src/index.js';

/** A payload with every byte value a UTF-8 decoder would reject or mangle. */
const BINARY = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x80, 0xc3, 0x28, 0xff, 0xfe, 0x00]);

describe('binary files through ArtifactFs', () => {
  it('writes and reads bytes back exactly, including bytes UTF-8 would not accept', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeBytesAtomic('exports/manuscript.docx', BINARY);

    expect(await fs.readBytes('exports/manuscript.docx')).toEqual(BINARY);
  });

  it('reads a text file as its UTF-8 bytes, so a caller need not know which kind a path holds', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeAtomic('exports/ToC.md', 'café\n');

    expect(await fs.readBytes('exports/ToC.md')).toEqual(new TextEncoder().encode('café\n'));
  });

  it('refuses a text read of a binary file rather than decoding it lossily', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeBytesAtomic('exports/manuscript.docx', BINARY);

    await expect(fs.read('exports/manuscript.docx')).rejects.toThrow(TypeError);
  });

  it('returns a copy, so an edit to what was read cannot reach the artifact', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeBytesAtomic('exports/manuscript.docx', BINARY);

    const first = await fs.readBytes('exports/manuscript.docx');
    first[0] = 0x00;

    expect((await fs.readBytes('exports/manuscript.docx'))[0]).toBe(0x50);
  });

  it('removes a binary file through the same remove() as a text one, and reports absence as not-found', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeBytesAtomic('exports/manuscript.epub', BINARY);
    expect(await fs.exists('exports/manuscript.epub')).toBe(true);

    await fs.remove('exports/manuscript.epub');

    expect(await fs.exists('exports/manuscript.epub')).toBe(false);
    await expect(fs.readBytes('exports/manuscript.epub')).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it('replaces a text file with bytes at the same path, and the path lists once', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeAtomic('exports/out.bin', 'placeholder');
    await fs.writeBytesAtomic('exports/out.bin', BINARY);

    expect(await fs.listFiles('exports')).toEqual(['out.bin']);
    expect(await fs.readBytes('exports/out.bin')).toEqual(BINARY);
  });
});

describe('joinPath', () => {
  it('joins a directory and a name, dropping trailing slashes from the directory', () => {
    expect(joinPath('', 'a.md')).toBe('a.md');
    expect(joinPath('.', 'a.md')).toBe('a.md');
    expect(joinPath('docs', 'a.md')).toBe('docs/a.md');
    expect(joinPath('docs/', 'a.md')).toBe('docs/a.md');
    expect(joinPath('docs///', 'a.md')).toBe('docs/a.md');
    expect(joinPath('/', 'a.md')).toBe('/a.md');
    expect(joinPath('///', 'a.md')).toBe('/a.md');
    expect(joinPath('dös/ünï/', 'ä.md')).toBe('dös/ünï/ä.md');
  });

  it('joins in linear time when the directory is a long run of slashes', () => {
    // `/\/+$/` took ~800 ms on this at 30k.
    const hostile = `${'/'.repeat(100_000)}x`;
    const start = performance.now();
    expect(joinPath(hostile, 'a.md')).toBe(`${hostile}/a.md`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
