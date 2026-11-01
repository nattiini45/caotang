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
  extensionOfMime,
  mintAssetId,
  parseAssetFileName,
  placeLink,
  readOrientation,
  recordOrientation,
  sha256Hex,
  validateAssetRecord,
  type AssetLink,
  type AssetSource,
  type AssetTarget,
  type DedupRecord,
  type PictureExtension,
  type PictureMime,
  type PrepareRefusal,
  type ReadAssetLink,
  type ReadAssetRecord,
  type UnrecordedFile,
} from '@caotang/pictures';

import { StagingError, isRetryable, type AssetReservation, type AssetStaging } from './asset-staging.js';
import type { ProjectAssetPort } from './commands-project.js';
import { linksOf, recordsOf, replaceList, undoList, type ListUndo } from './picture-registry.js';
import type { ProjectState } from './state.js';

/** The batch's one answer for large photos (D6). `keep` and `keep-originals` both keep the originals; absent keeps them too. */
export type LargePhotoChoice = 'keep' | 'keep-originals' | 'working-copies';

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

/**
 * The words of the refusal a caller may already have promised its writers when the staged bytes are gone (the cover and the shot's
 * image). Every other refusal is the import pipeline's own (`@caotang/pictures/prepare`), naming the picture by its label.
 */
export interface ImportWording {
  missing(label: string | undefined): string;
}

export const PICTURE_WORDING: ImportWording = {
  missing: (label) => `${label ?? 'the picture'} is no longer held, so nothing was imported`,
};

export interface ImportOptions {
  /**
   * `strict` is `asset.import`, `legacy` the cover and the shot's image. Both run the same pipeline (pictures.md §6.4); the mode names the
   * caller for the refusals' wording, and a picture is never treated differently by it.
   */
  readonly mode: 'strict' | 'legacy';
  readonly wording?: ImportWording;
  /** What a refusal calls a single picture with no label: "the picture" for `asset.import`, "the image" for the cover and a shot. */
  readonly what?: string;
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
  /** What the metadata strip took out (`location`, `maker notes`, …); empty when there was nothing to take. */
  readonly stripped: readonly string[];
  /** The picture arrived as HEIC and was converted to JPEG. */
  readonly convertedFromHeic?: true;
  readonly mime: PictureMime;
  readonly extension: PictureExtension;
  readonly sha256: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** The EXIF Orientation the stored bytes carry, 2–8; absent is upright. A layout turns width and height by it (displaySizeOf). */
  readonly orientation?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | undefined;
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
  /** The host's port the plan writes through; an undo of what it published remembers its records there (`undoPublished`). */
  readonly port: ProjectAssetPort;
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
  readonly sha256: string;
  /** The size the header states (the stored size; an Orientation that turns the picture does not swap it). */
  readonly width?: number;
  readonly height?: number;
  readonly orientation?: 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly stripped: readonly string[];
  readonly workingCopy?: { fromBytes: number; fromWidth: number; fromHeight: number };
  readonly convertedFromHeic?: true;
}

/** A pipeline refusal as the command's refusal: too large is over a limit, anything else is not a picture this import takes. */
function refusalOf(refusal: PrepareRefusal): ApplyRefusal {
  const code = refusal.code === 'too-large' || refusal.code === 'too-many-pixels' ? 'limit-exceeded' : 'invalid-params';
  return new ApplyRefusal({ code, message: refusal.message, target: 'stagingId', correctiveHint: refusal.hint });
}

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
      port,
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
  const total = requests.length;
  const keepOriginals = options.largePhotos !== 'working-copies';

  // Every picture runs the import pipeline (pictures.md §6.4) before anything is decided, so one refusal names the picture and writes
  // nothing for any: the sniff, HEIC through the host's decoder, the pixel budget and the batch's working-copy answer, the lossless strip
  // that keeps Orientation, and the hash of the bytes as they will be stored. It loads on the first import, so the first paint does not
  // carry it.
  const { preparePicture } = await import('@caotang/pictures/prepare');
  const pending: Pending[] = [];
  for (const [position, request] of requests.entries()) {
    const label = pictureLabel(request, position, total);
    const staged = reservation.items.find((item) => item.stagingId === request.stagingId);
    if (staged === undefined) throw refuse('not-found', wording.missing(label), 'stagingId', 'choose the image again');
    const prepared = await preparePicture(staged.bytes, {
      ...(port.decoder === undefined ? {} : { decoder: port.decoder }),
      largePhotos: keepOriginals ? 'keep' : 'working-copies',
      what: label ?? options.what ?? (options.mode === 'strict' ? 'the picture' : 'the image'),
    });
    if (!prepared.ok) throw refusalOf(prepared.refusal);
    const picture = prepared.picture;
    pending.push({
      request,
      label,
      bytes: picture.bytes,
      mime: picture.mime,
      extension: picture.extension,
      sha256: picture.sha256,
      ...(picture.size === undefined ? {} : { width: picture.size.width, height: picture.size.height }),
      // The strip keeps Orientation (pictures.md §6.4 step 4), so it is read from the bytes as stored.
      ...(recordOrientation(readOrientation(picture.bytes, picture.mime)) === undefined ? {} : { orientation: recordOrientation(readOrientation(picture.bytes, picture.mime))! }),
      stripped: picture.stripped,
      ...(picture.workingCopy === undefined ? {} : { workingCopy: { ...picture.workingCopy } }),
      ...(picture.convertedFromHeic === true ? { convertedFromHeic: true as const } : {}),
    });
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
    const { bytes, width, height, orientation, workingCopy, sha256 } = entry;
    const decision =
      dedup === 'none'
        ? ({ action: 'new' } as const)
        : decideDedup(sha256, recordsForDedup, { authoritative, files: await findUnrecorded() });

    let assetId: string;
    let action: PlannedPicture['action'];
    let write: boolean;
    let file: string;
    const retired = decision.action === 'new' ? retiredOf(port).get(sha256) : undefined;
    if (decision.action === 'reuse') {
      assetId = decision.assetId;
      action = 'reuse';
      const earlier = planned.find((picture) => picture.assetId === assetId);
      file = earlier?.file ?? records.find((record) => record.id === assetId)?.file ?? assetFileName(assetId, entry.mime);
      // A host that cannot list says whether the record's file is held; a record whose file is gone has it written back (§6.2). An
      // earlier picture of this batch with the same bytes writes the one file, so a later one writes nothing (main's dedup).
      write = earlier === undefined && (decision.restoreBytes || (!authoritative && port.has !== undefined && !(await port.has(`assets/${file}`))));
    } else if (decision.action === 'adopt') {
      assetId = decision.assetId;
      action = 'adopt';
      write = false;
      file = decision.file;
    } else if (retired !== undefined && !taken.has(retired.id)) {
      // The same bytes as a record an undo took out in this session: the record comes back over the file it left, which is written
      // again only when it is gone. A host that lists its files finds that file as unrecorded instead (the `adopt` above).
      assetId = retired.id;
      action = 'adopt';
      file = retired.file;
      write = port.has === undefined ? false : !(await port.has(`assets/${file}`));
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
      orientation,
      workingCopy,
      stripped: entry.stripped,
      ...(entry.convertedFromHeic === true ? { convertedFromHeic: true as const } : {}),
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
  /** The records this import added, as added, and the port they were written through: an undo remembers them by hash. */
  readonly records: readonly ReadAssetRecord[];
  readonly port: ProjectAssetPort;
}

/** Records an undo took out in this session, by hash, per host port: the same bytes imported again re-create the record over its file. */
const retiredByPort = new WeakMap<ProjectAssetPort, Map<string, ReadAssetRecord>>();

function retiredOf(port: ProjectAssetPort): Map<string, ReadAssetRecord> {
  let retired = retiredByPort.get(port);
  if (retired === undefined) {
    retired = new Map();
    retiredByPort.set(port, retired);
  }
  return retired;
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
        ...(item.orientation === undefined ? {} : { orientation: item.orientation }),
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
  const added = records.filter((record) => created.includes(record.id));
  return { items, createdRecordIds: created, links: made, undo, records: added, port: plan.port };
}

/** Takes back what `publishPlan` published: the records and placements it made, and nothing it did not. */
export function undoPublished(state: ProjectState, published: PublishedImport): void {
  for (const undo of [...published.undo].reverse()) undoList(state, undo);
  for (const record of published.records) retiredOf(published.port).set(record.sha256, record);
}
