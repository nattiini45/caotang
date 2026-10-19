/**
 * The dialogue table — [dialogue-narrative.md §4 and §6](../../../docs/architecture/dialogue-narrative.md).
 *
 * One row per speakable line and per choice label, in binder order, with the columns
 * `lineId, speaker, text, context, charLimit`. It is the one surface that localization, voice
 * recording and the engine's string tables all read (§6), so its shape is fixed here and the
 * CSV is RFC 4180: UTF-8, CRLF records, quoted fields that hold a comma, quote or line break.
 * The exporter also writes these rows as XLSX (`dialogue-xlsx`), through the spreadsheet writer it shares with the shot list.
 */

import type { CodexEntry } from '@caotang/store';

import type { DialogueContainerMeta } from './kinds.js';
import { parseInk, ROOT_NODE_ID } from './ink-parse.js';
import { resolveSpeakerId, resolveSpeakerName } from './speakers.js';

/** §6's columns, in order. `locale` and `condition` are appended only when a caller asks for them. */
export const TABLE_COLUMNS = ['lineId', 'speaker', 'text', 'context', 'charLimit'] as const;

/**
 * The columns of a Yarn Spinner strings file, in Yarn's order: the `yarn-csv` engine target's table (§2.1). Yarn reads
 * `language` as the line's locale and `id` as its line id; `lock` is a hash Yarn computes from its own source, so Caotang
 * leaves it empty.
 */
export const YARN_COLUMNS = ['language', 'id', 'text', 'file', 'node', 'lineNumber', 'lock', 'comment'] as const;

/** A dialogue container as the table reads it: its id, its title, its Ink body and its metadata. */
export interface DialogueSource {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly meta?: DialogueContainerMeta;
}

export interface TableRow {
  readonly container: string;
  /** The line id, or the empty string when the line has none. */
  readonly lineId: string;
  readonly missing: boolean;
  readonly kind: 'line' | 'choice';
  /** The speaker's codex id when it resolves, else the typed name, else the container's default, else empty. */
  readonly speaker: string;
  readonly text: string;
  /** The speaker's name as a reader sees it: the codex display name, else the typed name, else empty. */
  readonly speakerName: string;
  /** The knot path, then the codex-resolved speaker's display name, joined by ` / `. */
  readonly context: string;
  /** The locale the line is written in: the container's `locBaseline`, else the table's default locale, else empty. */
  readonly locale: string;
  /** The character limit when the template sets one, else null. */
  readonly charLimit: number | null;
  /** A choice's condition, or the empty string. */
  readonly condition: string;
  readonly node: string;
  readonly line: number;
}

export interface TableOptions {
  readonly entries?: readonly CodexEntry[];
  /** A subtitle-style limit, applied to every row. Null or absent means unconstrained (§4). */
  readonly charLimit?: number | null;
  /** The locale of a container that sets none (§2.1: the project's `language`). Absent leaves such rows' locale empty. */
  readonly locale?: string;
}

/** Builds the rows for one or more containers, in the order given (binder order, by the caller). */
export function buildRows(sources: readonly DialogueSource[], options: TableOptions = {}): TableRow[] {
  const entries = options.entries ?? [];
  const charLimit = options.charLimit ?? null;
  const defaultLocale = options.locale?.trim() ?? '';
  const rows: TableRow[] = [];
  for (const source of sources) {
    const parsed = parseInk(source.body);
    const defaultId = source.meta?.speaker ?? '';
    const defaultEntry = defaultId === '' ? undefined : resolveSpeakerId(entries, defaultId);
    const locale = source.meta?.locBaseline ?? defaultLocale;
    for (const line of parsed.lines) {
      let speaker = defaultId;
      let display = defaultEntry?.name ?? '';
      let speakerName = display;
      if (line.speaker !== null) {
        const resolved = resolveSpeakerName(entries, line.speaker);
        if (resolved.kind === 'resolved') {
          speaker = resolved.entry.id;
          display = resolved.entry.name;
          speakerName = display;
        } else {
          speaker = line.speaker;
          display = '';
          speakerName = line.speaker;
        }
      }
      const path = line.node === ROOT_NODE_ID ? '' : line.node;
      rows.push({
        container: source.id,
        lineId: line.lineId ?? '',
        missing: line.lineId === null,
        kind: line.kind,
        speaker,
        speakerName,
        text: line.text,
        context: [path, display].filter((part) => part !== '').join(' / '),
        locale,
        charLimit,
        condition: line.condition ?? '',
        node: line.node,
        line: line.line,
      });
    }
  }
  return rows;
}

/** A value as one RFC 4180 field: quoted when it holds a comma, a quote or a line break, with quotes doubled. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The table as RFC 4180 CSV: a header row, then one CRLF-terminated record per row. `includeLocale` appends the `locale`
 * column after §6's five, and `includeConditions` appends `condition` after that.
 */
export function toCsv(rows: readonly TableRow[], options: { includeConditions?: boolean; includeLocale?: boolean } = {}): string {
  const columns: string[] = [...TABLE_COLUMNS];
  if (options.includeLocale === true) columns.push('locale');
  if (options.includeConditions === true) columns.push('condition');
  const records = rows.map((row) => {
    const values = [row.lineId, row.speaker, row.text, row.context, row.charLimit === null ? '' : String(row.charLimit)];
    if (options.includeLocale === true) values.push(row.locale);
    if (options.includeConditions === true) values.push(row.condition);
    return values.map(csvField).join(',');
  });
  return [columns.join(','), ...records].map((record) => `${record}\r\n`).join('');
}

/** How {@link toYarnCsv} names a row's file, and the cell transform it applies to the `language`, `text`, `file` and `comment` cells. */
export interface YarnCsvOptions {
  /** The `file` column: the name of the container a row comes from. Absent writes the container id. */
  readonly fileOf?: (containerId: string) => string;
  /**
   * Applied to `language`, `text`, `file` and `comment` after they are composed, such as a spreadsheet formula guard. Default:
   * unchanged.
   */
  readonly cell?: (value: string) => string;
}

/**
 * The rows as a Yarn Spinner strings file (the `yarn-csv` engine target, §2.1), RFC 4180 like the table. Each row maps so:
 * `language` = the row's locale; `id` = `line:` + the line id, the prefix Yarn's line ids carry; `text` = `Speaker: text`
 * for a spoken line with a speaker name (Yarn keeps the character name in the line), and the label alone for a choice;
 * `file` = the container; `node` = the knot path, empty for text above the first knot; `lineNumber` = the Ink line;
 * `lock` = empty; `comment` = the table's context. Yarn has no character limit column, so the limit is not written.
 */
export function toYarnCsv(rows: readonly TableRow[], options: YarnCsvOptions = {}): string {
  const cell = options.cell ?? ((value: string) => value);
  const fileOf = options.fileOf ?? ((id: string) => id);
  const records = rows.map((row) => {
    const text = row.kind === 'line' && row.speakerName !== '' ? `${row.speakerName}: ${row.text}` : row.text;
    const values = [
      cell(row.locale),
      `line:${row.lineId}`,
      cell(text),
      cell(fileOf(row.container)),
      row.node === ROOT_NODE_ID ? '' : row.node,
      String(row.line),
      '',
      cell(row.context),
    ];
    return values.map(csvField).join(',');
  });
  return [YARN_COLUMNS.join(','), ...records].map((record) => `${record}\r\n`).join('');
}

/** The rows as plain objects, for the JSON form of the tool and for callers that render the table themselves. */
export function toJsonRows(rows: readonly TableRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    lineId: row.lineId,
    speaker: row.speaker,
    text: row.text,
    context: row.context,
    charLimit: row.charLimit,
    ...(row.kind === 'choice' ? { condition: row.condition } : {}),
    container: row.container,
    node: row.node,
    line: row.line,
    kind: row.kind,
  }));
}

export interface CsvExport {
  readonly ok: true;
  readonly csv: string;
  readonly rows: readonly TableRow[];
}

export interface CsvRefusal {
  readonly ok: false;
  /** Rows with no valid id. §6: the table is the VO and loc surface, so an unkeyed row is refused. */
  readonly missing: readonly TableRow[];
  /** Ids that more than one row carries. §6: an id names one line, once. */
  readonly duplicates: readonly string[];
}

/**
 * The export gate (§6, "a validator at export, not a finding class"). A table with any row
 * lacking an id, or any id used twice, is refused with the rows that caused it. Minting the
 * missing ids first (`ensureLineIds`) is the caller's step, and its unplaceable lines stay here.
 */
export function exportCsv(sources: readonly DialogueSource[], options: TableOptions & { includeConditions?: boolean } = {}): CsvExport | CsvRefusal {
  const rows = buildRows(sources, options);
  const missing = rows.filter((row) => row.missing);
  const seen = new Map<string, number>();
  for (const row of rows) if (row.lineId !== '') seen.set(row.lineId, (seen.get(row.lineId) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (missing.length > 0 || duplicates.length > 0) return { ok: false, missing, duplicates };
  return { ok: true, csv: toCsv(rows, options.includeConditions === undefined ? {} : { includeConditions: options.includeConditions }), rows };
}
