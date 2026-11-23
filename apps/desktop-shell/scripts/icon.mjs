/**
 * Writes the app icon electron-builder packages, decoded from the base64 text that carries it.
 *
 * A binary file may not sit under a guarded root (test/searchable-sources.test.ts), so the PNG travels as text in
 * resources/icon.png.base64 and is decoded into build-resources/icon.png here. electron-builder finds that file through
 * `directories.buildResources` and derives the Windows .ico and the macOS .icns from it. The PNG signature is checked on the way
 * out, so a corrupted or truncated text file fails the packaging instead of shipping an icon-less installer.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'resources', 'icon.png.base64');
const target = join(root, 'build-resources', 'icon.png');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const text = readFileSync(source, 'utf8')
  .split('\n')
  .filter((line) => !line.startsWith('#') && line.trim() !== '')
  .join('');
const png = Buffer.from(text, 'base64');
if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
  throw new Error(`${source} does not decode to a PNG: expected the PNG signature, found ${png.subarray(0, 8).toString('hex')}`);
}
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, png);
process.stdout.write(`wrote ${target} (${statSync(target).size} bytes)\n`);
