/**
 * The in-shot prompt editor's model (video-prompt-pack.md §2–§3): one shot's record for one vendor, as the editor's text, and the
 * `shot.setMeta` that writes it. Nothing here applies anything. The write is the storyboard engine's `shot.setMeta`, which
 * checks the value it replaces, so a record changed since the editor opened is refused rather than overwritten.
 *
 * Every number and list is kept as text in the draft, so an input can hold a partial value while the writer types. The parse
 * into a record is strict: a value that is not a number, or a line with no `key: value` shape, is refused with the field it
 * names, and the record is never written with a value the next load would have to keep as unknown.
 */

import { t } from '@lingui/core/macro';
import { nodeById, type ProjectState } from '@caotang/store';

import { isVideoShotRef } from './prompt-pack-model.js';
import {
  SEED_MAX,
  SEED_MIN,
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODES,
  VIDEO_RESOLUTIONS,
  isShotNode,
  readShotMeta,
  shotFieldOf,
  storedValueOf,
  type BestTake,
  type ShotCommand,
  type StoryboardResult,
  type VideoAspectRatio,
  type VideoDurationSec,
  type VideoMode,
  type VideoReference,
  type VideoResolution,
  type VideoShotRef,
} from './engines.js';


/* lingui-set comment="Shot prompt record refusals. Interpolated values: shotId is a shot's id; number is a line number; first and last bound a whole number." */
/** One reference row, as text: its type, and the codex entry or the project image it names. */
export interface ReferenceDraft {
  readonly type: string;
  /** `entry:<codex id>`, `asset:<asset id>`, or `''` for a reference that names neither yet. */
  readonly target: string;
}

/** The editor's text for one vendor record. */
export interface PromptDraft {
  readonly mode: string;
  readonly camera: string;
  readonly subject: string;
  readonly action: string;
  readonly context: string;
  readonly style: string;
  readonly dialogue: string;
  readonly sfx: string;
  readonly ambient: string;
  readonly music: string;
  readonly negativePrompt: string;
  readonly durationSec: string;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly seed: string;
  readonly model: string;
  readonly promptExtend: boolean;
  readonly notes: string;
  readonly references: readonly ReferenceDraft[];
  readonly keepTake: boolean;
  readonly takeSeed: string;
  readonly takeModel: string;
  readonly takeParams: string;
  readonly takeNote: string;
}

/** A field a validation row can name, by the key the editor gives its input. */
export type PromptFieldKey =
  | 'mode'
  | 'prompt.camera'
  | 'prompt.subject'
  | 'prompt.action'
  | 'prompt.context'
  | 'prompt.style'
  | 'audio.dialogue'
  | 'negativePrompt'
  | 'durationSec'
  | 'aspectRatio'
  | 'resolution'
  | 'seed'
  | 'promptExtend'
  | 'references'
  | 'bestTake.seed'
  | 'vendor';

/**
 * The field a validation row names (`ValidationIssue.field`, in the normalized schema's names), as the editor's input key. A row
 * whose field the editor does not show returns `undefined`, and the row names no link.
 */
export function fieldKeyOf(field: string): PromptFieldKey | undefined {
  switch (field) {
    case 'mode':
      return 'mode';
    case 'prompt':
    case 'prompt.camera':
      return 'prompt.camera';
    case 'prompt.subject':
      return 'prompt.subject';
    case 'prompt.action':
      return 'prompt.action';
    case 'prompt.context':
      return 'prompt.context';
    case 'prompt.style':
      return 'prompt.style';
    case 'audio':
    case 'audio.dialogue':
      return 'audio.dialogue';
    case 'negativePrompt':
      return 'negativePrompt';
    case 'durationSec':
      return 'durationSec';
    case 'aspectRatio':
      return 'aspectRatio';
    case 'resolution':
      return 'resolution';
    case 'seed':
      return 'seed';
    case 'promptExtend':
      return 'promptExtend';
    case 'references':
      return 'references';
    case 'bestTake':
    case 'bestTake.seed':
      return 'bestTake.seed';
    case 'template':
      return 'vendor';
    default:
      return undefined;
  }
}

/** The DOM id of an editor input for a field key. Dots become dashes, so the id is a valid selector. */
export function fieldIdOf(key: PromptFieldKey): string {
  return `prompt-field-${key.replace(/\./g, '-')}`;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** A `vendorParams` record as `key: value` lines, the form the editor shows. */
function paramsText(params: Readonly<Record<string, string | number>> | undefined): string {
  if (params === undefined) return '';
  return Object.entries(params)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join('\n');
}

/** The editor's starting text for one vendor's record: the record's values, or the defaults when the shot has none for the vendor. */
export function promptDraftOf(record: VideoShotRef | undefined): PromptDraft {
  const prompt = record?.prompt ?? {};
  const audio = record?.audio ?? {};
  const take = record?.bestTake;
  return {
    mode: record?.mode ?? 't2v',
    camera: textOf(prompt.camera),
    subject: textOf(prompt.subject),
    action: textOf(prompt.action),
    context: textOf(prompt.context),
    style: textOf(prompt.style),
    dialogue: textOf(audio.dialogue),
    sfx: textOf(audio.sfx),
    ambient: textOf(audio.ambient),
    music: textOf(audio.music),
    negativePrompt: textOf(record?.negativePrompt),
    durationSec: numberText(record?.durationSec),
    aspectRatio: textOf(record?.aspectRatio),
    resolution: textOf(record?.resolution),
    seed: numberText(record?.seed),
    model: textOf(record?.model),
    promptExtend: record?.promptExtend ?? false,
    notes: textOf(record?.notes),
    references: (record?.references ?? []).map((reference) => ({
      type: reference.type,
      target: reference.entryId !== undefined ? `entry:${reference.entryId}` : reference.assetId !== undefined ? `asset:${reference.assetId}` : '',
    })),
    keepTake: take !== undefined,
    takeSeed: numberText(take?.seed),
    takeModel: textOf(take?.model),
    takeParams: paramsText(take?.vendorParams),
    takeNote: textOf(take?.note),
  };
}

/** The refusal of one field: the field's key, and a sentence the writer can act on. */
export interface DraftRefusal {
  readonly field: PromptFieldKey;
  readonly message: string;
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: DraftRefusal };

function refuse(field: PromptFieldKey, message: string): { readonly ok: false; readonly refusal: DraftRefusal } {
  return { ok: false, refusal: { field, message } };
}

/** A whole number from the text, or `undefined` when the text is not one. */
function wholeNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/** A reference's target text as the reference it names, or `undefined` for a target the writer has not chosen yet. */
function referenceOf(draft: ReferenceDraft): VideoReference | undefined {
  const type = draft.type as VideoReference['type'];
  if (draft.target.startsWith('entry:')) return { type, entryId: draft.target.slice('entry:'.length) };
  if (draft.target.startsWith('asset:')) return { type, assetId: draft.target.slice('asset:'.length) };
  return undefined;
}

/** The best take's settings from its text: one `key: value` per line, with a number kept as a number. */
function paramsOf(text: string): Parsed<Record<string, string | number>> {
  const params: Record<string, string | number> = {};
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const match = /^([^:]+):\s*(.+)$/.exec(line);
    if (match === null) {
      const number = index + 1;
      return refuse('bestTake.seed', t`line ${number} of the take's settings is not "key: value"`);
    }
    const key = (match[1] ?? '').trim();
    const value = (match[2] ?? '').trim();
    params[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return { ok: true, value: params };
}

/**
 * The record one draft writes, or the refusal of the field it cannot be written from. The vendor is the template's id, so the
 * record is never written under another name. A reference with no target is refused, not dropped.
 */
export function recordOfDraft(vendor: string, draft: PromptDraft): Parsed<VideoShotRef> {
  if (!(VIDEO_MODES as readonly string[]).includes(draft.mode)) return refuse('mode', t`the mode is t2v or i2v`);
  let durationSec: VideoDurationSec | undefined;
  if (draft.durationSec.trim() !== '') {
    const seconds = Number(draft.durationSec);
    if (!Number.isFinite(seconds) || seconds < 0) return refuse('durationSec', t`the duration is a number of seconds, at least zero`);
    durationSec = seconds as VideoDurationSec;
  }
  if (draft.aspectRatio !== '' && !(VIDEO_ASPECT_RATIOS as readonly string[]).includes(draft.aspectRatio)) {
    return refuse('aspectRatio', t`the aspect ratio is one of the ratios in the list`);
  }
  if (draft.resolution !== '' && !(VIDEO_RESOLUTIONS as readonly string[]).includes(draft.resolution)) {
    return refuse('resolution', t`the resolution is 720p or 1080p`);
  }
  let seed: number | undefined;
  if (draft.seed.trim() !== '') {
    seed = wholeNumber(draft.seed) ?? Number.NaN;
    if (!Number.isInteger(seed) || seed < SEED_MIN || seed > SEED_MAX) {
      const first = SEED_MIN;
      const last = SEED_MAX;
      return refuse('seed', t`a seed is a whole number from ${first} to ${last}`);
    }
  }
  const references: VideoReference[] = [];
  for (const reference of draft.references) {
    const parsed = referenceOf(reference);
    if (parsed === undefined) return refuse('references', t`every reference names a codex entry or a project image, or is taken out`);
    references.push(parsed);
  }
  let bestTake: BestTake | undefined;
  if (draft.keepTake) {
    const takeSeed = wholeNumber(draft.takeSeed);
    if (takeSeed === undefined || takeSeed < SEED_MIN || takeSeed > SEED_MAX) {
      const first = SEED_MIN;
      const last = SEED_MAX;
      return refuse('bestTake.seed', t`the take's seed is a whole number from ${first} to ${last}`);
    }
    const params = paramsOf(draft.takeParams);
    if (!params.ok) return params;
    bestTake = {
      seed: takeSeed,
      model: draft.takeModel.trim(),
      vendorParams: params.value,
      ...(draft.takeNote.trim() === '' ? {} : { note: draft.takeNote.trim() }),
    };
  }

  const text = (value: string): string | undefined => (value === '' ? undefined : value);
  const audio = {
    ...(text(draft.dialogue) === undefined ? {} : { dialogue: draft.dialogue }),
    ...(text(draft.sfx) === undefined ? {} : { sfx: draft.sfx }),
    ...(text(draft.ambient) === undefined ? {} : { ambient: draft.ambient }),
    ...(text(draft.music) === undefined ? {} : { music: draft.music }),
  };
  const value: VideoShotRef = {
    vendor,
    mode: draft.mode as VideoMode,
    prompt: {
      ...(text(draft.camera) === undefined ? {} : { camera: draft.camera }),
      ...(text(draft.subject) === undefined ? {} : { subject: draft.subject }),
      ...(text(draft.action) === undefined ? {} : { action: draft.action }),
      ...(text(draft.context) === undefined ? {} : { context: draft.context }),
      ...(text(draft.style) === undefined ? {} : { style: draft.style }),
    },
    ...(Object.keys(audio).length === 0 ? {} : { audio }),
    ...(text(draft.model.trim()) === undefined ? {} : { model: draft.model.trim() }),
    ...(text(draft.negativePrompt) === undefined ? {} : { negativePrompt: draft.negativePrompt }),
    ...(durationSec === undefined ? {} : { durationSec }),
    ...(text(draft.aspectRatio) === undefined ? {} : { aspectRatio: draft.aspectRatio as VideoAspectRatio }),
    ...(text(draft.resolution) === undefined ? {} : { resolution: draft.resolution as VideoResolution }),
    ...(seed === undefined ? {} : { seed }),
    ...(draft.promptExtend ? { promptExtend: true } : {}),
    references,
    ...(text(draft.notes) === undefined ? {} : { notes: draft.notes }),
    ...(bestTake === undefined ? {} : { bestTake }),
  };
  return { ok: true, value };
}

/** Whether a stored `vendorRefs` entry names a vendor, read defensively: a malformed entry names none. */
function vendorOf(entry: unknown): unknown {
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as { vendor?: unknown }).vendor : undefined;
}

/**
 * The `shot.setMeta` that writes one vendor's record into a shot's `vendorRefs`: replaced where the vendor already has one, and
 * appended where it does not. The other vendors' records, and every other field, are kept as they are.
 */
export function promptEditCommand(state: ProjectState, shotId: string, vendor: string, draft: PromptDraft): StoryboardResult<ShotCommand> {
  const node = nodeById(state, shotId);
  if (node === undefined || !isShotNode(node)) return { ok: false, refusal: { code: 'not-a-shot', message: t`no shot "${shotId}" to write a prompt on` } };
  const parsed = recordOfDraft(vendor, draft);
  if (!parsed.ok) return { ok: false, refusal: { code: 'prompt-invalid', message: parsed.refusal.message } };
  const record = parsed.value;
  return writeVendorRefs(state, shotId, (current) => {
    const index = current.findIndex((entry) => vendorOf(entry) === vendor);
    return index < 0 ? [...current, record] : current.map((entry, at) => (at === index ? record : entry));
  });
}

/** The `shot.setMeta` that removes one vendor's record from a shot. The record is taken out and nothing else changes. */
export function clearPromptCommand(state: ProjectState, shotId: string, vendor: string): StoryboardResult<ShotCommand> {
  const node = nodeById(state, shotId);
  if (node === undefined || !isShotNode(node)) return { ok: false, refusal: { code: 'not-a-shot', message: t`no shot "${shotId}"` } };
  return writeVendorRefs(state, shotId, (current) => current.filter((entry) => vendorOf(entry) !== vendor));
}

function writeVendorRefs(
  state: ProjectState,
  shotId: string,
  next: (current: readonly unknown[]) => readonly unknown[],
): StoryboardResult<ShotCommand> {
  const node = nodeById(state, shotId);
  if (node === undefined) return { ok: false, refusal: { code: 'not-a-shot', message: t`no shot "${shotId}"` } };
  const raw = shotFieldOf(node);
  const base: Record<string, unknown> = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const current: readonly unknown[] = Array.isArray(base.vendorRefs) ? base.vendorRefs : [];
  const written = [...next(current)];
  if (written.length === 0) delete base.vendorRefs;
  else base.vendorRefs = written;
  const stored = storedValueOf(readShotMeta(base));
  const empty = stored === null || typeof stored !== 'object' || Object.keys(stored).length === 0;
  return {
    ok: true,
    value: {
      name: 'shot.setMeta',
      params: { nodeId: shotId, stored: empty ? null : (stored as Readonly<Record<string, unknown>>), expect: raw === undefined ? null : raw },
    },
  };
}

/** The record a shot holds for one vendor, when it holds a readable one. The editor starts from it. */
export function recordOf(state: ProjectState, shotId: string, vendor: string): VideoShotRef | undefined {
  const node = nodeById(state, shotId);
  if (node === undefined) return undefined;
  const found: unknown = (readShotMeta(shotFieldOf(node)).meta.vendorRefs ?? []).find((entry: unknown) => vendorOf(entry) === vendor);
  // A stored record the pack cannot read is not a starting point: the editor opens empty, and the panel names the unreadable record.
  return found !== undefined && isVideoShotRef(found) ? found : undefined;
}

/**
 * The text the editor holds for one vendor of one shot: what the writer has typed, the text the stored record gave, and the stored
 * record it came from. The editor keeps one per vendor, so a switch to another vendor does not lose the text typed for this one.
 */
export interface VendorDraftState {
  readonly draft: PromptDraft;
  /** The text the stored record gave. A draft the writer changed is one whose text differs from this. */
  readonly seeded: PromptDraft;
  /** The stored record the text came from, as {@link storedKeyOf} reads it, so a later change to that record is seen. */
  readonly storedKey: string;
}

/** The key a stored record is compared by: its JSON, and `null` where the vendor has no record. */
export function storedKeyOf(record: VideoShotRef | undefined): string {
  return JSON.stringify(record ?? null);
}

/** The editor's state for one vendor from its stored record: the record's text, with nothing typed. */
export function vendorDraftOf(record: VideoShotRef | undefined): VendorDraftState {
  const seeded = promptDraftOf(record);
  return { draft: seeded, seeded, storedKey: storedKeyOf(record) };
}

/** Whether the writer has typed text the stored record does not hold. */
export function hasUnsavedText(state: VendorDraftState): boolean {
  return JSON.stringify(state.draft) !== JSON.stringify(state.seeded);
}

/**
 * The state a vendor's editor shows, given the state the editor holds and the stored record now. While the stored record is the one
 * the held text came from, the held text stands, whichever vendor is on screen. When the record has changed since (an undo, or an
 * agent's apply to this shot), the editor takes the stored values, and `replaced` says whether unsaved text was replaced by them, so the
 * editor can say so. Nothing is replaced silently when the writer had typed something.
 */
export function syncVendorDraft(
  held: VendorDraftState | undefined,
  record: VideoShotRef | undefined,
): { readonly state: VendorDraftState; readonly replaced: boolean } {
  if (held === undefined) return { state: vendorDraftOf(record), replaced: false };
  if (held.storedKey === storedKeyOf(record)) return { state: held, replaced: false };
  return { state: vendorDraftOf(record), replaced: hasUnsavedText(held) };
}
