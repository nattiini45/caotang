/**
 * The figure model of the prose pipeline — pictures.md §4, the "figure block" of the B2 row.
 *
 * `prose.ts` reduces a body's inline images to `figure` blocks carrying the placement as the
 * writer wrote it (`![alt](../assets/a_….png "caption")`). This module resolves those placements
 * against the project: the asset identity from the destination, the placement text (the decoded
 * caption of pictures.md §2.2.1, the alt, the decorative flag) from the body first and the
 * registry record's defaults second, and the bytes through the host's `readAsset` and
 * `ProcessPicture` under the target's profile (`picture-profile.ts`).
 *
 * One resolution serves the whole compile, so a picture placed twice is read, converted and
 * packed once (dedup by asset id, and by the output hash when two different pictures convert to
 * the same bytes). What cannot be resolved degrades honestly: a missing file, or a picture the
 * host cannot convert, exports as its caption with a compile-log note — never a broken embed.
 */

import {
  decodePlacementTitle,
  extensionOfMime,
  finishPassthrough,
  isAssetId,
  parseAssetFileName,
  planPicture,
  sha256Hex,
  sniffPicture,
  PictureRefusal,
  type PictureBytes,
  type PictureMime,
  type ProcessPicture,
} from '@caotang/pictures';

import { parseProse, type ImageRef, type ProseBlock } from './prose.js';
import type { FlatBlock } from './types.js';
import { profileForSource, type FigureTargetSpec } from './picture-profile.js';

/** The registry facts a placement falls back to (pictures.md §2.2: the body is read first). */
export interface FigureRecord {
  readonly id: string;
  readonly file?: string | undefined;
  readonly caption?: string | undefined;
  readonly alt?: string | undefined;
  readonly decorative?: true | undefined;
}

/** What a compile hands the resolver: the project's asset bytes, the host's transcoder and the records. */
export interface FigureHost {
  /** Reads one file of the project's `assets/` by its path, or `null` when the store does not hold it. */
  readonly readAsset: (path: string) => Promise<Uint8Array | null>;
  /** The host's `ProcessPicture`. A profile that needs a transcode and has no host here is refused, not approximated. */
  readonly process?: ProcessPicture | undefined;
  /** The registry records by asset id. */
  readonly records: ReadonlyMap<string, FigureRecord>;
}

/** One image payload a package or an assets folder carries. */
export interface PackedImage {
  /** The file name inside the package or the `.assets` folder: `a_XXXXXXXXXX.<ext>`. */
  readonly name: string;
  readonly mime: PictureMime;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** A placement resolved against the project. */
export interface ResolvedFigure {
  readonly source: ImageRef;
  readonly assetId: string;
  /** The stored file name the destination named. */
  readonly fileName: string;
  /** The resolved payload, when the target embeds pictures and the file was found and converted. */
  readonly image?: PackedImage | undefined;
  /** The alt text every format writes (empty when decorative). */
  readonly alt: string;
  /** The decoded caption; for an unknown suffix version, the whole title as written. */
  readonly caption: string;
  readonly decorative: boolean;
  /** Set when the title carried a suffix version this build cannot decode: the title is kept verbatim. */
  readonly opaqueTitle?: string | undefined;
  /** The file was named by the body but is not in `assets/`, or could not be converted: the caption is exported. */
  readonly missing: boolean;
}

/** The resolved figures of one compile: by destination, the deduped payloads, and the log notes. */
export interface FigurePack {
  readonly figures: ReadonlyMap<string, ResolvedFigure>;
  readonly images: readonly PackedImage[];
  readonly notes: readonly string[];
}

/** Every figure placement in the flat blocks, in document order, duplicates included. */
export function figureSourcesOf(blocks: readonly FlatBlock[]): ImageRef[] {
  const out: ImageRef[] = [];
  const walk = (prose: readonly ProseBlock[]): void => {
    for (const block of prose) {
      switch (block.kind) {
        case 'figure':
          out.push(block.image);
          break;
        case 'quote':
          walk(block.blocks);
          break;
        case 'list':
          for (const item of block.items) walk(item);
          break;
        default:
          break;
      }
    }
  };
  for (const block of blocks) {
    if (block.kind === 'scene') walk(parseProse(block.body));
  }
  return out;
}

/** The asset a destination names, when it is the project's own `../assets/<file>` spelling (pictures.md §3). */
export function assetRefOfUrl(url: string): { readonly assetId: string; readonly file: string } | undefined {
  const match = /^\.\.\/assets\/([^\s?#]+)$/.exec(url.trim());
  if (match === null) return undefined;
  const parsed = parseAssetFileName(match[1] ?? '');
  if (parsed === undefined) return undefined;
  return { assetId: parsed.assetId, file: match[1] ?? '' };
}

/**
 * The placement text a format prints: the decoded caption of §2.2.1, or the whole title when it
 * carries a suffix version this build cannot decode; the alt from the alt slot, else the
 * record's, else the caption (with a note, §2.2); decorative from the suffix, else the record's.
 */
export function placementTextOf(source: ImageRef, record: FigureRecord | undefined): {
  readonly caption: string;
  readonly alt: string;
  readonly decorative: boolean;
  readonly opaqueTitle?: string;
  readonly altFromCaption: boolean;
} {
  const decoded = decodePlacementTitle(source.title);
  const opaque = decoded.kind === 'opaque-version' ? decoded.raw : undefined;
  const bodyCaption = decoded.kind === 'placement' ? decoded.caption : decoded.raw;
  const caption = bodyCaption !== '' ? bodyCaption : (record?.caption ?? '');
  const alt = source.alt !== '' ? source.alt : (record?.alt ?? '');
  const decorative = (decoded.kind === 'placement' && decoded.decorative) || record?.decorative === true;
  const altFromCaption = alt === '' && caption !== '' && !decorative;
  return {
    caption,
    alt: altFromCaption ? caption : alt,
    decorative,
    ...(opaque === undefined ? {} : { opaqueTitle: opaque }),
    altFromCaption,
  };
}

/** The asset ids the flat blocks name, deduplicated, in first-use order — the files a Markdown copy writes. */
export function usedAssetFilesOf(blocks: readonly FlatBlock[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of figureSourcesOf(blocks)) {
    const ref = assetRefOfUrl(source.url);
    if (ref === undefined || seen.has(ref.file)) continue;
    seen.add(ref.file);
    out.push(ref.file);
  }
  return out;
}

/**
 * Resolves every placement. `spec.embed` false (the TXT compile) reads the files only to name the
 * missing ones — no bytes are converted. A `PictureRefusal` from the plan of one picture degrades
 * that picture to its caption with a note; so does a profile that needs a transcode on a host with
 * no `ProcessPicture`, so nothing is ever embedded unscaled or unconverted (pictures.md §4, §6.4.1).
 * Only a failure that is not a `PictureRefusal` fails the compile.
 */
export async function resolveFigures(
  sources: readonly ImageRef[],
  host: FigureHost,
  spec: FigureTargetSpec & { readonly embed: boolean },
): Promise<FigurePack> {
  const figures = new Map<string, ResolvedFigure>();
  const images: PackedImage[] = [];
  const notes: string[] = [];
  const byAsset = new Map<string, ResolvedFigure>();
  const payloadByHash = new Map<string, PackedImage>();

  for (const source of sources) {
    const ref = assetRefOfUrl(source.url);
    if (ref === undefined) {
      // A `src` outside `../assets/` is kept in the project and exported as alt text (pictures.md §3).
      notes.push(`a picture at ${source.url} is not in the project's assets/, so its alt text is exported instead`);
      figures.set(source.url, {
        source,
        assetId: '',
        fileName: '',
        alt: source.alt,
        caption: placementTextOf(source, undefined).caption,
        decorative: placementTextOf(source, undefined).decorative,
        missing: true,
      });
      continue;
    }
    const cached = byAsset.get(ref.assetId);
    if (cached !== undefined) {
      figures.set(source.url, cached);
      continue;
    }
    const record = host.records.get(ref.assetId);
    const file = record?.file ?? ref.file;
    const text = placementTextOf(source, record);
    const figure: ResolvedFigure = {
      source,
      assetId: ref.assetId,
      fileName: file,
      alt: text.alt,
      caption: text.caption,
      decorative: text.decorative,
      ...(text.opaqueTitle === undefined ? {} : { opaqueTitle: text.opaqueTitle }),
      missing: false,
    };
    byAsset.set(ref.assetId, figure);
    figures.set(source.url, figure);

    if (text.opaqueTitle !== undefined) {
      notes.push(`${file}'s title carries a picture-suffix version this build cannot decode, so the whole title is kept`);
    }
    if (text.altFromCaption) {
      notes.push(`${file} has no alt text, so its caption is used as the alt text`);
    } else if (!text.decorative && text.alt === '' && text.caption === '') {
      notes.push(`${file} has no alt text and no caption`);
    }

    const bytes = await host.readAsset(`assets/${file}`);
    if (bytes === null) {
      notes.push(`${file} is placed in the manuscript but its file is not in assets/, so the caption is exported instead`);
      byAsset.set(ref.assetId, { ...figure, missing: true });
      figures.set(source.url, { ...figure, missing: true });
      continue;
    }
    const sniffed = sniffPicture(bytes);
    if (!sniffed.ok) {
      notes.push(`${file} is not a PNG, JPEG or WebP picture (${sniffed.reason}), so the caption is exported instead`);
      byAsset.set(ref.assetId, { ...figure, missing: true });
      figures.set(source.url, { ...figure, missing: true });
      continue;
    }
    if (!spec.embed) continue;

    const profile = profileForSource(sniffed.mime, bytes, spec);
    let plan;
    try {
      plan = planPicture(bytes, profile);
    } catch (error) {
      if (error instanceof PictureRefusal) {
        notes.push(`${file} could not be prepared for this format: ${error.message} The caption is exported instead.`);
        byAsset.set(ref.assetId, { ...figure, missing: true });
        figures.set(source.url, { ...figure, missing: true });
        continue;
      }
      throw error;
    }
    let out: PictureBytes;
    try {
      if (plan.kind === 'passthrough') {
        out = finishPassthrough(bytes, plan, profile);
      } else {
        if (host.process === undefined) {
          throw new PictureRefusal(
            'unsupported-profile',
            `This host cannot convert pictures, and ${file} needs converting for this format.`,
            'Open the project in Caotang and export there.',
          );
        }
        out = await host.process({ bytes, mime: sniffed.mime, width: plan.source.width, height: plan.source.height }, profile);
      }
    } catch (error) {
      if (error instanceof PictureRefusal) {
        notes.push(`${file} could not be prepared for this format: ${error.message} The caption is exported instead.`);
        byAsset.set(ref.assetId, { ...figure, missing: true });
        figures.set(source.url, { ...figure, missing: true });
        continue;
      }
      throw error;
    }
    // Two placements of one asset share the payload; two assets that convert to the same bytes share it too.
    // A copy keeps the stored file name, so the exported destination matches the project's own spelling.
    const hash = await sha256Hex(out.bytes);
    const shared = payloadByHash.get(hash);
    const image: PackedImage = {
      name: spec.keepStoredName === true ? file : `${ref.assetId}.${extensionOfMime(out.mime)}`,
      mime: out.mime,
      bytes: out.bytes,
      width: out.width,
      height: out.height,
    };
    const packed = shared ?? image;
    if (shared === undefined) {
      payloadByHash.set(hash, image);
      images.push(image);
    }
    const resolved: ResolvedFigure = { ...figure, image: packed };
    byAsset.set(ref.assetId, resolved);
    figures.set(source.url, resolved);
  }

  const total = images.reduce((sum, image) => sum + image.bytes.length, 0);
  if (images.length > 0) {
    const heaviest = [...images].sort((a, b) => b.bytes.length - a.bytes.length).slice(0, 5);
    notes.push(
      `pictures: ${images.length} ${images.length === 1 ? 'picture' : 'pictures'} weigh ${formatBytes(total)} in this export; the heaviest: ${heaviest
        .map((image) => `${image.name} (${formatBytes(image.bytes.length)})`)
        .join(', ')}`,
    );
  }
  return { figures, images, notes };
}

/** Bytes as a writer reads them: 812 B, 34.5 kB, 1.2 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Whether an asset id is the `a_XXXXXXXXXX` shape the file names and destinations carry. */
export function isFigureAssetId(value: string): boolean {
  return isAssetId(value);
}
