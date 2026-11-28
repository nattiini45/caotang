/** Column-role guessing and row mapping for CSV/TSV imports (#288). Pure: names and values in, import rows and losses out. */

import type { TableCellRow } from './parse.js';

export type CodexColumnRole = 'name' | 'aliases' | 'type' | 'description' | 'long-text' | 'tags' | 'include-policy' | 'image-file' | 'relation' | 'detail' | 'scope' | 'ignore';
export type TimelineColumnRole = 'title' | 'start' | 'end' | 'duration' | 'order' | 'part' | 'folder' | 'pov' | 'participants' | 'location' | 'arc' | 'summary' | 'body' | 'ignore';
export type ColumnRole = CodexColumnRole | TimelineColumnRole;

export const TABLE_COLUMN_ROLES: readonly ColumnRole[] = ['name', 'aliases', 'type', 'description', 'long-text', 'tags', 'include-policy', 'image-file', 'relation', 'detail', 'scope', 'title', 'start', 'end', 'duration', 'order', 'part', 'folder', 'pov', 'participants', 'location', 'arc', 'summary', 'body', 'ignore'];

export interface MappingLoss {
  readonly code: 'missing-required' | 'bad-date' | 'bad-number' | 'unknown-type' | 'kept-for-later' | 'image-file' | 'long-description' | 'aliases-truncated';
  readonly row?: number;
  readonly column?: string;
  readonly value?: string;
  readonly count?: number;
}

export interface MappedCodexRow {
  readonly row: number;
  readonly name: string;
  readonly aliases: string[];
  readonly type: string;
  readonly vendorType?: string;
  /** The type word the file used, whether or not the synonym table knew it. */
  readonly sourceType?: string;
  readonly description: string;
  readonly longText: string;
  readonly keywords: string[];
  readonly includePolicy?: string;
  readonly imageFile?: string;
  readonly scope?: string;
  readonly keptFields: Record<string, string>;
}

export interface MappedTimelineRow {
  readonly row: number;
  readonly title: string;
  readonly start?: number;
  /** True when `start` is an epoch day parsed from a calendar date rather than a relative story day. */
  readonly startAbsolute?: boolean;
  readonly end?: number;
  readonly endAbsolute?: boolean;
  readonly duration?: number;
  readonly order?: number;
  readonly part?: string;
  readonly folder?: string;
  readonly pov?: string;
  readonly participants: string[];
  readonly locations: string[];
  readonly arcs: string[];
  readonly summary: string;
  readonly body: string;
}

export type TimelineDateFormat = 'iso' | 'dmy' | 'mdy' | 'ymd';

/** The codex batch limit an import plans for; mirrored here so this pure reader stays dependency-free. */
export const TABLE_CODEX_ALIASES_MAX = 10;

const normal = (value: string): string => value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

const CODEX_GUESSES: [CodexColumnRole, readonly string[]][] = [
  ['name', ['name', 'title', 'character', 'entity', 'entry', 'full name']],
  ['aliases', ['alias', 'aliases', 'aka', 'also known as', 'nickname', 'nicknames', 'other names']],
  ['type', ['type', 'kind', 'category', 'entity type']],
  ['description', ['description', 'summary', 'short description', 'bio', 'notes']],
  ['long-text', ['long text', 'article', 'details', 'full text', 'history', 'background']],
  ['tags', ['tags', 'tag', 'keywords', 'keyword', 'labels']],
  ['include-policy', ['include policy', 'policy', 'visibility', 'private', 'secret', 'gm only']],
  ['image-file', ['image', 'image file', 'picture', 'portrait', 'avatar']],
  ['relation', ['relation', 'relationship', 'relationships', 'relation to']],
  ['detail', ['detail', 'details', 'attributes', 'properties']],
  ['scope', ['scope', 'world', 'world scope']],
];

const TIMELINE_GUESSES: [TimelineColumnRole, readonly string[]][] = [
  ['title', ['title', 'name', 'scene', 'scene title', 'event']],
  ['start', ['start', 'start date', 'date', 'day', 'day offset', 'begin']],
  ['end', ['end', 'end date', 'end day', 'finish']],
  ['duration', ['duration', 'duration days', 'length']],
  ['order', ['order', 'reading index', 'index', 'position', 'scene order']],
  ['part', ['part', 'chapter', 'chapter marker', 'scene marker', 'part chapter scene marker']],
  ['folder', ['folder path', 'folder', 'path', 'chapter path']],
  ['pov', ['pov', 'viewpoint', 'point of view', 'perspective']],
  ['participants', ['participants', 'characters', 'expected present', 'present', 'cast']],
  ['location', ['location', 'locations', 'place', 'setting']],
  ['arc', ['arc', 'plotline', 'plot line', 'thread', 'threads', 'subplot']],
  ['summary', ['summary', 'synopsis', 'description']],
  ['body', ['body', 'text', 'content', 'scene text', 'notes']],
];

/** Guess each column's role from the synonym table; duplicates after the first stay `ignore`. */
export function guessColumnRoles(columns: readonly string[], mode: 'codex' | 'timeline'): ColumnRole[] {
  const table = mode === 'codex' ? CODEX_GUESSES : TIMELINE_GUESSES;
  const used = new Set<ColumnRole>();
  return columns.map((column) => {
    const name = normal(column);
    const found = table.find(([role, words]) => !used.has(role) && (words.includes(name) || words.some((word) => name.startsWith(`${word} `))))?.[0];
    if (found !== undefined) used.add(found);
    return found ?? 'ignore';
  });
}

/** Spreadsheet lists use semicolons first; commas and newlines are also separators. */
export function splitCellList(value: string): string[] {
  const parts = value.includes(';') ? value.split(/[;\n]/) : value.split(/[,\n]/);
  return [...new Set(parts.map((item) => item.trim()).filter((item) => item !== ''))];
}

/** Entity names are unique case-insensitively in the codex and coherence metadata; keep the first spelling. */
function entityNames(values: readonly string[], except: readonly string[] = []): string[] {
  const seen = new Set(except.map((value) => value.trim().toLowerCase()));
  return values.filter((value) => {
    const key = value.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A spreadsheet cell's text without the apostrophe guard that keeps a leading formula character literal. */
export function tableCellText(value: string, preserveWhitespace = false): string {
  const text = preserveWhitespace ? value : value.trim();
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}

const PROSE_ROLES: readonly ColumnRole[] = ['description', 'long-text', 'relation', 'detail', 'summary', 'body'];

const cell = (row: TableCellRow, index: number, preserveWhitespace = false): string => tableCellText(row.cells[index] ?? '', preserveWhitespace);

const rowValues = (row: TableCellRow, roles: readonly ColumnRole[], role: ColumnRole): string[] =>
  roles.flatMap((candidate, index) => (candidate === role ? [cell(row, index, PROSE_ROLES.includes(role))].filter((value) => value !== '') : []));

export const TYPE_WORDS: Readonly<Record<string, string>> = {
  character: 'character', characters: 'character', person: 'character', people: 'character',
  location: 'location', locations: 'location', place: 'location', places: 'location',
  object: 'object', objects: 'object', item: 'object', items: 'object',
  lore: 'lore', knowledge: 'lore', world: 'lore',
  subplot: 'subplot', plot: 'subplot', arc: 'subplot', thread: 'subplot',
  other: 'other',
};

/** The built-in type for a source type word, or undefined when the synonym table does not define one. */
export function typeWord(value: string): string | undefined {
  const key = normal(value);
  return Object.hasOwn(TYPE_WORDS, key) ? TYPE_WORDS[key] : undefined;
}

/** Map rows in codex mode. A row without a name is named as a loss and skipped. */
export function mapCodexRows(columns: readonly string[], rows: readonly TableCellRow[], roles: readonly ColumnRole[]): { rows: MappedCodexRow[]; losses: MappingLoss[] } {
  const out: MappedCodexRow[] = [];
  const losses: MappingLoss[] = [];
  for (const row of rows) {
    const name = rowValues(row, roles, 'name')[0] ?? '';
    if (name === '') {
      losses.push({ code: 'missing-required', row: row.line, column: 'name' });
      continue;
    }
    const rawType = rowValues(row, roles, 'type')[0] ?? '';
    const mappedType = typeWord(rawType);
    if (rawType !== '' && mappedType === undefined) losses.push({ code: 'unknown-type', row: row.line, column: 'type', value: rawType });
    const policyText = normal(rowValues(row, roles, 'include-policy')[0] ?? '');
    const policy = policyText === 'always' || policyText === 'auto' || policyText === 'automatic' ? 'always'
      : policyText === 'manual' || policyText === 'private' || policyText === 'secret' || policyText === 'gm only' ? 'manual'
      : policyText === 'never' || policyText === 'exclude' || policyText === 'excluded' || policyText === 'hidden' ? 'never'
      : policyText === 'detected' ? 'detected'
      : undefined;
    const description = rowValues(row, roles, 'description')[0] ?? '';
    if ([...description].length > 2000) losses.push({ code: 'long-description', row: row.line });
    const keptFields: Record<string, string> = {};
    for (const role of ['relation', 'detail'] as const) {
      for (const [index, candidate] of roles.entries()) {
        if (candidate !== role) continue;
        const value = cell(row, index, true);
        if (value !== '') {
          const key = columns[index] ?? role;
          keptFields[key] = keptFields[key] === undefined ? value : `${keptFields[key]}\n\n${value}`;
          losses.push({ code: 'kept-for-later', row: row.line, column: key });
        }
      }
    }
    if ((rowValues(row, roles, 'image-file')[0] ?? '') !== '') losses.push({ code: 'image-file', row: row.line, column: 'image-file', value: rowValues(row, roles, 'image-file')[0] });
    const aliases = entityNames(splitCellList(rowValues(row, roles, 'aliases').join(';')), [name]);
    if (aliases.length > TABLE_CODEX_ALIASES_MAX) {
      losses.push({ code: 'aliases-truncated', row: row.line, column: 'aliases', value: aliases.slice(TABLE_CODEX_ALIASES_MAX).join('; '), count: aliases.length - TABLE_CODEX_ALIASES_MAX });
    }
    out.push({
      row: row.line,
      name,
      aliases: aliases.slice(0, TABLE_CODEX_ALIASES_MAX),
      type: mappedType ?? 'other',
      ...(rawType === '' ? {} : { sourceType: rawType }),
      ...(rawType !== '' && mappedType === undefined ? { vendorType: rawType } : {}),
      description,
      longText: rowValues(row, roles, 'long-text').join('\n\n'),
      keywords: splitCellList(rowValues(row, roles, 'tags').join(';')),
      ...(policy === undefined ? {} : { includePolicy: policy }),
      ...(rowValues(row, roles, 'image-file')[0] === undefined ? {} : { imageFile: rowValues(row, roles, 'image-file')[0] as string }),
      ...(rowValues(row, roles, 'scope')[0] === undefined ? {} : { scope: rowValues(row, roles, 'scope')[0] }),
      keptFields,
    });
  }
  return { rows: out, losses };
}

const intValue = (value: string): number | undefined => (/^[+-]?\d+$/.test(value.trim()) ? Number(value.trim()) : undefined);
const epochDay = (year: number, month: number, day: number): number | undefined => {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return Math.floor(date.getTime() / 86_400_000);
};

/** Parse ISO, explicit day/month/year or month/day/year, `Day N`, or a signed integer. Dates are never silently guessed. */
export function parseTimelineDay(value: string, format: TimelineDateFormat = 'iso'): number | undefined {
  const text = value.trim();
  const dayWord = /^day\s+([+-]?\d+)$/i.exec(text);
  if (dayWord !== null) return Number(dayWord[1]);
  const integer = intValue(text);
  if (integer !== undefined) return integer;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso !== null) return epochDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const parts = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/.exec(text);
  if (parts === null) return undefined;
  let year = Number(parts[3]);
  if (year < 100) year += year < 70 ? 2000 : 1900;
  const first = Number(parts[1]);
  const second = Number(parts[2]);
  if (format === 'dmy') return epochDay(year, second, first);
  if (format === 'mdy') return epochDay(year, first, second);
  return undefined;
}

/** A duration cell: an integer day count, or a count with `day(s)`, `week(s)`, `month(s)` or `year(s)`. */
export function parseDurationDays(value: string): number | undefined {
  const match = /^([+-]?\d+)\s*(days?|weeks?|months?|years?)?$/i.exec(value.trim());
  if (match === null) return undefined;
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count)) return undefined;
  const unit = (match[2] ?? 'day').toLowerCase();
  const factor = unit.startsWith('week') ? 7 : unit.startsWith('month') ? 30 : unit.startsWith('year') ? 365 : 1;
  const days = count * factor;
  return Number.isSafeInteger(days) && days >= 0 ? days : undefined;
}

/** Map rows in timeline mode. Absolute dates are epoch days here; the caller re-anchors them against its chosen day zero. */
export function buildTimelineRows(_columns: readonly string[], rows: readonly TableCellRow[], roles: readonly ColumnRole[], options: { dateFormat?: TimelineDateFormat } = {}): { rows: MappedTimelineRow[]; losses: MappingLoss[] } {
  const out: MappedTimelineRow[] = [];
  const losses: MappingLoss[] = [];
  const format = options.dateFormat ?? 'iso';
  for (const row of rows) {
    const title = rowValues(row, roles, 'title')[0] ?? '';
    if (title === '') {
      losses.push({ code: 'missing-required', row: row.line, column: 'title' });
      continue;
    }
    const date = (role: ColumnRole): { value?: number; absolute: boolean } => {
      const text = rowValues(row, roles, role)[0];
      if (text === undefined || text === '') return { absolute: false };
      const parsed = parseTimelineDay(text, format);
      if (parsed === undefined || parsed < -10_000_000 || parsed > 10_000_000) {
        losses.push({ code: 'bad-date', row: row.line, column: role, value: text });
        return { absolute: false };
      }
      const absolute = /^\d{4}-/.test(text.trim()) || /^\d{1,2}[./]\d{1,2}[./]\d{2,4}/.test(text.trim());
      return { value: parsed, absolute };
    };
    const number = (role: ColumnRole): number | undefined => {
      const text = rowValues(row, roles, role)[0];
      if (text === undefined || text === '') return undefined;
      const parsed = intValue(text);
      if (parsed === undefined) losses.push({ code: 'bad-number', row: row.line, column: role, value: text });
      return parsed;
    };
    const startDate = date('start');
    const endDate = date('end');
    const start = startDate.value;
    const end = endDate.value;
    let duration = (() => {
      const text = rowValues(row, roles, 'duration')[0];
      if (text === undefined || text === '') return undefined;
      const parsed = parseDurationDays(text);
      if (parsed === undefined) losses.push({ code: 'bad-number', row: row.line, column: 'duration', value: text });
      return parsed;
    })();
    if (duration === undefined && start !== undefined && end !== undefined && end >= start && startDate.absolute === endDate.absolute) duration = end - start;
    out.push({
      row: row.line,
      title,
      ...(start === undefined ? {} : { start }),
      ...(startDate.absolute ? { startAbsolute: true } : {}),
      ...(end === undefined ? {} : { end }),
      ...(endDate.absolute ? { endAbsolute: true } : {}),
      ...(duration === undefined ? {} : { duration }),
      ...(number('order') === undefined ? {} : { order: number('order') }),
      ...(rowValues(row, roles, 'part')[0] === undefined ? {} : { part: rowValues(row, roles, 'part')[0] }),
      ...(rowValues(row, roles, 'folder')[0] === undefined ? {} : { folder: rowValues(row, roles, 'folder')[0] }),
      ...(rowValues(row, roles, 'pov')[0] === undefined ? {} : { pov: rowValues(row, roles, 'pov')[0] }),
      participants: entityNames(splitCellList(rowValues(row, roles, 'participants').join(';'))),
      locations: entityNames(splitCellList(rowValues(row, roles, 'location').join(';'))),
      arcs: entityNames(splitCellList(rowValues(row, roles, 'arc').join(';'))),
      summary: rowValues(row, roles, 'summary')[0] ?? '',
      body: rowValues(row, roles, 'body')[0] ?? '',
    });
  }
  return { rows: out, losses };
}
