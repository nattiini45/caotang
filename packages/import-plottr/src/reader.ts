/**
 * The Plottr `.pltr` reader (#290): plain JSON, both beat shapes, Slate rich text, embedded data-URL images and the
 * file's own ids made stable strings. Pure and DOM-free; nothing in a file executes or fetches.
 */

const MAX_FILE_BYTES = 25_000_000;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_ALL_IMAGE_BYTES = 20_000_000;
const MAX_ITEMS = 20_000;

export interface PlottrBook { readonly id: string; readonly title: string }
export interface PlottrBeat { readonly id: string; readonly bookId: string; readonly title: string; readonly position: number; readonly parentId?: string }
export interface PlottrLine { readonly id: string; readonly bookId: string; readonly title: string; readonly position: number; readonly series: boolean }
export interface PlottrCard {
  readonly id: string;
  readonly bookId?: string;
  readonly beatId?: string;
  readonly lineId?: string;
  readonly seriesLineId?: string;
  readonly title: string;
  readonly description: string;
  readonly position: number;
  readonly positionWithinLine: number;
  readonly positionInChapter: number;
  readonly tags: readonly string[];
  readonly characters: readonly string[];
  readonly places: readonly string[];
  readonly imageId?: string;
  readonly pov?: string;
}
export interface PlottrAttribute {
  readonly key: string;
  readonly value: string;
}

export interface PlottrEntity {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly notes: string;
  readonly tags: readonly string[];
  readonly categoryId?: string;
  readonly imageId?: string;
  readonly attributes: readonly PlottrAttribute[];
}
export interface PlottrNote {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly characters: readonly string[];
  readonly places: readonly string[];
  readonly imageId?: string;
}
export interface PlottrImage {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly mislabeled: boolean;
}
export interface PlottrRead {
  readonly title?: string;
  readonly books: readonly PlottrBook[];
  readonly beats: readonly PlottrBeat[];
  readonly lines: readonly PlottrLine[];
  readonly cards: readonly PlottrCard[];
  readonly characters: readonly PlottrEntity[];
  readonly places: readonly PlottrEntity[];
  readonly notes: readonly PlottrNote[];
  readonly tags: ReadonlyMap<string, string>;
  readonly categories: ReadonlyMap<string, string>;
  readonly images: readonly PlottrImage[];
  readonly unknownKeys: readonly string[];
  readonly imageBytesDropped: number;
}
export type PlottrResult = { readonly ok: true; readonly value: PlottrRead } | { readonly ok: false; readonly error: { readonly kind: 'too-large' | 'not-json' | 'not-plottr'; readonly message: string } };

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
const idText = (value: unknown): string | undefined => typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const ids = (value: unknown): string[] => [...new Set(list(value).map(idText).filter((id): id is string => id !== undefined))];

function escapeInline(value: string): string {
  return value.replaceAll(/[\\*_`[\]]/g, '\\$&');
}

function inline(node: unknown): string {
  if (!isRecord(node)) return '';
  const children = list(node['children']).map(inline).join('');
  const own = typeof node['text'] === 'string' ? escapeInline(node['text']) : children;
  let out = own;
  if (node['code'] === true) out = `\`${out}\``;
  if (node['bold'] === true) out = `**${out}**`;
  if (node['italic'] === true) out = `*${out}*`;
  if (node['strikethrough'] === true) out = `~~${out}~~`;
  const url = isRecord(node['link']) ? text(node['link']['url']) : text(node['url']);
  if (url !== undefined && /^(https?:|mailto:)/i.test(url)) out = `[${out}](${url})`;
  return out;
}

/** Plottr's Slate value as plain Markdown: paragraphs, headings, lists and inline marks. Unknown nodes become their text. */
export function slateMarkdown(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  const blocks: string[] = [];
  for (const node of value) {
    if (!isRecord(node)) continue;
    const body = list(node['children']).map(inline).join('').trim();
    if (body === '') continue;
    const type = typeof node['type'] === 'string' ? node['type'] : 'paragraph';
    if (type.startsWith('heading')) {
      const level = /^heading-([1-6])$/.exec(type)?.[1] ?? '2';
      blocks.push(`${'#'.repeat(Number(level))} ${body}`);
    } else if (type === 'bulleted-list' || type === 'numbered-list') {
      for (const item of list(node['children'])) {
        const line = isRecord(item) ? list(item['children']).map(inline).join('').trim() : '';
        if (line !== '') blocks.push(`- ${line}`);
      }
    } else blocks.push(body);
  }
  return blocks.join('\n\n').trim();
}

function markdownValue(value: unknown): string {
  return slateMarkdown(value);
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

function sniff(bytes: Uint8Array, declared: string): { mime: string; mislabeled: boolean } {
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const webp = bytes.length > 11 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  const gif = bytes.length > 5 && String.fromCharCode(...bytes.slice(0, 3)) === 'GIF';
  const mime = png ? 'image/png' : jpeg ? 'image/jpeg' : webp ? 'image/webp' : gif ? 'image/gif' : declared;
  return { mime, mislabeled: mime !== declared && (png || jpeg || webp || gif) };
}

const STANDARD_ENTITY_KEYS = new Set(['id', 'name', 'description', 'notes', 'color', 'cards', 'noteIds', 'templates', 'tags', 'categoryId', 'imageId', 'bookIds']);

function entityOf(raw: unknown): PlottrEntity | undefined {
  if (!isRecord(raw)) return undefined;
  const id = idText(raw['id']);
  const name = text(raw['name']);
  if (id === undefined || name === undefined) return undefined;
  const attributes: PlottrAttribute[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (STANDARD_ENTITY_KEYS.has(key)) continue;
    const markdown = markdownValue(value);
    if (markdown !== '') attributes.push({ key, value: markdown });
  }
  return {
    id,
    name,
    description: markdownValue(raw['description']),
    notes: markdownValue(raw['notes']),
    tags: ids(raw['tags']),
    ...(idText(raw['categoryId']) === undefined ? {} : { categoryId: idText(raw['categoryId']) }),
    ...(idText(raw['imageId']) === undefined ? {} : { imageId: idText(raw['imageId']) }),
    attributes,
  };
}

function beatParents(children: unknown): Map<string, string | undefined> {
  const parents = new Map<string, string | undefined>();
  if (!isRecord(children)) return parents;
  const walk = (parent: string | undefined, key: string): void => {
    for (const child of list(children[key]).map(idText).filter((id): id is string => id !== undefined)) {
      parents.set(child, parent);
      walk(child, child);
    }
  };
  walk(undefined, 'null');
  return parents;
}

/** Read one `.pltr` file. Unknown top-level keys are tolerated and counted; malformed JSON is a named refusal. */
export function readPlottr(bytes: Uint8Array): PlottrResult {
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: { kind: 'too-large', message: 'A Plottr file is at most 25 MB.' } };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return { ok: false, error: { kind: 'not-json', message: error instanceof Error ? error.message : 'The JSON could not be read.' } };
  }
  if (!isRecord(raw) || (!Array.isArray(raw['cards']) && !isRecord(raw['beats']))) return { ok: false, error: { kind: 'not-plottr', message: 'The JSON holds no Plottr cards or beats.' } };
  if (list(raw['cards']).length + list(raw['characters']).length + list(raw['places']).length + list(raw['notes']).length > MAX_ITEMS) {
    return { ok: false, error: { kind: 'too-large', message: 'A Plottr file holds at most 20,000 cards and research records.' } };
  }

  const series = isRecord(raw['series']) ? raw['series'] : {};
  const file = isRecord(raw['file']) ? raw['file'] : {};
  const booksRaw = isRecord(raw['books']) ? raw['books'] : undefined;
  const allIds = list(booksRaw?.['allIds']).map(idText).filter((id): id is string => id !== undefined);
  const keys = allIds.length > 0 ? allIds : Object.keys(booksRaw ?? {}).filter((key) => key !== 'allIds' && isRecord(booksRaw?.[key]));
  const books: PlottrBook[] = (keys.length === 0 ? ['1'] : keys).map((id) => {
    const book = isRecord(booksRaw?.[id]) ? booksRaw[id] as Json : {};
    return { id, title: text(book['title']) ?? text(series['name']) ?? 'Untitled book' };
  });

  const beats: PlottrBeat[] = [];
  if (Array.isArray(raw['beats'])) {
    for (const beat of raw['beats']) {
      if (!isRecord(beat)) continue;
      const id = idText(beat['id']);
      if (id !== undefined) beats.push({ id, bookId: books[0]?.id ?? '1', title: text(beat['title']) ?? 'Untitled beat', position: number(beat['position']) });
    }
  } else if (isRecord(raw['beats'])) {
    for (const book of books) {
      const container = isRecord(raw['beats'][book.id]) ? raw['beats'][book.id] as Json : undefined;
      const index = isRecord(container?.['index']) ? container['index'] as Json : {};
      const parents = beatParents(container?.['children']);
      for (const value of Object.values(index)) {
        if (!isRecord(value)) continue;
        const id = idText(value['id']);
        if (id === undefined) continue;
        const parentId = parents.get(id);
        beats.push({ id, bookId: book.id, title: text(value['title']) ?? 'Untitled beat', position: number(value['position']), ...(parentId === undefined ? {} : { parentId }) });
      }
    }
  }

  const lines: PlottrLine[] = list(raw['lines']).flatMap((line) => {
    if (!isRecord(line)) return [];
    const id = idText(line['id']);
    const title = text(line['title']);
    if (id === undefined || title === undefined) return [];
    const bookId = idText(line['bookId']) ?? books[0]?.id ?? '1';
    return [{ id, bookId, title, position: number(line['position']), series: bookId === 'series' }];
  });

  const tagNames = new Map<string, string>();
  for (const tag of list(raw['tags'])) if (isRecord(tag)) {
    const id = idText(tag['id']);
    const title = text(tag['title']);
    if (id !== undefined && title !== undefined) tagNames.set(id, title);
  }
  const categories = new Map<string, string>();
  for (const group of ['characters', 'places'] as const) for (const category of list(isRecord(raw['categories']) ? raw['categories'][group] : undefined)) {
    if (!isRecord(category)) continue;
    const id = idText(category['id']);
    const name = text(category['name']);
    if (id !== undefined && name !== undefined) categories.set(id, name);
  }

  const cards: PlottrCard[] = list(raw['cards']).flatMap((card) => {
    if (!isRecord(card)) return [];
    const id = idText(card['id']);
    const title = text(card['title']);
    if (id === undefined || title === undefined) return [];
    const povKey = Object.keys(card).find((key) => /^(pov|point of view)$/i.test(key));
    const pov = povKey === undefined ? undefined : markdownValue(card[povKey]);
    return [{
      id,
      ...(idText(card['bookId']) === undefined ? {} : { bookId: idText(card['bookId']) }),
      ...(idText(card['beatId']) === undefined ? {} : { beatId: idText(card['beatId']) }),
      ...(idText(card['lineId']) === undefined ? {} : { lineId: idText(card['lineId']) }),
      ...(idText(card['seriesLineId']) === undefined ? {} : { seriesLineId: idText(card['seriesLineId']) }),
      title,
      description: markdownValue(card['description']),
      position: number(card['position']),
      positionWithinLine: number(card['positionWithinLine']),
      positionInChapter: number(card['positionInChapter']),
      tags: ids(card['tags']),
      characters: ids(card['characters']),
      places: ids(card['places']),
      ...(idText(card['imageId']) === undefined ? {} : { imageId: idText(card['imageId']) }),
      ...(pov === undefined || pov === '' ? {} : { pov }),
    }];
  });

  const notes: PlottrNote[] = list(raw['notes']).flatMap((note) => {
    if (!isRecord(note)) return [];
    const id = idText(note['id']);
    const title = text(note['title']);
    if (id === undefined || title === undefined) return [];
    return [{ id, title, content: markdownValue(note['content']), tags: ids(note['tags']), characters: ids(note['characters']), places: ids(note['places']), ...(idText(note['imageId']) === undefined ? {} : { imageId: idText(note['imageId']) }) }];
  });

  let used = 0;
  let dropped = 0;
  const images: PlottrImage[] = [];
  for (const value of Object.values(isRecord(raw['images']) ? raw['images'] : {})) {
    if (!isRecord(value)) continue;
    const id = idText(value['id']);
    const data = text(value['data']);
    if (id === undefined || data === undefined) continue;
    const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(data);
    if (match === null) continue;
    const bytes = decodeBase64(match[2] ?? '');
    if (bytes === undefined || bytes.length > MAX_IMAGE_BYTES || used + bytes.length > MAX_ALL_IMAGE_BYTES) {
      dropped += bytes?.length ?? 0;
      continue;
    }
    used += bytes.length;
    const declared = match[1] ?? 'application/octet-stream';
    const type = sniff(bytes, declared);
    images.push({ id, name: text(value['name']) ?? `Image ${id}`, mime: type.mime, bytes, mislabeled: type.mislabeled });
  }

  const title = text(series['name']) ?? text(file['fileName']);
  const known = new Set(['series', 'beats', 'books', 'cards', 'lines', 'characters', 'places', 'notes', 'tags', 'images', 'categories', 'attributes', 'customAttributes', 'file', 'hierarchyLevels', 'featureFlags', 'ui', 'appliedMigrations']);
  const unknownKeys = Object.keys(raw).filter((key) => !known.has(key)).sort();
  return {
    ok: true,
    value: {
      ...(title === undefined ? {} : { title }),
      books,
      beats,
      lines,
      cards,
      characters: list(raw['characters']).map(entityOf).filter((entity): entity is PlottrEntity => entity !== undefined),
      places: list(raw['places']).map(entityOf).filter((entity): entity is PlottrEntity => entity !== undefined),
      notes,
      tags: tagNames,
      categories,
      images,
      unknownKeys,
      imageBytesDropped: dropped,
    },
  };
}
