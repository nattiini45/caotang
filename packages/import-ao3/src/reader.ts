/**
 * The AO3 reader (#297, epic #263): an Archive of Our Own work download, HTML or EPUB, read into the same blocks and
 * the same metadata. The prose comes from the shared XHTML walker (HTML) or the shared EPUB reader (EPUB); the
 * preface — tags, summary, notes, series and stats — is kept apart by this adapter, so the text is not imported
 * twice. No DOM, no third-party dependency, no script ever run.
 */

import type { ImportAsset, ImportDocument } from '@caotang/import-core';
import { dropUnresolvedPictures, htmlToBlocks, pictureRefusal, type HtmlDropped, type PictureRefusal } from '@caotang/import-html';
import { readEpubArchive, containerOpfPath, parseOpf, type EpubChapter, type EpubMatter } from '@caotang/import-epub';
import { decodePlainText } from '@caotang/import-read/text';
import { openZip } from '@caotang/import-read/zip';

import { AO3_SKIP, ao3Keywords, ao3SeriesNote, looksLikeAo3, parseAo3Preface, proseOf, type Ao3Meta } from './preface.js';

/** A piece of the preface, placed at the block it sat before so the preview can attach it to the right node. */
export interface Ao3Note {
  blockIndex: number;
  kind: 'work-summary' | 'work-notes' | 'chapter-summary' | 'chapter-notes' | 'end-notes';
  text: string;
}

export interface Ao3Import {
  document: ImportDocument;
  title: string;
  meta: Ao3Meta;
  /** Every tag, deduplicated: the keywords the import offers (the preview lists what a scene cannot hold). */
  keywords: string[];
  summary: string;
  seriesNote: string;
  notes: Ao3Note[];
  assetData: Map<string, Uint8Array>;
  remoteImages: string[];
  dropped: HtmlDropped;
  /** The EPUB download's own chapter titles, by unit; empty for the HTML download, whose headings name the chapters. */
  chapters: EpubChapter[];
  matter: EpubMatter[];
  format: 'html' | 'epub';
}

export type Ao3Error =
  | { kind: 'not-ao3' }
  | { kind: 'ask-encoding' }
  | { kind: 'too-large' }
  | { kind: 'not-xml'; message: string }
  | { kind: 'archive'; message: string }
  | { kind: 'drm'; message: string }
  | { kind: 'no-opf' }
  | { kind: 'empty' };

export type Ao3Result = { ok: true; value: Ao3Import } | { ok: false; error: Ao3Error };

const EMPTY_DROPPED: HtmlDropped = { scripts: 0, styles: 0, iframes: 0, forms: 0, eventAttrs: 0, unsafeLinks: 0, media: 0 };

/** The last heading at or before a block: the chapter a note belongs to, or none for the work's own notes. */
function headingBefore(document: ImportDocument, blockIndex: number): string | null {
  for (let i = Math.min(blockIndex, document.blocks.length) - 1; i >= 0; i -= 1) {
    const block = document.blocks[i];
    if (block?.kind === 'heading') return block.text;
  }
  return null;
}

/**
 * The preface regions the walker kept out, as placed notes. The preface parser already knows which text is the
 * work's summary, its notes, its end notes and each chapter's, so a region is matched to it; a region the parser did
 * not name falls back to the heading it sits under.
 */
function notesOf(document: ImportDocument, regions: readonly { selector: string; blockIndex: number; text: string }[], meta: Ao3Meta): Ao3Note[] {
  const notes: Ao3Note[] = [];
  for (const region of regions) {
    const text = region.text;
    if (text === '') continue;
    if (region.selector === '#work_endnotes' || (meta.endNotes !== '' && text === meta.endNotes)) {
      notes.push({ blockIndex: region.blockIndex, kind: 'end-notes', text });
      continue;
    }
    if (meta.summary !== '' && text === meta.summary) {
      notes.push({ blockIndex: region.blockIndex, kind: 'work-summary', text });
      continue;
    }
    if (meta.notes !== '' && text === meta.notes) {
      notes.push({ blockIndex: region.blockIndex, kind: 'work-notes', text });
      continue;
    }
    if (region.selector !== '.summary' && region.selector !== '.notes') continue;
    const inChapter = headingBefore(document, region.blockIndex) !== null;
    const kind = region.selector === '.summary' ? (inChapter ? 'chapter-summary' : 'work-summary') : inChapter ? 'chapter-notes' : 'work-notes';
    notes.push({ blockIndex: region.blockIndex, kind, text });
  }
  return notes;
}

/** A `data:` picture's bytes, or null. */
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

/**
 * A chapter heading's own link to the work on the site (`[Chapter 1](#)`) is not a title: the text is kept and the
 * anchor, which points nowhere in a download, is dropped.
 */
function plainHeadings(blocks: ImportDocument['blocks']): ImportDocument['blocks'] {
  return blocks.map((block) => {
    if (block.kind !== 'heading') return block;
    const md = block.md.replace(/\[([^\]]*)\]\((?:#|https?:\/\/[^)]*)\)/g, '$1').trim();
    return md === block.md ? block : { ...block, md };
  });
}

/** Read an AO3 HTML download: one page with the whole work. */
export function readAo3Html(bytes: Uint8Array, fileName: string): Ao3Result {
  const decoded = decodePlainText(bytes);
  if (decoded.status === 'ask') return { ok: false, error: { kind: 'ask-encoding' } };
  if (decoded.status === 'too-large' || decoded.status === 'too-many-lines') return { ok: false, error: { kind: 'too-large' } };
  if (!looksLikeAo3(decoded.text)) return { ok: false, error: { kind: 'not-ao3' } };

  const preface = parseAo3Preface(decoded.text);
  if (preface === null) return { ok: false, error: { kind: 'not-ao3' } };

  const walked = htmlToBlocks(decoded.text, { unit: fileName, refPrefix: 'import:ao3-image-', skip: AO3_SKIP });
  if (!walked.ok) return { ok: false, error: { kind: 'not-xml', message: walked.error.message } };

  const assetData = new Map<string, Uint8Array>();
  const assets: ImportAsset[] = [];
  const refused = new Map<string, PictureRefusal>();
  for (const [ref, target] of walked.value.images) {
    const data = dataUriBytes(target);
    if (data === null) continue;
    // The commit's picture pipeline is strict over the whole batch, so bytes it would refuse never become an offer.
    const why = pictureRefusal(data);
    if (why !== undefined) {
      refused.set(ref, why);
      continue;
    }
    assetData.set(ref, data);
    assets.push({ ref, name: ref, bytes: data.length });
  }

  // A picture with no bytes behind it keeps its alt text and is named, rather than leaving a ref that resolves to nothing.
  const kept = dropUnresolvedPictures(walked.value.blocks, new Set(assetData.keys()), walked.value.images, refused);

  const document: ImportDocument = {
    blocks: plainHeadings(kept.blocks),
    losses: [...walked.value.losses, ...kept.losses],
    assets,
    metadata: { title: preface.meta.title, ...(preface.meta.author === '' ? {} : { author: preface.meta.author }), ...(preface.meta.language === '' ? {} : { language: preface.meta.language }) },
  };
  const notes = notesOf(document, walked.value.skipped.map((region) => ({ selector: region.selector, blockIndex: region.blockIndex, text: proseOf(region.element) })), preface.meta);

  return {
    ok: true,
    value: {
      document,
      title: preface.meta.title || fileName.replace(/\.[a-z0-9]+$/i, ''),
      meta: preface.meta,
      keywords: ao3Keywords(preface.meta),
      summary: preface.meta.summary,
      seriesNote: ao3SeriesNote(preface.meta),
      notes,
      assetData,
      remoteImages: walked.value.remoteImages,
      dropped: walked.value.dropped,
      chapters: [],
      matter: [],
      format: 'html',
    },
  };
}

/** Read an AO3 EPUB download: the same work, its chapters from the book's own navigation. */
export async function readAo3Epub(bytes: Uint8Array): Promise<Ao3Result> {
  const archive = await openZip(bytes);
  if (!archive.ok) return { ok: false, error: { kind: 'archive', message: archive.error.message } };
  const read = await readEpubArchive(archive.value, { skip: AO3_SKIP });
  if (!read.ok) {
    const error = read.error;
    switch (error.kind) {
      case 'archive':
        return { ok: false, error: { kind: 'archive', message: error.message } };
      case 'not-xml':
        return { ok: false, error: { kind: 'not-xml', message: error.message } };
      case 'drm':
        return { ok: false, error: { kind: 'drm', message: error.message } };
      case 'no-opf':
        return { ok: false, error: { kind: 'no-opf' } };
      case 'empty':
        return { ok: false, error: { kind: 'empty' } };
      default:
        return { ok: false, error: { kind: error.kind } };
    }
  }

  // The preface sits on the first page of the download: read it again as markup, without the text import's skipping.
  const container = await archive.value.read('META-INF/container.xml');
  if (!container.ok) return { ok: false, error: { kind: 'no-opf' } };
  const containerText = decodePlainText(container.value);
  if (containerText.status !== 'decoded') return { ok: false, error: { kind: 'ask-encoding' } };
  const opfPath = containerOpfPath(containerText.text);
  if (opfPath === null) return { ok: false, error: { kind: 'no-opf' } };
  const opfRead = await archive.value.read(opfPath);
  if (!opfRead.ok) return { ok: false, error: { kind: 'no-opf' } };
  const opfText = decodePlainText(opfRead.value);
  if (opfText.status !== 'decoded') return { ok: false, error: { kind: 'ask-encoding' } };
  const opf = parseOpf(opfText.text, opfPath);
  if (!opf.ok) return { ok: false, error: { kind: 'not-xml', message: opf.message } };

  let preface: ReturnType<typeof parseAo3Preface> = null;
  let prefaceHref = '';
  for (const item of opf.value.spine) {
    const entry = opf.value.manifest.get(item.idref);
    if (entry === undefined) continue;
    const page = await archive.value.read(entry.href);
    if (!page.ok) continue;
    const text = decodePlainText(page.value);
    if (text.status !== 'decoded') continue;
    preface = parseAo3Preface(text.text);
    if (preface !== null) {
      prefaceHref = entry.href;
      break;
    }
  }
  if (preface === null) return { ok: false, error: { kind: 'not-ao3' } };

  const document: ImportDocument = { ...read.value.document, blocks: plainHeadings(read.value.document.blocks) };
  const notes = notesOf(
    document,
    read.value.skipped.map((region) => ({
      selector: region.selector,
      blockIndex: region.blockIndex,
      text: proseOf(region.element),
    })),
    preface.meta,
  );
  // The work's own summary and notes are also on the preface page, which the EPUB reader may place before chapter one.
  if (preface.meta.summary !== '' && !notes.some((note) => note.kind === 'work-summary')) notes.unshift({ blockIndex: 0, kind: 'work-summary', text: preface.meta.summary });
  if (preface.meta.notes !== '' && !notes.some((note) => note.kind === 'work-notes')) notes.unshift({ blockIndex: 0, kind: 'work-notes', text: preface.meta.notes });
  if (preface.meta.endNotes !== '' && !notes.some((note) => note.kind === 'end-notes')) notes.push({ blockIndex: document.blocks.length, kind: 'end-notes', text: preface.meta.endNotes });

  const dropped: HtmlDropped = { ...EMPTY_DROPPED, ...read.value.dropped };
  return {
    ok: true,
    value: {
      document,
      title: preface.meta.title || read.value.title,
      meta: preface.meta,
      keywords: ao3Keywords(preface.meta),
      summary: preface.meta.summary,
      seriesNote: ao3SeriesNote(preface.meta),
      notes,
      assetData: read.value.assetData,
      remoteImages: read.value.remoteImages,
      dropped,
      chapters: read.value.chapters.filter((chapter) => chapter.title !== '' && !chapter.unit.startsWith(prefaceHref)),
      matter: read.value.matter,
      format: 'epub',
    },
  };
}

export { AO3_SKIP, ao3Keywords, ao3SeriesNote, looksLikeAo3, parseAo3Preface, proseOf } from './preface.js';
export type { Ao3Meta, Ao3Preface, Ao3ChapterNote, Ao3Stats } from './preface.js';
