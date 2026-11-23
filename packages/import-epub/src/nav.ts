/**
 * The EPUB navigation (#296, epic #263): the EPUB 3 nav document's `toc` and `landmarks`, and the EPUB 2 NCX.
 * Both give the chapter titles the book itself uses, and the fragments that split one XHTML file into several
 * chapters. Read with the shared XML reader over the shared HTML normaliser — no DOM, no dependency.
 */

import { readXml, isElement, attr, childElements, textOf, type XmlElement } from '@caotang/import-read/xml';
import { normaliseHtml } from '@caotang/import-html';

import { resolveHref, fragmentOf, dirOf, type EpubLandmark } from './opf.js';

export interface EpubNavEntry {
  /** The archive path of the XHTML file, resolved against the navigation document's folder. */
  href: string;
  /** The element id inside that file, or `''` for the whole file. */
  fragment: string;
  title: string;
  /** 0 for a top-level chapter, 1 for a section inside it. */
  depth: number;
}

/** An element's `epub:type` (or ARIA `role`) as its list of words. */
function typesOf(element: XmlElement): string[] {
  const typed =
    attr(element, 'type', 'http://www.idpf.org/2007/ops') ??
    element.attributes.find((a) => a.local === 'type' && a.prefix === 'epub')?.value ??
    attr(element, 'role') ??
    '';
  return typed.split(/\s+/).filter((word) => word !== '');
}

/** The `<nav>` (or NCX `navMap`) with one of these semantic types. */
function findNav(root: XmlElement, wanted: string[]): XmlElement | undefined {
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const element = stack.shift() as XmlElement;
    const types = typesOf(element);
    if (wanted.some((want) => types.includes(want))) return element;
    for (const child of element.children) if (isElement(child)) stack.push(child);
  }
  return undefined;
}

/** The first `<a>` directly inside an `<li>`, which is the entry's own link rather than a child's. */
function ownLink(item: XmlElement): XmlElement | undefined {
  for (const child of childElements(item)) {
    if (child.local === 'a') return child;
    if (child.local === 'span') {
      const inner = childElements(child, 'a')[0];
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

function walkList(list: XmlElement, base: string, depth: number, out: EpubNavEntry[]): void {
  for (const item of childElements(list, 'li')) {
    const link = ownLink(item);
    if (link !== undefined) {
      const href = attr(link, 'href') ?? '';
      const title = textOf(link).replace(/\s+/g, ' ').trim();
      if (href !== '' && title !== '') out.push({ href: resolveHref(base, href), fragment: fragmentOf(href), title, depth });
    }
    for (const child of childElements(item, 'ol')) walkList(child, base, depth + 1, out);
  }
}

/** The EPUB 3 nav document's table of contents, in reading order. */
export function parseNav(html: string, navPath: string): EpubNavEntry[] {
  const parsed = readXml(normaliseHtml(html));
  if (!parsed.ok) return [];
  const nav = findNav(parsed.document.root, ['toc', 'doc-toc']);
  if (nav === undefined) return [];
  const out: EpubNavEntry[] = [];
  const base = dirOf(navPath);
  for (const list of childElements(nav, 'ol')) walkList(list, base, 0, out);
  return out;
}

/** The EPUB 3 nav document's landmarks: the cover, the title page, the contents, the copyright page. */
export function parseLandmarks(html: string, navPath: string): EpubLandmark[] {
  const parsed = readXml(normaliseHtml(html));
  if (!parsed.ok) return [];
  const nav = findNav(parsed.document.root, ['landmarks', 'doc-landmarks']);
  if (nav === undefined) return [];
  const out: EpubLandmark[] = [];
  const base = dirOf(navPath);
  const stack: XmlElement[] = [nav];
  while (stack.length > 0) {
    const element = stack.shift() as XmlElement;
    if (element.local === 'a') {
      const href = attr(element, 'href') ?? '';
      const types = typesOf(element);
      if (href !== '' && types.length > 0) out.push({ type: types[0] as string, href: resolveHref(base, href), title: textOf(element).replace(/\s+/g, ' ').trim() });
      continue;
    }
    for (const child of element.children) if (isElement(child)) stack.push(child);
  }
  return out;
}

/** The EPUB 2 NCX `navMap`, in reading order. */
export function parseNcx(xml: string, ncxPath: string): EpubNavEntry[] {
  const parsed = readXml(xml);
  if (!parsed.ok) return [];
  const base = dirOf(ncxPath);
  const out: EpubNavEntry[] = [];
  const walk = (parent: XmlElement, depth: number): void => {
    for (const point of childElements(parent, 'navPoint')) {
      const label = childElements(point, 'navLabel')[0];
      const content = childElements(point, 'content')[0];
      const title = label === undefined ? '' : textOf(label).replace(/\s+/g, ' ').trim();
      const src = content === undefined ? '' : (attr(content, 'src') ?? '');
      if (title !== '' && src !== '') out.push({ href: resolveHref(base, src), fragment: fragmentOf(src), title, depth });
      walk(point, depth + 1);
    }
  };
  for (const map of childElements(parsed.document.root, 'navMap')) walk(map, 0);
  return out;
}
