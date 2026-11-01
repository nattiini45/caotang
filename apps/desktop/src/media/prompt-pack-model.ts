/**
 * The prompt pack panel's model: one storyboard folder's shots, run through one vendor template.
 *
 * The engine does the work (`preparePack`, `renderPromptPack`). This file only builds the snapshot the engine reads
 * from the project, and turns the run into the rows a panel shows. It writes nothing. The export is a file the writer
 * downloads, and a file never reaches a vendor from here (video-prompt-pack.md §1, the BYOK boundary).
 *
 * A stored prompt record is read before the engine sees it. A record whose fields have the wrong type is left out of
 * the pack and reported as a row, so the engine is never handed a value it would throw on. A record the engine throws
 * on anyway is set aside on its own shot as an error row, so one bad shot cannot take the pack, or the panel, down.
 */

import { isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { nodeById, type ProjectState, type TreeNode } from '@caotang/store';

import {
  REFERENCE_TYPES,
  VIDEO_MODES,
  VIDEO_TEMPLATES,
  mentionWords,
  preparePack,
  readShotMeta,
  renderPromptPack,
  shotFieldOf,
  shotNumbers,
  shotsIn,
  templateById,
  vendorRefOf,
  withheldWords,
  type AssetRecord,
  type CoveredScript,
  type PackArtifact,
  type PackRun,
  type ReferenceProvenance,
  type ShotNode,
  type StoryboardSnapshot,
  type ValidationIssue,
  type VideoShotRef,
  type VideoVendorTemplate,
} from './engines.js';


/* lingui-set comment="Prompt pack rows and checks. Interpolated values: name, shot and problem are a codex entry name, a shot label and a record problem; vendor is a video model's name; reason and failure are failure messages; where and the reasons come from the pack engine; the count is a number." */
/** The three artifacts an export writes, with the label and the MIME type each download carries. */
export const PACK_ARTIFACTS: readonly { readonly artifact: PackArtifact; readonly label: string; readonly mime: string }[] = [
  { artifact: 'json', get label() {
      return t`JSON pack`;
    }, mime: 'application/json' },
  { artifact: 'markdown', get label() {
      return t`Markdown pack`;
    }, mime: 'text/markdown' },
  { artifact: 'csv', get label() {
      return t`CSV shot list`;
    }, mime: 'text/csv' },
];

/** The templates a panel offers, in the engine's order. */
export const PACK_TEMPLATES: readonly VideoVendorTemplate[] = VIDEO_TEMPLATES;

/** The prompt's five parts, each text when present. */
const PROMPT_PARTS = ['camera', 'subject', 'action', 'context', 'style'] as const;
/** The four audio cues, each text when present. */
const AUDIO_CUES = ['dialogue', 'sfx', 'ambient', 'music'] as const;
/** The record's own fields that are text when present. */
const TEXT_FIELDS = ['model', 'aspectRatio', 'resolution', 'negativePrompt', 'notes'] as const;
/** The record's own fields that are numbers when present. */
const NUMBER_FIELDS = ['durationSec', 'seed'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why a stored `vendorRefs` entry cannot be read as a prompt record, in words the writer can act on, or `null` when it
 * can. This checks the types the engine reads, not the values: a mode, duration or aspect ratio outside its list is the
 * engine's to refuse, and its row names the list. A value of the wrong type is refused here, because the engine would
 * throw on it (`clean` calls `trim` on every prompt part, and `resolveReferences` reads each reference's fields).
 */
export function recordProblemOf(value: unknown): string | null {
  if (!isPlainObject(value)) return t`it is not an object`;
  if (typeof value.vendor !== 'string') return t`vendor is not text`;
  if (!(VIDEO_MODES as readonly unknown[]).includes(value.mode)) {
    const modes = VIDEO_MODES.join(', ');
    return t`mode is not one of ${modes}`;
  }

  const prompt = value.prompt;
  if (!isPlainObject(prompt)) return t`prompt is not an object`;
  for (const part of PROMPT_PARTS) {
    if (prompt[part] !== undefined && typeof prompt[part] !== 'string') {
      const name = `prompt.${part}`;
      return t`${name} is not text`;
    }
  }

  const audio = value.audio;
  if (audio !== undefined) {
    if (!isPlainObject(audio)) return t`audio is not an object`;
    for (const cue of AUDIO_CUES) {
      if (audio[cue] !== undefined && typeof audio[cue] !== 'string') {
        const name = `audio.${cue}`;
        return t`${name} is not text`;
      }
    }
  }

  for (const field of TEXT_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return t`${field} is not text`;
  }
  for (const field of NUMBER_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== 'number') return t`${field} is not a number`;
  }
  if (value.promptExtend !== undefined && typeof value.promptExtend !== 'boolean') return t`promptExtend is not true or false`;

  const references = value.references;
  if (!Array.isArray(references)) return t`references is not a list`;
  for (const [index, reference] of (references as unknown[]).entries()) {
    const item = index + 1;
    const types = REFERENCE_TYPES.join(', ');
    if (!isPlainObject(reference)) return t`references item ${item} is not an object`;
    if (!(REFERENCE_TYPES as readonly unknown[]).includes(reference.type)) return t`references item ${item} has no type from ${types}`;
    for (const key of ['entryId', 'assetId'] as const) {
      if (reference[key] !== undefined && typeof reference[key] !== 'string') return t`references item ${item} ${key} is not text`;
    }
  }

  const take = value.bestTake;
  if (take !== undefined) {
    if (!isPlainObject(take)) return t`bestTake is not an object`;
    if (typeof take.seed !== 'number') return t`bestTake.seed is not a number`;
    if (typeof take.model !== 'string') return t`bestTake.model is not text`;
    const params = take.vendorParams;
    if (!isPlainObject(params)) return t`bestTake.vendorParams is not an object`;
    for (const [key, param] of Object.entries(params)) {
      if (typeof param !== 'string' && typeof param !== 'number') return t`bestTake.vendorParams.${key} is not text or a number`;
    }
    if (take.note !== undefined && typeof take.note !== 'string') return t`bestTake.note is not text`;
  }
  return null;
}

/** A stored `vendorRefs` entry that reads as a prompt record. Anything else is left out of the pack, not guessed at. */
export function isVideoShotRef(value: unknown): value is VideoShotRef {
  return recordProblemOf(value) === null;
}

function titleOf(state: ProjectState, id: string): string {
  return nodeById(state, id)?.title ?? id;
}

/** One shot as the engine reads it: its prose fields, its covered script text, and its readable prompt records. */
function shotNodeOf(state: ProjectState, node: TreeNode): ShotNode {
  const meta = readShotMeta(shotFieldOf(node)).meta;
  // The anchors carry the text the writer covered, as captured. The pack reads it for codex mentions (video-prompt-pack §3).
  const covered: CoveredScript[] = (meta.dialogue ?? []).map((coverage) => ({
    label: titleOf(state, coverage.docId),
    text: coverage.anchor.exact,
  }));
  return {
    id: node.id,
    action: meta.action,
    imageAlt: meta.imageAlt,
    shotSize: meta.shotSize,
    cameraAngle: meta.cameraAngle,
    cameraMovement: meta.cameraMovement,
    lens: meta.lens,
    durationSec: meta.durationSec,
    covered,
    vendorRefs: (meta.vendorRefs ?? []).filter(isVideoShotRef),
  };
}

/**
 * The snapshot the engine reads, for one storyboard folder. `assets` is the project's asset records, which the caller
 * lists from the folder (`listAssets`); without it a visual reference names no file and the pack says so.
 */
export function storyboardSnapshotOf(
  state: ProjectState,
  folderId: string,
  assets: ReadonlyMap<string, AssetRecord> = new Map(),
): StoryboardSnapshot {
  return {
    tree: state.manifest.tree,
    shots: shotsIn(state, folderId).map((node) => shotNodeOf(state, node)),
    codex: state.manifest.codex ?? [],
    assets,
  };
}

/**
 * A row about a stored record, which the template's own rules do not raise. `unreadable-record` is a record the guard
 * refused (a warning: the shot is left out of the pack) or one the engine threw on (an error: the export is held).
 * `pack-failed` is a throw the pack could not attribute to one shot (an error: the export is held).
 */
export interface RecordIssue {
  readonly code: 'unreadable-record' | 'pack-failed';
  readonly severity: 'error' | 'warning';
  readonly field: string;
  readonly message: string;
  readonly shotId?: string;
  readonly vendor?: string;
}

/** Every row the panel can show: the engine's, or one about a stored record. */
export type PanelIssue = ValidationIssue | RecordIssue;

/** One shot's row in the panel: what the prompt says, what it attaches, and the vendor's own field names. */
export interface PackShotRow {
  readonly shotId: string;
  readonly number: number;
  readonly mode: string;
  readonly durationSec: number | null;
  readonly aspect: string;
  readonly prompt: string;
  readonly negative: string;
  readonly audio: readonly string[];
  /** A file name where the project holds the asset, otherwise the reference's type or codex label. */
  readonly references: readonly string[];
  /** Which codex entries the references came from, and which the shot names that sent nothing (video-prompt-pack.md §3). */
  readonly consistency: readonly string[];
  readonly bestTake: boolean;
  readonly mapped: Readonly<Record<string, unknown>>;
  /** Every row about this shot: the engine's, and any about its stored record. */
  readonly issues: readonly PanelIssue[];
}

export interface PackPreview {
  readonly template: VideoVendorTemplate;
  readonly rows: readonly PackShotRow[];
  /** Every row an export raises: the template's own note, the engine's rows, and the rows about stored records. */
  readonly issues: readonly PanelIssue[];
  readonly errors: number;
  readonly warnings: number;
  /** The shots in the folder with no readable prompt for this template: none stored, or a record the pack could not read. */
  readonly missing: readonly string[];
  /** Export is held while a row is an error, so no file is written from a prompt the vendor would refuse, or from a record it cannot read. */
  readonly canExport: boolean;
  /** The engine's run over the readable records, or `null` when the run as a whole could not be built. */
  readonly run: PackRun | null;
}

/**
 * The engine's own run over one shot alone. The snapshot is the whole folder's, so the shot keeps its folder number. Returns
 * the failure the engine threw, or `null` when the shot's record reads through the whole pipeline.
 */
function probeShot(snapshot: StoryboardSnapshot, templateId: string, shotId: string): string | null {
  try {
    preparePack(snapshot, templateId, [shotId]);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

/**
 * The stored records of a folder's shots that the guard refuses, with the reason. A record that names another vendor belongs
 * to that vendor's pack, so this pack does not list it. A record with no vendor name is listed in every pack, since no pack
 * can claim it.
 */
function unreadRecordsOf(state: ProjectState, folderId: string, templateId: string): { readonly shotId: string; readonly problem: string }[] {
  return shotsIn(state, folderId).flatMap((node) => {
    const stored = readShotMeta(shotFieldOf(node)).meta.vendorRefs ?? [];
    return stored.flatMap((value) => {
      const problem = recordProblemOf(value);
      if (problem === null) return [];
      const vendor = isPlainObject(value) ? value.vendor : undefined;
      if (typeof vendor === 'string' && vendor !== templateId) return [];
      return [{ shotId: node.id, problem }];
    });
  });
}

/**
 * The consistency lines of one shot's references (video-prompt-pack.md §3): each codex entry that supplied a reference, with where
 * it was named and how many files it sent, and each entry the shot names that sent nothing, with the reason. The wording is the
 * engine's, so the panel and the Markdown pack say the same thing.
 */
export function consistencyLinesOf(provenance: ReferenceProvenance): string[] {
  return [
    ...provenance.supplied.map((entry) => {
      const name = isolate(entry.name);
      const where = mentionWords(entry.where);
      const count = entry.assetIds.length;
      return entry.reason === 'override'
        ? plural(count, { one: `${name}: named by this shot, sends # reference`, other: `${name}: named by this shot, sends # references` })
        : plural(count, { one: `${name}: mentioned in ${where}, sends # reference`, other: `${name}: mentioned in ${where}, sends # references` });
    }),
    ...provenance.withheld.map((entry) => {
      const name = isolate(entry.name);
      const reason = withheldWords(entry.reason);
      return t`${name}: not sent, because ${reason}`;
    }),
  ];
}

/**
 * The engine words two rows as the drafting step: "Draft it to include it" (pack.ts) and "Draft the prompt" (validate.ts). The
 * panel words them for the place a writer fixes them, the shot's fields on the board. The code and the severity are the
 * engine's, so the rule is unchanged.
 */
function wordedFor(issue: ValidationIssue, numbers: ReadonlyMap<string, number>, displayName: string): ValidationIssue {
  if (issue.code !== 'empty-prompt') return issue;
  const number = issue.shotId === undefined ? undefined : numbers.get(issue.shotId);
  const shot = number === undefined ? t`This shot` : t`Shot ${number}`;
  const vendor = displayName;
  if (issue.severity === 'warning') {
    return { ...issue, message: t`${shot} has no prompt for ${vendor} yet, so the pack leaves it out. Write its prompt in the shot's fields on the board.` };
  }
  return {
    ...issue,
    message: t`The shot has no prompt text for ${vendor}. Its camera, subject, action or context needs text, which the shot's fields on the board take.`,
  };
}

/** The panel's view of one template over one folder. `null` only when the template id names no template. */
export function packPreviewOf(
  state: ProjectState,
  folderId: string,
  templateId: string,
  assets: ReadonlyMap<string, AssetRecord> = new Map(),
): PackPreview | null {
  const template = templateById(templateId);
  if (template === undefined) return null;
  const snapshot = storyboardSnapshotOf(state, folderId, assets);
  const numbers = shotNumbers(snapshot);
  const shotLabel = (shotId: string): string => {
    const number = numbers.get(shotId);
    return number === undefined ? t`A shot` : t`Shot ${number}`;
  };

  // A stored record the guard refuses is left out of the pack. Its row says why, and its shot counts as missing.
  const issues: PanelIssue[] = unreadRecordsOf(state, folderId, template.id).map(
    ({ shotId, problem }): PanelIssue => {
      const shot = shotLabel(shotId);
      return {
        code: 'unreadable-record',
        severity: 'warning',
        field: 'vendorRefs',
        message: t`${shot} has a stored prompt record that is not readable (${problem}). It is left out of this pack until the record is fixed.`,
        shotId,
      };
    },
  );

  // Each shot's record is run on its own first, so a throw is attributed to the shot it came from. That record is set aside
  // as an error row, and the pack is built without it. Every other shot is unaffected.
  const setAside = new Map<string, string>();
  for (const shot of snapshot.shots) {
    if (vendorRefOf(shot, template.id) === undefined) continue;
    const failure = probeShot(snapshot, template.id, shot.id);
    if (failure !== null) setAside.set(shot.id, failure);
  }
  const vendor = template.displayName;
  for (const [shotId, failure] of setAside) {
    const shot = shotLabel(shotId);
    issues.push({
      code: 'unreadable-record',
      severity: 'error',
      field: 'vendorRefs',
      message: t`${shot} has a stored ${vendor} prompt that the pack could not read (${failure}). The export is held until the record is fixed.`,
      shotId,
      vendor: template.id,
    });
  }
  const working: StoryboardSnapshot =
    setAside.size === 0
      ? snapshot
      : {
          ...snapshot,
          shots: snapshot.shots.map((shot) =>
            setAside.has(shot.id) ? { ...shot, vendorRefs: (shot.vendorRefs ?? []).filter((ref) => ref.vendor !== template.id) } : shot,
          ),
        };

  // The engine's run over what is left. A throw here is not attributable to one shot, so it is one error row for the pack.
  let run: PackRun | null = null;
  try {
    run = preparePack(working, template.id);
  } catch (error) {
    const reason = messageOf(error);
    issues.push({
      code: 'pack-failed',
      severity: 'error',
      field: 'prompt',
      message: t`The ${vendor} pack could not be built: ${reason}. The export is held until this is fixed.`,
    });
  }

  if (run !== null) {
    // A shot whose stored record the pack could not read is reported by that record, not as one with no prompt.
    const reported = new Set(issues.flatMap((issue) => (issue.shotId === undefined ? [] : [issue.shotId])));
    for (const issue of renderPromptPack(run, 'json').issues) {
      if (issue.code === 'empty-prompt' && issue.shotId !== undefined && reported.has(issue.shotId)) continue;
      issues.push(wordedFor(issue, numbers, template.displayName));
    }
  }

  const rows: PackShotRow[] =
    run === null
      ? []
      : run.shots.map((shot) => {
          const ref = shot.ref;
          const audio = ref.audio ?? {};
          return {
            shotId: shot.shotId,
            number: shot.shotNumber,
            mode: ref.mode,
            durationSec: ref.durationSec ?? null,
            aspect: ref.aspectRatio ?? '',
            prompt: template.compose(ref),
            negative: ref.negativePrompt ?? '',
            audio: (['dialogue', 'sfx', 'ambient', 'music'] as const)
              .filter((cue) => audio[cue] !== undefined && audio[cue] !== '')
              .map((cue) => `${cue}: ${audio[cue] ?? ''}`),
            references: shot.references.map((reference) => reference.fileName ?? reference.label ?? reference.type),
            consistency: consistencyLinesOf(shot.provenance),
            bestTake: ref.bestTake !== undefined,
            mapped: shot.mapped,
            issues: issues.filter((issue) => issue.shotId === shot.shotId),
          };
        });

  return {
    template,
    rows,
    issues,
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    missing: working.shots.filter((shot) => vendorRefOf(shot, template.id) === undefined).map((shot) => shot.id),
    canExport: !issues.some((issue) => issue.severity === 'error'),
    run,
  };
}

/** One export's outcome: the file's text when it was written, or every row when a row held it. */
export type PackOutcome =
  | {
      readonly ok: true;
      readonly artifact: PackArtifact;
      readonly fileName: string;
      readonly text: string;
      readonly issues: readonly PanelIssue[];
    }
  | { readonly ok: false; readonly artifact: PackArtifact; readonly issues: readonly PanelIssue[] };

/** One artifact of one template over one folder, rendered. A refusal carries every row, and no text. */
export function exportPackOf(
  state: ProjectState,
  folderId: string,
  templateId: string,
  artifact: PackArtifact,
  assets: ReadonlyMap<string, AssetRecord> = new Map(),
): PackOutcome | null {
  const preview = packPreviewOf(state, folderId, templateId, assets);
  if (preview === null) return null;
  if (!preview.canExport || preview.run === null) return { ok: false, artifact, issues: preview.issues };
  const outcome = renderPromptPack(preview.run, artifact);
  if (!outcome.ok) return { ok: false, artifact, issues: preview.issues };
  return { ok: true, artifact, fileName: outcome.fileName, text: outcome.text, issues: preview.issues };
}
