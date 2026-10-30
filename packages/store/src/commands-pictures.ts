/**
 * The picture registry's applies — [pictures.md](../../../docs/architecture/pictures.md) §2.4, §6.2, §6.4 — and the import every
 * picture command now runs on.
 *
 * `asset.import`, `asset.importBatch` and `asset.setMeta` are registered here. The cover import (`project.importAsset`) and the shot
 * imports (`shot.importImage`, `shot.importImages`) keep their names, params and undo, and are re-based on the same three steps:
 *
 *  1. **Take and prepare** (`preparedFromStaging`): the staged bytes are taken (single-use) and run through `@caotang/pictures`'
 *     pipeline: the sniff, HEIC through the host's decoder or a refusal with the remedy, the pixel budget and the batch's
 *     working-copy answer, the lossless GPS strip that keeps Orientation, and the SHA-256. A refusal here writes nothing.
 *  2. **Store** (`storePicture`): a hash equal to a record's returns that record's id and writes no file. A hash equal to a record an
 *     undo removed in this session re-creates that record over the file it left. Otherwise a new id is minted and the bytes are
 *     written through the host's port.
 *  3. **Commit** (`commitRecords`): after the last await, synchronously, the new records join `assets[]`.
 *
 * The undo of `asset.import` and `asset.importBatch` removes the records they made; the files stay, a harmless orphan (the sweep is
 * A6's). The cover and shot undos are unchanged: they put the reference back. Their record stays with the file, so the picture
 * stays in the project's pictures and a second import of it reuses the record.
 */

import { newId } from '@caotang/ids';
import {
  ApplyRefusal,
  pictureCommands,
  type ApplyContext,
  type AssetImportBatchParams,
  type AssetImportParams,
  type AssetImportSource,
  type AssetLargePhotos,
  type AssetMetaPatch,
  type AssetSetMetaParams,
  type Command,
  type CommandApply,
  type CommandRegistry,
} from '@caotang/bus';
import {
  ASSETS_DIR,
  mintAssetId,
  preparePicture,
  recordByHash,
  usedAssetIds,
  type AssetRecord,
  type PictureRefusal,
  type PreparedPicture,
} from '@caotang/pictures';

import type { ApplyClock, ProjectAssetPort } from './commands-project.js';
import type { ProjectState } from './state.js';

type PictureApply<P> = CommandApply<P, ProjectState>;

/** Records an undo took out in this session, by hash, so the same bytes imported again re-create the record over the file left behind. */
const retiredByPort = new WeakMap<ProjectAssetPort, Map<string, AssetRecord>>();

function retiredOf(port: ProjectAssetPort): Map<string, AssetRecord> {
  let retired = retiredByPort.get(port);
  if (retired === undefined) {
    retired = new Map();
    retiredByPort.set(port, retired);
  }
  return retired;
}

function refusalOf(refusal: PictureRefusal, target: string): ApplyRefusal {
  const code = refusal.code === 'too-large' || refusal.code === 'too-many-pixels' ? 'limit-exceeded' : 'invalid-params';
  return new ApplyRefusal({ code, message: refusal.message, target, correctiveHint: refusal.hint });
}

/**
 * Step 1: takes the staged bytes and runs the pipeline. Throws an `ApplyRefusal` that writes nothing: the bytes are no longer
 * held, or the pipeline refused them.
 */
export async function preparedFromStaging(
  assets: ProjectAssetPort,
  stagingId: string,
  options: { readonly what?: string; readonly largePhotos?: AssetLargePhotos; readonly target?: string } = {},
): Promise<PreparedPicture> {
  const bytes = assets.staging.take(stagingId);
  const target = options.target ?? 'stagingId';
  if (bytes === undefined) {
    throw new ApplyRefusal({
      code: 'not-found',
      message: `${options.what ?? 'the image'} is no longer held, so nothing was imported`,
      target,
      correctiveHint: 'choose the image again',
    });
  }
  const result = await preparePicture(bytes, {
    ...(assets.decoder === undefined ? {} : { decoder: assets.decoder }),
    ...(options.largePhotos === undefined ? {} : { largePhotos: options.largePhotos }),
    ...(options.what === undefined ? {} : { what: options.what }),
  });
  if (!result.ok) throw refusalOf(result.refusal, target);
  return result.picture;
}

/** What step 2 decided for one picture. `record` is set when the picture needs a record committed (a new one or a re-created one). */
export interface StoredPicture {
  readonly assetId: string;
  readonly path: string;
  /** The bytes matched a record already in the registry: nothing was written and no record is added. */
  readonly existing: boolean;
  /** A file was written by this import. */
  readonly written: boolean;
  readonly record?: AssetRecord;
}

/** The metadata a new record starts with. */
export interface PictureMeta {
  readonly caption?: string;
  readonly alt?: string;
  readonly source?: AssetImportSource;
}

function recordOf(assetId: string, prepared: PreparedPicture, meta: PictureMeta, clock: ApplyClock): AssetRecord {
  return {
    id: assetId,
    file: `${assetId}.${prepared.extension}`,
    mime: prepared.mime,
    sha256: prepared.sha256,
    bytes: prepared.bytes.length,
    ...(prepared.size === undefined ? {} : { width: prepared.size.width, height: prepared.size.height }),
    ...(meta.caption === undefined || meta.caption === '' ? {} : { caption: meta.caption }),
    ...(meta.alt === undefined || meta.alt === '' ? {} : { alt: meta.alt }),
    ...(meta.source === undefined ? {} : { source: { ...meta.source } }),
    ...(prepared.workingCopy === undefined ? {} : { workingCopy: { ...prepared.workingCopy } }),
    createdAt: new Date(clock.now()).toISOString(),
  };
}

/**
 * Step 2 for one picture: dedup by hash against the registry, the records this batch has already planned (`pending`) and the
 * records an undo retired in this session; otherwise mint an id and write the file. Throws whatever the port's write throws.
 */
export async function storePicture(
  state: ProjectState,
  assets: ProjectAssetPort,
  prepared: PreparedPicture,
  meta: PictureMeta,
  pending: readonly StoredPicture[],
  clock: ApplyClock,
): Promise<StoredPicture> {
  const recorded = recordByHash(state.manifest.assets, prepared.sha256);
  if (recorded !== undefined) return { assetId: recorded.id, path: `${ASSETS_DIR}/${recorded.file}`, existing: true, written: false };
  const planned = pending.find((stored) => stored.record?.sha256 === prepared.sha256);
  if (planned !== undefined) return { assetId: planned.assetId, path: planned.path, existing: true, written: false };
  const retired = retiredOf(assets).get(prepared.sha256);
  if (retired !== undefined) {
    return { assetId: retired.id, path: `${ASSETS_DIR}/${retired.file}`, existing: false, written: false, record: { ...retired } };
  }
  const taken = new Set<string>([
    ...(state.manifest.assets ?? []).map((record) => record.id),
    ...usedAssetIds(state),
    ...pending.map((stored) => stored.assetId),
  ]);
  const assetId = mintAssetId(taken);
  const record = recordOf(assetId, prepared, meta, clock);
  const path = `${ASSETS_DIR}/${record.file}`;
  await assets.writeBytes(path, prepared.bytes);
  return { assetId, path, existing: false, written: true, record };
}

/**
 * Step 3, synchronous: adds the records the stored pictures need, and returns the ones it added. A record whose hash arrived in
 * the registry while the files were written is not added twice; the picture keeps the id it was written under.
 */
export function commitRecords(state: ProjectState, stored: readonly StoredPicture[]): AssetRecord[] {
  const added: AssetRecord[] = [];
  for (const picture of stored) {
    const record = picture.record;
    if (record === undefined) continue;
    const records = (state.manifest.assets ??= []);
    if (records.some((candidate) => candidate.id === record.id)) continue;
    records.push(record);
    added.push(record);
  }
  return added;
}

/** Takes records back out of the registry (an import's undo), and remembers them for the session so a re-import finds the file. */
function retireRecords(state: ProjectState, assets: ProjectAssetPort, added: readonly AssetRecord[]): void {
  const ids = new Set(added.map((record) => record.id));
  const records = state.manifest.assets;
  if (records === undefined) return;
  const kept = records.filter((record) => !ids.has(record.id));
  if (kept.length === 0) delete state.manifest.assets;
  else state.manifest.assets = kept;
  for (const record of added) retiredOf(assets).set(record.sha256, record);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function strippedNote(prepared: readonly PreparedPicture[]): string {
  const located = prepared.filter((picture) => picture.stripped.includes('location')).length;
  if (located === 0) return '';
  return `; removed the location from ${plural(located, 'photo', 'photos')}`;
}

/* ------------------------------------------------------------------ *
 * asset.import and asset.importBatch
 * ------------------------------------------------------------------ */

async function importPictures(
  state: ProjectState,
  assets: ProjectAssetPort,
  items: readonly ({ readonly stagingId: string } & PictureMeta)[],
  largePhotos: AssetLargePhotos | undefined,
  clock: ApplyClock,
  context: ApplyContext,
  batch: boolean,
): Promise<{ stored: StoredPicture[]; prepared: PreparedPicture[] }> {
  // Every staged picture is taken and prepared before a byte is written, so a refusal writes nothing.
  const prepared: PreparedPicture[] = [];
  for (const [index, item] of items.entries()) {
    prepared.push(
      await preparedFromStaging(assets, item.stagingId, {
        what: batch ? `picture ${index + 1}${item.source?.label === undefined ? '' : ` (${item.source.label})`}` : 'the picture',
        ...(largePhotos === undefined ? {} : { largePhotos }),
        target: batch ? `items[${index}].stagingId` : 'stagingId',
      }),
    );
  }

  const stored: StoredPicture[] = [];
  for (const [index, picture] of prepared.entries()) {
    const item = items[index];
    if (item === undefined) continue;
    try {
      stored.push(await storePicture(state, assets, picture, item, stored, clock));
    } catch (failure) {
      const written = stored.filter((entry) => entry.written).length;
      const left = written === 0 ? '' : ` ${plural(written, 'file was', 'files were')} already written to the project's pictures, and no record names ${written === 1 ? 'it' : 'them'}.`;
      throw new ApplyRefusal({
        code: 'internal',
        message: `${batch ? `picture ${index + 1}` : 'the picture'} could not be saved (${failure instanceof Error ? failure.message : String(failure)}), so nothing was added.${left}`,
        target: batch ? 'items' : 'stagingId',
        correctiveHint: 'attach a folder or export a bundle, then add the pictures again',
      });
    }
  }

  // Everything after the last await is synchronous.
  const added = commitRecords(state, stored);
  context.undo.compensate(
    added.length === 0 ? 'nothing to take back: every picture was already in the project' : `take ${plural(added.length, 'picture', 'pictures')} back out of the project's pictures`,
    () => retireRecords(state, assets, added),
  );
  const existing = stored.filter((entry) => entry.existing).length;
  const summary =
    added.length === 0
      ? `${plural(existing, 'picture was', 'pictures were')} already in the project`
      : `added ${plural(added.length, 'picture', 'pictures')}${existing === 0 ? '' : ` (${existing} already in the project)`}${strippedNote(prepared)}`;
  context.report({ affected: [], summary });
  return { stored, prepared };
}

function resultOf(stored: StoredPicture, prepared: PreparedPicture): Record<string, unknown> {
  return {
    assetId: stored.assetId,
    path: stored.path,
    existing: stored.existing,
    ...(prepared.stripped.length === 0 ? {} : { stripped: [...prepared.stripped] }),
    ...(prepared.workingCopy === undefined ? {} : { workingCopy: true }),
    ...(prepared.convertedFromHeic === true ? { convertedFromHeic: true } : {}),
  };
}

function assetImportApply(clock: ApplyClock, assets: ProjectAssetPort): PictureApply<AssetImportParams> {
  return async (state, params, context) => {
    const { stored, prepared } = await importPictures(state, assets, [params], params.largePhotos, clock, context, false);
    const first = stored[0];
    const picture = prepared[0];
    if (first === undefined || picture === undefined) throw new Error('asset.import stored no picture');
    return resultOf(first, picture);
  };
}

function assetImportBatchApply(clock: ApplyClock, assets: ProjectAssetPort): PictureApply<AssetImportBatchParams> {
  return async (state, params, context) => {
    const { stored, prepared } = await importPictures(state, assets, params.items, params.largePhotos, clock, context, true);
    return { items: stored.map((entry, index) => resultOf(entry, prepared[index] as PreparedPicture)) };
  };
}

/* ------------------------------------------------------------------ *
 * asset.setMeta
 * ------------------------------------------------------------------ */

const META_KEYS = ['caption', 'alt', 'decorative', 'tags', 'sourceLabel'] as const;

/** A record's current value of one patch key, `null` for none. `decorative` false and absent are both none. */
function currentOf(record: AssetRecord, key: (typeof META_KEYS)[number]): string | boolean | string[] | null {
  if (key === 'decorative') return record.decorative === true ? true : null;
  if (key === 'sourceLabel') return record.source?.label ?? null;
  if (key === 'tags') return record.tags === undefined || record.tags.length === 0 ? null : [...record.tags];
  return record[key] ?? null;
}

function normalised(value: unknown): unknown {
  if (value === false || value === '' || (Array.isArray(value) && value.length === 0)) return null;
  return value ?? null;
}

function assetSetMetaApply(clock: ApplyClock): PictureApply<AssetSetMetaParams> {
  return (state, params, context) => {
    const record = state.manifest.assets?.find((candidate) => candidate.id === params.assetId);
    if (record === undefined) {
      throw new ApplyRefusal({
        code: 'not-found',
        message: `there is no picture "${params.assetId}" in the project's pictures`,
        target: 'assetId',
        correctiveHint: 'list the pictures again and pick one that is there',
      });
    }
    const keys = META_KEYS.filter((key) => params.patch[key] !== undefined);
    for (const key of keys) {
      if (JSON.stringify(normalised(currentOf(record, key))) !== JSON.stringify(normalised(params.expect[key]))) {
        throw new ApplyRefusal({
          code: 'revision-conflict',
          message: `the picture's ${key === 'sourceLabel' ? 'source label' : key} changed since it was read, so nothing was changed`,
          target: `expect.${key}`,
          correctiveHint: 'read the picture again and make the change on what it holds now',
        });
      }
    }
    if (keys.includes('sourceLabel') && params.patch.sourceLabel !== null && params.patch.sourceLabel !== '' && record.source === undefined) {
      throw new ApplyRefusal({
        code: 'invalid-params',
        message: 'the picture records no source, so it has no source label to set',
        target: 'patch.sourceLabel',
        correctiveHint: 'leave the source label out',
      });
    }

    const inverse: AssetMetaPatch = {};
    const after: AssetMetaPatch = {};
    for (const key of keys) {
      const before = currentOf(record, key);
      (inverse as Record<string, unknown>)[key] = before;
      const value = normalised(params.patch[key]);
      (after as Record<string, unknown>)[key] = value;
      if (key === 'decorative') {
        if (value === true) record.decorative = true;
        else delete record.decorative;
      } else if (key === 'tags') {
        if (value === null) delete record.tags;
        else record.tags = [...(value as string[])];
      } else if (key === 'sourceLabel') {
        if (record.source !== undefined) {
          if (value === null) delete record.source.label;
          else record.source.label = value as string;
        }
      } else if (value === null) {
        delete record[key];
      } else {
        record[key] = value as string;
      }
    }
    record.updatedAt = new Date(clock.now()).toISOString();

    context.undo.inverse(inverseCommand({ assetId: record.id, patch: inverse, expect: after }, clock));
    const words = keys.map((key) => (key === 'sourceLabel' ? 'source label' : key === 'alt' ? 'alt text' : key));
    context.report({ affected: [], summary: `changed the ${words.join(', ')} of a picture` });
    return { assetId: record.id, changed: words };
  };
}

function inverseCommand(params: AssetSetMetaParams, clock: ApplyClock): Command<AssetSetMetaParams> {
  return { id: newId('cmd'), name: 'asset.setMeta', params, issuedBy: 'user', createdAt: clock.now() };
}

function narrow<P>(apply: PictureApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/**
 * The picture registrations, for the store's registry. `asset.setMeta` needs nothing from the host. The two imports are registered only
 * when the host injects the asset port, as the cover import is: without it they stay descriptor-only and are refused as not wired.
 */
export function pictureCommandRegistrations(options: { readonly clock: ApplyClock; readonly assets?: ProjectAssetPort }): Partial<CommandRegistry> {
  const registrations: Partial<CommandRegistry> = {
    'asset.setMeta': { descriptor: pictureCommands.assetSetMeta, apply: narrow(assetSetMetaApply(options.clock)) },
  };
  if (options.assets !== undefined) {
    registrations['asset.import'] = { descriptor: pictureCommands.assetImport, apply: narrow(assetImportApply(options.clock, options.assets)) };
    registrations['asset.importBatch'] = {
      descriptor: pictureCommands.assetImportBatch,
      apply: narrow(assetImportBatchApply(options.clock, options.assets)),
    };
  }
  return registrations;
}

