/**
 * The picture registry's descriptors — [pictures.md](../../../docs/architecture/pictures.md) §2.4. Their applies are the store's
 * (`packages/store/src/commands-pictures.ts`), reached through the same registry as the rest of the closed set.
 *
 * - `asset.import` takes one staged picture through the import pipeline (§6.4) into `assets/` and the registry. Its undo removes
 *   the record it made; the file stays, a harmless orphan the hash reclaims if the same bytes come back.
 * - `asset.importBatch` is the same for several pictures, one command and so one undo group, all or none.
 * - `asset.setMeta` edits a record's caption, alt text, decorative flag, tags and source label, with an `expect` check.
 *
 * The bytes are never params (a param is JSON and is copied into the undo group): the host stages them, as it does for the cover.
 * An agent cannot stage bytes, so its import is refused as not-found before anything is written. Validation is pure and total
 * (command-bus §2): the closed key sets, the strings and their limits. Whether a record exists is the apply's to say.
 */

import { ALT_MAX_CHARS, CAPTION_MAX_CHARS, SOURCE_LABEL_MAX_CHARS, TAGS_MAX, TAG_MAX_CHARS, validTags } from '@caotang/pictures';

import type {
  AssetImportBatchParams,
  AssetImportParams,
  AssetImportSource,
  AssetLargePhotos,
  AssetMetaPatch,
  AssetSetMetaParams,
  CommandDescriptor,
} from './command.js';
import { ok, type CommandError, type Result } from './result.js';
import { describe, invalid, isRecord, limitExceeded, requireDeclaredParams, requireNonBlankString, showValue } from './params.js';

/** The most pictures one `asset.importBatch` takes, the same as `shot.importImages`. */
export const ASSET_IMPORT_BATCH_MAX = 200;

const ITEM_KEYS = new Set(['stagingId', 'caption', 'alt', 'source']);
const PATCH_KEYS = ['caption', 'alt', 'decorative', 'tags', 'sourceLabel'] as const;

function textField(value: unknown, path: string, max: number): Result<string | undefined, CommandError> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'string') return invalid(`params.${path} must be a string, got ${describe(value)}`, undefined, path);
  if (value.length > max) return limitExceeded(`params.${path} is ${value.length} characters, limit ${max}`, `shorten it to ${max} characters`, path);
  return ok(value);
}

function sourceField(value: unknown, path: string): Result<AssetImportSource | undefined, CommandError> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) return invalid(`params.${path} must be {kind, label?}, got ${showValue(value)}`, undefined, path);
  for (const key of Object.keys(value)) {
    if (key !== 'kind' && key !== 'label') return invalid(`params.${path}.${key} is not a key of a source`, 'a source carries only kind and label', `${path}.${key}`);
  }
  const kind = value['kind'];
  if (kind !== 'import' && kind !== 'paste') {
    return invalid(`params.${path}.kind must be "import" or "paste", got ${showValue(kind)}`, 'a picture the writer brings is an import or a paste', `${path}.kind`);
  }
  const label = textField(value['label'], `${path}.label`, SOURCE_LABEL_MAX_CHARS);
  if (!label.ok) return label;
  return ok({ kind, ...(label.value === undefined ? {} : { label: label.value }) });
}

function largePhotosField(value: unknown): Result<AssetLargePhotos | undefined, CommandError> {
  if (value === undefined) return ok(undefined);
  if (value !== 'keep' && value !== 'working-copies') {
    return invalid(`params.largePhotos must be "keep" or "working-copies", got ${showValue(value)}`, 'answer the large-photo question with one of the two', 'largePhotos');
  }
  return ok(value);
}

/** One import's fields, shared by the single import and each batch item. */
function itemFields(
  value: Record<string, unknown>,
  prefix: string,
): Result<{ stagingId: string; caption?: string; alt?: string; source?: AssetImportSource }, CommandError> {
  const stagingId = requireNonBlankString(value, 'stagingId', { maxChars: 64 });
  if (!stagingId.ok) return invalid(`${prefix}${stagingId.error.message}`, stagingId.error.correctiveHint, `${prefix}stagingId`);
  const caption = textField(value['caption'], `${prefix}caption`, CAPTION_MAX_CHARS);
  if (!caption.ok) return caption;
  const alt = textField(value['alt'], `${prefix}alt`, ALT_MAX_CHARS);
  if (!alt.ok) return alt;
  const source = sourceField(value['source'], `${prefix}source`);
  if (!source.ok) return source;
  return ok({
    stagingId: stagingId.value,
    ...(caption.value === undefined ? {} : { caption: caption.value }),
    ...(alt.value === undefined ? {} : { alt: alt.value }),
    ...(source.value === undefined ? {} : { source: source.value }),
  });
}

export const assetImport: CommandDescriptor<AssetImportParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  // The undo removes the record the import made (and nothing when the bytes matched a record already there); the file stays.
  undo: 'compensable',
  asyncApply: true,
  validate: (params): Result<AssetImportParams, CommandError> => {
    const p = requireDeclaredParams('asset.import', params);
    if (!p.ok) return p;
    const item = itemFields(p.value, '');
    if (!item.ok) return item;
    const largePhotos = largePhotosField(p.value['largePhotos']);
    if (!largePhotos.ok) return largePhotos;
    return ok({ ...item.value, ...(largePhotos.value === undefined ? {} : { largePhotos: largePhotos.value }) });
  },
};

export const assetImportBatch: CommandDescriptor<AssetImportBatchParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'compensable',
  asyncApply: true,
  validate: (params): Result<AssetImportBatchParams, CommandError> => {
    const p = requireDeclaredParams('asset.importBatch', params);
    if (!p.ok) return p;
    const list = p.value['items'];
    if (!Array.isArray(list) || list.length === 0) {
      return invalid(`params.items must be a non-empty array of {stagingId, caption?, alt?, source?}, got ${showValue(list)}`, 'pass one entry for each picture', 'items');
    }
    if (list.length > ASSET_IMPORT_BATCH_MAX) {
      return limitExceeded(`params.items has ${list.length} entries, limit ${ASSET_IMPORT_BATCH_MAX}`, `send at most ${ASSET_IMPORT_BATCH_MAX} pictures at once`, 'items');
    }
    const items: AssetImportBatchParams['items'] = [];
    const staged = new Set<string>();
    for (const [index, entry] of list.entries()) {
      if (!isRecord(entry)) return invalid(`params.items[${index}] must be an object {stagingId, caption?, alt?, source?}, got ${showValue(entry)}`, undefined, `items[${index}]`);
      for (const key of Object.keys(entry)) {
        if (!ITEM_KEYS.has(key)) return invalid(`params.items[${index}].${key} is not a key of an item`, 'an item carries stagingId, caption, alt and source', `items[${index}].${key}`);
      }
      const item = itemFields(entry, `items[${index}].`);
      if (!item.ok) return item;
      if (staged.has(item.value.stagingId)) return invalid(`params.items names the staged picture "${item.value.stagingId}" more than once`, 'name each staged picture once', `items[${index}].stagingId`);
      staged.add(item.value.stagingId);
      items.push(item.value);
    }
    const largePhotos = largePhotosField(p.value['largePhotos']);
    if (!largePhotos.ok) return largePhotos;
    return ok({ items, ...(largePhotos.value === undefined ? {} : { largePhotos: largePhotos.value }) });
  },
};

/** One patch (or expect) object: the five keys, each absent, `null`, or a value within its limit. */
function metaPatch(value: unknown, path: 'patch' | 'expect'): Result<AssetMetaPatch, CommandError> {
  if (!isRecord(value)) return invalid(`params.${path} must be an object, got ${showValue(value)}`, `name at least one of: ${PATCH_KEYS.join(', ')}`, path);
  const out: AssetMetaPatch = {};
  for (const key of Object.keys(value)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) return invalid(`params.${path}.${key} is not a picture field`, `the fields are ${PATCH_KEYS.join(', ')}`, `${path}.${key}`);
  }
  for (const key of PATCH_KEYS) {
    const field = value[key];
    if (field === undefined) continue;
    if (field === null) {
      out[key] = null;
      continue;
    }
    if (key === 'decorative') {
      if (typeof field !== 'boolean') return invalid(`params.${path}.decorative must be true, false or null, got ${describe(field)}`, undefined, `${path}.decorative`);
      out.decorative = field;
    } else if (key === 'tags') {
      if (!validTags(field)) {
        return invalid(
          `params.${path}.tags must be at most ${TAGS_MAX} distinct, non-blank tags of at most ${TAG_MAX_CHARS} characters`,
          'drop the repeated, blank or long tags',
          `${path}.tags`,
        );
      }
      out.tags = [...field];
    } else {
      const max = key === 'caption' ? CAPTION_MAX_CHARS : key === 'alt' ? ALT_MAX_CHARS : SOURCE_LABEL_MAX_CHARS;
      const text = textField(field, `${path}.${key}`, max);
      if (!text.ok) return text;
      out[key] = text.value ?? null;
    }
  }
  return ok(out);
}

export const assetSetMeta: CommandDescriptor<AssetSetMetaParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params): Result<AssetSetMetaParams, CommandError> => {
    const p = requireDeclaredParams('asset.setMeta', params);
    if (!p.ok) return p;
    const assetId = requireNonBlankString(p.value, 'assetId', { maxChars: 64 });
    if (!assetId.ok) return assetId;
    const patch = metaPatch(p.value['patch'], 'patch');
    if (!patch.ok) return patch;
    const keys = Object.keys(patch.value);
    if (keys.length === 0) return invalid('the patch sets nothing', `name at least one of: ${PATCH_KEYS.join(', ')}`, 'patch');
    const expect = metaPatch(p.value['expect'], 'expect');
    if (!expect.ok) return expect;
    const expectKeys = Object.keys(expect.value).sort();
    if (expectKeys.join(',') !== [...keys].sort().join(',')) {
      return invalid('params.expect must name the same fields as the patch, each with its value now (null for none)', 'read the picture again and send what it holds', 'expect');
    }
    return ok({ assetId: assetId.value, patch: patch.value, expect: expect.value });
  },
};
