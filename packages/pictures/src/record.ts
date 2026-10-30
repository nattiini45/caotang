/**
 * The picture registry's record — pictures.md §2.1 — and the load's reading of one.
 *
 * `assets[]` is an additive top-level array in `caotang.json` (decision D4): one record per picture file, carrying what a file
 * alone cannot — its hash, its size, a caption, alt text, tags and where it came from. The three typed pointers that existed
 * before the registry (`project.coverAssetId`, `tree[].shot.image`, `codex[].visualRefs[]`) stay as they are on disk and are
 * read as uses of a record (`uses.ts`).
 *
 * The load rules (§2.1): a record that cannot be read is dropped with a warning that names it, and the load goes on; a record
 * whose file is missing from an authoritative listing is **kept** (it carries the writer's caption), never dropped. A second
 * record with a kept record's id is dropped. An unknown `source.kind` is kept as its string.
 */

import { isAssetId } from './ids.js';
import { formatOfMime, parseAssetFileName, type PictureMime } from './files.js';

/** The limits on a record's text (§2.1): a caption ≤ 2000 characters, alt ≤ 500, at most 32 tags of ≤ 64 characters each. */
export const CAPTION_MAX_CHARS = 2000;
export const ALT_MAX_CHARS = 500;
export const TAGS_MAX = 32;
export const TAG_MAX_CHARS = 64;
/** The longest `source.label`, a short line such as a file name. */
export const SOURCE_LABEL_MAX_CHARS = 200;

/** Where a picture came from. `kind` is one of the five the spec names; a later kind loads as its string. */
export type AssetSourceKind = 'import' | 'paste' | 'mcp' | 'scan' | 'agent';

export interface AssetSource {
  kind: AssetSourceKind | (string & {});
  label?: string;
  server?: string;
  tool?: string;
  url?: string;
}

/** The size of the original a working copy stands in for (§6.4, decision D6). */
export interface WorkingCopyOf {
  fromBytes: number;
  fromWidth: number;
  fromHeight: number;
}

export interface AssetRecord {
  /** `a_XXXXXXXXXX`: the existing id space, and the file's name. */
  id: string;
  /** `a_….png` under `assets/`, the extension from the sniff. */
  file: string;
  mime: PictureMime;
  /** Lower-case hex SHA-256 of the bytes as stored: the dedup key (§6.2). */
  sha256: string;
  bytes: number;
  width?: number;
  height?: number;
  /** ≤ 2000 characters; the default caption for a new placement. */
  caption?: string;
  /** ≤ 500 characters; the default alt text for a new placement. */
  alt?: string;
  /** Exports write `alt=""`. */
  decorative?: true;
  /** ≤ 32 tags of ≤ 64 characters, the keywords rule. */
  tags?: string[];
  source?: AssetSource;
  /** The handwriting transcription (§8.4). Carried as read; this build does not write it. */
  transcription?: Record<string, unknown>;
  workingCopy?: WorkingCopyOf;
  createdAt: string;
  updatedAt?: string;
}

export type ReadRecord = { readonly ok: true; readonly record: AssetRecord } | { readonly ok: false; readonly reason: string };

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RECORD_KEYS = new Set([
  'id',
  'file',
  'mime',
  'sha256',
  'bytes',
  'width',
  'height',
  'caption',
  'alt',
  'decorative',
  'tags',
  'source',
  'transcription',
  'workingCopy',
  'createdAt',
  'updatedAt',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Whether a tag list keeps the keywords rule: at most 32 non-blank strings of at most 64 characters, no repeats. */
export function validTags(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > TAGS_MAX) return false;
  const seen = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== 'string' || tag.trim() === '' || tag.length > TAG_MAX_CHARS || seen.has(tag)) return false;
    seen.add(tag);
  }
  return true;
}

function readSource(value: unknown): AssetSource | string {
  if (!isPlainObject(value)) return 'source is not an object';
  if (typeof value['kind'] !== 'string' || value['kind'] === '') return 'source.kind is not a string';
  const source: AssetSource = { kind: value['kind'] };
  for (const key of ['label', 'server', 'tool', 'url'] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== 'string') return `source.${key} is not a string`;
    if (key === 'label' && field.length > SOURCE_LABEL_MAX_CHARS) return `source.label is longer than ${SOURCE_LABEL_MAX_CHARS} characters`;
    source[key] = field;
  }
  return source;
}

/**
 * Reads one record as the load finds it. The id, file, MIME type, hash, byte count and creation time are required; the file
 * name must be the id's, and its extension must match the MIME type. Every optional field is checked against its limit.
 * Keys this build does not know are left out of the record, as an unknown node key is.
 */
export function readAssetRecord(value: unknown): ReadRecord {
  if (!isPlainObject(value)) return { ok: false, reason: 'not an object' };
  const id = value['id'];
  if (!isAssetId(id)) return { ok: false, reason: 'id is not an a_ asset id' };
  const file = value['file'];
  const parsed = typeof file === 'string' ? parseAssetFileName(file) : undefined;
  if (typeof file !== 'string' || parsed === undefined || parsed.assetId !== id) return { ok: false, reason: `file is not "${id}.png", ".jpg" or ".webp"` };
  const mime = value['mime'];
  if (typeof mime !== 'string' || formatOfMime(mime) !== parsed.format) return { ok: false, reason: 'mime does not match the file' };
  const sha256 = value['sha256'];
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return { ok: false, reason: 'sha256 is not 64 lower-case hex digits' };
  if (!isCount(value['bytes'])) return { ok: false, reason: 'bytes is not a whole number' };
  if (typeof value['createdAt'] !== 'string' || value['createdAt'] === '') return { ok: false, reason: 'createdAt is not a timestamp' };
  const record: AssetRecord = {
    id,
    file,
    mime: mime as PictureMime,
    sha256,
    bytes: value['bytes'],
    createdAt: value['createdAt'],
  };
  if (value['width'] !== undefined || value['height'] !== undefined) {
    if (!isPositive(value['width']) || !isPositive(value['height'])) return { ok: false, reason: 'width and height are not both whole numbers above zero' };
    record.width = value['width'];
    record.height = value['height'];
  }
  if (value['caption'] !== undefined) {
    if (typeof value['caption'] !== 'string' || value['caption'].length > CAPTION_MAX_CHARS) return { ok: false, reason: `caption is not a string of at most ${CAPTION_MAX_CHARS} characters` };
    record.caption = value['caption'];
  }
  if (value['alt'] !== undefined) {
    if (typeof value['alt'] !== 'string' || value['alt'].length > ALT_MAX_CHARS) return { ok: false, reason: `alt is not a string of at most ${ALT_MAX_CHARS} characters` };
    record.alt = value['alt'];
  }
  if (value['decorative'] !== undefined) {
    if (value['decorative'] !== true) return { ok: false, reason: 'decorative is not true' };
    record.decorative = true;
  }
  if (value['tags'] !== undefined) {
    if (!validTags(value['tags'])) return { ok: false, reason: `tags is not a list of at most ${TAGS_MAX} distinct tags of at most ${TAG_MAX_CHARS} characters` };
    record.tags = [...value['tags']];
  }
  if (value['source'] !== undefined) {
    const source = readSource(value['source']);
    if (typeof source === 'string') return { ok: false, reason: source };
    record.source = source;
  }
  if (value['transcription'] !== undefined) {
    const transcription = value['transcription'];
    if (!isPlainObject(transcription) || typeof transcription['at'] !== 'string') return { ok: false, reason: 'transcription is not an object with "at"' };
    record.transcription = { ...transcription };
  }
  if (value['workingCopy'] !== undefined) {
    const copy = value['workingCopy'];
    if (!isPlainObject(copy) || !isCount(copy['fromBytes']) || !isPositive(copy['fromWidth']) || !isPositive(copy['fromHeight'])) {
      return { ok: false, reason: 'workingCopy is not {fromBytes, fromWidth, fromHeight}' };
    }
    record.workingCopy = { fromBytes: copy['fromBytes'], fromWidth: copy['fromWidth'], fromHeight: copy['fromHeight'] };
  }
  if (value['updatedAt'] !== undefined) {
    if (typeof value['updatedAt'] !== 'string') return { ok: false, reason: 'updatedAt is not a timestamp' };
    record.updatedAt = value['updatedAt'];
  }
  return { ok: true, record };
}

/** The keys of a record this build reads and writes, for the load's "unknown key" note. */
export function unknownRecordKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => !RECORD_KEYS.has(key));
}

/** The record with a hash, or `undefined`. The dedup check (§6.2). */
export function recordByHash(records: readonly AssetRecord[] | undefined, sha256: string): AssetRecord | undefined {
  return records?.find((record) => record.sha256 === sha256);
}

/** The record with an id, or `undefined`. */
export function recordById(records: readonly AssetRecord[] | undefined, id: string): AssetRecord | undefined {
  return records?.find((record) => record.id === id);
}
