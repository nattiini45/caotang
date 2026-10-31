/**
 * The timeline's table — one row per scene in canonical logical order — and its CSV writer (timeline.md §8,
 * `timeline-csv`). The XLSX variant (`timeline-xlsx`, render-timeline-xlsx.ts) writes the same rows through
 * `render-xlsx.ts`; the SVG and PDF (render-timeline-svg.ts, render-timeline-pdf.ts) draw the same model.
 *
 * ## The row order is canonical and never mirrored
 *
 * Rows are ordered by part (prologue, main, epilogue), then day, then reading index, with the undated scenes of a
 * part after its dated ones (timeline.md §8). That order is a property of the data, so it is the same whichever
 * language the book is written in and whichever direction the interface runs; only the drawn geometry (the view,
 * the SVG, the PDF, the PNG) follows the project language's direction.
 *
 * ## The cells
 *
 * Days are signed integers written as plain decimal strings (`-14`, never a locale-formatted `−14`), so a tool
 * that reads the file gets the stored value. Text cells — titles, folder paths, names, handles — carry the CSV
 * formula guard: a cell opening with `=`, `+`, `-`, `@`, tab or carriage return gets an apostrophe, because RFC
 * 4180 quoting does not stop a spreadsheet evaluating it. The day cells go through the guard too: a negative day
 * opens with `-`, and the guard is the repo's own rule for that character. In the spreadsheet the same columns
 * are number cells, so they sort and sum as numbers.
 */

import { emptyCoherenceFile, type CoherenceFile } from '@caotang/coherence';
import { csvField } from '@caotang/dialogue';
import { guardFormula } from '@caotang/storyboard';
import { nodeById, type ProjectState, type TreeNode } from '@caotang/store';
import {
  buildTimeline,
  ENGLISH_LABELS,
  projectLensOf,
  type CalendarLens,
  type StoryPart,
  type TimelineItem,
  type TimelineLabels,
  type TimelineModel,
} from '@caotang/timeline';

import { timelinePicturesOf } from './timeline-pictures.js';

/** The table's columns, in order. The header row of the CSV and of the spreadsheet's sheet. */
export const TIMELINE_COLUMNS = [
  'reading index',
  'part',
  'title',
  'folder path',
  'day',
  'duration days',
  'end day',
  'day label',
  'mode',
  'pov',
  'expected present',
  'after',
  'threads',
  'open findings',
  'picture ids',
  'picture alt',
] as const;

/** One scene's row. Numbers are numbers; `null` is a column the scene does not declare. */
export interface TimelineExportRow {
  readonly index: number;
  readonly part: StoryPart;
  readonly title: string;
  readonly folderPath: string;
  readonly day: number | null;
  readonly duration: number | null;
  readonly end: number | null;
  readonly dayLabel: string;
  readonly mode: string;
  readonly pov: string;
  readonly present: string;
  readonly after: string;
  readonly threads: string;
  readonly findings: string;
  /** The ids of the pictures on the scene, card first, joined by `, `. */
  readonly pictureIds: string;
  /** Each of those pictures' alt text in the same order, joined by ` | `, so the Nth alt belongs to the Nth id; a decorative picture's is empty. */
  readonly pictureAlt: string;
}

export interface TimelineTableInput {
  readonly state: ProjectState;
  /** The selection's root ids: `manuscript` for the whole book, or the nodes a part names. */
  readonly includeRootIds: readonly string[];
  /** The project language, as the metadata seam reads it; the lens's numbers follow its locale. */
  readonly language?: string;
}

export interface TimelineTable {
  readonly columns: readonly string[];
  readonly rows: readonly TimelineExportRow[];
  readonly model: TimelineModel;
  readonly lens: CalendarLens;
  readonly labels: TimelineLabels;
  readonly notes: readonly string[];
}

const PART_RANK: Readonly<Record<StoryPart, number>> = { prologue: 0, main: 1, epilogue: 2 };

/** The manuscript root: the selection `['manuscript']` names, and the binder's top. */
const MANUSCRIPT_ROOT = 'manuscript';

/** The coherence file as the state holds it, or the empty one a project without a findings file reads as. */
function coherenceFileOf(state: ProjectState): CoherenceFile {
  return (state.coherence ?? emptyCoherenceFile()) as CoherenceFile;
}

/** The title path of a node's ancestor folders, nearest last, without the manuscript root. */
function folderPathOf(state: ProjectState, node: TreeNode): string {
  const titles: string[] = [];
  let at = node.parentId;
  while (at !== null && at !== MANUSCRIPT_ROOT) {
    const folder = state.manifest.tree.find((candidate) => candidate.id === at);
    if (folder === undefined) break;
    titles.unshift(folder.title);
    at = folder.parentId;
  }
  return titles.join(' / ');
}

/**
 * The timeline model an export draws or tables, built the way the view builds it: the story axis, no lane grouping,
 * day zoom, open findings, gap compression on. A single selected node narrows the model through its `scope`; a
 * selection of several nodes is filtered out of the whole-manuscript model, so every root's scenes land in one table.
 */
export function buildExportModel(input: TimelineTableInput): {
  readonly model: TimelineModel;
  readonly lens: CalendarLens;
  readonly labels: TimelineLabels;
} {
  const language = input.language ?? input.state.manifest.project.language ?? '';
  const lens = projectLensOf(input.state.manifest.timeline, { locale: language === '' ? 'en' : language }).lens;
  const labels = ENGLISH_LABELS;
  const roots = input.includeRootIds.length === 0 ? [MANUSCRIPT_ROOT] : input.includeRootIds;
  const scope = roots.length === 1 && roots[0] !== MANUSCRIPT_ROOT ? (roots[0] as string) : undefined;
  const model = buildTimeline(input.state, coherenceFileOf(input.state), {
    axis: 'story',
    groupBy: 'none',
    zoom: 'day',
    lens,
    labels,
    findings: 'open',
    compressGaps: true,
    ...(scope !== undefined ? { scope } : {}),
  });
  if (scope !== undefined || roots.includes(MANUSCRIPT_ROOT)) return { model, lens, labels };
  // Several named roots: keep the scenes under any of them, in the model's canonical order.
  const selected = new Set(roots);
  const under = (nodeId: string): boolean => {
    let at: string | null = nodeId;
    while (at !== null) {
      if (selected.has(at)) return true;
      at = nodeById(input.state, at)?.parentId ?? null;
    }
    return false;
  };
  const items = model.items.filter((item) => item.kind === 'scene' && under(item.nodeId));
  return { model: { ...model, items }, lens, labels };
}

/**
 * The table: one row per scene, deduplicated across lanes (a grouped view shows one scene in several lanes; the
 * export has no lanes), in canonical order — part, dated before undated, day, reading index — with the reading
 * index renumbered over the rows that are actually exported.
 */
export function timelineTable(input: TimelineTableInput): TimelineTable {
  const { model, lens, labels } = buildExportModel(input);
  const file = coherenceFileOf(input.state);
  const codexName = (id: string): string =>
    input.state.manifest.codex?.find((entry) => entry.id === id)?.name ?? id;
  const titleOf = (docId: string): string => nodeById(input.state, docId)?.title ?? docId;

  const seen = new Set<string>();
  const scenes: TimelineItem[] = [];
  for (const item of model.items) {
    if (item.kind !== 'scene' || seen.has(item.nodeId)) continue;
    seen.add(item.nodeId);
    scenes.push(item);
  }
  scenes.sort(
    (a, b) =>
      PART_RANK[a.part] - PART_RANK[b.part] ||
      (a.start === undefined ? 1 : 0) - (b.start === undefined ? 1 : 0) ||
      (a.start ?? 0) - (b.start ?? 0) ||
      a.readingIndex - b.readingIndex,
  );

  const pictures = timelinePicturesOf(input.state, scenes.map((item) => item.nodeId));

  const rows: TimelineExportRow[] = scenes.map((item, index) => {
    const node = nodeById(input.state, item.nodeId);
    const own = pictures.of(item.nodeId);
    const meta = file.sceneMeta[item.nodeId] ?? {};
    const day = item.dayOffset ?? null;
    const duration = item.durationDays ?? null;
    return {
      index,
      part: item.part,
      title: item.title,
      folderPath: node === undefined ? '' : folderPathOf(input.state, node),
      day,
      duration,
      end: day !== null && duration !== null ? day + duration : null,
      dayLabel: day === null ? '' : lens.label(day, 'long'),
      mode: labels.modeName(item.mode),
      pov: item.pov === undefined || item.pov === '' ? '' : codexName(item.pov),
      present: (meta.expectedPresent ?? []).map(codexName).join(', '),
      after: (meta.after ?? []).map(titleOf).join(', '),
      threads: (meta.threads ?? []).map((thread) => thread.id).join(', '),
      findings: [...new Set(item.findings.map((finding) => finding.checkId))].join(', '),
      pictureIds: own.map((picture) => picture.assetId).join(', '),
      pictureAlt: own.map((picture) => picture.alt).join(' | '),
    };
  });

  const notes: string[] = [];
  const undated = rows.filter((row) => row.day === null).length;
  if (undated > 0) {
    notes.push(`${undated} scene${undated === 1 ? '' : 's'} have no day declared, so ${undated === 1 ? 'its row' : 'their rows'} follow the dated rows of their part`);
  }
  if (pictures.unrecorded > 0) {
    const count = pictures.unrecorded;
    notes.push(`${count} picture placement${count === 1 ? '' : 's'} on scenes ${count === 1 ? 'names' : 'name'} a picture the project has no record of, so ${count === 1 ? 'it is' : 'they are'} left out of the picture columns`);
  }
  return { columns: [...TIMELINE_COLUMNS], rows, model, lens, labels, notes };
}

/** One row as the table's cell values, in column order: numbers as numbers, everything else as text. */
export function timelineRowCells(row: TimelineExportRow, labels: TimelineLabels): (string | number | null)[] {
  return [
    row.index,
    labels.partName(row.part),
    row.title,
    row.folderPath,
    row.day,
    row.duration,
    row.end,
    row.dayLabel,
    row.mode,
    row.pov,
    row.present,
    row.after,
    row.threads,
    row.findings,
    row.pictureIds,
    row.pictureAlt,
  ];
}

/**
 * The table as RFC 4180 CSV: a header row, then one CRLF-terminated record per scene. Every text cell carries the
 * formula guard, and is quoted only when it has to be; the numeric cells are written as plain decimal strings and
 * guarded like any other cell, so a negative day cannot start a formula in a spreadsheet that opens the file.
 */
export function timelineCsv(table: TimelineTable): string {
  const record = (cells: readonly (string | number | null)[]): string =>
    cells
      .map((cell) => (cell === null ? '' : csvField(guardFormula(String(cell)))))
      .join(',') + '\r\n';
  const header = table.columns.map((column) => csvField(guardFormula(column))).join(',') + '\r\n';
  return header + table.rows.map((row) => record(timelineRowCells(row, table.labels))).join('');
}
