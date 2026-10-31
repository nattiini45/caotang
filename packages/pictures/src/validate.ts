/**
 * Readers and validators for the registry's records and links — pictures.md §2.1.
 *
 * Two postures, one schema. A **tolerant read** (a project being opened) keeps whatever it can: fields
 * this build does not know stay on the object, an unknown link role or target kind stays a string, an
 * over-long caption stays, and a known field with an unusable value is dropped with a notice. An entry
 * whose core fields cannot be trusted is returned untouched in `unreadable`, so the caller can write
 * it back as it found it rather than lose it. A **strict validation** (a new write) refuses all of
 * that: unknown keys, unknown roles, over-long text.
 */

import { extensionOfMime, isAssetId, isSha256Hex } from './asset-files.js';
import {
  ASSET_LINK_ROLES,
  ASSET_SOURCE_KINDS,
  PICTURE_LIMITS,
  PICTURE_MIMES,
  type AssetLink,
  type AssetRecord,
  type ReadAssetLink,
  type ReadAssetRecord,
} from './model.js';

export const LINK_ID_PATTERN = /^l_[0-9A-HJKMNP-TV-Z]{10}$/;

export function isLinkId(value: unknown): value is string {
  return typeof value === 'string' && LINK_ID_PATTERN.test(value);
}

export interface PictureIssue {
  code: string;
  path: string;
  message: string;
}

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly PictureIssue[] };

interface Problem {
  kind: 'invalid' | 'limit';
  message: string;
}

type Check = (value: unknown, strict: boolean) => Problem | undefined;

interface FieldSpec {
  required: boolean;
  check: Check;
}

type Schema = Readonly<Record<string, FieldSpec>>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const invalid = (message: string): Problem => ({ kind: 'invalid', message });
const limit = (message: string): Problem => ({ kind: 'limit', message });

function text(max?: number): Check {
  return (value) => {
    if (typeof value !== 'string') return invalid('must be text');
    if (max !== undefined && value.length > max) return limit(`must be at most ${max} characters`);
    return undefined;
  };
}

const nonEmptyText: Check = (value) => (typeof value === 'string' && value.length > 0 ? undefined : invalid('must be non-empty text'));

function integer(min: number): Check {
  return (value) => (typeof value === 'number' && Number.isInteger(value) && value >= min ? undefined : invalid(`must be a whole number of at least ${min}`));
}

const anyInteger: Check = (value) => (typeof value === 'number' && Number.isInteger(value) ? undefined : invalid('must be a whole number'));

const literalTrue: Check = (value) => (value === true ? undefined : invalid('must be true when present'));

const stringList: Check = (value) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return invalid('must be a list of text');
  if (value.length > PICTURE_LIMITS.tags) return limit(`must have at most ${PICTURE_LIMITS.tags} entries`);
  if (value.some((item: string) => item.length > PICTURE_LIMITS.tagLength)) return limit(`each tag must be at most ${PICTURE_LIMITS.tagLength} characters`);
  return undefined;
};

function oneOf(values: readonly string[], strictOnly: boolean): Check {
  return (value, strict) => {
    if (typeof value !== 'string') return invalid('must be text');
    if (values.includes(value)) return undefined;
    return strictOnly && !strict ? undefined : invalid(`must be one of ${values.join(', ')}`);
  };
}

/**
 * A nested object is judged by its known fields in both postures: a bad known field makes the whole
 * value unusable (so the tolerant reader drops it rather than keep a lie), while unknown keys and
 * over-long text are tolerated on a read and refused on a write.
 */
function checkAgainst(schema: Schema, value: unknown, strict: boolean): Problem | undefined {
  if (!isObject(value)) return invalid('must be an object');
  const result = applySchema(value, schema, true, '');
  if (result.ok) return undefined;
  const fatal = result.issues.filter((i) => i.code !== 'over-limit' && (strict || i.code !== 'unknown-field'));
  if (fatal.length > 0) return invalid(fatal[0]?.message ?? 'is not valid');
  return strict ? invalid(result.issues[0]?.message ?? 'is not valid') : undefined;
}

function checkObject(schema: Schema): Check {
  return (value, strict) => checkAgainst(schema, value, strict);
}

const TEXT_ANCHOR_SCHEMA: Schema = {
  from: { required: true, check: integer(0) },
  to: { required: true, check: integer(0) },
  exact: { required: true, check: text() },
  prefix: { required: true, check: text() },
  suffix: { required: true, check: text() },
  capturedRevision: { required: true, check: integer(0) },
};

const PARAGRAPH_ANCHOR_SCHEMA: Schema = {
  ...TEXT_ANCHOR_SCHEMA,
  blockHash: { required: true, check: nonEmptyText },
  ordinal: { required: true, check: integer(0) },
};

const checkTextAnchor = checkObject(TEXT_ANCHOR_SCHEMA);

const RECORD_SCHEMA: Schema = {
  id: { required: true, check: (v) => (isAssetId(v) ? undefined : invalid('must be an asset id like a_XXXXXXXXXX')) },
  file: {
    required: true,
    check: (v) => (typeof v === 'string' && /^[^/\\]+$/.test(v) && v !== '.' && v !== '..' ? undefined : invalid('must be a file name inside assets/')),
  },
  mime: { required: true, check: oneOf(PICTURE_MIMES, false) },
  sha256: { required: true, check: (v) => (isSha256Hex(v) ? undefined : invalid('must be 64 lower-case hex characters')) },
  bytes: { required: true, check: integer(0) },
  width: { required: false, check: integer(1) },
  height: { required: false, check: integer(1) },
  caption: { required: false, check: text(PICTURE_LIMITS.caption) },
  alt: { required: false, check: text(PICTURE_LIMITS.alt) },
  decorative: { required: false, check: literalTrue },
  tags: { required: false, check: stringList },
  source: {
    required: false,
    check: checkObject({
      kind: { required: true, check: oneOf(ASSET_SOURCE_KINDS, false) },
      label: { required: false, check: text(PICTURE_LIMITS.label) },
      server: { required: false, check: text(PICTURE_LIMITS.label) },
      tool: { required: false, check: text(PICTURE_LIMITS.label) },
      url: { required: false, check: text(PICTURE_LIMITS.caption) },
    }),
  },
  transcription: {
    required: false,
    check: checkObject({
      at: { required: true, check: nonEmptyText },
      docId: { required: false, check: nonEmptyText },
      anchor: { required: false, check: checkTextAnchor },
      text: { required: false, check: text() },
      model: { required: false, check: text(PICTURE_LIMITS.label) },
    }),
  },
  workingCopy: {
    required: false,
    check: checkObject({
      fromBytes: { required: true, check: integer(0) },
      fromWidth: { required: true, check: integer(1) },
      fromHeight: { required: true, check: integer(1) },
    }),
  },
  createdAt: { required: true, check: nonEmptyText },
  updatedAt: { required: false, check: nonEmptyText },
};

const WHEN_CHECK = checkObject({
  dayOffset: { required: false, check: anyInteger },
  label: { required: false, check: text(PICTURE_LIMITS.label) },
});

const KNOWN_TARGET_KINDS = ['project', 'node', 'paragraph'] as const;

const TARGET_SCHEMAS: Readonly<Record<string, Schema>> = {
  project: { kind: { required: true, check: nonEmptyText } },
  node: { kind: { required: true, check: nonEmptyText }, nodeId: { required: true, check: nonEmptyText } },
  paragraph: {
    kind: { required: true, check: nonEmptyText },
    nodeId: { required: true, check: nonEmptyText },
    anchor: { required: true, check: checkObject(PARAGRAPH_ANCHOR_SCHEMA) },
    orphaned: { required: false, check: literalTrue },
    moved: { required: false, check: literalTrue },
  },
};

const checkTarget: Check = (value, strict) => {
  if (!isObject(value) || typeof value['kind'] !== 'string') return invalid('must be an object with a kind');
  const schema = TARGET_SCHEMAS[value['kind']];
  if (schema === undefined) return strict ? invalid(`has an unknown kind; use ${KNOWN_TARGET_KINDS.join(', ')}`) : undefined;
  return checkAgainst(schema, value, strict);
};

const LINK_SCHEMA: Schema = {
  id: { required: true, check: (v) => (isLinkId(v) ? undefined : invalid('must be a link id like l_XXXXXXXXXX')) },
  assetId: { required: true, check: (v, strict) => (strict ? (isAssetId(v) ? undefined : invalid('must be an asset id')) : nonEmptyText(v, strict)) },
  target: { required: true, check: checkTarget },
  role: { required: true, check: oneOf(ASSET_LINK_ROLES, true) },
  order: { required: true, check: (v, strict) => (strict ? integer(0)(v, strict) : typeof v === 'number' && Number.isFinite(v) ? undefined : invalid('must be a number')) },
  note: { required: false, check: text(PICTURE_LIMITS.note) },
  when: { required: false, check: WHEN_CHECK },
};

type Applied = { ok: true; value: Record<string, unknown>; notices: PictureIssue[] } | { ok: false; issues: PictureIssue[] };

function applySchema(raw: Record<string, unknown>, schema: Schema, strict: boolean, path: string): Applied {
  const issues: PictureIssue[] = [];
  const notices: PictureIssue[] = [];
  const value: Record<string, unknown> = { ...raw };
  const at = (key: string): string => (path === '' ? key : `${path}.${key}`);

  if (strict) {
    for (const key of Object.keys(raw)) {
      if (schema[key] === undefined) issues.push({ code: 'unknown-field', path: at(key), message: `${at(key)} is not a field of this record` });
    }
  }
  for (const [key, spec] of Object.entries(schema)) {
    const present = raw[key] !== undefined;
    if (!present) {
      if (spec.required) issues.push({ code: 'missing', path: at(key), message: `${at(key)} is required` });
      continue;
    }
    const problem = spec.check(raw[key], strict);
    if (problem === undefined) continue;
    const issue = { code: problem.kind === 'limit' ? 'over-limit' : 'invalid', path: at(key), message: `${at(key)} ${problem.message}` };
    if (problem.kind === 'limit' && !strict) {
      notices.push(issue);
    } else if (strict || spec.required) {
      issues.push(issue);
    } else {
      delete value[key];
      notices.push({ ...issue, code: 'dropped' });
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value, notices };
}

export interface ReadRecords {
  readonly records: readonly ReadAssetRecord[];
  /** Entries that could not be trusted as records, exactly as they were stored. Write them back unchanged. */
  readonly unreadable: readonly unknown[];
  readonly notices: readonly PictureIssue[];
}

export interface ReadLinks {
  readonly links: readonly ReadAssetLink[];
  readonly unreadable: readonly unknown[];
  readonly notices: readonly PictureIssue[];
}

function readList(raw: unknown, key: string, notices: PictureIssue[]): readonly unknown[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    notices.push({ code: 'not-a-list', path: key, message: `${key} is not a list, so it was ignored` });
    return [];
  }
  return raw;
}

/** Reads `assets[]` from a manifest, keeping everything that can be kept. */
export function readAssetRecords(raw: unknown): ReadRecords {
  const notices: PictureIssue[] = [];
  const records: ReadAssetRecord[] = [];
  const unreadable: unknown[] = [];
  const seen = new Set<string>();
  readList(raw, 'assets', notices).forEach((entry, index) => {
    const path = `assets[${index}]`;
    if (!isObject(entry)) {
      unreadable.push(entry);
      notices.push({ code: 'unreadable', path, message: `${path} is not an object` });
      return;
    }
    const applied = applySchema(entry, RECORD_SCHEMA, false, path);
    if (!applied.ok) {
      unreadable.push(entry);
      for (const issue of applied.issues) notices.push({ ...issue, code: 'unreadable' });
      return;
    }
    const id = applied.value['id'] as string;
    if (seen.has(id)) {
      unreadable.push(entry);
      notices.push({ code: 'duplicate-id', path, message: `${path} repeats the id ${id}, so only the first is used` });
      return;
    }
    seen.add(id);
    notices.push(...applied.notices);
    records.push(applied.value as ReadAssetRecord);
  });
  return { records, unreadable, notices };
}

/** Reads `assetLinks[]` from a manifest. An unknown role or target kind is kept as the string it was. */
export function readAssetLinks(raw: unknown): ReadLinks {
  const notices: PictureIssue[] = [];
  const links: ReadAssetLink[] = [];
  const unreadable: unknown[] = [];
  const seen = new Set<string>();
  readList(raw, 'assetLinks', notices).forEach((entry, index) => {
    const path = `assetLinks[${index}]`;
    if (!isObject(entry)) {
      unreadable.push(entry);
      notices.push({ code: 'unreadable', path, message: `${path} is not an object` });
      return;
    }
    const applied = applySchema(entry, LINK_SCHEMA, false, path);
    if (!applied.ok) {
      unreadable.push(entry);
      for (const issue of applied.issues) notices.push({ ...issue, code: 'unreadable' });
      return;
    }
    const id = applied.value['id'] as string;
    if (seen.has(id)) {
      unreadable.push(entry);
      notices.push({ code: 'duplicate-id', path, message: `${path} repeats the id ${id}, so only the first is used` });
      return;
    }
    seen.add(id);
    notices.push(...applied.notices);
    links.push(applied.value as ReadAssetLink);
  });

  const cardsByNode = new Map<string, number>();
  for (const link of links) {
    const target = link.target as { kind: string; nodeId?: unknown };
    if (link.role === 'card' && target.kind === 'node' && typeof target.nodeId === 'string') {
      cardsByNode.set(target.nodeId, (cardsByNode.get(target.nodeId) ?? 0) + 1);
    }
  }
  for (const [nodeId, count] of cardsByNode) {
    if (count > 1) notices.push({ code: 'card-conflict', path: 'assetLinks', message: `node ${nodeId} has ${count} card pictures; the first by order is used until one is changed` });
  }
  return { links, unreadable, notices };
}

function finish<T>(result: Applied, extra: PictureIssue[] = []): Validation<T> {
  if (!result.ok) return { ok: false, issues: [...result.issues, ...extra] };
  return extra.length > 0 ? { ok: false, issues: extra } : { ok: true, value: result.value as T };
}

/** Strict check of a record about to be written. */
export function validateAssetRecord(value: unknown): Validation<AssetRecord> {
  if (!isObject(value)) return { ok: false, issues: [{ code: 'invalid', path: '', message: 'a picture record must be an object' }] };
  const applied = applySchema(value, RECORD_SCHEMA, true, '');
  const extra: PictureIssue[] = [];
  if (applied.ok) {
    const id = applied.value['id'] as string;
    const file = applied.value['file'] as string;
    const mime = applied.value['mime'] as AssetRecord['mime'];
    if (file !== `${id}.${extensionOfMime(mime)}`) extra.push({ code: 'file-name', path: 'file', message: `file must be ${id}.${extensionOfMime(mime)}, named from the id and the sniffed type` });
    if ((applied.value['width'] === undefined) !== (applied.value['height'] === undefined)) {
      extra.push({ code: 'size', path: 'width', message: 'width and height are given together or not at all' });
    }
  }
  return finish<AssetRecord>(applied, extra);
}

/** Strict check of a link about to be written. Card links belong to nodes only. */
export function validateAssetLink(value: unknown): Validation<AssetLink> {
  if (!isObject(value)) return { ok: false, issues: [{ code: 'invalid', path: '', message: 'a picture link must be an object' }] };
  const applied = applySchema(value, LINK_SCHEMA, true, '');
  const extra: PictureIssue[] = [];
  if (applied.ok && applied.value['role'] === 'card') {
    const target = applied.value['target'] as { kind: string };
    if (target.kind !== 'node') extra.push({ code: 'card-target', path: 'role', message: 'a card picture belongs to a binder item, not to the project or a paragraph' });
  }
  return finish<AssetLink>(applied, extra);
}

export interface LinkSetContext {
  /** Every record id; when given, a link naming another asset is reported. */
  assetIds?: ReadonlySet<string>;
  /** Every node id; when given, a link naming another node is reported. */
  nodeIds?: ReadonlySet<string>;
}

/**
 * Cross-link rules for a whole list: unique ids, at most one card link per node, and (when the
 * context is supplied) no link to an asset or node that does not exist. The same picture at many
 * targets is allowed.
 */
export function validateLinkSet(links: readonly (AssetLink | ReadAssetLink)[], context: LinkSetContext = {}): PictureIssue[] {
  const issues: PictureIssue[] = [];
  const ids = new Set<string>();
  const cards = new Map<string, string>();
  links.forEach((link, index) => {
    const path = `assetLinks[${index}]`;
    if (ids.has(link.id)) issues.push({ code: 'duplicate-id', path, message: `${path} repeats the link id ${link.id}` });
    ids.add(link.id);
    if (context.assetIds !== undefined && !context.assetIds.has(link.assetId)) {
      issues.push({ code: 'unknown-asset', path, message: `${path} names a picture that has no record` });
    }
    const target = link.target as { kind: string; nodeId?: unknown };
    const nodeId = target.kind === 'node' || target.kind === 'paragraph' ? target.nodeId : undefined;
    if (typeof nodeId === 'string' && context.nodeIds !== undefined && !context.nodeIds.has(nodeId)) {
      issues.push({ code: 'unknown-node', path, message: `${path} names a binder item that does not exist` });
    }
    if (link.role === 'card') {
      if (target.kind !== 'node' || typeof nodeId !== 'string') {
        issues.push({ code: 'card-target', path, message: `${path} is a card picture, which belongs to a binder item` });
      } else if (cards.has(nodeId)) {
        issues.push({ code: 'card-conflict', path, message: `${path} is a second card picture for the same binder item` });
      } else {
        cards.set(nodeId, link.id);
      }
    }
  });
  return issues;
}

export interface RecordPatch {
  caption?: string | null;
  alt?: string | null;
  decorative?: boolean | null;
  tags?: string[] | null;
  sourceLabel?: string | null;
}

const PATCH_SCHEMA: Readonly<Record<keyof RecordPatch, Check>> = {
  caption: text(PICTURE_LIMITS.caption),
  alt: text(PICTURE_LIMITS.alt),
  decorative: (v) => (typeof v === 'boolean' ? undefined : invalid('must be true or false')),
  tags: stringList,
  sourceLabel: text(PICTURE_LIMITS.label),
};

/** Record fields only: the caption, alt, decorative flag, tags and source label belong to `asset.setMeta`. A link's note does not. */
export function validateRecordPatch(value: unknown): Validation<RecordPatch> {
  if (!isObject(value)) return { ok: false, issues: [{ code: 'invalid', path: '', message: 'a patch must be an object' }] };
  const issues: PictureIssue[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const check = (PATCH_SCHEMA as Readonly<Record<string, Check | undefined>>)[key];
    if (check === undefined) {
      issues.push({ code: 'unknown-field', path: key, message: `${key} is not a picture field${key === 'note' ? '; a note belongs to a link' : ''}` });
    } else if (entry !== null) {
      const problem = check(entry, true);
      if (problem !== undefined) issues.push({ code: problem.kind === 'limit' ? 'over-limit' : 'invalid', path: key, message: `${key} ${problem.message}` });
    }
  }
  if (Object.keys(value).length === 0) issues.push({ code: 'empty', path: '', message: 'a patch must change something' });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: value as RecordPatch };
}

export interface LinkNotePatch {
  note: string | null;
}

/** The link's own text: `asset.setLinkMeta`'s patch. */
export function validateLinkNotePatch(value: unknown): Validation<LinkNotePatch> {
  if (!isObject(value)) return { ok: false, issues: [{ code: 'invalid', path: '', message: 'a patch must be an object' }] };
  const issues: PictureIssue[] = [];
  for (const key of Object.keys(value)) if (key !== 'note') issues.push({ code: 'unknown-field', path: key, message: `${key} is not a link field you can change here` });
  if (value['note'] === undefined) issues.push({ code: 'missing', path: 'note', message: 'note is required (use null to clear it)' });
  else if (value['note'] !== null) {
    const problem = text(PICTURE_LIMITS.note)(value['note'], true);
    if (problem !== undefined) issues.push({ code: 'invalid', path: 'note', message: `note ${problem.message}` });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: value as unknown as LinkNotePatch };
}
