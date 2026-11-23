/**
 * The AO3 preface (#297, epic #263): an Archive of Our Own work download carries its own metadata beside the text —
 * the tag list (`dl.work.meta`), the title and byline, a summary, work notes, chapter notes and end notes, and the
 * series and stats lines. The classes are AO3's own and stable; this reads them with the shared XML reader, so the
 * text import keeps the prose and the metadata goes where a writer can use it. No DOM, no dependency.
 */

import { readXml, attr, descendants, textOf, type XmlElement, type XmlNode } from '@caotang/import-read/xml';
import { normaliseHtml } from '@caotang/import-html';

/**
 * The regions the text import keeps out of the prose, because this adapter keeps them apart: the tag list, the
 * summary, the notes (work and chapter), the byline and the end notes. The work's own `h2.title` and each chapter's
 * `h3.title` stay in the text, where the splitter reads them.
 */
export const AO3_SKIP: readonly string[] = ['#work_endnotes', '.meta', '.summary', '.notes', '.byline'];

export interface Ao3Stats {
  published: string;
  updated: string;
  words: string;
  chapters: string;
}

export interface Ao3Meta {
  title: string;
  author: string;
  rating: string[];
  warnings: string[];
  categories: string[];
  fandoms: string[];
  relationships: string[];
  characters: string[];
  freeform: string[];
  language: string;
  series: string[];
  stats: Ao3Stats;
  /** The work's summary, as paragraphs. */
  summary: string;
  /** The notes above chapter one. */
  notes: string;
  /** The notes after the last chapter. */
  endNotes: string;
}

/** A chapter's own summary and notes, in reading order, as the download writes them. */
export interface Ao3ChapterNote {
  title: string;
  summary: string;
  notes: string;
}

export interface Ao3Preface {
  meta: Ao3Meta;
  chapters: Ao3ChapterNote[];
}

const classesOf = (element: XmlElement): string[] => (attr(element, 'class') ?? '').split(/\s+/).filter((word) => word !== '');
const hasClass = (element: XmlElement, name: string): boolean => classesOf(element).includes(name);

/** Every element under `root` with this class, in document order. */
function byClass(root: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlNode[] = [root];
  while (stack.length > 0) {
    const node = stack.shift() as XmlNode;
    if (node.type !== 'element') continue;
    if (hasClass(node, name)) out.push(node);
    stack.unshift(...node.children);
  }
  return out;
}

function byId(root: XmlElement, id: string): XmlElement | undefined {
  for (const element of descendants(root)) if (attr(element, 'id') === id) return element;
  return undefined;
}

/** An element's prose: its paragraphs joined by a blank line, else its whole text. */
export function proseOf(element: XmlElement): string {
  const paragraphs = [...descendants(element, 'p')].map((p) => textOf(p).replace(/\s+/g, ' ').trim()).filter((text) => text !== '');
  if (paragraphs.length > 0) return paragraphs.join('\n\n');
  return textOf(element).replace(/\s+/g, ' ').trim();
}

/** The text of a `blockquote.userstuff` inside a module, or of the module itself. */
function moduleProse(module: XmlElement | undefined): string {
  if (module === undefined) return '';
  const stuff = byClass(module, 'userstuff')[0];
  return proseOf(stuff ?? module);
}

/** The tags of one `dd` row: its links, else its list items, else its comma-separated text. */
function tagsOf(row: XmlElement): string[] {
  const links = [...descendants(row, 'a')].map((a) => textOf(a).replace(/\s+/g, ' ').trim()).filter((text) => text !== '');
  if (links.length > 0) return links;
  const items = [...descendants(row, 'li')].map((li) => textOf(li).replace(/\s+/g, ' ').trim()).filter((text) => text !== '');
  if (items.length > 0) return items;
  return textOf(row)
    .split(',')
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter((text) => text !== '');
}

/** Whether this page is an AO3 work download: its work block and tag list, or the workskin the site writes. */
export function looksLikeAo3(html: string): boolean {
  return /id="workskin"/.test(html) || /class="[^"]*\bwork meta\b[^"]*"/.test(html) || html.includes('://archiveofourown.org') || html.includes('://www.archiveofourown.org');
}

const EMPTY_STATS: Ao3Stats = { published: '', updated: '', words: '', chapters: '' };

/**
 * Read the preface of an AO3 download. `null` when the page carries none of AO3's structure, so the caller can say
 * plainly that this is not an AO3 download rather than importing a page of tags as prose.
 */
export function parseAo3Preface(html: string): Ao3Preface | null {
  const parsed = readXml(normaliseHtml(html));
  if (!parsed.ok) return null;
  const root = parsed.document.root;

  const metaList = byClass(root, 'meta').find((element) => element.local === 'dl');
  const workskin = byId(root, 'workskin');
  if (metaList === undefined && workskin === undefined) return null;

  const meta: Ao3Meta = {
    title: '',
    author: '',
    rating: [],
    warnings: [],
    categories: [],
    fandoms: [],
    relationships: [],
    characters: [],
    freeform: [],
    language: '',
    series: [],
    stats: { ...EMPTY_STATS },
    summary: '',
    notes: '',
    endNotes: '',
  };

  if (metaList !== undefined) {
    for (const row of descendants(metaList, 'dd')) {
      const classes = classesOf(row);
      if (classes.includes('rating')) meta.rating.push(...tagsOf(row));
      else if (classes.includes('warning')) meta.warnings.push(...tagsOf(row));
      else if (classes.includes('category')) meta.categories.push(...tagsOf(row));
      else if (classes.includes('fandom')) meta.fandoms.push(...tagsOf(row));
      else if (classes.includes('relationship')) meta.relationships.push(...tagsOf(row));
      else if (classes.includes('character')) meta.characters.push(...tagsOf(row));
      else if (classes.includes('freeform')) meta.freeform.push(...tagsOf(row));
      else if (classes.includes('language')) meta.language = textOf(row).replace(/\s+/g, ' ').trim();
      else if (classes.includes('series')) meta.series.push(textOf(row).replace(/\s+/g, ' ').trim());
      else if (classes.includes('stats')) {
        for (const stat of descendants(row, 'dd')) {
          const value = textOf(stat).replace(/\s+/g, ' ').trim();
          const kind = classesOf(stat)[0];
          if (kind === 'published') meta.stats.published = value;
          else if (kind === 'updated') meta.stats.updated = value;
          else if (kind === 'words') meta.stats.words = value;
          else if (kind === 'chapters') meta.stats.chapters = value;
        }
      }
    }
  }

  const scope = workskin ?? root;
  const titleHeading = byClass(scope, 'title').find((element) => element.local === 'h2');
  meta.title = titleHeading === undefined ? '' : textOf(titleHeading).replace(/\s+/g, ' ').trim();
  const byline = byClass(scope, 'byline')[0];
  meta.author = byline === undefined ? '' : textOf(byline).replace(/\s+/g, ' ').trim();

  // The work's own preface is the one that is not a chapter's.
  const workPreface = byClass(scope, 'preface').find((element) => !hasClass(element, 'chapter'));
  if (workPreface !== undefined) {
    meta.summary = moduleProse(byClass(workPreface, 'summary')[0]);
    meta.notes = moduleProse(byClass(workPreface, 'notes')[0]);
  }
  meta.endNotes = moduleProse(byId(scope, 'work_endnotes'));

  const chapters: Ao3ChapterNote[] = [];
  for (const preface of byClass(scope, 'preface')) {
    if (!hasClass(preface, 'chapter')) continue;
    const heading = byClass(preface, 'title')[0];
    chapters.push({
      title: heading === undefined ? '' : textOf(heading).replace(/\s+/g, ' ').trim(),
      summary: moduleProse(byClass(preface, 'summary')[0]),
      notes: moduleProse(byClass(preface, 'notes')[0]),
    });
  }

  return { meta, chapters };
}

/** Every tag the work carries, in AO3's own order, deduplicated: the keywords the import offers. */
export function ao3Keywords(meta: Ao3Meta): string[] {
  const all = [...meta.rating, ...meta.warnings, ...meta.categories, ...meta.fandoms, ...meta.relationships, ...meta.characters, ...meta.freeform];
  return [...new Set(all.map((tag) => tag.trim()).filter((tag) => tag !== ''))];
}

/** The series and stats lines, kept as a note so nothing the download carried is lost. */
export function ao3SeriesNote(meta: Ao3Meta): string {
  const lines: string[] = [];
  if (meta.series.length > 0) lines.push(`Series: ${meta.series.join('; ')}`);
  if (meta.language !== '') lines.push(`Language: ${meta.language}`);
  const stats = [
    meta.stats.published === '' ? '' : `Published: ${meta.stats.published}`,
    meta.stats.updated === '' ? '' : `Updated: ${meta.stats.updated}`,
    meta.stats.words === '' ? '' : `Words: ${meta.stats.words}`,
    meta.stats.chapters === '' ? '' : `Chapters: ${meta.stats.chapters}`,
  ].filter((line) => line !== '');
  if (stats.length > 0) lines.push(stats.join(' · '));
  return lines.join('\n');
}
