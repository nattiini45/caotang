/// <reference types="vite/client" />
// The `?url` imports below are typed by Vite's client types; the root typecheck (e2e/) reaches this file through the session.
/**
 * The PDFs' fallback fonts, read in the browser (the contact sheet and the screenplay PDF load the same two): Noto Sans Mono
 * CJK SC for text outside Latin script, and Noto Emoji (monochrome) for emoji.
 *
 * The font files come from `@caotang/font-noto-cjk` and `@caotang/font-noto-emoji`. The `?url` imports make Vite emit each
 * as an asset of its own, served from this app's origin like every other file, so the Content-Security-Policy needs no
 * change and no CDN is involved. Each import is dynamic and sits inside its loader, so neither the URL module nor the file is
 * fetched until a contact sheet holds text that needs it (CJK text, or an emoji) and the exporter asks for it.
 */

import { checkFontBytes, type FontLoader } from '@caotang/pdf-fonts';

/**
 * The font file at a URL. A body that does not start as a font file does (an HTML page from a dev server's fallback, a service
 * worker or a proxy, answered with 200) is refused here with what was served, rather than reaching fontkit as a parse error.
 */
async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return checkFontBytes(new Uint8Array(await response.arrayBuffer()), url);
}

export const loadCjkFontOverHttp: FontLoader = async () => {
  const { default: url } = await import('@caotang/font-noto-cjk/NotoSansMonoCJKsc-Regular.woff?url');
  return fetchBytes(url);
};

export const loadEmojiFontOverHttp: FontLoader = async () => {
  const { default: url } = await import('@caotang/font-noto-emoji/NotoEmoji-Regular.woff?url');
  return fetchBytes(url);
};
