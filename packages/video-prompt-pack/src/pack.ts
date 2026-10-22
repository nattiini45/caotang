/**
 * The prompt pack exports — [video-prompt-pack.md §3, §5](../../../docs/architecture/video-prompt-pack.md).
 *
 * Three artifacts come from one run: the JSON pack, which is the canonical machine-readable one; the
 * Markdown pack, the reviewable per-shot cards; and the CSV shot list, for bulk and external tools.
 * Each is a pure render of the same `PackRun`, so the three cannot disagree.
 *
 * Export fails closed. When any shot has an error row, nothing is rendered, and the caller gets every
 * row to show the writer. A warning does not stop an export, and it is carried in the compile log. A
 * provisional template adds one warning row to every export, and its note goes into the JSON and Markdown.
 *
 * Boundary: the pack names files and never carries their bytes. A template with `fileRefPolicy: 'attach'`
 * also gets an `attach` list, the files the writer uploads by hand in the vendor's own tool (§3).
 */

import { requireTemplate } from './draft.js';
import { PromptPackError } from './errors.js';
import { resolveReferences, type ReferenceProvenance, type SuppliedEntry, type WithheldEntry } from './references.js';
import { shotNumbers, storyboardRank, vendorRefOf } from './shot.js';
import type { VendorPayload, VideoVendorTemplate } from './template.js';
import type { ResolvedReference, StoryboardSnapshot, ValidationIssue, VideoAudio, VideoShotRef } from './model.js';

/** One shot as the pack holds it: its record, its resolved references, and the vendor's payload for it. */
export interface PackShot {
  readonly shotId: string;
  readonly shotNumber: number;
  readonly ref: VideoShotRef;
  readonly references: readonly ResolvedReference[];
  /**
   * Which codex entries supplied this shot's references, and which were withheld and why (video-prompt-pack.md §3). It is
   * the same answer `references` came from, so the export and the preview cannot disagree about where a file came from.
   */
  readonly provenance: ReferenceProvenance;
  /** The vendor's own field names, with the best take's seed, model and vendor parameters merged in. */
  readonly mapped: VendorPayload;
}

/** The shots of one export, in storyboard order, with every validation row the export raised. */
export interface PackRun {
  readonly template: VideoVendorTemplate;
  readonly shots: readonly PackShot[];
  readonly issues: readonly ValidationIssue[];
}

/**
 * The vendor payload for one shot, with its best take folded in. A take's seed and model fill
 * the payload when the shot itself does not set them, so a re-run reproduces the take (§3). A
 * key that is already set is kept, and the clash is reported, never silently overwritten.
 */
function mapShot(template: VideoVendorTemplate, ref: VideoShotRef, references: readonly ResolvedReference[]): { payload: VendorPayload; collisions: string[] } {
  const payload: VendorPayload = { ...template.map(ref, { references }) };
  const collisions: string[] = [];
  const take = ref.bestTake;
  if (take !== undefined) {
    if (template.limits.seed) {
      if (!('seed' in payload)) payload.seed = take.seed;
      else if (payload.seed !== take.seed) collisions.push('seed');
    }
    if (!('model' in payload) && take.model !== '') payload.model = take.model;
    for (const [key, value] of Object.entries(take.vendorParams)) {
      if (key in payload) collisions.push(key);
      else payload[key] = value;
    }
  }
  return { payload, collisions };
}

/**
 * Collects the shots of one export for one template. A shot with no record for the vendor has nothing to
 * send. When the writer named the shot, that is an error row and the export is refused. When the export is
 * the whole storyboard, the shot is left out with a warning, so a half-drafted project can still export what
 * it has, and the log says what was left out. Unknown shot ids are refused, and never skipped.
 */
export function preparePack(storyboard: StoryboardSnapshot, templateId: string, shotIds?: readonly string[]): PackRun {
  const template = requireTemplate(templateId);
  const byId = new Map(storyboard.shots.map((shot) => [shot.id, shot]));
  const unknown = (shotIds ?? []).filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new PromptPackError('unknown-shot', `No storyboard shot has the id ${unknown.join(', ')}. Name shots by the ids in their storyboard folder.`);
  }
  const numbers = shotNumbers(storyboard);
  const rank = storyboardRank(storyboard);
  const selected = (shotIds === undefined ? storyboard.shots : storyboard.shots.filter((shot) => shotIds.includes(shot.id)))
    .slice()
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));

  const shots: PackShot[] = [];
  const issues: ValidationIssue[] = [];
  for (const shot of selected) {
    const shotNumber = numbers.get(shot.id) ?? 0;
    const ref = vendorRefOf(shot, template.id);
    if (ref === undefined) {
      issues.push(
        shotIds === undefined
          ? {
              code: 'empty-prompt',
              severity: 'warning',
              field: 'prompt',
              message: `Shot ${shotNumber} has no prompt for ${template.displayName} yet, so the pack leaves it out. Draft it to include it.`,
              shotId: shot.id,
              vendor: template.id,
            }
          : {
              code: 'empty-prompt',
              severity: 'error',
              field: 'prompt',
              message: `Shot ${shotNumber} has no prompt for ${template.displayName} yet. Run prompt.draft on it, then export again.`,
              shotId: shot.id,
              vendor: template.id,
            },
      );
      continue;
    }
    const resolution = resolveReferences({ shot, override: ref.references, storyboard });
    const references = resolution.references;
    issues.push(...template.accepts(ref, { shotId: shot.id, references }));
    const { payload, collisions } = mapShot(template, ref, references);
    for (const key of collisions) {
      issues.push({
        code: 'best-take-collision',
        severity: 'warning',
        field: 'bestTake',
        message: `The best take's ${key} is already a field of ${template.displayName}'s payload. The shot's value is sent, and the take's is kept in the record.`,
        shotId: shot.id,
        vendor: template.id,
      });
    }
    shots.push({ shotId: shot.id, shotNumber, ref, references, provenance: resolution.provenance, mapped: payload });
  }
  return { template, shots, issues };
}

export type PackArtifact = 'json' | 'markdown' | 'csv';

export type RenderOutcome =
  | { readonly ok: true; readonly artifact: PackArtifact; readonly fileName: string; readonly text: string; readonly issues: readonly ValidationIssue[] }
  | { readonly ok: false; readonly artifact: PackArtifact; readonly issues: readonly ValidationIssue[] };

/** The file name an artifact is written under, from the template id. */
export function fileNameFor(templateId: string, artifact: PackArtifact): string {
  if (artifact === 'json') return `${templateId}-prompt-pack.json`;
  if (artifact === 'markdown') return `${templateId}-prompt-pack.md`;
  return `${templateId}-shot-list.csv`;
}

function referenceRecord(reference: ResolvedReference): Record<string, string | undefined> {
  return { type: reference.type, source: reference.source, entryId: reference.entryId, assetId: reference.assetId, file: reference.fileName, label: reference.label };
}

/**
 * Why a codex entry sent nothing, in the words a writer reads (video-prompt-pack.md §3). The Markdown pack and the panel
 * both say it, so the reason is worded once.
 */
export function withheldWords(reason: WithheldEntry['reason']): string {
  switch (reason) {
    case 'never':
      return 'its entry is set to never be sent';
    case 'manual-unattached':
      return 'it is set to manual and is not attached to this storyboard';
    case 'empty-description':
      return 'its description is empty';
    case 'no-visual-reference':
      return 'it has no visual reference image';
  }
}

/** Where a mention was found, in the words a writer reads: the action, the covered script, or both. */
export function mentionWords(where: readonly string[]): string {
  const parts = where.map((surface) => (surface === 'covered' ? 'the covered script' : surface === 'action' ? 'the action' : surface));
  return parts.length === 0 ? 'the shot' : parts.join(' and ');
}

/** A shot's provenance as the JSON pack carries it: which entries supplied each reference, and which were withheld. */
function provenanceRecord(provenance: ReferenceProvenance): Record<string, unknown> {
  return {
    source: provenance.source,
    supplied: provenance.supplied.map((entry: SuppliedEntry) => ({
      entryId: entry.entryId,
      name: entry.name,
      reason: entry.reason,
      where: [...entry.where],
      assetIds: [...entry.assetIds],
    })),
    withheld: provenance.withheld.map((entry: WithheldEntry) => ({ entryId: entry.entryId, name: entry.name, reason: entry.reason })),
  };
}

function shotRecord(shot: PackShot): Record<string, unknown> {
  const ref = shot.ref;
  return {
    shotNumber: shot.shotNumber,
    shotId: shot.shotId,
    mode: ref.mode,
    prompt: ref.prompt,
    ...(ref.audio === undefined ? {} : { audio: ref.audio }),
    ...(ref.negativePrompt === undefined ? {} : { negativePrompt: ref.negativePrompt }),
    ...(ref.durationSec === undefined ? {} : { durationSec: ref.durationSec }),
    ...(ref.aspectRatio === undefined ? {} : { aspectRatio: ref.aspectRatio }),
    ...(ref.resolution === undefined ? {} : { resolution: ref.resolution }),
    ...(ref.seed === undefined ? {} : { seed: ref.seed }),
    promptExtend: ref.promptExtend ?? false,
    ...(ref.notes === undefined ? {} : { notes: ref.notes }),
    references: shot.references.map(referenceRecord),
    provenance: provenanceRecord(shot.provenance),
    mapped: shot.mapped,
    ...(ref.bestTake === undefined ? {} : { bestTake: ref.bestTake }),
  };
}

/**
 * The JSON pack: `{vendor, templateId, provisional?, shots, attach?}`. `provisional` is the template's note, present
 * only while the template is unverified (§9 A3). `attach` is present only for a template that uploads by hand.
 */
function jsonPack(run: PackRun): string {
  const { template, shots } = run;
  const attach =
    template.fileRefPolicy === 'attach'
      ? shots.flatMap((shot) =>
          shot.references.flatMap((reference) =>
            reference.fileName === undefined ? [] : [{ shotNumber: shot.shotNumber, file: reference.fileName, type: reference.type, for: reference.label ?? reference.assetId }],
          ),
        )
      : undefined;
  const document = {
    vendor: template.displayName,
    templateId: template.id,
    ...(template.provisional === undefined ? {} : { provisional: template.provisional }),
    shots: shots.map(shotRecord),
    ...(attach === undefined ? {} : { attach }),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** A Markdown table cell: backslashes and pipes escaped, line breaks flattened. */
function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** A text block as a quotation: every line prefixed, so a multi-line dialogue cue stays one block. */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line.trim()}`))
    .join('\n');
}

/** Comment lines that cannot close the comment early, by `-->` or by the `--!>` that HTML also accepts. */
function comment(text: string): string {
  return text.replace(/--(!?)>/g, '--$1&gt;');
}

function markdownPack(run: PackRun): string {
  const { template, shots } = run;
  const lines: string[] = [];
  lines.push(`# Prompt pack: ${template.displayName}`, '');
  lines.push(
    `${shots.length} shot${shots.length === 1 ? '' : 's'} for \`${template.id}\`. Generation happens in ${template.displayName}, with your own account. Caotang writes the prompts and names the files to attach, and nothing is uploaded.`,
    '',
  );
  if (template.provisional !== undefined) lines.push(`> **Provisional template.** ${template.provisional}`, '');
  lines.push('<!--', ...template.grammarHints.split('\n').map((hint) => `Grammar: ${comment(hint)}`), '-->', '');
  for (const shot of shots) {
    const ref = shot.ref;
    lines.push(`## Shot ${shot.shotNumber}`, '');
    lines.push('| Field | Value |', '|---|---|');
    lines.push(`| Mode | ${ref.mode} |`);
    lines.push(`| Duration | ${ref.durationSec === undefined ? '(not set)' : `${ref.durationSec} s`} |`);
    lines.push(`| Aspect ratio | ${cell(ref.aspectRatio ?? '(vendor default)')} |`);
    lines.push(`| Resolution | ${cell(ref.resolution ?? '(vendor default)')} |`);
    lines.push(`| Seed | ${ref.seed === undefined ? '(not set)' : String(ref.seed)} |`);
    lines.push('');
    const prompt = template.compose(ref);
    lines.push('**Prompt**', '', quote(prompt === '' ? '(empty)' : prompt), '');
    const audio: VideoAudio = ref.audio ?? {};
    const cues = (['dialogue', 'sfx', 'ambient', 'music'] as const).filter((cue) => audio[cue] !== undefined && audio[cue] !== '');
    if (cues.length > 0) {
      lines.push('**Audio**', '');
      for (const cue of cues) lines.push(`- ${cue}: ${cell(audio[cue] ?? '')}`);
      lines.push('');
    }
    if (ref.negativePrompt !== undefined && ref.negativePrompt.trim() !== '') {
      lines.push('**Negative prompt**', '', quote(ref.negativePrompt), '');
    }
    if (shot.references.length > 0) {
      lines.push('**Reference files**', '');
      for (const reference of shot.references) {
        const file = reference.fileName ?? '(no file in the project)';
        const who = reference.label === undefined ? '' : ` for ${reference.label}`;
        lines.push(`- \`${file}\`: ${reference.type}${who}`);
      }
      lines.push('');
    }
    // Which codex entries the references came from, and which entries the shot names that sent nothing (video-prompt-pack.md §3).
    if (shot.provenance.supplied.length > 0 || shot.provenance.withheld.length > 0) {
      lines.push('**Consistency**', '');
      for (const entry of shot.provenance.supplied) {
        const how = entry.reason === 'override' ? 'named by this shot' : `mentioned in ${mentionWords(entry.where)}`;
        const count = entry.assetIds.length;
        lines.push(`- ${cell(entry.name)}: ${how}, sends ${count} reference${count === 1 ? '' : 's'}`);
      }
      for (const entry of shot.provenance.withheld) {
        lines.push(`- ${cell(entry.name)}: not sent, because ${withheldWords(entry.reason)}`);
      }
      lines.push('');
    }
    if (ref.notes !== undefined && ref.notes.trim() !== '') {
      lines.push(`<!-- Notes: ${comment(ref.notes)} -->`, '');
    }
    if (ref.bestTake !== undefined) {
      const params = Object.entries(ref.bestTake.vendorParams)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(', ');
      lines.push(`<!-- Best take: seed ${ref.bestTake.seed}, model ${comment(ref.bestTake.model)}${params === '' ? '' : `, ${comment(params)}`}. -->`, '');
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * One CSV field. A value that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading single
 * quote, so a spreadsheet reads it as text and does not run it as a formula. The prompt is model output over
 * manuscript and codex text, which is untrusted, so this guard is needed. The guard changes the raw value: a
 * tool that parses this file as data sees the quote (`'=1+1`) and has to strip it. RFC 4180 quoting then applies
 * to everything else: a field with a comma, a quote or a line break is quoted, with its quotes doubled.
 */
function csvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function csvPack(run: PackRun): string {
  const header = ['shotNumber', 'vendor', 'mode', 'duration', 'aspect', 'prompt', 'negativePrompt', 'refs'];
  const rows = run.shots.map((shot) => {
    const ref = shot.ref;
    const fields = [
      String(shot.shotNumber),
      run.template.id,
      ref.mode,
      ref.durationSec === undefined ? '' : String(ref.durationSec),
      ref.aspectRatio ?? '',
      run.template.compose(ref).replace(/\s+/g, ' ').trim(),
      ref.negativePrompt ?? '',
      shot.references.flatMap((reference) => (reference.fileName === undefined ? [] : [reference.fileName])).join('; '),
    ];
    return fields.map(csvField).join(',');
  });
  return `${[header.join(','), ...rows].join('\r\n')}\r\n`;
}

/**
 * The rows every export of a template carries. A provisional template says so once, as a warning, before the
 * writer sends the file anywhere (video-prompt-pack.md §9, A3). The row is in the compile log of every export,
 * the CSV included, since the CSV has no place for the note itself.
 */
function templateRows(template: VideoVendorTemplate): ValidationIssue[] {
  if (template.provisional === undefined) return [];
  return [
    {
      code: 'provisional-template',
      severity: 'warning',
      field: 'template',
      message: `${template.displayName} is a provisional template. ${template.provisional} Check the export against the vendor's current documentation before you send it.`,
      vendor: template.id,
    },
  ];
}

/**
 * Renders one artifact. Refuses, with every row, when any row is an error. Nothing is rendered from
 * a run that has an error, so a shot the vendor would refuse never reaches a file.
 */
export function renderPromptPack(run: PackRun, artifact: PackArtifact): RenderOutcome {
  const issues = [...templateRows(run.template), ...run.issues];
  if (issues.some((issue) => issue.severity === 'error')) {
    return { ok: false, artifact, issues };
  }
  const text = artifact === 'json' ? jsonPack(run) : artifact === 'markdown' ? markdownPack(run) : csvPack(run);
  return { ok: true, artifact, fileName: fileNameFor(run.template.id, artifact), text, issues };
}
