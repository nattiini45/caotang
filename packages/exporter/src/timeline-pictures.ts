/**
 * The pictures the timeline exports name (timeline.md §9.1): which pictures sit on each scene, the words they are listed with,
 * and the small image the PDF draws for one.
 *
 * A scene's pictures are the view's: its card first, then its references in the order the writer gave them. A `source` placement (a
 * transcription's page) is not one, a placement whose picture has no record in the registry is left out (there is nothing to name or
 * draw, and the Picture board is where that is mended), and a picture on a paragraph of a scene belongs to the paragraph, not the scene.
 */

import {
  finishPassthrough,
  linksOf,
  planPicture,
  PictureRefusal,
  sniffPicture,
  type PictureBytes,
  type ProcessPicture,
  type ReadAssetLink,
  type ReadAssetRecord,
} from '@caotang/pictures';
import type { ProjectState } from '@caotang/store';

import { profileForSource, type FigureTargetSpec } from './picture-profile.js';

/** One picture on a scene, with the words the table lists it by. */
export interface TimelineScenePicture {
  readonly assetId: string;
  /** The stored file's name under `assets/`. */
  readonly file: string;
  /** Alt text: empty for a decorative picture, else the record's alt, else its caption. */
  readonly alt: string;
}

/** The pictures of a set of scenes, and how many placements were left out for want of a record. */
export interface TimelinePictures {
  readonly of: (nodeId: string) => readonly TimelineScenePicture[];
  readonly unrecorded: number;
}

function altOf(record: Pick<ReadAssetRecord, 'caption' | 'alt' | 'decorative'>): string {
  if (record.decorative === true) return '';
  const alt = record.alt?.trim();
  if (alt !== undefined && alt !== '') return alt;
  return record.caption?.trim() ?? '';
}

/** The pictures on each of `nodeIds`, read once from the manifest's registry. */
export function timelinePicturesOf(state: Pick<ProjectState, 'manifest'>, nodeIds: Iterable<string>): TimelinePictures {
  const records = new Map<string, ReadAssetRecord>((state.manifest.assets ?? []).map((record) => [record.id, record]));
  const links = (state.manifest.assetLinks ?? []) as readonly ReadAssetLink[];
  const byNode = new Map<string, readonly TimelineScenePicture[]>();
  let unrecorded = 0;
  for (const nodeId of nodeIds) {
    if (byNode.has(nodeId)) continue;
    const own = linksOf(links, { kind: 'node', nodeId }).filter((link) => link.role === 'card' || link.role === 'reference');
    const ordered = [...own.filter((link) => link.role === 'card'), ...own.filter((link) => link.role !== 'card')];
    const pictures: TimelineScenePicture[] = [];
    for (const link of ordered) {
      const record = records.get(link.assetId);
      if (record === undefined) {
        unrecorded += 1;
        continue;
      }
      pictures.push({ assetId: record.id, file: record.file, alt: altOf(record) });
    }
    byNode.set(nodeId, pictures);
  }
  return { of: (nodeId) => byNode.get(nodeId) ?? [], unrecorded };
}

/** The long edge, in pixels, a PDF thumbnail is made at: a bar's picture is a dozen points wide, so this is generous and stays small. */
export const THUMBNAIL_MAX_PX = 64;

const THUMBNAIL_SPEC: FigureTargetSpec = {
  maxEdge: THUMBNAIL_MAX_PX,
  jpegQuality: 0.8,
  // The PDF carries alpha as a soft mask, so a picture needs no converting just to be flattened.
  flattenAlpha: false,
  stripMetadata: true,
  keepWebp: false,
};

/** What the PDF can draw for one picture: PNG or JPEG bytes, or the reason there are none. */
export type Thumbnail =
  | { readonly ok: true; readonly mime: 'image/png' | 'image/jpeg'; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string };

export interface ThumbnailHost {
  /** The stored bytes of a file under `assets/`, or `null` when the store does not hold it. A rejection reads as `null` with its message. */
  readonly readAsset: (path: string) => Promise<Uint8Array | null>;
  /** The host's converter. Without it a picture larger than the thumbnail cannot be shrunk, and is left out rather than embedded whole. */
  readonly process?: ProcessPicture | undefined;
}

/**
 * One picture as a thumbnail: the stored bytes under the thumbnail profile (a long edge of {@link THUMBNAIL_MAX_PX}, stripped of private
 * metadata, a WebP converted), by the same plan the prose figures follow. A picture that is gone, that is not a PNG,
 * JPEG or WebP, or that this host cannot shrink gives a reason instead, and the bar shows an empty frame for it.
 */
export async function prepareThumbnail(picture: TimelineScenePicture, host: ThumbnailHost): Promise<Thumbnail> {
  let bytes: Uint8Array | null;
  try {
    bytes = await host.readAsset(`assets/${picture.file}`);
  } catch (error) {
    return { ok: false, reason: `${picture.file} could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if (bytes === null) return { ok: false, reason: `${picture.file} is not in assets/` };
  const sniffed = sniffPicture(bytes);
  if (!sniffed.ok) return { ok: false, reason: `${picture.file} is not a PNG, JPEG or WebP picture` };
  const profile = profileForSource(sniffed.mime, bytes, THUMBNAIL_SPEC);
  try {
    const plan = planPicture(bytes, profile);
    let out: PictureBytes;
    if (plan.kind === 'passthrough') {
      out = finishPassthrough(bytes, plan, profile);
    } else if (host.process === undefined) {
      return { ok: false, reason: `${picture.file} needs shrinking to a thumbnail, which this compile cannot do` };
    } else {
      out = await host.process({ bytes, mime: sniffed.mime, width: plan.source.width, height: plan.source.height }, profile);
    }
    if (out.mime !== 'image/png' && out.mime !== 'image/jpeg') return { ok: false, reason: `${picture.file} could not be made into a PNG or JPEG thumbnail` };
    return { ok: true, mime: out.mime, bytes: out.bytes };
  } catch (error) {
    if (error instanceof PictureRefusal) return { ok: false, reason: `${picture.file} could not be prepared (${error.message})` };
    throw error;
  }
}
