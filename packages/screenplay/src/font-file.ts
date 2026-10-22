/**
 * What the two fallback fonts of the screenplay PDF share (cjk-font.ts, emoji-font.ts): reading a font file that ships
 * beside the module. Reached only through those two modules, which render-pdf.ts imports dynamically.
 */

import { checkFontBytes } from '@caotang/pdf-fonts';

interface NodeFs {
  readFile(path: URL): Promise<Uint8Array>;
}

/**
 * A font file's bytes. In the browser the file is a build asset on the app's own origin; under Node it is read from disk.
 * `label` names the font in the error a failed load throws. What was read must start as a font file does: an HTML page served in
 * a font's place (a dev server's fallback, a proxy's error page) is refused with what was served.
 */
export async function fontFileBytes(url: URL, label: string): Promise<Uint8Array> {
  if (url.protocol === 'file:') {
    // Under Node (the tests, the MCP server) the file is read from disk. The specifier is a variable, so the browser build
    // does not try to bundle a Node module it never runs.
    const specifier = 'node:fs/promises';
    const fs = (await import(/* @vite-ignore */ specifier)) as NodeFs;
    return checkFontBytes(new Uint8Array(await fs.readFile(url)), label);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`pdf: the ${label} did not load (${response.status} ${response.statusText})`);
  return checkFontBytes(new Uint8Array(await response.arrayBuffer()), label);
}
