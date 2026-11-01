/**
 * Helpers shared by the localisation guards ([i18n.md §8.2](../docs/architecture/i18n.md), I8 / #195).
 *
 * `check-ui-strings.mjs`, `check-translations.mjs` and `logical-css.mjs` all need the same three
 * things: a platform-stable relative path, a way for a test to import the module without running its
 * CLI, and a sorted walk over the source tree. Keeping one copy here means a change to the walk — an
 * extra skipped directory, a new extension — cannot drift between the guards.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A path relative to a scan root, with forward slashes, so JSON and report keys are stable everywhere. */
export function posixPath(path) {
  return path.split(sep).join('/');
}

/** True when `moduleUrl` is the process entry point rather than an import from a test. */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === moduleUrl;
}

/**
 * Every file under `root`, depth-first with sorted directory entries. Callers filter by extension; the
 * order is the one both the walkers and the report lines have always used.
 */
export function walkFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      files.push(path);
    }
  };
  walk(root);
  return files;
}

/** Every TypeScript/TSX source file under `root`, without tests or declarations. */
export function sourceFilesUnder(root) {
  if (!statSync(root).isDirectory()) return [];
  return walkFiles(root).filter((path) => /\.(ts|tsx)$/.test(path) && !/\.d\.ts$/.test(path) && !/\.(test|spec)\.(ts|tsx)$/.test(path));
}

/** The top-of-file marker that exempts a file from translation (i18n.md §3.4). */
export const MODEL_FACING_MARKER = '// i18n: model-facing';
