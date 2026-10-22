import { describe, expect, it } from 'vitest';
import { ArtifactNotFoundError, type ArtifactFs } from '@caotang/store';

/** A payload with every byte value a UTF-8 decoder would reject or mangle. */
const BINARY = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x80, 0xc3, 0x28, 0xff, 0xfe, 0x00]);

/**
 * The `ArtifactFs` contract (artifact-fs.ts, project-format.md §4), written once and run against every binding, the
 * in-memory one included, so the encrypted remote one is held to what the others do and not to its own idea of it.
 */
export function artifactFsContract(label: string, make: () => Promise<ArtifactFs>): void {
  describe(`ArtifactFs contract: ${label}`, () => {
    it('writes and reads text back, and a second write replaces the first', async () => {
      const fs = await make();
      await fs.writeAtomic('docs/n_ONE.md', 'caf\u00e9\n');
      expect(await fs.read('docs/n_ONE.md')).toBe('caf\u00e9\n');
      await fs.writeAtomic('docs/n_ONE.md', 'second');
      expect(await fs.read('docs/n_ONE.md')).toBe('second');
      await fs.writeAtomic('docs/n_ONE.md', '');
      expect(await fs.read('docs/n_ONE.md')).toBe('');
    });

    it('reports an absent path as not found, for text and bytes', async () => {
      const fs = await make();
      await expect(fs.read('nope.md')).rejects.toBeInstanceOf(ArtifactNotFoundError);
      await expect(fs.readBytes('nope.md')).rejects.toBeInstanceOf(ArtifactNotFoundError);
    });

    it('writes and reads bytes exactly, and reads a text file as its UTF-8 bytes', async () => {
      const fs = await make();
      await fs.writeBytesAtomic('exports/manuscript.docx', BINARY);
      expect(await fs.readBytes('exports/manuscript.docx')).toEqual(BINARY);
      await fs.writeAtomic('exports/ToC.md', 'caf\u00e9\n');
      expect(await fs.readBytes('exports/ToC.md')).toEqual(new TextEncoder().encode('caf\u00e9\n'));
    });

    it('refuses a text read of bytes that are not UTF-8', async () => {
      const fs = await make();
      await fs.writeBytesAtomic('exports/manuscript.docx', BINARY);
      await expect(fs.read('exports/manuscript.docx')).rejects.toThrow(TypeError);
    });

    it('returns a copy, so an edit to what was read cannot reach the artifact', async () => {
      const fs = await make();
      await fs.writeBytesAtomic('a.bin', BINARY);
      const first = await fs.readBytes('a.bin');
      first[0] = 0;
      expect((await fs.readBytes('a.bin'))[0]).toBe(0x50);
    });

    it('copies what it is given, so editing the buffer after the write changes nothing', async () => {
      const fs = await make();
      const bytes = BINARY.slice();
      await fs.writeBytesAtomic('a.bin', bytes);
      bytes[0] = 0;
      expect((await fs.readBytes('a.bin'))[0]).toBe(0x50);
    });

    it('lists the files and directories directly inside a directory, sorted, not recursively', async () => {
      const fs = await make();
      await fs.writeAtomic('caotang.json', '{}');
      await fs.writeAtomic('docs/b.md', 'b');
      await fs.writeAtomic('docs/a.md', 'a');
      await fs.writeAtomic('docs/deep/c.md', 'c');
      await fs.writeAtomic('codex/e.md', 'e');
      expect(await fs.listFiles('')).toEqual(['caotang.json']);
      expect(await fs.listFiles('docs')).toEqual(['a.md', 'b.md']);
      expect(await fs.listDirs('')).toEqual(['codex', 'docs']);
      expect(await fs.listDirs('docs')).toEqual(['deep']);
      expect(await fs.listFiles('absent')).toEqual([]);
      expect(await fs.listDirs('absent')).toEqual([]);
    });

    it('lists a directory made with ensureDir, nested, and keeps it when it is empty', async () => {
      const fs = await make();
      await fs.ensureDir('assets/img/small');
      await fs.ensureDir('assets/img/small');
      expect(await fs.listDirs('')).toEqual(['assets']);
      expect(await fs.listDirs('assets')).toEqual(['img']);
      expect(await fs.listDirs('assets/img')).toEqual(['small']);
      expect(await fs.listFiles('assets/img/small')).toEqual([]);
    });

    it('knows what exists: files, directories (explicit or holding a file), the root, and nothing else', async () => {
      const fs = await make();
      await fs.writeAtomic('docs/a.md', 'a');
      await fs.ensureDir('exports');
      expect(await fs.exists('docs/a.md')).toBe(true);
      expect(await fs.exists('docs')).toBe(true);
      expect(await fs.exists('exports')).toBe(true);
      expect(await fs.exists('')).toBe(true);
      expect(await fs.exists('docs/b.md')).toBe(false);
      expect(await fs.exists('doc')).toBe(false);
    });

    it('removes a text or binary file, is a no-op for an absent one, and refuses a directory', async () => {
      const fs = await make();
      await fs.writeAtomic('docs/a.md', 'a');
      await fs.writeBytesAtomic('exports/x.epub', BINARY);
      await fs.ensureDir('keep');
      await fs.remove('docs/a.md');
      await fs.remove('exports/x.epub');
      await fs.remove('never-was.md');
      expect(await fs.exists('docs/a.md')).toBe(false);
      expect(await fs.listFiles('docs')).toEqual([]);
      await expect(fs.read('docs/a.md')).rejects.toBeInstanceOf(ArtifactNotFoundError);
      await expect(fs.readBytes('exports/x.epub')).rejects.toBeInstanceOf(ArtifactNotFoundError);
      await expect(fs.remove('keep')).rejects.toThrow(/directory/);
      expect(await fs.exists('keep')).toBe(true);
    });

    it('writes again to a path that was removed', async () => {
      const fs = await make();
      await fs.writeAtomic('a.md', 'one');
      await fs.remove('a.md');
      await fs.writeAtomic('a.md', 'two');
      expect(await fs.read('a.md')).toBe('two');
      expect(await fs.listFiles('')).toEqual(['a.md']);
    });

    it('keeps a path that is a prototype property name an ordinary path', async () => {
      const fs = await make();
      await fs.writeAtomic('__proto__', 'x');
      await fs.writeAtomic('constructor', 'y');
      expect(await fs.read('__proto__')).toBe('x');
      expect(await fs.listFiles('')).toEqual(['__proto__', 'constructor']);
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    });

    it('refuses an absolute path and a path that escapes the root, on every call', async () => {
      const fs = await make();
      for (const bad of ['/etc/passwd', 'C:/x', '../x', 'docs/../../x']) {
        await expect(fs.read(bad), bad).rejects.toThrow(/project/);
        await expect(fs.writeAtomic(bad, 'x'), bad).rejects.toThrow(/project/);
        await expect(fs.writeBytesAtomic(bad, BINARY), bad).rejects.toThrow(/project/);
        await expect(fs.readBytes(bad), bad).rejects.toThrow(/project/);
        await expect(fs.listFiles(bad), bad).rejects.toThrow(/project/);
        await expect(fs.listDirs(bad), bad).rejects.toThrow(/project/);
        await expect(fs.exists(bad), bad).rejects.toThrow(/project/);
        await expect(fs.ensureDir(bad), bad).rejects.toThrow(/project/);
        await expect(fs.remove(bad), bad).rejects.toThrow(/project/);
      }
    });
  });
}
