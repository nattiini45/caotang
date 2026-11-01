/**
 * The project's pictures as a Node host reads them — [pictures.md §6.1, §6.4.1, §8.2](../../../docs/architecture/pictures.md).
 *
 * Two reads, both pure over the session's state and its folder, and neither one writes or logs a row:
 *
 * - the registry: `pictureRegistryOf` lists the records and their links, and `pictureListOf` narrows that by a target or a tag and
 *   adds what uses each picture, so the MCP resource `caotang://assets`, the `pictures.list` tool and the app's board all read
 *   the manifest's `assets[]` and `assetLinks[]` through one set of shapes;
 * - one file: `readPictureFile` returns the bytes of a picture by its asset id, and only from the project's own `assets/` folder.
 *
 * **A file is named by its id and its record's type, never by a path the caller or the manifest supplies.** The id must match the
 * asset-id shape (so `..`, a separator or a drive letter cannot be an id), the record must exist, and the file name is built from
 * the id and the record's MIME. A record whose stored `file` does not say exactly that is refused as damaged, and never read.
 * The folder port refuses a path that leaves the folder, or leads out through a link, on top of that.
 *
 * The bytes are checked before they are returned: no larger than the bound the host passes (the record's own size is checked
 * first, so a refused picture is never read), and a file whose leading bytes do not name the record's type is refused rather than
 * served under a type it is not. This is a Node host: it cannot decode or resize a picture (pictures.md §6.4.1), so a picture over
 * the bound is refused with its size, never shrunk.
 */

import {
  ASSETS_DIR,
  collectUses,
  isAssetId,
  linksOf,
  parseAssetFileName,
  readPictureHeader,
  sniffPicture,
  type AssetLink,
  type PictureMime,
  type PictureUse,
  type ReadAssetLink,
  type ReadAssetRecord,
} from '@caotang/pictures';
import { ArtifactNotFoundError, usesSnapshotOfState, type ArtifactFs, type ProjectState } from '@caotang/store';

import { ArtifactPathError } from './node-fs.js';

/** Why a picture could not be read, as a code a host can act on. */
export type PictureReadCode =
  /** The id is not an asset id (`a_` and ten characters), so no file is looked up. */
  | 'bad-id'
  /** The project holds no record with this id. */
  | 'unknown-picture'
  /** The target of a list is neither `project` nor a node of the project. */
  | 'unknown-target'
  /** The record names a file other than the one its id and type give, or a path outside `assets/`. */
  | 'damaged-record'
  /** The record is there and the file is not. */
  | 'missing-file'
  /** The file's bytes are not the type the record says, or not a PNG, JPEG or WebP at all. */
  | 'wrong-type'
  /** The picture is larger than the bound the caller gave. */
  | 'too-large';

/** A refusal to read a picture. The message is whole sentences and ends with what the caller can do next. */
export class PictureReadError extends Error {
  constructor(
    readonly code: PictureReadCode,
    message: string,
    readonly assetId: string,
    /** For `too-large`: the picture's size and the bound it was held to, in bytes. */
    readonly detail?: { readonly bytes: number; readonly limit: number },
  ) {
    super(message);
    this.name = 'PictureReadError';
  }
}

/** One record as a host reads it: the fields a caller can use. The stored file name and the content hash are internal, and absent. */
export type PictureSummary = Pick<ReadAssetRecord, 'id' | 'mime' | 'bytes' | 'createdAt'> &
  Partial<Pick<ReadAssetRecord, 'width' | 'height' | 'caption' | 'alt' | 'decorative' | 'tags' | 'source' | 'transcription' | 'workingCopy' | 'updatedAt'>>;

const OPTIONAL_FIELDS = ['width', 'height', 'caption', 'alt', 'decorative', 'tags', 'source', 'transcription', 'workingCopy', 'updatedAt'] as const;

/** A record's readable fields, in the spec's order. A field a newer build added is left out, as it is for any caller that does not know it. */
export function pictureSummaryOf(record: ReadAssetRecord): PictureSummary {
  const summary: PictureSummary = { id: record.id, mime: record.mime, bytes: record.bytes, createdAt: record.createdAt };
  const into = summary as Record<string, unknown>;
  for (const field of OPTIONAL_FIELDS) if (record[field] !== undefined) into[field] = record[field];
  return summary;
}

/** Where a link places a picture. A paragraph link carries the quote it was pinned to instead of the whole anchor. */
export type LinkPlacement =
  | { readonly kind: 'project' }
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'paragraph'; readonly nodeId: string; readonly quote: string; readonly orphaned?: true; readonly moved?: true }
  | { readonly kind: string };

export interface LinkSummary {
  readonly id: string;
  readonly assetId: string;
  readonly role: string;
  readonly order: number;
  readonly target: LinkPlacement;
  readonly note?: string;
}

function placementOf(target: AssetLink['target'] | ReadAssetLink['target']): LinkPlacement {
  if (target.kind === 'project') return { kind: 'project' };
  if (target.kind === 'node' && typeof (target as { nodeId?: unknown }).nodeId === 'string') return { kind: 'node', nodeId: (target as { nodeId: string }).nodeId };
  if (target.kind === 'paragraph') {
    const paragraph = target as Extract<AssetLink['target'], { kind: 'paragraph' }>;
    const quote = typeof paragraph.anchor?.exact === 'string' ? paragraph.anchor.exact : '';
    return {
      kind: 'paragraph',
      nodeId: paragraph.nodeId,
      quote,
      ...(paragraph.orphaned === true ? { orphaned: true as const } : {}),
      ...(paragraph.moved === true ? { moved: true as const } : {}),
    };
  }
  return { kind: String(target.kind) };
}

export function linkSummaryOf(link: AssetLink | ReadAssetLink): LinkSummary {
  return {
    id: link.id,
    assetId: link.assetId,
    role: String(link.role),
    order: link.order,
    target: placementOf(link.target),
    ...(link.note === undefined ? {} : { note: link.note }),
  };
}

export interface PictureRegistry {
  readonly pictures: readonly PictureSummary[];
  readonly links: readonly LinkSummary[];
}

/** Every record and every link of the project as it is now, in the manifest's order. Read-only. */
export function pictureRegistryOf(state: ProjectState): PictureRegistry {
  return {
    pictures: (state.manifest.assets ?? []).map(pictureSummaryOf),
    links: (state.manifest.assetLinks ?? []).map(linkSummaryOf),
  };
}

export interface PictureListQuery {
  /** `project`, or the id of a node: only the pictures linked to it (a paragraph of the node counts). Absent is every picture. */
  readonly target?: string;
  /** Only the pictures carrying this tag, ignoring case. */
  readonly tag?: string;
}

/** What uses a picture, other than its links, which are listed beside it. */
export type PictureUseSummary = Exclude<PictureUse, { kind: 'link' }>;

export interface ListedPicture {
  readonly picture: PictureSummary;
  readonly links: readonly LinkSummary[];
  readonly uses: readonly PictureUseSummary[];
}

/** The registry's pictures narrowed by `query`, each with its links and uses, in the manifest's order. Read-only. */
export function pictureListOf(state: ProjectState, query: PictureListQuery = {}): ListedPicture[] {
  const records = state.manifest.assets ?? [];
  const links = state.manifest.assetLinks ?? [];
  let wanted: ReadonlySet<string> | undefined;
  if (query.target !== undefined) {
    const placement =
      query.target === 'project'
        ? ({ kind: 'project' } as const)
        : state.manifest.tree.some((node) => node.id === query.target)
          ? ({ kind: 'node', nodeId: query.target } as const)
          : undefined;
    if (placement === undefined) {
      throw new PictureReadError(
        'unknown-target',
        `"${query.target}" is neither "project" nor a node of this project, so no pictures are listed for it. Read the ids with binder.read_tree, or leave target out to list every picture.`,
        query.target,
      );
    }
    wanted = new Set(linksOf(links, placement, { includeParagraphs: true }).map((link) => link.assetId));
  }
  const tag = query.tag?.trim().toLowerCase();
  const uses = collectUses(usesSnapshotOfState(state));
  return records
    .filter((record) => (wanted === undefined || wanted.has(record.id)) && (tag === undefined || (record.tags ?? []).some((candidate) => candidate.toLowerCase() === tag)))
    .map((record) => ({
      picture: pictureSummaryOf(record),
      links: links.filter((link) => link.assetId === record.id).map(linkSummaryOf),
      uses: (uses.get(record.id) ?? []).filter((use): use is PictureUseSummary => use.kind !== 'link'),
    }));
}

export interface ReadPictureOptions {
  /** The most bytes the caller can carry; a picture over it is refused, never shrunk. */
  readonly maxBytes: number;
}

/** A picture's bytes with the record they belong to, and the display size read from the file's own header when it could be read. */
export interface PictureFile {
  readonly record: ReadAssetRecord;
  readonly mime: PictureMime;
  readonly bytes: Uint8Array;
  /** What the writer sees once the file's EXIF orientation is applied. Absent when the header could not be read. */
  readonly display?: { readonly width: number; readonly height: number };
}

function kib(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

/** The sentence a picture over a bound is refused with: its size, the bound, and that nothing here shrinks it. */
export function tooLargeMessage(label: string, bytes: number, limit: number): string {
  return (
    `${label} is ${kib(bytes)} (${bytes} bytes), over the ${kib(limit)} (${limit} bytes) this host can send in one message, so it was not sent. ` +
    'This host cannot shrink a picture. Open the project in the Caotang app and store a working copy of it, or import a copy at or below that size, then ask again.'
  );
}

/**
 * The bytes of one picture. Refuses, in order: an id that is not an asset id, an id the registry does not hold, a record whose
 * stored file is not the one its id and type name, a record or file larger than `options.maxBytes` (the record's size is checked
 * before the file is read), a file the folder does not hold, and a file whose bytes are not the record's type.
 */
export async function readPictureFile(fs: Pick<ArtifactFs, 'readBytes'>, state: ProjectState, assetId: string, options: ReadPictureOptions): Promise<PictureFile> {
  if (!isAssetId(assetId)) {
    throw new PictureReadError(
      'bad-id',
      `"${assetId}" is not a picture id, which is "a_" and ten characters. Read the ids with pictures.list or caotang://assets.`,
      assetId,
    );
  }
  const record = (state.manifest.assets ?? []).find((candidate) => candidate.id === assetId);
  if (record === undefined) {
    throw new PictureReadError('unknown-picture', `There is no picture ${assetId} in this project. Read the ids with pictures.list or caotang://assets.`, assetId);
  }
  const named = parseAssetFileName(record.file);
  if (named === undefined || named.assetId !== record.id || named.mime !== record.mime) {
    throw new PictureReadError(
      'damaged-record',
      `The record of picture ${assetId} does not name the file its id and type give, so no file was read. Open the project in the Caotang app to repair it.`,
      assetId,
    );
  }
  const label = `Picture ${assetId}`;
  if (record.bytes > options.maxBytes) {
    throw new PictureReadError('too-large', tooLargeMessage(label, record.bytes, options.maxBytes), assetId, { bytes: record.bytes, limit: options.maxBytes });
  }
  let bytes: Uint8Array;
  try {
    bytes = await fs.readBytes(`${ASSETS_DIR}/${record.file}`);
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) {
      throw new PictureReadError('missing-file', `The file of picture ${assetId} is not in the project's assets folder. Open the project in the Caotang app to re-link or remove it.`, assetId);
    }
    if (error instanceof ArtifactPathError) {
      throw new PictureReadError('damaged-record', `The file of picture ${assetId} resolves outside the project's assets folder, so it was not read.`, assetId);
    }
    throw error;
  }
  if (bytes.length > options.maxBytes) {
    throw new PictureReadError('too-large', tooLargeMessage(label, bytes.length, options.maxBytes), assetId, { bytes: bytes.length, limit: options.maxBytes });
  }
  const sniffed = sniffPicture(bytes);
  if (!sniffed.ok || sniffed.mime !== record.mime) {
    throw new PictureReadError(
      'wrong-type',
      `The file of picture ${assetId} is not the ${record.mime} the project records, so it was not sent. Open the project in the Caotang app to replace it.`,
      assetId,
    );
  }
  const header = readPictureHeader(bytes, record.mime);
  return {
    record,
    mime: record.mime,
    bytes,
    ...(header.ok ? { display: { width: header.displayWidth, height: header.displayHeight } } : {}),
  };
}
