/**
 * The picture import engine — [pictures.md §6.4](docs/architecture/pictures.md). One pipeline, three callers: `asset.import(Batch)`,
 * `project.importAsset` and `shot.importImage(s)`.
 *
 * An import runs in three steps, and the callers need the seams between them:
 *
 * 1. `planPictureImport` reserves the staged bytes, checks every picture and writes nothing. It sniffs, applies the size rules, removes
 *    private metadata (GPS, maker notes, serial numbers, XMP, IPTC), hashes **the bytes as they will be stored**, and decides for each
 *    picture whether it is new, the same bytes as a record (reuse), or the same bytes as a file an undone import left behind (adopt).
 *    Anything wrong refuses the whole batch here.
 * 2. `plan.writeFiles` writes the files the plan needs. A failed write releases the reservation, so the writer's pictures are still staged
 *    and a retry does not ask for them again. A cancel released the same way, before the next file.
 * 3. `publishPlan`, after the caller's own steps, adds the records and the placements to the manifest in one synchronous step and commits
 *    the reservation. Nothing is published unless every file is in place, so a failing second picture never leaves a partial registry.
 *
 * The file is written before the record names it, and the record is published only with the caller's own change (a shot's `image`, the
 * cover), so a crash in between leaves an unrecorded file that the next import adopts, never a record with no bytes.
 */

import { ApplyRefusal } from '@caotang/bus';
import {
  assetFileName,
  decideDedup,
  decideImportSize,
  extensionOfMime,
  mintAssetId,
  parseAssetFileName,
  PICTURE_MAX_BYTES,
  placeLink,
  readPictureHeader,
  sha256Hex,
  sniffPicture,
  stripPrivateMetadata,
  validateAssetRecord,
  workingCopySize,
  WORKING_COPY_LONG_EDGE,
  type AssetLink,
  type AssetSource,
  type AssetTarget,
  type DedupRecord,
  type PictureExtension,
  type PictureMime,
  type ReadAssetLink,
  type ReadAssetRecord,
  type UnrecordedFile,
} from '@caotang/pictures';

import { StagingError, isRetryable, type AssetReservation, type AssetStaging } from './asset-staging.js';
import type { ProjectAssetPort } from './commands-project.js';
import { linksOf, recordsOf, replaceList, undoList, type ListUndo } from './picture-registry.js';
import type { ProjectState } from './state.js';

export type LargePhotoChoice = 'keep-originals' | 'working-copies';

/** One staged picture and what to record about it. */
export interface PictureRequest {
  readonly stagingId: string;
  /** How a refusal names this picture: `the image for "Shot 2"`. Absent, the wording's own default. */
  readonly label?: string;
  readonly links?: readonly AssetTarget[];
  readonly caption?: string;
  readonly alt?: string;
  readonly source?: AssetSource;
}

/** The words of the three refusals a caller may already have promised its writers (the cover and the shot's image). */
export interface ImportWording {
  missing(label: string | undefined): string;
  tooBig(label: string | undefined, bytes: number): string;
  notPicture(label: string | undefined, reason: string): string;
}

const megabytes = (bytes: number): number => Math.round(bytes / (1024 * 1024));

export const PICTURE_WORDING: ImportWording = {
  missing: (label) => `${label ?? 'the picture'} is no longer held, so nothing was imported`,
  tooBig: (label, bytes) => `${label ?? 'the picture'} is ${megabytes(bytes)} MB, which is over the 16 MB a picture may be`,
  notPicture: (label, reason) => `${label ?? 'the file'}: ${reason}`,
};

export interface ImportOptions {
  /**
   * `strict` is `asset.import`: the header must read (the pixel budget is checked on it), and a file whose metadata cannot be walked is refused.
   * `legacy` is the cover and the shot's image, which never read a header and are given a record without a size when they cannot; a file whose
   * header reads but whose metadata cannot be walked is still refused, because that is a real picture that may carry a location.
   */
  readonly mode: 'strict' | 'legacy';
  readonly wording?: ImportWording;
  /** `all`: match records, files and earlier pictures of the batch. `existing`: not earlier pictures of the batch. `none`: always a new file. */
  readonly dedup?: 'all' | 'existing' | 'none';
  readonly largePhotos?: LargePhotoChoice | undefined;
  readonly now: Date;
  /** Random bytes for the ids, so a test can pin them. */
  readonly randomBytes?: ((length: number) => Uint8Array) | undefined;
}

export interface PlannedPicture {
  readonly request: PictureRequest;
  /** The bytes as they will be stored: metadata removed, a working copy when the writer chose one. */
  readonly bytes: Uint8Array;
  readonly mime: PictureMime;
  readonly extension: PictureExtension;
  readonly sha256: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly workingCopy?: { fromBytes: number; fromWidth: number; fromHeight: number } | undefined;
  readonly action: 'new' | 'reuse' | 'adopt';
  readonly assetId: string;
  readonly file: string;
  readonly path: string;
  /** Whether the file has to be written: a new picture, or a record's own file that is missing. */
  readonly write: boolean;
}

/** A write that failed, after `written` files were written by this plan. The reservation is already released. */
export class PictureWriteError extends Error {
  readonly index: number;
  readonly written: number;
  readonly path: string;
  readonly quota: boolean;
  constructor(index: number, written: number, path: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'PictureWriteError';
    this.index = index;
    this.written = written;
    this.path = path;
    this.quota = cause instanceof Error && (cause.name === 'QuotaExceededError' || /quota/i.test(cause.message));
  }
}

export interface ImportPlan {
  readonly items: readonly PlannedPicture[];
  /** Whether the writer cancelled one of the pictures. */
  cancelled(): boolean;
  /** Writes the files the plan needs, one at a time. Releases the reservation and throws on a failed write or a cancel. */
  writeFiles(): Promise<void>;
  /** The staged pictures go back to the staged set, as if the command had not run. Safe to call twice. */
  release(): void;
  /** The pictures are imported: the staged bytes are forgotten. */
  commit(): void;
}

const refuse = (code: ApplyRefusal['error']['code'], message: string, target: string, correctiveHint: string, details?: Record<string, unknown>): ApplyRefusal =>
  new ApplyRefusal({ code, message, target, correctiveHint, ...(details === undefined ? {} : { details }) });

/** The wording is the caller's for the refusals it promised; everything else is this engine's. */
function pictureLabel(request: PictureRequest, position: number, total: number): string | undefined {
  return request.label ?? (total > 1 ? `picture ${position + 1}` : undefined);
}

/** A reservation, whatever the host's staging can do: a host with only `take` hands the bytes over for good, as it always did. */
function reserveBytes(staging: AssetStaging, ids: readonly string[], scope: string): { reservation: AssetReservation; release(): void; commit(): void } {
  if (isRetryable(staging)) {
    const reservation = staging.reserve(ids, scope);
    return { reservation, release: () => staging.release(reservation.id), commit: () => staging.commit(reservation.id) };
  }
  const items: { stagingId: string; bytes: Uint8Array }[] = [];
  for (const id of ids) {
    const bytes = staging.take(id);
    if (bytes === undefined) throw new StagingError('unknown', id);
    items.push({ stagingId: id, bytes });
  }
  return { reservation: { id: 'taken', items, isCancelled: () => false }, release: () => undefined, commit: () => undefined };
}

interface Pending {
  readonly request: PictureRequest;
  readonly label: string | undefined;
  readonly bytes: Uint8Array;
  readonly mime: PictureMime;
  readonly extension: PictureExtension;
  /** The display size: what the writer sees once the orientation is applied. */
  readonly width?: number;
  readonly height?: number;
  /** The size as stored, which is what a resize starts from. */
  readonly fromHeader?: { width: number; height: number };
  readonly ask: readonly ('pixels' | 'bytes')[];
}

const describeAsk = (ask: readonly ('pixels' | 'bytes')[]): string => (ask.includes('pixels') ? 'many pixels' : 'many bytes');

export async function planPictureImport(
  state: ProjectState,
  port: ProjectAssetPort,
  requests: readonly PictureRequest[],
  options: ImportOptions,
): Promise<ImportPlan> {
  const wording = options.wording ?? PICTURE_WORDING;
  const scope = state.manifest.project.id;

  let held: ReturnType<typeof reserveBytes>;
  try {
    held = reserveBytes(port.staging, requests.map((request) => request.stagingId), scope);
  } catch (failure) {
    if (!(failure instanceof StagingError)) throw failure;
    const position = requests.findIndex((request) => request.stagingId === failure.stagingId);
    const request = requests[Math.max(position, 0)];
    const label = request === undefined ? undefined : pictureLabel(request, Math.max(position, 0), requests.length);
    throw refuse(
      'not-found',
      failure.reason === 'unknown'
        ? wording.missing(label)
        : failure.reason === 'reserved'
          ? `${label ?? 'the picture'} is already being imported, so nothing was imported`
          : `${label ?? 'the picture'} was staged for another project, so nothing was imported`,
      'stagingId',
      'choose the image again',
    );
  }

  let finished = false;
  const release = (): void => {
    if (finished) return;
    finished = true;
    held.release();
  };
  const commit = (): void => {
    if (finished) return;
    finished = true;
    held.commit();
  };

  try {
    const items = await prepare(state, port, held.reservation, requests, options, wording);
    return {
      items,
      cancelled: () => held.reservation.isCancelled(),
      release,
      commit,
      async writeFiles() {
        let written = 0;
        for (const [index, item] of items.entries()) {
          if (!item.write) continue;
          if (held.reservation.isCancelled()) {
            release();
            throw refuse('internal', `the import was cancelled${written === 0 ? ', so nothing was saved' : `, after ${written === 1 ? '1 file was' : `${written} files were`} saved that no picture names`}`, 'stagingId', 'choose the pictures again when you are ready');
          }
          try {
            await port.writeBytes(item.path, item.bytes);
          } catch (cause) {
            release();
            throw new PictureWriteError(index, written, item.path, cause);
          }
          written += 1;
        }
        if (held.reservation.isCancelled()) {
          release();
          throw refuse('internal', `the import was cancelled${written === 0 ? ', so nothing was saved' : `, after ${written === 1 ? '1 file was' : `${written} files were`} saved that no picture names`}`, 'stagingId', 'choose the pictures again when you are ready');
        }
      },
    };
  } catch (failure) {
    release();
    throw failure;
  }
}

async function prepare(
  state: ProjectState,
  port: ProjectAssetPort,
  reservation: AssetReservation,
  requests: readonly PictureRequest[],
  options: ImportOptions,
  wording: ImportWording,
): Promise<PlannedPicture[]> {
  const strict = options.mode === 'strict';
  const total = requests.length;

  // Every picture is read before anything is decided, so one refusal names the picture and writes nothing for any.
  const pending: Pending[] = [];
  for (const [position, request] of requests.entries()) {
    const label = pictureLabel(request, position, total);
    const staged = reservation.items.find((item) => item.stagingId === request.stagingId);
    if (staged === undefined) throw refuse('not-found', wording.missing(label), 'stagingId', 'choose the image again');
    let bytes = staged.bytes;

    if (!strict) {
      if (bytes.length > PICTURE_MAX_BYTES) throw refuse('limit-exceeded', wording.tooBig(label, bytes.length), 'stagingId', 'use a smaller image of the same picture');
    } else {
      const bySize = decideImportSize({ bytes: bytes.length });
      if (bySize.action === 'refuse') throw refuse('limit-exceeded', `${label === undefined ? '' : `${label}: `}${bySize.message}`, 'stagingId', 'use a smaller image of the same picture');
    }

    const sniffed = sniffPicture(bytes);
    if (!sniffed.ok) throw refuse('invalid-params', wording.notPicture(label, sniffed.reason), 'stagingId', 'choose a PNG, JPEG or WebP file');

    const header = readPictureHeader(bytes, sniffed.mime);
    if (strict && !header.ok) throw refuse('invalid-params', `${label === undefined ? '' : `${label}: `}${header.reason}`, 'stagingId', 'choose a different file, or export the picture again');
    let ask: readonly ('pixels' | 'bytes')[] = [];
    if (strict && header.ok) {
      const bySize = decideImportSize({ bytes: bytes.length, width: header.width, height: header.height });
      if (bySize.action === 'refuse') throw refuse('limit-exceeded', `${label === undefined ? '' : `${label}: `}${bySize.message}`, 'stagingId', 'export the picture smaller and choose it again');
      if (bySize.action === 'ask') ask = bySize.because;
    }

    // Private metadata goes before the bytes are hashed, so two copies that differ only in a location match.
    const stripped = stripPrivateMetadata(bytes, sniffed.mime);
    if (!stripped.ok) {
      if (strict || header.ok) throw refuse('invalid-params', `${label === undefined ? 'the picture' : label}: ${stripped.message}`, 'stagingId', 'export the picture again from the app that made it, then choose it');
    } else {
      bytes = stripped.bytes;
    }

    pending.push({
      request,
      label,
      bytes,
      mime: sniffed.mime,
      extension: sniffed.extension,
      ...(header.ok ? { width: header.displayWidth, height: header.displayHeight, fromHeader: { width: header.width, height: header.height } } : {}),
      ask,
    });
  }

  const asking = pending.filter((entry) => entry.ask.length > 0);
  let workingCopies = false;
  if (asking.length > 0) {
    if (options.largePhotos === undefined) {
      throw refuse(
        'invalid-params',
        `${asking.length === 1 ? 'one picture has' : `${asking.length} pictures have`} ${describeAsk(asking[0]?.ask ?? [])} (over 24 megapixels or 8 MB), so nothing was imported until you choose how to keep ${asking.length === 1 ? 'it' : 'them'}`,
        'largePhotos',
        'ask the writer once, then send largePhotos as keep-originals or working-copies',
        { largePhotoPrompt: true, items: asking.map((entry) => pending.indexOf(entry)), because: [...new Set(asking.flatMap((entry) => entry.ask))] },
      );
    }
    workingCopies = options.largePhotos === 'working-copies';
    if (workingCopies && port.process === undefined) {
      throw refuse(
        'invalid-params',
        'this host cannot make 4096 px working copies, so nothing was imported',
        'largePhotos',
        'keep the originals, or open the project in the app to make working copies',
      );
    }
  }

  const planned: PlannedPicture[] = [];
  const dedup = options.dedup ?? 'all';
  const records = recordsOf(state);
  const listing = dedup === 'none' ? undefined : await port.list?.();
  const listed = new Set(listing?.files ?? []);
  const authoritative = listing?.authoritative === true;
  const taken = new Set<string>([...records.map((record) => record.id)]);
  for (const name of listed) {
    const parsed = parseAssetFileName(name);
    if (parsed !== undefined) taken.add(parsed.assetId);
  }
  const recordsForDedup: DedupRecord[] = records.map((record) => ({
    id: record.id,
    sha256: record.sha256,
    ...(authoritative && !listed.has(record.file) ? { missing: true } : {}),
  }));
  let unrecorded: UnrecordedFile[] | undefined;
  const findUnrecorded = async (): Promise<UnrecordedFile[]> => {
    if (unrecorded !== undefined) return unrecorded;
    unrecorded = [];
    if (!authoritative || port.readBytes === undefined) return unrecorded;
    const recorded = new Set(records.map((record) => record.id));
    for (const name of [...listed].sort()) {
      const parsed = parseAssetFileName(name);
      if (parsed === undefined || recorded.has(parsed.assetId)) continue;
      const bytes = await port.readBytes(`assets/${name}`);
      if (bytes !== undefined && bytes !== null) unrecorded.push({ assetId: parsed.assetId, file: name, sha256: await sha256Hex(bytes) });
    }
    return unrecorded;
  };

  for (const entry of pending) {
    if (reservation.isCancelled()) {
      throw refuse('internal', 'the import was cancelled, so nothing was saved', 'stagingId', 'choose the pictures again when you are ready');
    }
    let bytes = entry.bytes;
    let width = entry.width;
    let height = entry.height;
    let workingCopy: PlannedPicture['workingCopy'];
    if (workingCopies && entry.ask.length > 0 && port.process !== undefined && entry.fromHeader !== undefined) {
      const fromWidth = entry.width ?? entry.fromHeader.width;
      const fromHeight = entry.height ?? entry.fromHeader.height;
      const target = workingCopySize(entry.fromHeader.width, entry.fromHeader.height);
      const output = await port.process(
        { bytes, mime: entry.mime, width: entry.fromHeader.width, height: entry.fromHeader.height },
        { maxEdge: WORKING_COPY_LONG_EDGE, output: 'preserve', jpegQuality: 0.9, flattenAlpha: false, stripMetadata: true },
      );
      const again = sniffPicture(output.bytes);
      const outHeader = again.ok ? readPictureHeader(output.bytes, again.mime) : undefined;
      if (!again.ok || again.mime !== entry.mime || outHeader === undefined || !outHeader.ok) {
        throw refuse('invalid-params', `${entry.label ?? 'the picture'} could not be made into a working copy, so nothing was imported`, 'largePhotos', 'keep the originals instead');
      }
      const cleaned = stripPrivateMetadata(output.bytes, again.mime);
      bytes = cleaned.ok ? cleaned.bytes : output.bytes;
      width = outHeader.displayWidth;
      height = outHeader.displayHeight;
      if (Math.max(outHeader.width, outHeader.height) > Math.max(target.width, target.height)) {
        throw refuse('invalid-params', `${entry.label ?? 'the picture'} came back larger than a working copy, so nothing was imported`, 'largePhotos', 'keep the originals instead');
      }
      workingCopy = { fromBytes: entry.bytes.length, fromWidth, fromHeight };
    }

    const sha256 = await sha256Hex(bytes);
    const decision =
      dedup === 'none'
        ? ({ action: 'new' } as const)
        : decideDedup(sha256, recordsForDedup, { authoritative, files: await findUnrecorded() });

    let assetId: string;
    let action: PlannedPicture['action'];
    let write: boolean;
    let file: string;
    if (decision.action === 'reuse') {
      assetId = decision.assetId;
      action = 'reuse';
      write = decision.restoreBytes;
      file = records.find((record) => record.id === assetId)?.file ?? assetFileName(assetId, entry.mime);
    } else if (decision.action === 'adopt') {
      assetId = decision.assetId;
      action = 'adopt';
      write = false;
      file = decision.file;
    } else {
      assetId = mintAssetId(taken, options.randomBytes);
      action = 'new';
      write = true;
      file = `${assetId}.${extensionOfMime(entry.mime)}`;
    }
    taken.add(assetId);
    const extension = (parseAssetFileName(file)?.extension ?? entry.extension) as PictureExtension;
    const stored: PlannedPicture = {
      request: entry.request,
      bytes,
      mime: parseAssetFileName(file)?.mime ?? entry.mime,
      extension,
      sha256,
      width,
      height,
      workingCopy,
      action,
      assetId,
      file,
      path: `assets/${file}`,
      write,
    };
    planned.push(stored);
    // Within one batch, a later picture with the same bytes reuses the earlier one: no second file, and the same id.
    if (dedup === 'all' && action !== 'reuse') recordsForDedup.push({ id: assetId, sha256 });
  }
  return planned;
}

/** What `publishPlan` changed, and everything an undo of it needs. */
export interface PublishedImport {
  readonly items: readonly { readonly assetId: string; readonly path: string; readonly created: boolean }[];
  /** The records this import added (a reused picture adds none). */
  readonly createdRecordIds: readonly string[];
  /** The placements this import made. */
  readonly links: readonly AssetLink[];
  readonly undo: readonly ListUndo[];
}

const nodeExists = (state: ProjectState, nodeId: string): boolean => state.manifest.tree.some((node) => node.id === nodeId);

/** The links of a request that name a binder item the project no longer has, which the caller refuses before it writes. */
export function missingTargets(state: ProjectState, links: readonly AssetTarget[] | undefined): AssetTarget[] {
  return (links ?? []).filter((target) => target.kind !== 'project' && !nodeExists(state, target.nodeId));
}

/**
 * Adds the records and the placements. Synchronous: it is the last thing an import does after its last `await`, and it cannot fail for
 * a reason `planPictureImport` could have caught. A placement whose binder item is gone is skipped, not invented.
 */
export function publishPlan(state: ProjectState, plan: ImportPlan, now: Date, options: { readonly links?: boolean } = {}): PublishedImport {
  const stamp = now.toISOString();
  let records: ReadAssetRecord[] = [...recordsOf(state)];
  const created: string[] = [];
  const made: AssetLink[] = [];
  let links: (AssetLink | ReadAssetLink)[] = [...linksOf(state)];
  const touchedLinks = new Set<string>();
  const items: { assetId: string; path: string; created: boolean }[] = [];

  for (const item of plan.items) {
    const exists = records.some((record) => record.id === item.assetId);
    if (!exists) {
      const record: ReadAssetRecord = {
        id: item.assetId,
        file: item.file,
        mime: item.mime,
        sha256: item.sha256,
        bytes: item.bytes.length,
        ...(item.width === undefined || item.height === undefined ? {} : { width: item.width, height: item.height }),
        ...(item.request.caption === undefined ? {} : { caption: item.request.caption }),
        ...(item.request.alt === undefined ? {} : { alt: item.request.alt }),
        source: item.request.source ?? { kind: 'import' },
        ...(item.workingCopy === undefined ? {} : { workingCopy: item.workingCopy }),
        createdAt: stamp,
      };
      const checked = validateAssetRecord(record);
      if (!checked.ok) throw new Error(`the picture record for ${item.assetId} is not valid: ${checked.issues.map((issue) => issue.message).join('; ')}`);
      records = [...records, record];
      created.push(item.assetId);
    }
    items.push({ assetId: item.assetId, path: item.path, created: !exists });

    if (options.links === false) continue;
    for (const target of item.request.links ?? []) {
      if (target.kind !== 'project' && !nodeExists(state, target.nodeId)) continue;
      const placed = placeLink(links, { assetId: item.assetId, target, role: 'reference' });
      if (!placed.ok) continue;
      links = placed.value.links;
      made.push(placed.value.link);
      for (const change of placed.value.changes) touchedLinks.add(change.linkId);
    }
  }

  const undo: ListUndo[] = [];
  if (created.length > 0) undo.push(replaceList(state, 'assets', records, created));
  if (made.length > 0) undo.push(replaceList(state, 'assetLinks', links, touchedLinks));
  plan.commit();
  return { items, createdRecordIds: created, links: made, undo };
}

/** Takes back what `publishPlan` published: the records and placements it made, and nothing it did not. */
export function undoPublished(state: ProjectState, published: PublishedImport): void {
  for (const undo of [...published.undo].reverse()) undoList(state, undo);
}
