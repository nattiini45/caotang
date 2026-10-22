/**
 * The fallback fonts, read in Node: the MCP server, and the tests. The app has its own loaders, over `fetch`
 * (apps/desktop/src/app/fallback-fonts.ts), so this file is a subpath of its own (`@caotang/pdf-fonts/node-loader`) and the
 * package's index never imports it: the browser bundle never sees `node:fs`.
 *
 * Two fonts, each a {@link FontLoader}: Noto Sans Mono CJK SC (`@caotang/font-noto-cjk`) and Noto Emoji
 * (`@caotang/font-noto-emoji`). Where each loader looks, in order:
 *
 * 1. `fonts/<file>` beside the running module. The MCPB bundle stages both files there, beside `caotang-mcp.mjs`, so the
 *    installed server needs no `node_modules`.
 * 2. The font's package, resolved from the running module: a checkout, and the built bundle run in place.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FontLoader } from './font-bytes.js';
import { CJK_FONT_FILE, EMOJI_FONT_FILE } from './font-files.js';

const CJK_PACKAGE = '@caotang/font-noto-cjk';
const EMOJI_PACKAGE = '@caotang/font-noto-emoji';

/** The places a font file is read from, in the order they are tried. */
function fontCandidates(file: string, pkg: string, moduleUrl: string): string[] {
  const candidates = [join(dirname(fileURLToPath(moduleUrl)), 'fonts', file)];
  try {
    candidates.push(createRequire(moduleUrl).resolve(`${pkg}/${file}`));
  } catch {
    // Not resolvable from here: the bundled copy, if any, is the only place.
  }
  return candidates;
}

/** Reads a font from the first place that holds it, and says every place it looked when none does. */
async function readFirst(file: string, candidates: readonly string[]): Promise<Uint8Array> {
  for (const path of candidates) {
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      // Try the next place.
    }
  }
  throw new Error(`${file} is not at ${candidates.join(' or ')}`);
}

/** The places {@link loadCjkFontInNode} reads, in the order it tries them. */
export function cjkFontCandidates(moduleUrl: string = import.meta.url): string[] {
  return fontCandidates(CJK_FONT_FILE, CJK_PACKAGE, moduleUrl);
}

/** The places {@link loadEmojiFontInNode} reads, in the order it tries them. */
export function emojiFontCandidates(moduleUrl: string = import.meta.url): string[] {
  return fontCandidates(EMOJI_FONT_FILE, EMOJI_PACKAGE, moduleUrl);
}

/** Reads Noto Sans Mono CJK SC, the fallback for text outside Latin script. */
export const loadCjkFontInNode: FontLoader = async () => readFirst(CJK_FONT_FILE, cjkFontCandidates());

/** Reads Noto Emoji, the fallback for emoji. */
export const loadEmojiFontInNode: FontLoader = async () => readFirst(EMOJI_FONT_FILE, emojiFontCandidates());
