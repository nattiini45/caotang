/**
 * The EPUB package document (#296, epic #263): `META-INF/container.xml` names the OPF, and the OPF carries the
 * metadata, the manifest, the spine and the EPUB 2 guide. Read with the shared XML reader — no DOM, no
 * dependency. Every href is resolved against the OPF's own folder, so a spine item is an archive path.
 */

import { readXml, attr, childElements, firstChild, descendants, textOf, type XmlElement } from '@caotang/import-read/xml';

export interface EpubManifestItem {
  id: string;
  /** The archive path, resolved against the OPF's folder and percent-decoded. */
  href: string;
  mediaType: string;
  /** EPUB 3 `properties`: `nav`, `cover-image`, `scripted`, `mathml`, … */
  properties: string[];
}

export interface EpubSpineItem {
  idref: string;
  /** `linear="no"` is matter the reader offers apart from the chapters. */
  linear: boolean;
}

export interface EpubLandmark {
  /** The semantic type: `cover`, `titlepage`, `toc`, `copyright-page`, `bodymatter`, … */
  type: string;
  href: string;
  title: string;
}

export interface EpubOpf {
  title: string;
  creator: string;
  language: string;
  manifest: Map<string, EpubManifestItem>;
  spine: EpubSpineItem[];
  /** The EPUB 3 navigation document (manifest `properties="nav"`). */
  navHref: string | null;
  /** The EPUB 2 NCX (the spine's `toc` attribute). */
  ncxHref: string | null;
  /** The cover picture: `properties="cover-image"`, else `<meta name="cover" content="id">`. */
  coverHref: string | null;
  /** The EPUB 2 `<guide>` references, the same shape as the EPUB 3 landmarks. */
  guide: EpubLandmark[];
  /** `rendition:layout` is `pre-paginated`: a fixed layout the import cannot keep. */
  fixedLayout: boolean;
}

export type OpfResult = { ok: true; value: EpubOpf } | { ok: false; message: string };

/** The folder a path sits in, `''` at the root. */
export function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/** Resolve a manifest or nav href against the folder of the file that wrote it, without a leading `./` or `../`. */
export function resolveHref(baseDir: string, href: string): string {
  const clean = href.split('#')[0]?.split('?')[0] ?? '';
  if (clean === '') return '';
  const parts = (baseDir === '' ? clean : `${baseDir}/${clean}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const joined = out.join('/');
  try {
    return decodeURIComponent(joined);
  } catch {
    return joined;
  }
}

/** The fragment of an href, percent-decoded, or `''`. */
export function fragmentOf(href: string): string {
  const cut = href.indexOf('#');
  if (cut < 0) return '';
  const fragment = href.slice(cut + 1);
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/** `META-INF/container.xml` → the OPF's path. */
export function containerOpfPath(xml: string): string | null {
  const parsed = readXml(xml);
  if (!parsed.ok) return null;
  for (const rootfile of descendants(parsed.document.root, 'rootfile')) {
    const path = attr(rootfile, 'full-path');
    if (path !== undefined && path !== '') return resolveHref('', path);
  }
  return null;
}

const words = (value: string | undefined): string[] => (value ?? '').split(/\s+/).filter((word) => word !== '');

/** Read the OPF into the manifest, spine and metadata, every href an archive path. */
export function parseOpf(xml: string, opfPath: string): OpfResult {
  const parsed = readXml(xml);
  if (!parsed.ok) return { ok: false, message: parsed.error.message };
  const root = parsed.document.root;
  const base = dirOf(opfPath);

  const metadata = firstChild(root, 'metadata');
  const dc = (name: string): string => {
    if (metadata === undefined) return '';
    for (const child of childElements(metadata)) {
      if (child.local === name) return textOf(child).replace(/\s+/g, ' ').trim();
    }
    return '';
  };

  const manifest = new Map<string, EpubManifestItem>();
  const manifestElement = firstChild(root, 'manifest');
  if (manifestElement !== undefined) {
    for (const item of childElements(manifestElement, 'item')) {
      const id = attr(item, 'id') ?? '';
      const href = attr(item, 'href') ?? '';
      if (id === '' || href === '') continue;
      manifest.set(id, { id, href: resolveHref(base, href), mediaType: attr(item, 'media-type') ?? '', properties: words(attr(item, 'properties')) });
    }
  }

  const spineElement = firstChild(root, 'spine');
  const spine: EpubSpineItem[] = [];
  if (spineElement !== undefined) {
    for (const item of childElements(spineElement, 'itemref')) {
      const idref = attr(item, 'idref') ?? '';
      if (idref === '') continue;
      spine.push({ idref, linear: (attr(item, 'linear') ?? 'yes').toLowerCase() !== 'no' });
    }
  }

  let navHref: string | null = null;
  let coverHref: string | null = null;
  for (const item of manifest.values()) {
    if (navHref === null && item.properties.includes('nav')) navHref = item.href;
    if (coverHref === null && item.properties.includes('cover-image')) coverHref = item.href;
  }
  const ncxId = spineElement === undefined ? undefined : attr(spineElement, 'toc');
  const ncxHref = ncxId === undefined ? null : (manifest.get(ncxId)?.href ?? null);

  let fixedLayout = false;
  if (metadata !== undefined) {
    for (const meta of childElements(metadata, 'meta')) {
      const name = attr(meta, 'name') ?? '';
      const property = attr(meta, 'property') ?? '';
      if (coverHref === null && name === 'cover') coverHref = manifest.get(attr(meta, 'content') ?? '')?.href ?? null;
      if (property === 'rendition:layout' && textOf(meta).trim() === 'pre-paginated') fixedLayout = true;
    }
  }

  const guide: EpubLandmark[] = [];
  const guideElement = firstChild(root, 'guide');
  if (guideElement !== undefined) {
    for (const reference of childElements(guideElement, 'reference')) {
      const href = attr(reference, 'href') ?? '';
      if (href === '') continue;
      guide.push({ type: attr(reference, 'type') ?? '', href: resolveHref(base, href), title: attr(reference, 'title') ?? '' });
    }
  }

  return {
    ok: true,
    value: { title: dc('title'), creator: dc('creator'), language: dc('language'), manifest, spine, navHref, ncxHref, coverHref, guide, fixedLayout },
  };
}

/** The algorithm of an `EncryptedData`, whatever namespace the encryption file used. */
function encryptionAlgorithm(element: XmlElement): string {
  for (const child of descendants(element)) {
    if (child.local === 'EncryptionMethod') return attr(child, 'Algorithm') ?? '';
  }
  return '';
}

/** The font-obfuscation algorithms an EPUB may use without DRM: they hide a font, not the text. */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

/**
 * Whether `META-INF/encryption.xml` encrypts anything but a font. An EPUB that does is refused: Caotang does not
 * break DRM, and says so rather than importing a book of ciphertext.
 */
export function encryptionIsDrm(xml: string): boolean {
  const parsed = readXml(xml);
  if (!parsed.ok) return true; // an encryption file we cannot read is not a book we can promise to read
  const encrypted = [...descendants(parsed.document.root, 'EncryptedData')];
  if (encrypted.length === 0) return false;
  return encrypted.some((element) => !FONT_OBFUSCATION.has(encryptionAlgorithm(element)));
}
