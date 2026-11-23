/**
 * The Plottr reader (#290, epic #263): a `.pltr` file — plain JSON — read into the import's outline. The beat tree
 * becomes folders, its cards scenes (the card text is the synopsis, capped, with the overflow in the body), the
 * plotlines the cards sit on become keywords, characters and places with their custom attributes become codex rows
 * with a Details page, and the notes become Research documents. Tags are keywords; `data:` pictures are decoded and
 * sniffed (Plottr calls PNGs JPEG). A series file asks for a book; the older flat `beats` array and unknown keys are
 * tolerated. No DOM, no third-party dependency.
 */

import type { ImportAsset, LossWarning } from '@caotang/import-core';
import { MAX_TEXT_BYTES } from '@caotang/import-read/text';

import { slateToMarkdown } from './slate.js';

export interface PlottrBook {
  readonly id: string;
  readonly title: string;
}

export interface PlottrScene {
  readonly id: number;
  readonly title: string;
  /** The card text as Markdown, at most {@link SYNOPSIS_CHARS}; longer text continues in `body`. */
  readonly synopsis: string;
  /** The card text past the synopsis cap. */
  readonly body: string;
  readonly keywords: string[];
  /** The characters and places the card names, by name, for the scene's notes. */
  readonly characters: string[];
  readonly places: string[];
}

export interface PlottrFolder {
  readonly id: number;
  readonly title: string;
  readonly scenes: PlottrScene[];
  readonly children: PlottrFolder[];
}

export interface PlottrCodex {
  readonly id: number;
  readonly kind: 'character' | 'place';
  readonly name: string;
  readonly description: string;
  readonly keywords: string[];
  /** The full notes and every custom attribute, as a Research page. */
  readonly page: { readonly title: string; readonly body: string };
}

export interface PlottrResearch {
  readonly title: string;
  readonly body: string;
  readonly keywords: string[];
}

export interface PlottrImport {
  readonly seriesName: string;
  /** Every book the file holds, in order; more than one means a series file and the picker chooses. */
  readonly books: PlottrBook[];
  readonly book: PlottrBook;
  /** The beat tree's top folders, in book order. */
  readonly folders: PlottrFolder[];
  /** Cards no beat or no line of this book owns, for the "Unsorted" folder. */
  readonly orphans: PlottrScene[];
  /** The book's plotline titles (a card names its own as a keyword). */
  readonly threads: string[];
  /** The series-level plotlines a book cannot carry, reported as a notice. */
  readonly seriesThreads: string[];
  readonly codex: PlottrCodex[];
  readonly research: PlottrResearch[];
  readonly assets: ImportAsset[];
  readonly assetData: Map<string, Uint8Array>;
  readonly losses: LossWarning[];
  /** Top-level keys of a newer Plottr this reader does not know, reported as a notice. */
  readonly unknownKeys: string[];
}

export type PlottrError =
  | { kind: 'not-plottr' }
  | { kind: 'too-large' }
  | { kind: 'bad-json'; message: string }
  | { kind: 'empty' };

export type PlottrResult = { ok: true; value: PlottrImport } | { ok: false; error: PlottrError };

/** The page's own headings, in the writer's language; the app passes them, as it passes the splitter's labels. */
export interface PlottrLabels {
  readonly details: string;
  readonly attributes: string;
}

export interface PlottrReadOptions {
  /** Which book of a series file to read; the first when absent. */
  readonly bookId?: string;
  readonly labels?: PlottrLabels;
}

/** The card text kept as the synopsis; a longer description continues in the scene's body. */
export const SYNOPSIS_CHARS = 2_000;

const KNOWN_KEYS = new Set(['file', 'ui', 'featureFlags', 'series', 'books', 'beats', 'cards', 'categories', 'characters', 'customAttributes', 'attributes', 'lines', 'notes', 'places', 'tags', 'hierarchyLevels', 'images', 'permission', 'actions']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const idList = (value: unknown): number[] => (Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number') : []);

/** The bytes of a `data:` picture, or null. */
function dataUriBytes(target: string): Uint8Array | null {
  const match = /^data:[^;,]*;base64,(.*)$/i.exec(target);
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

/** The picture type from its magic bytes: Plottr writes `image/jpeg` for PNGs too. */
function sniffImage(bytes: Uint8Array, declared: string): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return declared;
}

interface RawBeat {
  readonly id: number;
  readonly title: string;
  readonly childIds: readonly number[];
}

/** The beat tree of one book key, both shapes: the `{children, heap, index}` maps and the older flat array. */
function beatTree(raw: unknown): { nodes: Map<number, RawBeat>; rootIds: number[] } {
  const nodes = new Map<number, RawBeat>();
  const roots: number[] = [];
  if (isRecord(raw) && isRecord(raw.index)) {
    const children = isRecord(raw.children) ? raw.children : {};
    const index = raw.index;
    for (const [key, beat] of Object.entries(index)) {
      if (!isRecord(beat)) continue;
      const id = typeof beat.id === 'number' ? beat.id : Number(key);
      nodes.set(id, {
        id,
        title: text(beat.title) || `Beat ${id}`,
        childIds: Array.isArray(children[key]) ? (children[key] as number[]) : [],
      });
    }
    const top = children['null'];
    if (Array.isArray(top)) roots.push(...top.filter((id): id is number => typeof id === 'number'));
    if (roots.length === 0) {
      // No null bucket: the beats nothing claims are the top level.
      const held = new Set<number>();
      for (const list of Object.values(children)) {
        if (Array.isArray(list)) for (const id of list) if (typeof id === 'number') held.add(id);
      }
      for (const id of nodes.keys()) if (!held.has(id)) roots.push(id);
    }
  } else if (Array.isArray(raw)) {
    // The older shape: an array of beats with a `children` list of ids.
    for (const beat of raw) {
      if (!isRecord(beat) || typeof beat.id !== 'number') continue;
      nodes.set(beat.id, {
        id: beat.id,
        title: text(beat.title) || `Beat ${beat.id}`,
        childIds: idList(beat.children),
      });
      if (beat.expanded === undefined || beat.parentId === undefined || beat.parentId === null) roots.push(beat.id);
    }
  }
  return { nodes, rootIds: roots };
}

/** The tag and line dictionaries, by id. */
function dictionaries(source: Record<string, unknown>): { tags: Map<number, string>; lines: Map<number, { title: string; bookId: unknown }> } {
  const tags = new Map<number, string>();
  if (Array.isArray(source.tags)) {
    for (const tag of source.tags) {
      if (isRecord(tag) && typeof tag.id === 'number') tags.set(tag.id, text(tag.title) || `Tag ${tag.id}`);
    }
  }
  const lines = new Map<number, { title: string; bookId: unknown }>();
  if (Array.isArray(source.lines)) {
    for (const line of source.lines) {
      if (isRecord(line) && typeof line.id === 'number') lines.set(line.id, { title: text(line.title) || `Plotline ${line.id}`, bookId: line.bookId });
    }
  }
  return { tags, lines };
}

/** Every custom attribute an entity carries, as a name → value list. Attribute definitions sit in customAttributes; the values are the entity's own extra keys. */
function entityAttributes(entity: Record<string, unknown>, known: ReadonlySet<string>): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(entity)) {
    if (known.has(name)) continue;
    if (typeof value === 'string' && value.trim() !== '') out.push([name, value.trim()]);
    else if (Array.isArray(value)) {
      const md = slateToMarkdown(value);
      if (md !== '') out.push([name, md]);
    }
  }
  return out;
}

const ENTITY_KEYS = new Set(['id', 'name', 'description', 'notes', 'color', 'cards', 'noteIds', 'templates', 'tags', 'categoryId', 'imageId', 'bookIds']);

export function readPlottr(bytes: Uint8Array, options: PlottrReadOptions = {}): PlottrResult {
  if (bytes.length > MAX_TEXT_BYTES) return { ok: false, error: { kind: 'too-large' } };
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    if (!isRecord(parsed)) return { ok: false, error: { kind: 'not-plottr' } };
    root = parsed;
  } catch (failure) {
    return { ok: false, error: { kind: 'bad-json', message: failure instanceof Error ? failure.message : String(failure) } };
  }
  // A .pltr always carries a file record and a beats map; a bare JSON without them is not Plottr's.
  if (!isRecord(root.file) || root.beats === undefined) return { ok: false, error: { kind: 'not-plottr' } };

  const books: PlottrBook[] = [];
  if (isRecord(root.books)) {
    const order = Array.isArray(root.books.allIds) ? root.books.allIds : [];
    for (const id of order) {
      const book = root.books[String(id)];
      if (isRecord(book)) books.push({ id: String(id), title: text(book.title) || `Book ${id}` });
    }
  }
  const book = books.find((entry) => entry.id === options.bookId) ?? books[0];
  if (books.length === 0 || book === undefined) return { ok: false, error: { kind: 'empty' } };
  const bookKey = book.id;
  const seriesName = isRecord(root.series) ? text(root.series.name) : '';

  const { tags, lines } = dictionaries(root);
  const images = isRecord(root.images) ? root.images : {};
  const losses: LossWarning[] = [];

  // Pictures: decoded once; the record's own extension is kept and the MIME sniffed.
  const assets: ImportAsset[] = [];
  const assetData = new Map<string, Uint8Array>();
  const pictureRef = (imageId: unknown): string | null => {
    const image = images[String(imageId)];
    if (!isRecord(image)) return null;
    const data = text(image.data);
    const bytes = dataUriBytes(data);
    if (bytes === null) return null;
    const declared = /^data:([^;,]+)/.exec(data)?.[1] ?? 'image/jpeg';
    const sniffed = sniffImage(bytes, declared);
    const ref = `plottr-${String(imageId)}`;
    if (!assetData.has(ref)) {
      const name = text(image.name) || `Picture ${String(imageId)}`;
      assets.push({ ref, name: `${name}.${sniffed === 'image/png' ? 'png' : sniffed === 'image/gif' ? 'gif' : sniffed === 'image/webp' ? 'webp' : 'jpg'}`, mime: sniffed, bytes: bytes.length });
      assetData.set(ref, bytes);
    }
    return ref;
  };

  // Scenes: every card of this book, by beat.
  const cardList = Array.isArray(root.cards) ? root.cards : [];
  const linesById = new Map(lines);
  const cardsByBeat = new Map<number, Record<string, unknown>[]>();
  const orphans: PlottrScene[] = [];
  const beatsKey = isRecord(root.beats) ? root.beats[bookKey] : undefined;
  const beatSet = beatTree(beatsKey);

  const sceneOf = (card: Record<string, unknown>): PlottrScene => {
    const markdown = slateToMarkdown(card.description);
    const over = markdown.length > SYNOPSIS_CHARS;
    const synopsis = over ? markdown.slice(0, SYNOPSIS_CHARS) : markdown;
    const body = over ? markdown.slice(SYNOPSIS_CHARS).trimStart() : '';
    const keywords: string[] = [];
    for (const tagId of idList(card.tags)) {
      const tag = tags.get(tagId);
      if (tag !== undefined) keywords.push(tag);
    }
    const line = typeof card.lineId === 'number' ? linesById.get(card.lineId) : undefined;
    if (line !== undefined) keywords.push(`Plotline: ${line.title}`);
    const characters = idList(card.characters)
      .map((id) => nameOf(root.characters, id))
      .filter((name): name is string => name !== null);
    const places = idList(card.places)
      .map((id) => nameOf(root.places, id))
      .filter((name): name is string => name !== null);
    return { id: typeof card.id === 'number' ? card.id : -1, title: text(card.title) || 'Untitled card', synopsis, body, keywords, characters, places };
  };

  function nameOf(list: unknown, id: number): string | null {
    if (!Array.isArray(list)) return null;
    const entry = list.find((candidate) => isRecord(candidate) && candidate.id === id);
    return isRecord(entry) ? text(entry.name) || null : null;
  }

  const ownCard = (card: Record<string, unknown>): boolean => {
    // A card belongs to this book through its beat; a card without a beat is kept only when its line is the book's.
    if (typeof card.beatId === 'number' && beatSet.nodes.has(card.beatId)) return true;
    const line = typeof card.lineId === 'number' ? linesById.get(card.lineId) : undefined;
    return line !== undefined && String(line.bookId) === bookKey;
  };

  for (const card of cardList) {
    if (!isRecord(card) || !ownCard(card)) continue;
    const scene = sceneOf(card);
    if (typeof card.beatId === 'number' && beatSet.nodes.has(card.beatId)) {
      const list = cardsByBeat.get(card.beatId) ?? [];
      list.push(card);
      cardsByBeat.set(card.beatId, list);
    } else {
      orphans.push(scene);
    }
  }

  const orderedScenes = (beatId: number): PlottrScene[] =>
    (cardsByBeat.get(beatId) ?? [])
      .sort((a, b) => (typeof a.position === 'number' ? a.position : 0) - (typeof b.position === 'number' ? b.position : 0) || (typeof a.positionWithinLine === 'number' ? a.positionWithinLine : 0) - (typeof b.positionWithinLine === 'number' ? b.positionWithinLine : 0))
      .map(sceneOf);

  const folderOf = (beat: RawBeat): PlottrFolder => ({
    id: beat.id,
    title: beat.title,
    scenes: orderedScenes(beat.id),
    children: beat.childIds.map((id) => beatSet.nodes.get(id)).filter((child): child is RawBeat => child !== undefined).map(folderOf),
  });
  const folders = beatSet.rootIds.map((id) => beatSet.nodes.get(id)).filter((beat): beat is RawBeat => beat !== undefined).map(folderOf);

  const threads = [...lines.values()].filter((line) => String(line.bookId) === bookKey).map((line) => line.title);
  const seriesThreads = [...lines.values()].filter((line) => String(line.bookId) === 'series').map((line) => line.title);

  // Codex: characters and places of this book, plus every series-level one.
  const codex: PlottrCodex[] = [];
  const inBook = (entity: Record<string, unknown>): boolean => {
    const list = idList(entity.bookIds);
    return list.length === 0 || list.map(String).includes(bookKey);
  };
  const categoryNames = (module: 'characters' | 'places'): Map<number, string> => {
    const out = new Map<number, string>();
    const categories = isRecord(root.categories) ? root.categories[module] : undefined;
    if (Array.isArray(categories)) {
      for (const category of categories) {
        if (isRecord(category) && typeof category.id === 'number') out.set(category.id, text(category.name) || `Category ${category.id}`);
      }
    }
    return out;
  };
  const labels = options.labels ?? { details: 'Details', attributes: 'Attributes' };
  const codexOf = (entity: Record<string, unknown>, kind: 'character' | 'place', categories: Map<number, string>): PlottrCodex | null => {
    const name = text(entity.name);
    if (name === '') return null;
    const description = text(entity.description);
    const keywords: string[] = [];
    const category = typeof entity.categoryId === 'number' || typeof entity.categoryId === 'string' ? categories.get(Number(entity.categoryId)) : undefined;
    if (category !== undefined) keywords.push(category);
    for (const tagId of idList(entity.tags)) {
      const tag = tags.get(tagId);
      if (tag !== undefined) keywords.push(tag);
    }
    const notes = slateToMarkdown(entity.notes);
    const attributes = entityAttributes(entity, ENTITY_KEYS);
    const sections: string[] = [];
    const ref = pictureRef(entity.imageId);
    if (ref !== null) sections.push(`![${name}](${ref})`);
    if (notes !== '') sections.push(notes);
    if (attributes.length > 0) {
      sections.push(`## ${labels.attributes}\n\n${attributes.map(([attr, value]) => `- **${attr}**: ${value.replace(/\n/g, ' ')}`).join('\n')}`);
    }
    const body = sections.length === 0 ? `# ${name}` : `# ${name}\n\n## ${labels.details}\n\n${sections.join('\n\n')}`;
    return { id: typeof entity.id === 'number' ? entity.id : -1, kind, name, description, keywords, page: { title: `${name}: ${labels.details}`, body } };
  };
  const characterCategories = categoryNames('characters');
  const placeCategories = categoryNames('places');
  for (const entity of Array.isArray(root.characters) ? root.characters : []) {
    if (isRecord(entity) && inBook(entity)) {
      const row = codexOf(entity, 'character', characterCategories);
      if (row !== null) codex.push(row);
    }
  }
  for (const entity of Array.isArray(root.places) ? root.places : []) {
    if (isRecord(entity) && inBook(entity)) {
      const row = codexOf(entity, 'place', placeCategories);
      if (row !== null) codex.push(row);
    }
  }

  // Research: the notes of this book.
  const research: PlottrResearch[] = [];
  for (const note of Array.isArray(root.notes) ? root.notes : []) {
    if (!isRecord(note) || !inBook(note)) continue;
    const body = slateToMarkdown(note.content);
    const keywords: string[] = [];
    for (const tagId of idList(note.tags)) {
      const tag = tags.get(tagId);
      if (tag !== undefined) keywords.push(tag);
    }
    const ref = pictureRef(note.imageId);
    research.push({ title: text(note.title) || 'Note', body: ref === null ? body : `![${text(note.title) || 'Note'}](${ref})\n\n${body}`, keywords });
  }

  const unknownKeys = Object.keys(root).filter((key) => !KNOWN_KEYS.has(key));
  losses.push({ code: 'unsupported', message: 'Colours, UI state and templates were not kept; Plottr stores no prose and no dates, only the outline order.', count: 1 });
  if (unknownKeys.length > 0) losses.push({ code: 'unsupported', message: `This file holds keys a newer Plottr writes that this reader does not know: ${unknownKeys.join(', ')}.`, count: unknownKeys.length });
  if (seriesThreads.length > 0) losses.push({ code: 'unsupported', message: `${seriesThreads.length} series-level plotline(s) sit above the books: ${seriesThreads.join(', ')}. They are named here, not imported.`, count: seriesThreads.length });

  return { ok: true, value: { seriesName, books, book, folders, orphans, threads, seriesThreads, codex, research, assets, assetData, losses, unknownKeys } };
}
