/**
 * The EPUB reader (#296, epic #263): a book recovered when the EPUB is the only copy. `META-INF/container.xml`
 * names the OPF; its spine gives the reading order, the EPUB 3 nav (or the EPUB 2 NCX) the chapter titles and the
 * fragments that split one XHTML file into several chapters, and the shared XHTML walker the text. Landmarks and
 * `linear="no"` items are offered as front or back matter, footnotes become `[^n]`, the cover and the pictures are
 * kept, and a DRM file is refused. No DOM, no third-party dependency, no script ever run.
 */

import type { ImportAsset, ImportBlock, ImportDocument, ImportFootnote } from '@caotang/import-core';
import { collectHtmlFootnotes, dropUnresolvedPictures, htmlToBlocks, pictureRefusal, type HtmlDropped, type PictureRefusal } from '@caotang/import-html';
import { decodePlainText } from '@caotang/import-read/text';
import { openZip, type ImportArchive } from '@caotang/import-read/zip';
import type { XmlElement } from '@caotang/import-read/xml';

import { containerOpfPath, dirOf, encryptionIsDrm, parseOpf, resolveHref, type EpubLandmark, type EpubOpf } from './opf.js';
import { parseLandmarks, parseNav, parseNcx, type EpubNavEntry } from './nav.js';

/** A chapter the navigation names: its unit (an archive path, with `#fragment` when the file holds several) and its title. */
export interface EpubChapter {
  unit: string;
  title: string;
  depth: number;
}

/** Matter the book itself marks: the cover, the title page, the contents, the copyright page, the back matter. */
export interface EpubMatter {
  unit: string;
  kind: 'front' | 'back';
  title: string;
}

export interface EpubImport {
  document: ImportDocument;
  title: string;
  assetData: Map<string, Uint8Array>;
  chapters: EpubChapter[];
  matter: EpubMatter[];
  /** The cover picture, kept as a picture; setting it as the project's cover is not part of this import. */
  cover: { ref: string; name: string; bytes: number } | null;
  remoteImages: string[];
  dropped: HtmlDropped;
  /** `rendition:layout: pre-paginated`: the fixed layout is not kept, the text is reflowed. */
  fixedLayout: boolean;
  /** Spine items read, for the report. */
  spineItems: number;
  /** The regions `options.skip` named, with the spine item and block index each sat before. */
  skipped: { unit: string; selector: string; blockIndex: number; element: XmlElement }[];
}

export type EpubError =
  | { kind: 'archive'; message: string }
  | { kind: 'no-opf' }
  | { kind: 'not-xml'; message: string }
  | { kind: 'drm'; message: string }
  | { kind: 'ask-encoding' }
  | { kind: 'too-large' }
  | { kind: 'empty' };

export type EpubResult = { ok: true; value: EpubImport } | { ok: false; error: EpubError };

const XHTML_TYPE = /application\/xhtml\+xml|text\/html/i;
const COVER_REF = 'import:epub-cover';

/** The landmark types that are matter before the chapters, and those after them. */
const FRONT_TYPES = new Set(['cover', 'cover-image', 'titlepage', 'title-page', 'halftitlepage', 'toc', 'copyright-page', 'dedication', 'epigraph', 'foreword', 'preface', 'frontmatter', 'introduction']);
const BACK_TYPES = new Set(['backmatter', 'acknowledgments', 'acknowledgements', 'about-the-author', 'colophon', 'index', 'glossary', 'bibliography', 'afterword', 'conclusion']);

function matterKind(type: string): 'front' | 'back' | null {
  const key = type.toLowerCase();
  if (FRONT_TYPES.has(key)) return 'front';
  if (BACK_TYPES.has(key)) return 'back';
  return null;
}

/** One spine item's blocks, cut where the navigation's fragments start. */
interface Segment {
  unit: string;
  title: string;
  depth: number;
  blocks: ImportBlock[];
}

function segmentsOf(href: string, blocks: ImportBlock[], anchors: Map<string, number>, entries: readonly EpubNavEntry[]): Segment[] {
  const withBlocks = (unit: string, title: string, depth: number, from: number, to: number): Segment => ({
    unit,
    title,
    depth,
    blocks: blocks.slice(from, to).map((block) => ('src' in block ? { ...block, src: { ...block.src, sourceUnit: unit } } : block)),
  });

  const cuts = entries
    .filter((entry) => entry.fragment !== '')
    .map((entry) => ({ entry, index: anchors.get(entry.fragment) }))
    .filter((cut): cut is { entry: EpubNavEntry; index: number } => cut.index !== undefined)
    .sort((a, b) => a.index - b.index);

  const whole = entries.find((entry) => entry.fragment === '');
  if (cuts.length === 0) return [withBlocks(href, whole?.title ?? entries[0]?.title ?? '', whole?.depth ?? 0, 0, blocks.length)];

  const out: Segment[] = [];
  for (const [i, cut] of cuts.entries()) {
    const from = i === 0 ? 0 : cut.index;
    const to = i + 1 < cuts.length ? (cuts[i + 1] as { index: number }).index : blocks.length;
    if (to <= from) continue;
    out.push(withBlocks(`${href}#${cut.entry.fragment}`, cut.entry.title, cut.entry.depth, from, to));
  }
  return out;
}

/** What a reader of a particular book asks the walker to keep out of the text (an AO3 download's own preface, #297). */
export interface EpubReadOptions {
  /** Regions to keep out of the text, each `.class` or `#id`, passed to the shared XHTML walker. */
  skip?: readonly string[];
}

/** Read an EPUB's bytes: the zip is opened with the shared caps and zip-bomb guard. */
export async function readEpub(bytes: Uint8Array, options: EpubReadOptions = {}): Promise<EpubResult> {
  const archive = await openZip(bytes);
  if (!archive.ok) return { ok: false, error: { kind: 'archive', message: archive.error.message } };
  return readEpubArchive(archive.value, options);
}

/** Read an opened EPUB archive. */
export async function readEpubArchive(archive: ImportArchive, options: EpubReadOptions = {}): Promise<EpubResult> {
  // DRM first: a book we may not read is refused before any of it is parsed.
  if (archive.entry('META-INF/rights.xml') !== undefined) {
    return { ok: false, error: { kind: 'drm', message: 'META-INF/rights.xml' } };
  }
  const encryption = archive.entry('META-INF/encryption.xml');
  if (encryption !== undefined) {
    const read = await archive.read('META-INF/encryption.xml');
    if (!read.ok) return { ok: false, error: { kind: 'archive', message: read.error.message } };
    const decoded = decodePlainText(read.value);
    if (decoded.status !== 'decoded') return { ok: false, error: { kind: 'ask-encoding' } };
    if (encryptionIsDrm(decoded.text)) return { ok: false, error: { kind: 'drm', message: 'META-INF/encryption.xml' } };
  }

  const container = await archive.read('META-INF/container.xml');
  if (!container.ok) return { ok: false, error: { kind: 'no-opf' } };
  const containerText = decodePlainText(container.value);
  if (containerText.status !== 'decoded') return { ok: false, error: { kind: 'ask-encoding' } };
  const opfPath = containerOpfPath(containerText.text);
  if (opfPath === null) return { ok: false, error: { kind: 'no-opf' } };

  const opfRead = await archive.read(opfPath);
  if (!opfRead.ok) return { ok: false, error: { kind: 'no-opf' } };
  const opfText = decodePlainText(opfRead.value);
  if (opfText.status !== 'decoded') return { ok: false, error: { kind: 'ask-encoding' } };
  const parsed = parseOpf(opfText.text, opfPath);
  if (!parsed.ok) return { ok: false, error: { kind: 'not-xml', message: parsed.message } };
  const opf = parsed.value;

  const navigation = await readNavigation(archive, opf);
  const blocks: ImportBlock[] = [];
  const losses: NonNullable<ImportDocument['losses']> = [];
  const footnotes: ImportFootnote[] = [];
  const assets = new Map<string, ImportAsset>();
  const assetData = new Map<string, Uint8Array>();
  const remoteImages: string[] = [];
  const chapters: EpubChapter[] = [];
  const matter: EpubMatter[] = [];
  const dropped: HtmlDropped = { scripts: 0, styles: 0, iframes: 0, forms: 0, eventAttrs: 0, unsafeLinks: 0, media: 0 };
  const targets = new Map<string, string>();
  const refused = new Map<string, PictureRefusal>();
  let spineItems = 0;
  let nextNoteLabel = 1;
  let seenLinear = false;
  const skipped: EpubImport['skipped'] = [];

  for (const item of opf.spine) {
    const entry = opf.manifest.get(item.idref);
    if (entry === undefined || !XHTML_TYPE.test(entry.mediaType)) continue;
    const read = await archive.read(entry.href);
    if (!read.ok) continue; // a spine item the zip does not hold is named by the archive's own report
    const decoded = decodePlainText(read.value);
    if (decoded.status === 'ask') return { ok: false, error: { kind: 'ask-encoding' } };
    if (decoded.status === 'too-large' || decoded.status === 'too-many-lines') return { ok: false, error: { kind: 'too-large' } };

    const walked = htmlToBlocks(decoded.text, {
      unit: entry.href,
      refPrefix: `import:epub-image-${spineItems}-`,
      firstNoteLabel: nextNoteLabel,
      ...(options.skip === undefined ? {} : { skip: options.skip }),
    });
    if (!walked.ok) return { ok: false, error: { kind: 'not-xml', message: walked.error.message } };
    spineItems += 1;

    const offset = blocks.length;
    const entries = navigation.toc.filter((nav) => nav.href === entry.href);
    const segments = segmentsOf(entry.href, walked.value.blocks, walked.value.anchors, entries);
    const landmark = navigation.landmarks.find((mark) => mark.href === entry.href);
    const kind = landmark === undefined ? (item.linear ? null : seenLinear ? 'back' : 'front') : matterKind(landmark.type);
    if (item.linear) seenLinear = true;

    for (const segment of segments) {
      if (segment.blocks.length === 0) continue;
      blocks.push(...segment.blocks);
      chapters.push({ unit: segment.unit, title: segment.title, depth: segment.depth });
      if (kind !== null) matter.push({ unit: segment.unit, kind, title: landmark?.title ?? segment.title });
    }

    losses.push(...walked.value.losses.map((loss) => ({ ...loss, ...(loss.blockIndex === undefined ? {} : { blockIndex: loss.blockIndex + offset }) })));
    remoteImages.push(...walked.value.remoteImages);
    dropped.scripts += walked.value.dropped.scripts;
    dropped.styles += walked.value.dropped.styles;
    dropped.iframes += walked.value.dropped.iframes;
    dropped.forms += walked.value.dropped.forms;
    dropped.eventAttrs += walked.value.dropped.eventAttrs;
    dropped.unsafeLinks += walked.value.dropped.unsafeLinks;
    dropped.media += walked.value.dropped.media;

    const collectedNotes = collectHtmlFootnotes(walked.value.noterefs, walked.value.notes, offset, nextNoteLabel);
    footnotes.push(...collectedNotes.footnotes);
    nextNoteLabel = collectedNotes.nextLabel;
    for (const region of walked.value.skipped) skipped.push({ unit: entry.href, selector: region.selector, blockIndex: region.blockIndex + offset, element: region.element });

    for (const [ref, target] of walked.value.images) {
      targets.set(ref, target);
      const resolved = await resolvePicture(archive, entry.href, target);
      if (resolved === null) continue;
      // The commit's picture pipeline is strict over the whole batch, so bytes it would refuse never become an offer.
      const why = pictureRefusal(resolved.bytes);
      if (why !== undefined) {
        refused.set(ref, why);
        continue;
      }
      assetData.set(ref, resolved.bytes);
      assets.set(ref, { ref, name: resolved.name, bytes: resolved.bytes.length });
    }
  }

  let cover: EpubImport['cover'] = null;
  if (opf.coverHref !== null) {
    const read = await archive.read(opf.coverHref);
    if (read.ok && pictureRefusal(read.value) === undefined) {
      assetData.set(COVER_REF, read.value);
      const name = opf.coverHref.split('/').pop() ?? COVER_REF;
      assets.set(COVER_REF, { ref: COVER_REF, name, bytes: read.value.length });
      cover = { ref: COVER_REF, name, bytes: read.value.length };
    }
  }

  // A picture with no usable bytes keeps its alt text and is named, rather than leaving a ref that resolves to nothing.
  const kept = dropUnresolvedPictures(blocks, new Set(assetData.keys()), targets, refused);
  const keptBlocks = kept.blocks;
  losses.push(...kept.losses);

  if (keptBlocks.length === 0) return { ok: false, error: { kind: 'empty' } };
  if (opf.fixedLayout) losses.push({ code: 'unsupported', message: 'The book’s fixed layout was not kept: its text is reflowed.' });

  const document: ImportDocument = {
    blocks: keptBlocks,
    footnotes,
    losses,
    assets: [...assets.values()],
    metadata: { title: opf.title, ...(opf.creator === '' ? {} : { author: opf.creator }), ...(opf.language === '' ? {} : { language: opf.language }) },
  };
  return {
    ok: true,
    value: { document, title: opf.title, assetData, chapters, matter, cover, remoteImages, dropped, fixedLayout: opf.fixedLayout, spineItems, skipped },
  };
}

/** The nav (or NCX) table of contents and the landmarks, with the EPUB 2 guide as a fallback. */
async function readNavigation(archive: ImportArchive, opf: EpubOpf): Promise<{ toc: EpubNavEntry[]; landmarks: EpubLandmark[] }> {
  if (opf.navHref !== null) {
    const read = await archive.read(opf.navHref);
    if (read.ok) {
      const decoded = decodePlainText(read.value);
      if (decoded.status === 'decoded') {
        const toc = parseNav(decoded.text, opf.navHref);
        const landmarks = parseLandmarks(decoded.text, opf.navHref);
        if (toc.length > 0) return { toc, landmarks: landmarks.length > 0 ? landmarks : opf.guide };
      }
    }
  }
  if (opf.ncxHref !== null) {
    const read = await archive.read(opf.ncxHref);
    if (read.ok) {
      const decoded = decodePlainText(read.value);
      if (decoded.status === 'decoded') return { toc: parseNcx(decoded.text, opf.ncxHref), landmarks: opf.guide };
    }
  }
  return { toc: [], landmarks: opf.guide };
}

/** A picture's bytes: a `data:` URI decodes, a relative path reads from the zip beside the page. */
async function resolvePicture(archive: ImportArchive, pagePath: string, target: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  const data = target.match(/^data:[^;,]*;base64,(.*)$/i);
  if (data !== null) {
    try {
      const binary = atob(data[1] ?? '');
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return { name: 'picture', bytes };
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null; // remote: listed, never fetched
  const resolved = resolveHref(dirOf(pagePath), target);
  const read = await archive.read(resolved);
  if (!read.ok) return null;
  return { name: resolved.split('/').pop() ?? resolved, bytes: read.value };
}
