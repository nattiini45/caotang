/**
 * The HTML reader (#299, epic #263): reads a saved HTML page or a Google Docs "Web page" zip (one `.html` plus
 * its images) over the own XHTML walker. `data:` images are decoded and relative-in-zip images resolved; remote
 * http(s) images are listed, not fetched. No DOM, no third-party dependencies, so it runs on the main thread, in
 * a 'self' Worker and in Node.
 */

import type { ImportDocument, ImportAsset } from '@caotang/import-core';
import { decodePlainText } from '@caotang/import-read/text';
import { openZip, isArchiveResidue, type ImportArchive } from '@caotang/import-read/zip';
import { htmlToBlocks, type HtmlDropped } from './walker.js';

export interface HtmlImport {
  document: ImportDocument;
  title: string;
  /** Resolved picture bytes by asset ref (`data:` images and relative-in-zip images). */
  assetData: Map<string, Uint8Array>;
  /** Remote http(s) image targets, listed as not downloaded unless the writer opts in. */
  remoteImages: string[];
  dropped: HtmlDropped;
}

export type HtmlError =
  | { kind: 'ask-encoding' }
  | { kind: 'too-large' }
  | { kind: 'too-many-lines' }
  | { kind: 'no-html' }
  | { kind: 'not-xml'; message: string }
  | { kind: 'archive'; message: string };

export type HtmlResult = { ok: true; value: HtmlImport } | { ok: false; error: HtmlError };

const HTML_EXT = /\.(html?|xhtml)$/i;
const EMPTY_DROPPED: HtmlDropped = { scripts: 0, styles: 0, iframes: 0, eventAttrs: 0, unsafeLinks: 0 };

const titleOf = (html: string, fallback: string): string => {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = (match?.[1] ?? '').replace(/\s+/g, ' ').trim();
  return text !== '' ? text : fallback.replace(HTML_EXT, '');
};

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Decode a `data:` image URI to bytes, or null when it is not a base64 image we can read. */
function dataUriBytes(target: string): Uint8Array | null {
  const match = target.match(/^data:[^;,]*;base64,(.*)$/i);
  if (match === null) return null;
  try {
    const binary = atob(match[1] ?? '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Read one HTML page's bytes into blocks and its resolved pictures. */
export function readHtmlFile(bytes: Uint8Array, fileName: string): HtmlResult {
  const decoded = decodePlainText(bytes);
  if (decoded.status === 'ask') return { ok: false, error: { kind: 'ask-encoding' } };
  if (decoded.status === 'too-large') return { ok: false, error: { kind: 'too-large' } };
  if (decoded.status === 'too-many-lines') return { ok: false, error: { kind: 'too-many-lines' } };

  const walked = htmlToBlocks(decoded.text);
  if (!walked.ok) return { ok: false, error: { kind: 'not-xml', message: walked.error.message } };
  const { blocks, losses, images, remoteImages, dropped } = walked.value;

  const assetData = new Map<string, Uint8Array>();
  const assets: ImportAsset[] = [];
  for (const [ref, target] of images) {
    const data = dataUriBytes(target);
    if (data === null) continue; // a relative target with no archive to resolve it against
    assetData.set(ref, data);
    assets.push({ ref, name: ref, bytes: data.length });
  }

  const title = titleOf(decoded.text, fileName);
  const document: ImportDocument = { blocks, losses, assets, metadata: { title } };
  return { ok: true, value: { document, title, assetData, remoteImages, dropped } };
}

/** Read a Google Docs "Web page" zip: its HTML page(s) and the images they name. */
export async function readHtmlZip(bytes: Uint8Array): Promise<HtmlResult> {
  const archive = await openZip(bytes);
  if (!archive.ok) return { ok: false, error: { kind: 'archive', message: archive.error.message } };
  return readHtmlArchive(archive.value);
}

/** Read an opened archive of HTML pages and their images. */
export async function readHtmlArchive(archive: ImportArchive): Promise<HtmlResult> {
  const paths = archive.entries.map((entry) => entry.path).filter((path) => HTML_EXT.test(path) && !isArchiveResidue(path));
  if (paths.length === 0) return { ok: false, error: { kind: 'no-html' } };

  const blocks: ImportDocument['blocks'] = [];
  const losses: NonNullable<ImportDocument['losses']> = [];
  const assetData = new Map<string, Uint8Array>();
  const assets = new Map<string, ImportAsset>();
  const remoteImages: string[] = [];
  const dropped: HtmlDropped = { ...EMPTY_DROPPED };
  let title: string | undefined;

  for (const [pageIndex, path] of paths.entries()) {
    const read = await archive.read(path);
    if (!read.ok) return { ok: false, error: { kind: 'archive', message: read.error.message } };
    const decoded = decodePlainText(read.value);
    if (decoded.status === 'ask') return { ok: false, error: { kind: 'ask-encoding' } };
    if (decoded.status === 'too-large') return { ok: false, error: { kind: 'too-large' } };
    if (decoded.status === 'too-many-lines') return { ok: false, error: { kind: 'too-many-lines' } };

    // Each page has its own image-ref namespace: two pages' pictures must never share a ref.
    const walked = htmlToBlocks(decoded.text, { unit: path, refPrefix: `import:html-image-${pageIndex}-` });
    if (!walked.ok) return { ok: false, error: { kind: 'not-xml', message: walked.error.message } };
    if (title === undefined) title = titleOf(decoded.text, path);

    const offset = blocks.length;
    blocks.push(...walked.value.blocks);
    losses.push(...walked.value.losses.map((loss) => ({ ...loss, blockIndex: loss.blockIndex === undefined ? undefined : loss.blockIndex + offset })));
    remoteImages.push(...walked.value.remoteImages);
    dropped.scripts += walked.value.dropped.scripts;
    dropped.styles += walked.value.dropped.styles;
    dropped.iframes += walked.value.dropped.iframes;
    dropped.eventAttrs += walked.value.dropped.eventAttrs;
    dropped.unsafeLinks += walked.value.dropped.unsafeLinks;

    // Resolve each image: a data: URI decodes; a relative path reads from the zip near the page.
    for (const [ref, target] of walked.value.images) {
      const data = dataUriBytes(target);
      if (data !== null) {
        assetData.set(ref, data);
        assets.set(ref, { ref, name: ref, bytes: data.length });
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue; // remote: listed, not fetched
      const clean = target.replace(/^\.\//, '');
      const dir = dirOf(path);
      const candidate = dir === '' ? clean : `${dir}/${clean}`;
      const resolved = archive.entry(candidate) !== undefined ? candidate : archive.entry(clean) !== undefined ? clean : null;
      if (resolved === null) continue;
      const imageRead = await archive.read(resolved);
      if (!imageRead.ok) continue;
      assetData.set(ref, imageRead.value);
      assets.set(ref, { ref, name: resolved.split('/').pop() ?? ref, bytes: imageRead.value.length });
    }
  }

  const document: ImportDocument = { blocks, losses, assets: [...assets.values()], ...(title === undefined ? {} : { metadata: { title } }) };
  return { ok: true, value: { document, title: title ?? '', assetData, remoteImages, dropped } };
}
