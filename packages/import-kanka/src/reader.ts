/**
 * The Kanka reader (#293, epic #263): a JSON campaign export zip read into codex rows and their Research pages.
 * The zip is opened with the shared caps and zip-bomb guard; every entry's HTML goes through the shared XHTML
 * walker, so nothing runs. Kanka is Commons Clause: its export was read as format documentation, no code copied.
 */

import type { ImportAsset, LossWarning } from '@caotang/import-core';
import { pictureRefusal, type HtmlDropped, type PictureRefusal } from '@caotang/import-html';
import { decodePlainText } from '@caotang/import-read/text';
import { openZip, type ImportArchive } from '@caotang/import-read/zip';

import { campaignName, moduleLabels, parseInfo, versionAtLeast, type KankaInfo } from './campaign.js';
import { codexTypeOf, moduleOfPath, parseEntityFile, type KankaEntity } from './entity.js';
import { entityPage, reminderDate, DEFAULT_KANKA_LABELS, type KankaLabels, type KankaPage } from './pages.js';

export interface KankaImport {
  campaign: string;
  info: KankaInfo;
  /** Every entity the export carries, tags aside, in module then name order. */
  entities: KankaEntity[];
  /** One page per entity, in the same order. */
  pages: KankaPage[];
  /** The keywords each entity offers: the campaign's word for its module, its own type and its tags. Capped at the keywords field's 32, each trimmed to 64 characters; the rest are in `keywordOverflow`. */
  keywords: Map<number, string[]>;
  /** The keywords past the field's limit, named so the report can list them instead of dropping them silently. */
  keywordOverflow: string[];
  /** The world-history index: events and the calendar reminders that are not a birth or a death. `body` is the list; the caller writes the heading in the writer's language. */
  history: { title: string; body: string } | null;
  /** The gallery pictures no entity uses, as a list of pictures and names. */
  gallery: { title: string; body: string } | null;
  assets: ImportAsset[];
  assetData: Map<string, Uint8Array>;
  remoteImages: string[];
  dropped: HtmlDropped;
  losses: LossWarning[];
  refusedSvg: number;
  missingPictures: number;
  unresolvedMentions: number;
  privateEntities: number;
}

export type KankaError =
  | { kind: 'not-kanka' }
  | { kind: 'old-export'; version: string }
  | { kind: 'archive'; message: string }
  | { kind: 'empty' };

export type KankaResult = { ok: true; value: KankaImport } | { ok: false; error: KankaError };

/** The page's own headings, in the writer's language; the app passes them, as it passes the splitter's labels. */
export interface KankaReadOptions {
  labels?: KankaLabels;
}

const EMPTY_DROPPED: HtmlDropped = { scripts: 0, styles: 0, iframes: 0, forms: 0, eventAttrs: 0, unsafeLinks: 0, media: 0 };

const addDropped = (into: HtmlDropped, from: HtmlDropped): void => {
  into.scripts += from.scripts;
  into.styles += from.styles;
  into.iframes += from.iframes;
  into.eventAttrs += from.eventAttrs;
  into.unsafeLinks += from.unsafeLinks;
  into.media += from.media;
};

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

const isSvg = (path: string): boolean => /\.svgz?$/i.test(path);
const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Remove the Markdown image for a ref; its alt text may itself hold escaped brackets. */
function withoutImageRef(body: string, imageRef: string): string {
  const ref = imageRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body.replace(new RegExp(`!\\[(?:\\\\.|[^\\]\\\\])*\\]\\(${ref}\\)`, 'g'), '');
}

/** Read a Kanka export's bytes. */
export async function readKanka(bytes: Uint8Array, options: KankaReadOptions = {}): Promise<KankaResult> {
  const archive = await openZip(bytes);
  if (!archive.ok) return { ok: false, error: { kind: 'archive', message: archive.error.message } };
  return readKankaArchive(archive.value, options);
}

/** Read an opened Kanka export. */
export async function readKankaArchive(archive: ImportArchive, options: KankaReadOptions = {}): Promise<KankaResult> {
  const pageLabels = options.labels ?? DEFAULT_KANKA_LABELS;
  const paths = archive.entries.map((entry) => entry.path);
  const entityPaths = paths.filter((path) => moduleOfPath(path) !== null);
  const infoEntry = archive.entry('info.json');
  if (infoEntry === undefined && entityPaths.length === 0) return { ok: false, error: { kind: 'not-kanka' } };

  const json = async (path: string): Promise<unknown> => {
    const read = await archive.read(path);
    if (!read.ok) return null;
    const decoded = decodePlainText(read.value);
    if (decoded.status !== 'decoded') return null;
    try {
      return JSON.parse(decoded.text) as unknown;
    } catch {
      return null;
    }
  };

  const info = parseInfo(await json('info.json'));
  if (info === null) return { ok: false, error: { kind: 'old-export', version: '' } };
  if (!versionAtLeast(info.kankaVersion, 2, 1)) return { ok: false, error: { kind: 'old-export', version: info.kankaVersion } };
  if (entityPaths.length === 0) return { ok: false, error: { kind: 'empty' } };

  const campaign = campaignName(await json('campaign.json'));
  const labels = moduleLabels(await json('settings/modules.json'));

  const read = await archive.readMany(entityPaths);
  if (!read.ok) return { ok: false, error: { kind: 'archive', message: read.error.message } };
  const entities: KankaEntity[] = [];
  for (const path of entityPaths) {
    const named = moduleOfPath(path);
    const bytes = read.value.get(path);
    if (named === null || bytes === undefined) continue;
    const decoded = decodePlainText(bytes);
    if (decoded.status !== 'decoded') continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(decoded.text) as unknown;
    } catch {
      continue;
    }
    const entity = parseEntityFile(named.module, parsed);
    if (entity !== null) entities.push(entity);
  }
  if (entities.length === 0) return { ok: false, error: { kind: 'empty' } };

  const names = new Map<number, string>();
  for (const entity of entities) names.set(entity.id, entity.name);
  const tagNames = new Map<number, string>();
  for (const entity of entities) if (entity.module === 'tags') tagNames.set(entity.id, entity.name);

  const kept = entities
    .filter((entity) => entity.module !== 'tags')
    .sort((a, b) => (a.module === b.module ? a.name.localeCompare(b.name) : a.module.localeCompare(b.module)));

  const dropped: HtmlDropped = { ...EMPTY_DROPPED };
  const losses: LossWarning[] = [];
  const remoteImages: string[] = [];
  const assets: ImportAsset[] = [];
  const assetData = new Map<string, Uint8Array>();
  const keywords = new Map<number, string[]>();
  const pages: KankaPage[] = [];
  const usedPaths = new Set<string>();
  let refusedSvg = 0;
  let missingPictures = 0;
  let unresolvedMentions = 0;
  let pictureIndex = 0;
  const keywordOverflow: string[] = [];
  const unsupportedPictures = new Set<string>();
  const unsupportedPicturePaths = new Set<string>();

  /** Name bytes the picture pipeline would refuse, once per picture, instead of letting them reject the whole import. */
  const noteUnsupportedPicture = (name: string, why: PictureRefusal): void => {
    const key = `${name}:${why}`;
    if (unsupportedPictures.has(key)) return;
    unsupportedPictures.add(key);
    const reason = why === 'format' ? 'is not a PNG, JPEG or WebP picture' : 'is larger than a picture may be (16 MB and 50 megapixels)';
    losses.push({ code: 'image-unreadable', message: `${name} ${reason}, so it is not imported; the rest of the campaign is kept.` });
  };

  /** A picture from the zip, or null when it is not there, is an SVG, or is bytes the picture store would refuse. */
  const zipPicture = async (path: string): Promise<Uint8Array | null> => {
    const clean = path.replace(/^\.?\//, '');
    if (isSvg(clean)) {
      refusedSvg += 1;
      return null;
    }
    const entry = archive.entry(clean);
    if (entry === undefined) return null;
    const bytes = await archive.read(clean);
    if (!bytes.ok) return null;
    usedPaths.add(clean);
    const why = pictureRefusal(bytes.value);
    if (why !== undefined) {
      unsupportedPicturePaths.add(clean);
      noteUnsupportedPicture(clean, why);
      return null;
    }
    return bytes.value;
  };

  for (const entity of kept) {
    const ref = `import:kanka-image-${(pictureIndex += 1)}`;
    let picture: { ref: string; name: string; data: Uint8Array } | undefined;
    if (entity.imagePath !== '') {
      const data = await zipPicture(entity.imagePath);
      if (data !== null) picture = { ref, name: fileName(entity.imagePath), data };
      else if (!isSvg(entity.imagePath) && !unsupportedPicturePaths.has(entity.imagePath.replace(/^\.?\//, ''))) missingPictures += 1;
    }

    const parts = entityPage(entity, {
      moduleLabel: labels.get(entity.module) ?? entity.module,
      names,
      refPrefix: `import:kanka-entry-${entity.id}-`,
      labels: pageLabels,
      ...(picture === undefined ? {} : { picture }),
    });
    addDropped(dropped, parts.dropped);
    losses.push(...parts.losses);
    unresolvedMentions += parts.unresolvedMentions;
    for (const target of parts.remoteImages) if (!remoteImages.includes(target)) remoteImages.push(target);
    assets.push(...parts.assets);
    for (const [key, data] of parts.assetData) assetData.set(key, data);

    // The pictures the entry itself names: a `data:` URI, or a path inside the export.
    let body = parts.page.body;
    for (const [imageRef, target] of parts.images) {
      const inline = dataUriBytes(target);
      const data = inline ?? (await zipPicture(target));
      if (data === null) {
        if (!isSvg(target) && !/^https?:/i.test(target) && !unsupportedPicturePaths.has(target.replace(/^\.?\//, ''))) missingPictures += 1;
        body = withoutImageRef(body, imageRef);
        continue;
      }
      const why = pictureRefusal(data);
      if (why !== undefined) {
        noteUnsupportedPicture(target.startsWith('data:') ? 'an embedded picture' : target, why);
        body = withoutImageRef(body, imageRef);
        continue;
      }
      assets.push({ ref: imageRef, name: fileName(target), bytes: data.length });
      assetData.set(imageRef, data);
    }
    body = body.replace(/\n{3,}/g, '\n\n').trim();

    pages.push({ ...parts.page, body });
    const words = [labels.get(entity.module) ?? entity.module, entity.type, ...entity.tagIds.map((id) => tagNames.get(id) ?? '')].filter((word) => word !== '');
    // The keywords field holds 32 of 64 characters each: more tags or a longer one would refuse the whole import.
    const all = [...new Set(words.map((word) => word.slice(0, 64)).filter((word) => word !== ''))];
    keywords.set(entity.id, all.slice(0, 32));
    keywordOverflow.push(...all.slice(32));
  }

  // The world-history index: the events, and the calendar reminders that are not a birth or a death.
  const historyLines: string[] = [];
  for (const entity of kept) {
    if (entity.module === 'events') historyLines.push(`- ${entity.date === '' ? '' : `${entity.date} — `}${entity.name}`);
    for (const reminder of entity.reminders) {
      if (reminder.typeId === 2 || reminder.typeId === 3) continue;
      const date = reminderDate(reminder, pageLabels);
      historyLines.push(`- ${date === '' ? '' : `${date} — `}${entity.name}${reminder.comment === '' ? '' : ` (${reminder.comment})`}`);
    }
  }
  const history = historyLines.length === 0 ? null : { title: 'World history', body: historyLines.join('\n') };

  // The gallery pictures no entity used.
  const galleryLines: string[] = [];
  for (const path of paths) {
    if (!path.startsWith('gallery/') || path.endsWith('.json')) continue;
    if (usedPaths.has(path)) continue;
    if (isSvg(path)) {
      refusedSvg += 1;
      continue;
    }
    const bytes = await zipPicture(path);
    if (bytes === null) continue;
    const id = fileName(path).replace(/\.[^.]+$/, '');
    const meta = await json(`gallery/${id}.json`);
    const name = typeof meta === 'object' && meta !== null && 'name' in meta && typeof (meta as { name: unknown }).name === 'string' ? (meta as { name: string }).name : fileName(path);
    const ref = `import:kanka-image-${(pictureIndex += 1)}`;
    assets.push({ ref, name: fileName(path), bytes: bytes.length });
    assetData.set(ref, bytes);
    galleryLines.push(`![${name}](${ref})`, name);
  }
  const gallery = galleryLines.length === 0 ? null : { title: 'Campaign gallery', body: galleryLines.join('\n\n') };

  return {
    ok: true,
    value: {
      campaign,
      info,
      entities: kept,
      pages,
      keywords,
      keywordOverflow,
      history,
      gallery,
      assets,
      assetData,
      remoteImages,
      dropped,
      losses,
      refusedSvg,
      missingPictures,
      unresolvedMentions,
      privateEntities: kept.filter((entity) => entity.isPrivate).length,
    },
  };
}

export { codexTypeOf };
