/**
 * What the picture board, the Inspector's picture strip and the corkboard's card pictures read of the project — pure, so the
 * gallery's filters, its size meter and its import summary are tested without a renderer (pictures.md §5).
 *
 * Nothing here applies anything. A change is one of the `asset.*` commands, dispatched by the view that asked for it.
 */

import { collectUses, deletionBlockers, linksToAsset, nodeIdOfTarget, type AssetLink, type AssetSourceKind, type PictureUse, type ReadAssetLink, type ReadAssetRecord } from '@caotang/pictures';
import { picturesUsesSnapshot } from '@caotang/bus';
import { foldText } from '@caotang/furniture';
import { numberFormat } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { nodeById, type ProjectState } from '@caotang/store';

import { childrenOf } from '../app/binder-model.js';
import { formatterLocale } from '../i18n/format-locale.js';

import { IMAGE_ACCEPT } from './shot-image-model.js';

/* lingui-set comment="Interpolated values: count, total, size, width, height, megapixels are numbers or formatted sizes; name, title, label and tag are the writer's own text or a file name; reason is a sentence." */

/** What a picture dragged from the Inspector or the board carries, so a card or a target can take it. */
export const PICTURE_DRAG_TYPE = 'application/x-caotang-picture';

/** What a file chooser offers for pictures: the types the store takes, and HEIC, which the import converts where the browser can. */
export const PICTURE_ACCEPT = [IMAGE_ACCEPT, 'image/heic', 'image/heif', '.heic', '.heif'].join(',');

/** The most pictures the board lists as the project's heaviest (pictures.md §5). */
export const LARGEST_COUNT = 10;

/** A request to open the board on one picture. `serial` makes the same picture asked twice a new request. */
export interface PictureFocusRequest {
  readonly assetId: string;
  readonly serial: number;
}

type AnyLink = AssetLink | ReadAssetLink;

/** The name a picture goes by: its caption, else its alt text, else the name of the file it came from, else its own file. */
export function pictureLabelOf(record: Pick<ReadAssetRecord, 'caption' | 'alt' | 'file'> & { readonly source?: { readonly label?: string } }): string {
  const caption = record.caption?.trim();
  if (caption !== undefined && caption !== '') return caption;
  const alt = record.alt?.trim();
  if (alt !== undefined && alt !== '') return alt;
  const origin = record.source?.label?.trim();
  if (origin !== undefined && origin !== '') return origin;
  return record.file;
}

/** The label a picker's option shows: the registry's caption when the picture has a record, else the file name the listing found. */
export function pickerLabelOf(state: Pick<ProjectState, 'manifest'>, assetId: string, fileName: string): string {
  const record = (state.manifest.assets ?? []).find((candidate) => candidate.id === assetId);
  return record === undefined ? fileName : pictureLabelOf(record);
}

/** The alt text a picture is shown with: empty when the writer marked it decorative, else its alt, else its caption. */
export function altOf(record: Pick<ReadAssetRecord, 'caption' | 'alt' | 'decorative'>): string {
  if (record.decorative === true) return '';
  const alt = record.alt?.trim();
  if (alt !== undefined && alt !== '') return alt;
  return record.caption?.trim() ?? '';
}

/** Where a picture came from, as a short phrase. */
export function sourceLabelOf(kind: AssetSourceKind): string {
  switch (kind) {
    case 'import':
      return t`Imported`;
    case 'paste':
      return t`Pasted`;
    case 'mcp':
      return t`From a tool`;
    case 'scan':
      return t`Scanned`;
    case 'agent':
      return t`From the agent`;
    default:
      return kind;
  }
}

export interface PictureEntry {
  readonly id: string;
  readonly record: ReadAssetRecord;
  readonly label: string;
  readonly uses: readonly PictureUse[];
  readonly links: readonly AnyLink[];
  /** The binder items the picture is placed on, a paragraph placement included. */
  readonly nodeIds: readonly string[];
  /** The project listing says the file is not there. `false` while the listing is unknown. */
  readonly missing: boolean;
  /** Placed on a paragraph that has since gone (pictures.md §2.3). */
  readonly orphaned: boolean;
  /** Nothing uses it: no cover, shot, codex entry, inline image, panel or placement. */
  readonly unused: boolean;
  readonly pixels: number | undefined;
}

/** The registry as the board lists it, in the order the manifest keeps it. `present` is the files the listing found, or `null` before it has. */
export function entriesOf(state: ProjectState, present: ReadonlySet<string> | null): PictureEntry[] {
  const records = state.manifest.assets ?? [];
  const uses = collectUses(picturesUsesSnapshot(state));
  const links = state.manifest.assetLinks ?? [];
  return records.map((record) => {
    const own = uses.get(record.id) ?? [];
    const placed = linksToAsset(links, record.id);
    const nodeIds = [...new Set(placed.flatMap((link) => nodeIdOfTarget(link.target) ?? []))];
    const orphaned = placed.some((link) => link.target.kind === 'paragraph' && (link.target as { orphaned?: unknown }).orphaned === true);
    return {
      id: record.id,
      record,
      label: pictureLabelOf(record),
      uses: own,
      links: placed,
      nodeIds,
      missing: present !== null && !present.has(record.id),
      orphaned,
      unused: own.length === 0,
      pixels: record.width !== undefined && record.height !== undefined ? record.width * record.height : undefined,
    };
  });
}

/** The uses that stop the picture being deleted, in the words `asset.delete` refuses with. */
export function blockersOf(entry: PictureEntry): PictureUse[] {
  return deletionBlockers(entry.uses);
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

export interface BoardFilters {
  readonly tag: string | null;
  /** `'project'`, or a binder item's id. `null`: anywhere. */
  readonly target: string | null;
  readonly source: AssetSourceKind | null;
  readonly unused: boolean;
  readonly orphaned: boolean;
  readonly transcribed: boolean;
  /** Free text a picture's transcription must contain, folded like the binder's text filter. `''` searches nothing. */
  readonly text: string;
}

export const NO_FILTERS: BoardFilters = { tag: null, target: null, source: null, unused: false, orphaned: false, transcribed: false, text: '' };

/**
 * Whether the Inspector's strip can attach a picture to the paragraph the caret is in (pictures.md §5).
 *
 * Three things have to hold at once. The editor has to be showing **this** item, because the anchor belongs to a document and
 * the strip belongs to whatever the binder has selected. There has to be a **range**, not a bare caret: a paragraph placement
 * names a paragraph, so the writer points at one with a selection. And the store has to hold the text the caret is in — an
 * anchor is captured against the body the next write diffs against, so while the editor holds unsaved words the offsets it
 * reports describe text the project does not have yet.
 */
export function canAttachToParagraph(
  caret: { readonly docId: string; readonly from: number; readonly to: number; readonly dirty: boolean } | null,
  node: { readonly id: string; readonly type: string },
): boolean {
  return caret !== null && caret.docId === node.id && node.type === 'document' && caret.from !== caret.to && !caret.dirty;
}

export function filtersActive(filters: BoardFilters): boolean {
  return filters.tag !== null || filters.target !== null || filters.source !== null || filters.unused || filters.orphaned || filters.transcribed || filters.text !== '';
}

/** The folded transcription needle, or `null` when the text is empty — an empty needle hides nothing, untranscribed pictures included. */
function textNeedleOf(filters: BoardFilters): string | null {
  return filters.text === '' ? null : foldText(filters.text);
}

export function filterEntries(entries: readonly PictureEntry[], filters: BoardFilters): PictureEntry[] {
  const needle = textNeedleOf(filters);
  return entries.filter((entry) => {
    if (filters.tag !== null && !(entry.record.tags ?? []).includes(filters.tag)) return false;
    if (filters.target === 'project' && !entry.links.some((link) => link.target.kind === 'project')) return false;
    if (filters.target !== null && filters.target !== 'project' && !entry.nodeIds.includes(filters.target)) return false;
    if (filters.source !== null && entry.record.source?.kind !== filters.source) return false;
    if (filters.unused && !entry.unused) return false;
    if (filters.orphaned && !entry.orphaned) return false;
    if (filters.transcribed && entry.record.transcription === undefined) return false;
    if (needle !== null) {
      const haystack = entry.record.transcription?.text;
      if (haystack === undefined || !foldText(haystack).includes(needle)) return false;
    }
    return true;
  });
}

export interface FilterChoices {
  readonly tags: readonly string[];
  readonly sources: readonly AssetSourceKind[];
  /** The binder items some picture is placed on, with their titles, and whether any picture is placed on the project. */
  readonly targets: readonly { readonly id: string; readonly title: string }[];
  readonly project: boolean;
  /** The transcription filter is offered only once some picture has one. */
  readonly transcriptions: boolean;
}

/** What each filter can offer, read off the whole registry so a choice never disappears because another filter hid its pictures. */
export function filterChoicesOf(state: ProjectState, entries: readonly PictureEntry[]): FilterChoices {
  const tags = new Set<string>();
  const sources = new Set<AssetSourceKind>();
  const nodes = new Set<string>();
  let project = false;
  let transcriptions = false;
  for (const entry of entries) {
    for (const tag of entry.record.tags ?? []) tags.add(tag);
    if (entry.record.source !== undefined) sources.add(entry.record.source.kind);
    for (const id of entry.nodeIds) nodes.add(id);
    if (entry.links.some((link) => link.target.kind === 'project')) project = true;
    if (entry.record.transcription !== undefined) transcriptions = true;
  }
  const collator = new Intl.Collator(state.manifest.project.language ?? undefined);
  return {
    tags: [...tags].sort(collator.compare),
    sources: [...sources].sort(),
    targets: [...nodes]
      .flatMap((id) => {
        const node = nodeById(state, id);
        return node === undefined ? [] : [{ id, title: node.title }];
      })
      .sort((a, b) => collator.compare(a.title, b.title)),
    project,
    transcriptions,
  };
}

export interface NodeChoice {
  readonly id: string;
  readonly title: string;
  readonly depth: number;
}

/** The binder items a picture can be placed on, in binder order, with their depth under the sections. The hidden root is not one. */
export function nodeChoicesOf(state: ProjectState): NodeChoice[] {
  const out: NodeChoice[] = [];
  const visit = (parentId: string, depth: number): void => {
    for (const node of childrenOf(state, parentId)) {
      out.push({ id: node.id, title: node.title, depth });
      visit(node.id, depth + 1);
    }
  };
  visit('root', 0);
  return out;
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

/** The selection after one picture is toggled; the ids that no longer exist drop out. */
export function toggledSelection(selection: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** A selection kept to the pictures the registry still has, so a delete or an undo never leaves a ghost in the batch bar. */
export function liveSelection(selection: ReadonlySet<string>, entries: readonly PictureEntry[]): Set<string> {
  const live = new Set(entries.map((entry) => entry.id));
  return new Set([...selection].filter((id) => live.has(id)));
}

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

export const TAGS_MAX = 32;
export const TAG_CHARS_MAX = 64;

/** The tags a typed line names: split on commas, trimmed, without blanks or repeats. */
export function parseTags(line: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of line.split(',')) {
    const tag = piece.trim();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export type TagPlan = { readonly ok: true; readonly tags: string[] } | { readonly ok: false; readonly reason: string };

/** A picture's tags with `added` after them, or why they do not fit (at most 32, each at most 64 characters). */
export function withTags(existing: readonly string[] | undefined, added: readonly string[]): TagPlan {
  const tags = [...(existing ?? [])];
  for (const tag of added) {
    if (tag.length > TAG_CHARS_MAX) return { ok: false, reason: t`A tag may be at most ${{ max: TAG_CHARS_MAX }} characters.` };
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > TAGS_MAX) return { ok: false, reason: t`A picture may have at most ${{ max: TAGS_MAX }} tags.` };
  return { ok: true, tags };
}

/* ------------------------------------------------------------------ *
 * The size meter
 * ------------------------------------------------------------------ */

export interface SizeMeter {
  readonly count: number;
  readonly totalBytes: number;
  readonly totalPixels: number;
  /** The heaviest pictures, heaviest first; equal sizes keep the registry's order. */
  readonly largest: readonly PictureEntry[];
}

export function sizeMeterOf(entries: readonly PictureEntry[]): SizeMeter {
  let totalBytes = 0;
  let totalPixels = 0;
  for (const entry of entries) {
    totalBytes += entry.record.bytes;
    totalPixels += entry.pixels ?? 0;
  }
  const largest = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.record.bytes - a.entry.record.bytes || a.index - b.index)
    .slice(0, LARGEST_COUNT)
    .map(({ entry }) => entry);
  return { count: entries.length, totalBytes, totalPixels, largest };
}

/** A byte count as a person reads it: "812 KB", "4.2 MB". Grouped and pointed for the formatter locale. */
export function bytesText(bytes: number, locale: string = formatterLocale()): string {
  const one = numberFormat(locale, { maximumFractionDigits: 1 });
  if (bytes < 1024) return t`${{ size: one.format(bytes) }} bytes`;
  if (bytes < 1024 * 1024) return t`${{ size: one.format(bytes / 1024) }} KB`;
  if (bytes < 1024 * 1024 * 1024) return t`${{ size: one.format(bytes / (1024 * 1024)) }} MB`;
  return t`${{ size: one.format(bytes / (1024 * 1024 * 1024)) }} GB`;
}

/** A picture's size in pixels: "4032 × 3024 px (12.2 MP)", or nothing when the record has no size. */
export function pixelsText(record: Pick<ReadAssetRecord, 'width' | 'height'>, locale: string = formatterLocale()): string | undefined {
  if (record.width === undefined || record.height === undefined) return undefined;
  const width = numberFormat(locale).format(record.width);
  const height = numberFormat(locale).format(record.height);
  const megapixels = numberFormat(locale, { maximumFractionDigits: 1 }).format((record.width * record.height) / 1_000_000);
  return t`${{ width }} × ${{ height }} px (${{ megapixels }} MP)`;
}

/** The whole project's picture weight, in one sentence. */
export function meterSentence(meter: SizeMeter, locale: string = formatterLocale()): string {
  const total = bytesText(meter.totalBytes, locale);
  const count = meter.count;
  return t`${plural(count, { one: '# picture', other: '# pictures' })}, ${{ total }} in all.`;
}

/* ------------------------------------------------------------------ *
 * Uses, in the words the board shows
 * ------------------------------------------------------------------ */

export type UseLine = { readonly key: string; readonly text: string };

/** One line per use of a picture, for "Used in". Writer titles are returned raw; the view isolates them. */
export function usedInLines(state: ProjectState, uses: readonly PictureUse[]): UseLine[] {
  const title = (nodeId: string): string => nodeById(state, nodeId)?.title ?? nodeId;
  return uses.map((use, index): UseLine => {
    const key = `${use.kind}-${index}`;
    switch (use.kind) {
      case 'cover':
        return { key, text: t`The project cover` };
      case 'shot':
        return { key, text: t`The picture of the shot “${{ title: title(use.nodeId) }}”` };
      case 'codex': {
        const name = state.manifest.codex?.find((entry) => entry.id === use.entryId)?.name ?? use.entryId;
        return { key, text: t`A visual reference of “${{ name }}”` };
      }
      case 'inline':
        return { key, text: t`In the text of “${{ title: title(use.nodeId) }}”` };
      case 'vendor':
        return { key, text: t`Named by a video prompt` };
      case 'comic-panel':
        return { key, text: t`A panel of “${{ title: title(use.nodeId) }}”` };
      case 'link': {
        if (!use.understood) return { key, text: t`Placed where this version of Caotang cannot read` };
        if (use.target.kind === 'project') return { key, text: t`Placed on the project` };
        const nodeId = nodeIdOfTarget(use.target);
        const name = nodeId === undefined ? '' : title(nodeId);
        if (use.target.kind === 'paragraph') return { key, text: t`Placed on a paragraph of “${{ title: name }}”` };
        return { key, text: use.role === 'card' ? t`The card picture of “${{ title: name }}”` : t`Placed on “${{ title: name }}”` };
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * Drags
 * ------------------------------------------------------------------ */

/** What a drag carries, read from its types: a picture from this app, files from the desktop, or something else. */
export function dragKindOf(types: Iterable<string>): 'picture' | 'files' | null {
  let files = false;
  for (const type of types) {
    if (type === PICTURE_DRAG_TYPE) return 'picture';
    if (type === 'Files') files = true;
  }
  return files ? 'files' : null;
}

/* ------------------------------------------------------------------ *
 * Import summary
 * ------------------------------------------------------------------ */

export interface ImportSkip {
  readonly name: string;
  readonly reason: string;
}

export interface ImportReport {
  readonly status: 'imported' | 'cancelled' | 'nothing' | 'failed';
  readonly created: number;
  /** Pictures the project already held, so only their placements were made. */
  readonly reused: number;
  readonly assetIds: readonly string[];
  readonly skipped: readonly ImportSkip[];
  /** The command's own refusal, for `failed`. */
  readonly message?: string;
  /** For a refusal that kept the chosen pictures staged (a full disk): imports them again. Absent when nothing is held. */
  readonly retry?: () => Promise<ImportReport>;
  /** Lets go of the pictures a `retry` would import. */
  readonly discard?: () => void;
}

/** The status line after an import. */
export function importSummary(report: ImportReport): { readonly text: string; readonly tone: 'info' | 'error' } {
  switch (report.status) {
    case 'cancelled':
      return { text: t`Nothing was imported.`, tone: 'info' };
    case 'failed':
      return { text: report.message ?? t`The pictures could not be imported.`, tone: 'error' };
    case 'nothing':
      return { text: report.skipped.length === 0 ? t`There was no picture to import.` : t`None of those files could be imported.`, tone: 'error' };
    case 'imported': {
      const { created, reused } = report;
      const skipped = report.skipped.length;
      // Each part is a whole sentence, so a translation orders its own words.
      const sentences: string[] = [];
      if (created > 0) sentences.push(t`${plural(created, { one: 'Imported # picture.', other: 'Imported # pictures.' })}`);
      if (reused > 0) sentences.push(t`${plural(reused, { one: '# picture was already in the project.', other: '# pictures were already in the project.' })}`);
      if (skipped > 0) sentences.push(t`${plural(skipped, { one: '# file was left out.', other: '# files were left out.' })}`);
      return { text: sentences.join(' '), tone: 'info' };
    }
  }
}

/** The large-photo question's facts, read off the refusal an import answers with before it knows the writer's choice. */
export function largePhotoQuestionOf(details: unknown): { readonly count: number; readonly because: readonly ('pixels' | 'bytes')[] } | null {
  if (typeof details !== 'object' || details === null) return null;
  const record = details as { largePhotoPrompt?: unknown; items?: unknown; because?: unknown };
  if (record.largePhotoPrompt !== true) return null;
  const count = Array.isArray(record.items) ? record.items.length : 1;
  const because = Array.isArray(record.because) ? record.because.filter((item): item is 'pixels' | 'bytes' => item === 'pixels' || item === 'bytes') : [];
  return { count: Math.max(count, 1), because };
}
