/**
 * The storyboard vocabulary — [storyboard.md](../../../docs/architecture/storyboard.md) §2 and §4.
 *
 * Two node facts belong to this module and to no other: the `shot` node type, and the
 * `storyboard` kind on the folder that holds shots (§2.1). The per-shot metadata is one
 * object, {@link ShotMeta} (§2.2), stored under the node's `shot` key.
 *
 * The store's `TreeNode` declares both fields (`kind` and `shot`), and this module
 * reads and writes them through the {@link StoryboardNode} view, so the engine and the saved
 * project agree on them.
 *
 * The enum lists are the closed v1 sets of §2.2. `test/model.test.ts` reads them back out
 * of the spec, so a list cannot drift from the file that defines it.
 */

import type { TreeNode } from '@caotang/store';

/** The node type a shot card is. Loaders keep an unknown type, and this one is known. */
export const SHOT_NODE_TYPE = 'shot';

/** The `kind` a folder carries when it holds shots (§2.1). */
export const STORYBOARD_KIND = 'storyboard';

/** The `kind` a document carries when it is a screenplay scene (screenplay.md §2.1). Absent means prose. */
export const SCREENPLAY_KIND = 'screenplay';

/** The suffix `shots.derive` gives the folder it creates: `<Scene Title> — Shots` (§4). */
export const DERIVE_FOLDER_SUFFIX = ' — Shots';

export const SHOT_SIZES = ['WS', 'FS', 'MFS', 'MS', 'MCU', 'CU', 'ECU', 'OTS', 'POV', 'INSERT'] as const;
export const CAMERA_ANGLES = ['eye', 'low', 'high', 'birds', 'worms', 'dutch', 'overhead'] as const;
export const CAMERA_MOVEMENTS = [
  'static',
  'pan',
  'tilt',
  'dolly-in',
  'dolly-out',
  'truck',
  'crane',
  'handheld',
  'zoom',
  'rack-focus',
] as const;
export const TRANSITIONS = ['cut', 'dissolve', 'wipe', 'fade-in', 'fade-out', 'match-on-action'] as const;

export type ShotSize = (typeof SHOT_SIZES)[number];
export type CameraAngle = (typeof CAMERA_ANGLES)[number];
export type CameraMovement = (typeof CAMERA_MOVEMENTS)[number];
export type Transition = (typeof TRANSITIONS)[number];

/**
 * The four closed enum fields and their lists. A value outside a list is refused on a
 * write, and on a load it is kept verbatim and shown as an unknown value (§2.2).
 */
export const SHOT_ENUMS = {
  shotSize: SHOT_SIZES,
  cameraAngle: CAMERA_ANGLES,
  cameraMovement: CAMERA_MOVEMENTS,
  transition: TRANSITIONS,
} as const;

export type ShotEnumField = keyof typeof SHOT_ENUMS;

export const SHOT_ENUM_FIELDS: readonly ShotEnumField[] = ['shotSize', 'cameraAngle', 'cameraMovement', 'transition'];

/**
 * The words the shot editor shows for each enum value (storyboard.md §3.2, and the writer-facing copy rule). The stored value is always
 * the enum value; a label is only what the writer reads. The type makes every value of a list carry a label, so a value added to a list
 * cannot reach the editor as a raw token. The apostrophe is the typographic one the rest of the app uses.
 */
export const SHOT_ENUM_LABELS: {
  readonly [F in ShotEnumField]: { readonly [V in (typeof SHOT_ENUMS)[F][number]]: string };
} = {
  shotSize: {
    WS: 'Wide shot (WS)',
    FS: 'Full shot (FS)',
    MFS: 'Medium full shot (MFS)',
    MS: 'Medium shot (MS)',
    MCU: 'Medium close-up (MCU)',
    CU: 'Close-up (CU)',
    ECU: 'Extreme close-up (ECU)',
    OTS: 'Over the shoulder (OTS)',
    POV: 'Point of view (POV)',
    INSERT: 'Insert',
  },
  cameraAngle: {
    eye: 'Eye level',
    low: 'Low angle',
    high: 'High angle',
    birds: 'Bird’s-eye view',
    worms: 'Worm’s-eye view',
    dutch: 'Dutch angle',
    overhead: 'Overhead',
  },
  cameraMovement: {
    static: 'Static',
    pan: 'Pan',
    tilt: 'Tilt',
    'dolly-in': 'Dolly in',
    'dolly-out': 'Dolly out',
    truck: 'Truck',
    crane: 'Crane',
    handheld: 'Handheld',
    zoom: 'Zoom',
    'rack-focus': 'Rack focus',
  },
  transition: {
    cut: 'Cut',
    dissolve: 'Dissolve',
    wipe: 'Wipe',
    'fade-in': 'Fade in',
    'fade-out': 'Fade out',
    'match-on-action': 'Match on action',
  },
};

/**
 * The key order a `shot` object is written in. Fixed, so a manifest diff is one line per
 * changed shot, the same discipline project-format §2 applies to `tree[]`.
 */
export const SHOT_META_KEYS = [
  'image',
  'imageAlt',
  'shotSize',
  'cameraAngle',
  'cameraMovement',
  'lens',
  'action',
  'dialogue',
  'durationSec',
  'transition',
  'vendorRefs',
] as const;

/** §2.2: `action` is at most 1000 characters. Counted in code points, the unit the spec's prose uses. */
export const ACTION_MAX_CHARS = 1000;

/** §4: `shots.annotate` takes at most 50 shot ids per call, and says to split above it. */
export const ANNOTATE_MAX_SHOTS = 50;

/** §4: `shots.derive` refuses above 60 proposed shots, with a split suggestion. */
export const DERIVE_MAX_SHOTS = 60;

/** The longest a derived shot's title reads before it is cut, code points including the ellipsis. */
export const DERIVE_TITLE_CHARS = 40;

/** §4's `granularity` values. The default is `key-shots`. */
export const DERIVE_GRANULARITIES = ['key-shots', 'full-coverage'] as const;
export type DeriveGranularity = (typeof DERIVE_GRANULARITIES)[number];

/**
 * edit-anchors.md §2's `TextAnchor`, declared with the same six fields and the same offsets. The
 * editor's type is the one the apply path uses; this copy keeps the storyboard engine free of the
 * editor's runtime dependencies, and the shared field list is what keeps the two interchangeable.
 */
export interface TextAnchor {
  readonly from: number;
  readonly to: number;
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly capturedRevision: number;
}

/** §2.2's `DialogueCoverage`: the covered cue, dialogue or heading range in a screenplay scene. */
export interface DialogueCoverage {
  readonly kind: 'fountain-element';
  readonly docId: string;
  readonly anchor: TextAnchor;
}

/**
 * The shot record (§2.2). Enum fields carry only values from their lists; a loaded value
 * outside a list is held beside this object by {@link ShotMetaRead}, not inside it.
 */
export interface ShotMeta {
  /** An asset id (`a_` + 10 Crockford characters), never a path. */
  image?: string;
  imageAlt?: string;
  shotSize?: ShotSize;
  cameraAngle?: CameraAngle;
  cameraMovement?: CameraMovement;
  /** Free text, no enum (§2.2: "free field, no enum"). */
  lens?: string;
  action?: string;
  dialogue?: DialogueCoverage[];
  /** Seconds, finite and at least zero. Missing means the shot is left out of animatic totals. */
  durationSec?: number;
  transition?: Transition;
  /** Reserved for the video prompt pack (video-prompt-pack.md §4). Carried verbatim here, typed there. */
  vendorRefs?: unknown[];
}

/**
 * The two additive node fields this module owns. Typed `unknown` because the store does
 * not declare them, so a reader must check them before trusting them.
 */
export interface StoryboardFields {
  readonly kind?: unknown;
  readonly shot?: unknown;
}

/** A tree node as this module sees it: the store's node plus the two additive fields. */
export type StoryboardNode = TreeNode & StoryboardFields;

/** The `kind` marker on a node, when it is a string. Absent is `undefined`, not a default. */
export function kindOf(node: TreeNode): string | undefined {
  const kind = (node as StoryboardFields).kind;
  return typeof kind === 'string' ? kind : undefined;
}

export function isShotNode(node: TreeNode): boolean {
  return node.type === SHOT_NODE_TYPE;
}

/** A folder marked `kind: 'storyboard'` (§3.1): the corkboard renders it in shot mode. */
export function isStoryboardFolder(node: TreeNode): boolean {
  return node.type === 'folder' && kindOf(node) === STORYBOARD_KIND;
}

/** A document marked `kind: 'screenplay'`, the only kind `shots.derive` reads (§4). */
export function isScreenplayDocument(node: TreeNode): boolean {
  return node.type === 'document' && kindOf(node) === SCREENPLAY_KIND;
}

/** Formats a duration the way the spec row and the CSV both print it: no trailing zeros, at most two places. */
export function durationText(seconds: number): string {
  return String(Math.round(seconds * 100) / 100);
}

/**
 * The words the shot editor shows for one closed-list value. The stored value stays the enum value; this is only what the writer reads.
 * A value the list does not have (a kept unknown) is returned as it is, because the writer has to see what the file holds.
 */
export function enumLabelOf(field: ShotEnumField, value: string): string {
  const labels: Readonly<Record<string, string>> = SHOT_ENUM_LABELS[field];
  return Object.prototype.hasOwnProperty.call(labels, value) ? (labels[value] ?? value) : value;
}

function labelledEnumOf(stored: Readonly<Record<string, unknown>>, field: ShotEnumField): string | undefined {
  const value = stored[field];
  return typeof value === 'string' && value !== '' ? enumLabelOf(field, value) : undefined;
}

function specPartsOf(stored: Readonly<Record<string, unknown>>): string[] {
  const parts: string[] = [];
  for (const field of ['shotSize', 'cameraAngle', 'cameraMovement'] as const) {
    const label = labelledEnumOf(stored, field);
    if (label !== undefined) parts.push(label);
  }
  const duration = stored.durationSec;
  if (typeof duration === 'number' && Number.isFinite(duration)) parts.push(`${durationText(duration)} s`);
  return parts;
}

/**
 * The spec row a card shows: `shotSize · cameraAngle · cameraMovement · durationSec s` (§3.1), each closed-list value as the shot
 * editor words it ({@link enumLabelOf}). A part that is absent is left out, so the row never has an empty slot. Reads the stored
 * object, so a value kept as unknown still shows as it is, which is what the writer needs to see.
 */
export function specRowOf(stored: Readonly<Record<string, unknown>>): string {
  return specPartsOf(stored).join(' · ');
}

/**
 * The whole row the board's M card and the contact sheet print: {@link specRowOf}'s parts, then the lens and the transition when they
 * are set, the transition in the editor's words too. One builder, so no surface can print a transition as its token.
 */
export function cardSpecRowOf(stored: Readonly<Record<string, unknown>>): string {
  const parts = specPartsOf(stored);
  const lens = stored.lens;
  if (typeof lens === 'string' && lens.trim() !== '') parts.push(lens.trim());
  const transition = labelledEnumOf(stored, 'transition');
  if (transition !== undefined) parts.push(transition);
  return parts.join(' · ');
}
