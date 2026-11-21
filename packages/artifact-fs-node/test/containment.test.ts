/**
 * Root containment on a real folder, and the comparison it rests on (#812).
 *
 * The check resolves the target's nearest existing ancestor and the project folder, then asks whether the first is inside the
 * second. Both sides must be resolved by the same call: on Windows the two realpath implementations do not always agree on the
 * canonical form of a path, and the runner's temp folder — `C:\Users\RUNNER~1\AppData\Local\Temp\…` — is the path that showed it,
 * with every write into a folder there refused as if it pointed outside itself.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ArtifactPathError, NodeArtifactFs, withinRealRoot } from '../src/index.js';

const made: string[] = [];
const tempDir = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `caotang-containment-${name}-`));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('withinRealRoot', () => {
  it('accepts the folder itself and anything below it', () => {
    expect(withinRealRoot('/projects/book', '/projects/book', 'linux')).toBe(true);
    expect(withinRealRoot('/projects/book/docs/n_1.md', '/projects/book', 'linux')).toBe(true);
  });

  it('refuses a sibling whose name starts with the folder name', () => {
    expect(withinRealRoot('/projects/book-two/docs', '/projects/book', 'linux')).toBe(false);
    expect(withinRealRoot('C:\\projects\\book-two\\docs', 'C:\\projects\\book', 'win32')).toBe(false);
  });

  it('refuses a parent of the folder', () => {
    expect(withinRealRoot('/projects', '/projects/book', 'linux')).toBe(false);
  });

  it('is case-sensitive where the file system is, and case-insensitive on Windows', () => {
    expect(withinRealRoot('/projects/Book/docs', '/projects/book', 'linux')).toBe(false);
    expect(withinRealRoot('C:\\Projects\\Book\\docs', 'c:\\projects\\book', 'win32')).toBe(true);
    expect(withinRealRoot('C:/Projects/Book/docs', 'C:\\projects\\book', 'win32')).toBe(true);
  });
});

describe('NodeArtifactFs containment', () => {
  it('writes into a folder under the system temp directory', async () => {
    // The Windows runner's temp path is where a real folder was read as outside itself, so a plain write there is the case that
    // has to keep working. It is the same shape every fixture in the suites uses.
    const root = tempDir('temp-root');
    const fs = new NodeArtifactFs(root);
    await fs.writeAtomic('docs/n_1.md', '# A scene\n');
    expect(await fs.read('docs/n_1.md')).toBe('# A scene\n');
  });

  it('refuses a folder that is not there, and says so as ENOENT', () => {
    // The callers report this as "the folder could not be opened", so it has to happen when the writer is made.
    expect(() => new NodeArtifactFs(join(tempDir('missing-parent'), 'missing'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it('accepts a folder reached through a link, because the link leads to the folder', async () => {
    const real = tempDir('real-root');
    mkdirSync(join(real, 'docs'));
    const alias = join(tempDir('alias-parent'), 'linked');
    symlinkSync(realpathSync(real), alias, 'dir');
    const fs = new NodeArtifactFs(alias);
    await fs.writeAtomic('docs/n_2.md', '# Through the link\n');
    expect(await fs.read('docs/n_2.md')).toBe('# Through the link\n');
  });

  it('refuses a path whose link leads out of the folder', async () => {
    const outside = tempDir('outside');
    const root = tempDir('inside');
    symlinkSync(realpathSync(outside), join(root, 'escape'), 'dir');
    const fs = new NodeArtifactFs(root);
    await expect(fs.writeAtomic('escape/n_3.md', '# Not here\n')).rejects.toThrow(ArtifactPathError);
    // Reading through the same link is refused too, rather than answering an empty folder.
    await expect(fs.listFiles('escape')).rejects.toThrow(ArtifactPathError);
  });
});
