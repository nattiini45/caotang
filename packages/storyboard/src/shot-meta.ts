/**
 * The shot record's codec — [storyboard.md](../../../docs/architecture/storyboard.md) §2.2, and the
 * load and save rules of [project-format.md](../../../docs/architecture/project-format.md) §2 and §6.
 *
 * Two directions, two rule sets. On a **load** the module is tolerant, because a manifest may
 * have been written by a newer build or edited by hand:
 *
 * - a closed-enum value outside its list is **kept verbatim** and reported, never dropped (§2.2:
 *   "keep string, surface 'unknown value' chip");
 * - an unknown field is kept in memory and **dropped on the next save**, with a notice (§6);
 * - a malformed value (a wrong type, a path where an asset id belongs) is dropped with a notice,
 *   which is the house rule for malformed objects (project-format §2, the goals and filters rule).
 *
 * On a **write** the module is strict: a value outside a closed list, an over-long action or a
 * negative duration is refused, so a model's call cannot put a value into the manifest that the
 * next load would have to keep as unknown.
 */

import { ANCHOR_CONTEXT_CHARS, ANCHOR_MAX_EXACT_CHARS } from './anchors.js';
import { isAssetId } from './ids.js';
import {
  ACTION_MAX_CHARS,
  SHOT_ENUMS,
  SHOT_ENUM_FIELDS,
  SHOT_META_KEYS,
  type DialogueCoverage,
  type ShotEnumField,
  type ShotMeta,
  type TextAnchor,
} from './model.js';
import { codePointCount, type StoryboardRefusal } from './result.js';

/** What a load made of one shot's metadata. `meta` is the well-formed part; the rest is kept beside it. */
export interface ShotMetaRead {
  readonly meta: ShotMeta;
  /** Closed-enum fields whose value is outside the list, kept verbatim for the unknown-value chip. */
  readonly unknownValues: Readonly<Record<string, unknown>>;
  /** Keys the schema does not define. Kept in memory and dropped on the next save (§6). */
  readonly unknownFields: Readonly<Record<string, unknown>>;
  /** The whole value, when it was not an object. Kept as written; the shot cannot be edited until fixed. */
  readonly rawPreserved?: unknown;
  /** One line per thing the load changed or kept, for the load report. */
  readonly notices: readonly string[];
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The stored object of a shot node, when it is an object. Absent and malformed are both `undefined`. */
export function storedOf(raw: unknown): Readonly<Record<string, unknown>> | undefined {
  return isPlainObject(raw) ? raw : undefined;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isEnumValue(field: ShotEnumField, value: unknown): value is string {
  return typeof value === 'string' && (SHOT_ENUMS[field] as readonly string[]).includes(value);
}

function readAnchor(raw: unknown): TextAnchor | undefined {
  if (!isPlainObject(raw)) return undefined;
  const from = raw.from;
  const to = raw.to;
  const exact = raw.exact;
  const prefix = raw.prefix;
  const suffix = raw.suffix;
  const capturedRevision = raw.capturedRevision;
  if (!isOffset(from) || !isOffset(to) || to <= from) return undefined;
  if (typeof exact !== 'string' || exact.length === 0 || exact.length > ANCHOR_MAX_EXACT_CHARS) return undefined;
  if (typeof prefix !== 'string' || prefix.length > ANCHOR_CONTEXT_CHARS) return undefined;
  if (typeof suffix !== 'string' || suffix.length > ANCHOR_CONTEXT_CHARS) return undefined;
  if (!isOffset(capturedRevision)) return undefined;
  return { from, to, exact, prefix, suffix, capturedRevision };
}

function readCoverage(entry: unknown): DialogueCoverage | undefined {
  if (!isPlainObject(entry) || entry.kind !== 'fountain-element') return undefined;
  const docId = entry.docId;
  if (typeof docId !== 'string' || docId === '') return undefined;
  const anchor = readAnchor(entry.anchor);
  return anchor === undefined ? undefined : { kind: 'fountain-element', docId, anchor };
}

/**
 * Reads one shot's stored metadata. `undefined` and `null` read as an empty shot, which is a
 * valid state: a shot card can exist before anyone has written a field on it.
 */
export function readShotMeta(raw: unknown): ShotMetaRead {
  if (raw === undefined || raw === null) return { meta: {}, unknownValues: {}, unknownFields: {}, notices: [] };
  if (!isPlainObject(raw)) {
    return {
      meta: {},
      unknownValues: {},
      unknownFields: {},
      rawPreserved: raw,
      notices: ['shot metadata is not an object; kept as written and not read'],
    };
  }

  const meta: Record<string, unknown> = {};
  const unknownValues: Record<string, unknown> = {};
  const unknownFields = Object.create(null) as Record<string, unknown>;
  const notices: string[] = [];
  const enumFields = new Set<string>(SHOT_ENUM_FIELDS);

  for (const [key, value] of Object.entries(raw)) {
    if (enumFields.has(key)) {
      const field = key as ShotEnumField;
      if (isEnumValue(field, value)) {
        meta[field] = value;
      } else {
        unknownValues[field] = value;
        notices.push(`${field} "${String(value)}" is not in the v1 list; kept, and shown as an unknown value`);
      }
    } else if (key === 'image') {
      if (isAssetId(value)) meta.image = value;
      else notices.push('image is not an asset id; the reference was dropped (images are held by id, inside the project folder)');
    } else if (key === 'imageAlt' || key === 'lens') {
      if (typeof value === 'string') meta[key] = value;
      else notices.push(`${key} is not text; dropped`);
    } else if (key === 'action') {
      if (typeof value === 'string') {
        meta.action = value;
        const length = codePointCount(value);
        if (length > ACTION_MAX_CHARS) {
          notices.push(`action is ${length} characters, over the ${ACTION_MAX_CHARS} limit; kept as written, to be shortened before the next edit`);
        }
      } else {
        notices.push('action is not text; dropped');
      }
    } else if (key === 'dialogue') {
      if (Array.isArray(value)) {
        const kept: DialogueCoverage[] = [];
        value.forEach((entry: unknown, index) => {
          const coverage = readCoverage(entry);
          if (coverage === undefined) notices.push(`dialogue entry ${index + 1} is malformed; dropped`);
          else kept.push(coverage);
        });
        meta.dialogue = kept;
      } else {
        notices.push('dialogue is not a list; dropped');
      }
    } else if (key === 'durationSec') {
      if (isDuration(value)) meta.durationSec = value;
      else notices.push('durationSec is not a finite number of seconds at least zero; dropped, so the shot is left out of animatic totals');
    } else if (key === 'vendorRefs') {
      // Carried verbatim: the video prompt pack types these, and this module must not drop them.
      if (Array.isArray(value)) meta.vendorRefs = value;
      else notices.push('vendorRefs is not a list; dropped');
    } else {
      unknownFields[key] = value;
      notices.push(`unknown field "${key}" is kept in memory and dropped on the next save`);
    }
  }

  return { meta: meta as ShotMeta, unknownValues, unknownFields, notices };
}

function encodeCoverage(list: readonly DialogueCoverage[]): unknown[] {
  return list.map((coverage) => ({
    kind: coverage.kind,
    docId: coverage.docId,
    anchor: {
      from: coverage.anchor.from,
      to: coverage.anchor.to,
      exact: coverage.anchor.exact,
      prefix: coverage.anchor.prefix,
      suffix: coverage.anchor.suffix,
      capturedRevision: coverage.anchor.capturedRevision,
    },
  }));
}

/**
 * The stored object for a read shot, in {@link SHOT_META_KEYS} order. A value the load kept as
 * unknown is written back exactly where it was, so a save does not turn an unknown value into a
 * missing one. Unknown fields are not written: §6 says they are dropped on the next save.
 */
export function writeShotMeta(read: ShotMetaRead): Record<string, unknown> {
  const meta = read.meta as Record<string, unknown>;
  const stored: Record<string, unknown> = {};
  for (const key of SHOT_META_KEYS) {
    const known = meta[key];
    if (known !== undefined) {
      stored[key] = key === 'dialogue' ? encodeCoverage(known as DialogueCoverage[]) : known;
    } else if (hasOwn(read.unknownValues, key)) {
      stored[key] = read.unknownValues[key];
    }
  }
  return stored;
}

/** What a shot node's `shot` key should hold after a read: the value kept whole, or the rebuilt object. */
export function storedValueOf(read: ShotMetaRead): unknown {
  return read.rawPreserved !== undefined ? read.rawPreserved : writeShotMeta(read);
}

/** Refuses a value outside a closed list, naming the list (§4: "unknown enum → lists valid values"). */
export function checkEnum(field: ShotEnumField, value: unknown): StoryboardRefusal | undefined {
  if (isEnumValue(field, value)) return undefined;
  const list = SHOT_ENUMS[field] as readonly string[];
  return {
    code: 'enum-invalid',
    message: `${field} "${String(value)}" is not one of the v1 values: ${list.join(', ')}`,
  };
}

/**
 * The strict check for a value about to be written. Runs on the stored shape, so it accepts what a
 * caller would pass to {@link writeShotMeta} and nothing it could not write back losslessly.
 */
export function checkShotMeta(meta: Readonly<Record<string, unknown>>): StoryboardRefusal | undefined {
  for (const field of SHOT_ENUM_FIELDS) {
    const value = meta[field];
    if (value === undefined) continue;
    const refusal = checkEnum(field, value);
    if (refusal !== undefined) return refusal;
  }
  if (meta.image !== undefined && !isAssetId(meta.image)) {
    return { code: 'image-id-invalid', message: 'image must be an asset id (a_ and ten characters), never a path' };
  }
  if (meta.action !== undefined) {
    if (typeof meta.action !== 'string') return { code: 'action-invalid', message: 'action must be text' };
    const length = codePointCount(meta.action);
    if (length > ACTION_MAX_CHARS) {
      return {
        code: 'action-too-long',
        message: `action is ${length} characters; the limit is ${ACTION_MAX_CHARS}. Shorten it, or move the rest into another shot.`,
      };
    }
  }
  if (meta.durationSec !== undefined && !isDuration(meta.durationSec)) {
    return { code: 'duration-invalid', message: 'durationSec must be a number of seconds, at least zero' };
  }
  if (meta.lens !== undefined && typeof meta.lens !== 'string') return { code: 'lens-invalid', message: 'lens must be text' };
  return undefined;
}
