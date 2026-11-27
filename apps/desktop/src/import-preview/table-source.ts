/**
 * **Import spreadsheet…** through the shared preview (#288, #289): delimited rows or one Excel worksheet become codex entries or timeline scenes.
 * Decoding and RFC 4180 parsing run in the preview's `'self'` Worker; mapping and re-planning stay cheap on the main
 * thread. The first twenty rows are shown with a role dropdown per column, a writer's mapping is reapplied to the
 * same column layout, and Import commits one `binder.importTree`.
 */
/* lingui-set comment="The CSV/TSV table import. Interpolated values: file, column, value and row name text; count, rows, line and limit are counts; encoding is an encoding's name." */

import { plural, t } from '@lingui/core/macro';
import {
  buildTimelineRows,
  guessColumnRoles,
  mapCodexRows,
  tableCellText,
  tableColumns,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  typeWord,
  type ColumnRole,
  type MappedTimelineRow,
  type TableDelimiter,
  type TableParse,
  type TableCellRow,
} from '@caotang/import-table';
import { MAX_TEXT_BYTES, MAX_TEXT_LINES } from '@caotang/import-read/text';
import { ARCHIVE_LIMITS } from '@caotang/import-read/zip';
import type { DecodableEncoding } from '@caotang/store/encoding';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewChip, PreviewCodexRow, PreviewLoss, PreviewNode, PreviewPlan, PreviewSettings } from './model.js';
import { ReaderHost } from './reader-host.js';
import { encodingLabel } from './text-source.js';

export type TableImportOpening = { readonly ok: true; readonly source: ImportPreviewSource } | { readonly ok: false; readonly message: string };

const MODE = 'table-mode';
const HEADER = 'table-header';
const DELIMITER = 'table-delimiter';
const SHEET = 'table-sheet';
const ENCODING = 'table-encoding';
const DATE_FORMAT = 'table-date-format';
const DAY_ZERO = 'table-day-zero';
const TYPE_PREFIX = 'table-type-';
const ROLE_PREFIX = 'table-role-';
const STORAGE_PREFIX = 'caotang.import-table.v1:';

const ENCODINGS: readonly DecodableEncoding[] = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'iso-8859-15', 'gb18030', 'big5', 'shift_jis', 'euc-kr'];
const CODEX_ROLES: readonly ColumnRole[] = ['name', 'aliases', 'type', 'description', 'long-text', 'tags', 'include-policy', 'image-file', 'relation', 'detail', 'scope', 'ignore'];
const TIMELINE_ROLES: readonly ColumnRole[] = ['title', 'start', 'end', 'duration', 'order', 'part', 'folder', 'pov', 'participants', 'location', 'arc', 'summary', 'body', 'ignore'];

interface CachedCsvTable {
  readonly kind: 'csv';
  readonly encoding: DecodableEncoding;
  readonly guessed: boolean;
  readonly candidates: readonly { readonly encoding: DecodableEncoding }[];
  readonly parse: TableParse;
}

interface CachedXlsxTable {
  readonly kind: 'xlsx';
  readonly sheets: string[];
  readonly sheet: string;
  readonly rows: TableCellRow[];
  readonly formulas: number;
  readonly times: number;
  readonly errors: number;
  readonly truncatedCells: number;
}

type CachedTable = CachedCsvTable | CachedXlsxTable;

interface FirstRead {
  readonly suggested: DecodableEncoding;
  readonly guessed: boolean;
  readonly choices: readonly DecodableEncoding[];
}

function isEncoding(value: string | undefined): value is DecodableEncoding {
  return value !== undefined && (ENCODINGS as readonly string[]).includes(value);
}

function roleWord(role: ColumnRole): string {
  switch (role) {
    case 'name': return t`Name`;
    case 'aliases': return t`Aliases`;
    case 'type': return t`Type`;
    case 'description': return t`Description`;
    case 'long-text': return t`Long text`;
    case 'tags': return t`Tags`;
    case 'include-policy': return t`Include policy`;
    case 'image-file': return t`Image file`;
    case 'relation': return t`Relation to…`;
    case 'detail': return t`Detail field`;
    case 'scope': return t`Scope`;
    case 'title': return t`Title`;
    case 'start': return t`Start`;
    case 'end': return t`End`;
    case 'duration': return t`Duration`;
    case 'order': return t`Order`;
    case 'part': return t`Part`;
    case 'folder': return t`Part/Chapter/Scene marker`;
    case 'pov': return t`POV`;
    case 'participants': return t`Participants`;
    case 'location': return t`Location`;
    case 'arc': return t`Arc/plotline`;
    case 'summary': return t`Summary`;
    case 'body': return t`Body`;
    case 'ignore': return t`Ignore`;
  }
}

const modeOf = (settings: PreviewSettings): 'codex' | 'timeline' => (settings.chips[MODE] === 'timeline' ? 'timeline' : 'codex');
const headerOf = (settings: PreviewSettings): boolean => settings.chips[HEADER] !== 'data';
const delimiterOf = (settings: PreviewSettings): TableDelimiter | undefined => {
  const value = settings.chips[DELIMITER];
  return value === ',' || value === ';' || value === '\t' || value === '|' ? value : undefined;
};
const encodingOf = (settings: PreviewSettings, first: FirstRead | null): DecodableEncoding | undefined => {
  const chosen = settings.chips[ENCODING];
  return isEncoding(chosen) ? chosen : first?.suggested;
};
const roleId = (mode: 'codex' | 'timeline', index: number): string => `${ROLE_PREFIX}${mode}-${index}`;
const roleOptions = (mode: 'codex' | 'timeline'): { value: string; label: string }[] => (mode === 'codex' ? CODEX_ROLES : TIMELINE_ROLES).map((role) => ({ value: role, label: roleWord(role) }));
const validRole = (mode: 'codex' | 'timeline', value: string | undefined): ColumnRole | undefined =>
  ((mode === 'codex' ? CODEX_ROLES : TIMELINE_ROLES) as readonly string[]).includes(value ?? '') ? (value as ColumnRole) : undefined;

/** The file is checked by size before its bytes are read. */
export function tableSizeRefusal(fileName: string, size: number, workbook = false): string | undefined {
  const limit = workbook ? ARCHIVE_LIMITS.maxArchiveBytes : MAX_TEXT_BYTES;
  if (size <= limit) return undefined;
  return t`${{ file: fileName }} is too large to import as a table: the import reads files up to ${{ limit: formatCount(limit / (1024 * 1024)) }} MB.`;
}

function storageKey(mode: 'codex' | 'timeline', columns: readonly string[]): string {
  return `${STORAGE_PREFIX}${mode}:${columns.map((column) => column.trim().toLowerCase()).join('\u001f')}`;
}

function storedRoles(mode: 'codex' | 'timeline', columns: readonly string[]): ColumnRole[] {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(mode, columns));
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => validRole(mode, typeof value === 'string' ? value : undefined) ?? 'ignore') : [];
  } catch {
    return [];
  }
}

function saveRoles(mode: 'codex' | 'timeline', columns: readonly string[], roles: readonly ColumnRole[]): void {
  try {
    globalThis.localStorage?.setItem(storageKey(mode, columns), JSON.stringify(roles));
  } catch {
    // A full or unavailable store must never block an import.
  }
}


const typeStorageKey = (value: string): string => `${STORAGE_PREFIX}type:${value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')}`;

function storedType(value: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(typeStorageKey(value)) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveType(value: string, mapped: string): void {
  try {
    globalThis.localStorage?.setItem(typeStorageKey(value), mapped);
  } catch {
    // A full or unavailable store must never block an import.
  }
}

function mappingLossSentence(code: string, row: number | undefined, column: string | undefined, value: string | undefined): string {
  const line = row ?? 0;
  if (code === 'bad-date') return t`A date could not be read in row ${{ line }}: ${{ value: value ?? '' }}. Choose the date format it uses.`;
  if (code === 'bad-number') return t`A number could not be read in row ${{ line }}: ${{ value: value ?? '' }}.`;
  if (code === 'unknown-type') return t`The type ${{ value: value ?? '' }} in row ${{ line }} is kept as a keyword. Choose what type the entry becomes above.`;
  if (code === 'kept-for-later') return t`${{ column: column ?? t`A column` }} in row ${{ line }} is kept in the entry's research page; this import does not map it further.`;
  if (code === 'image-file') return t`The image file ${{ value: value ?? '' }} in row ${{ line }} is named in the entry's research page; a standalone table import cannot read its image bytes.`;
  if (code === 'long-description') return t`A long description in row ${{ line }} is shown as an excerpt; its full text is kept in the research page.`;
  if (code === 'aliases-truncated') return t`The aliases ${{ value: value ?? '' }} in row ${{ line }} are left out; an entry keeps at most ten.`;
  return t`A required value is missing in row ${{ line }}.`;
}

function parseLosses(parse: TableParse): PreviewLoss[] {
  return parse.losses.map((loss) => {
    if (loss.code === 'unterminated-quote') return { message: t`A quoted cell that starts on line ${{ line: loss.line ?? 0 }} never closes; the text read so far is kept.` };
    if (loss.code === 'inconsistent-row') return { message: t`${plural({ count: loss.count ?? 0 }, { one: '# row has', other: '# rows have' })} a different number of cells from the first row.`, count: loss.count };
    return { message: t`The table could not be read completely.` };
  });
}

function workbookLosses(cached: CachedXlsxTable): PreviewLoss[] {
  const losses: PreviewLoss[] = [];
  if (cached.times > 0) losses.push({ message: t`${plural({ count: cached.times }, { one: '# date cell carries', other: '# date cells carry' })} a time of day, which this import does not keep.`, count: cached.times });
  if (cached.truncatedCells > 0) losses.push({ message: t`${plural({ count: cached.truncatedCells }, { one: '# cell is', other: '# cells are' })} cut at Excel's own character limit.`, count: cached.truncatedCells });
  return losses;
}

/** Open a `.csv`, `.tsv` or `.txt` table, or an `.xlsx` workbook starting with the zip signature, for the shared preview. */
export function tablePreviewSource(fileName: string, bytes: Uint8Array): TableImportOpening {
  const workbook = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const limit = workbook ? ARCHIVE_LIMITS.maxArchiveBytes : MAX_TEXT_BYTES;
  if (bytes.length > limit) return { ok: false, message: tableSizeRefusal(fileName, bytes.length, workbook) ?? '' };

  const host = new ReaderHost();
  const cache = new Map<string, CachedTable>();
  let first: FirstRead | null = null;
  let currentSettings: PreviewSettings = { chips: {}, options: {} };

  const keyOf = (settings: PreviewSettings): string => workbook ? `sheet|${settings.chips[SHEET] ?? 'first'}` : `${encodingOf(settings, first) ?? 'auto'}|${delimiterOf(settings) ?? 'auto'}`;
  const parseFailure = (kind: string, limit?: number): Error => {
    if (kind === 'too-many-rows') return new Error(t`${{ file: fileName }} has more rows than one table import reads: at most ${{ limit: formatCount(limit ?? 0) }}.`);
    if (kind === 'too-many-columns') return new Error(t`${{ file: fileName }} has more columns than one table import reads: at most ${{ limit: formatCount(limit ?? 0) }}.`);
    return new Error(t`${{ file: fileName }} holds no readable table rows.`);
  };
  const workbookFailure = (kind: string, value?: string): Error => {
    if (kind === 'too-many-rows') return parseFailure(kind, MAX_TABLE_ROWS);
    if (kind === 'too-many-columns') return parseFailure(kind, MAX_TABLE_COLUMNS);
    if (kind === 'too-many-cells') return new Error(t`${{ file: fileName }} has more cells than one workbook import reads: at most ${{ limit: formatCount(2_000_000) }}.`);
    if (kind === 'empty') return new Error(t`${{ file: fileName }} holds no readable table rows.`);
    if (kind === 'unknown-sheet') return new Error(t`${{ file: fileName }} has no worksheet named ${{ value: value ?? '' }}.`);
    if (kind === 'no-sheets') return new Error(t`${{ file: fileName }} holds no readable worksheets.`);
    if (kind === 'not-xlsx' || kind === 'archive' || kind === 'not-xml') return new Error(t`${{ file: fileName }} could not be read as an Excel workbook.`);
    return new Error(t`${{ file: fileName }} holds no readable table rows.`);
  };

  const cacheCsvReply = (reply: Awaited<ReturnType<ReaderHost['read']>>, settings: PreviewSettings): CachedCsvTable => {
    if (reply.kind !== 'table') throw new Error(t`The file could not be read as a table.`);
    if (reply.result.status !== 'read') throw new Error(t`The table text could not be decoded.`);
    if (!reply.result.parse.ok) throw parseFailure(reply.result.parse.error.kind, reply.result.parse.error.limit);
    const value: CachedCsvTable = { kind: 'csv', encoding: reply.result.encoding, guessed: reply.result.guessed, candidates: reply.result.candidates, parse: reply.result.parse.value };
    cache.clear();
    cache.set(keyOf(settings), value);
    return value;
  };

  const cacheXlsxReply = (reply: Awaited<ReturnType<ReaderHost['read']>>, settings: PreviewSettings): CachedXlsxTable => {
    if (reply.kind !== 'xlsx') throw new Error(t`The file could not be read as an Excel workbook.`);
    if (!reply.result.ok) throw workbookFailure(reply.result.error.kind, 'name' in reply.result.error ? reply.result.error.name : undefined);
    const value: CachedXlsxTable = { kind: 'xlsx', ...reply.result.value };
    cache.set(keyOf(settings), value);
    cache.set(`sheet|${value.sheet}`, value);
    return value;
  };


  const load = async (progress: (text: string) => void, signal: AbortSignal): Promise<void> => {
    progress(t`Reading ${{ file: fileName }}…`);
    const initial: PreviewSettings = { chips: {}, options: {} };
    if (workbook) {
      await host.open({ kind: 'open', reader: 'xlsx', bytes }, signal);
      cacheXlsxReply(await host.read({ kind: 'read', reader: 'xlsx' }, signal), initial);
      return;
    }
    await host.open({ kind: 'open', reader: 'table', bytes }, signal);
    const reply = await host.read({ kind: 'read', reader: 'table' }, signal);
    if (reply.kind !== 'table') throw new Error(t`The file could not be read as a table.`);
    if (reply.result.status === 'undecoded') {
      const decode = reply.result.decode;
      if (decode.status === 'too-large') throw new Error(tableSizeRefusal(fileName, decode.bytes) ?? '');
      if (decode.status === 'too-many-lines') throw new Error(t`${{ file: fileName }} has more lines than a table import reads: at most ${{ limit: formatCount(MAX_TEXT_LINES) }}.`);
      const suggested = decode.suggested;
      if (suggested === undefined) throw new Error(t`Caotang cannot tell which encoding ${{ file: fileName }} is in, so it cannot import it.`);
      const settings: PreviewSettings = { chips: { [ENCODING]: suggested }, options: {} };
      const second = await host.read({ kind: 'read', reader: 'table', encoding: suggested }, signal);
      const cached = cacheCsvReply(second, settings);
      first = { suggested, guessed: true, choices: [...new Set([suggested, ...decode.detection.candidates.map((candidate) => candidate.encoding)])] };
      cache.set(keyOf(initial), cached);
      return;
    }
    const cached = cacheCsvReply(reply, initial);
    first = {
      suggested: cached.encoding,
      guessed: cached.guessed,
      choices: cached.guessed ? [...new Set([cached.encoding, ...cached.candidates.map((candidate) => candidate.encoding)])] : [],
    };
    cache.set(keyOf(initial), cached);
  };

  const prepare = async (settings: PreviewSettings, signal: AbortSignal): Promise<void> => {
    if (cache.has(keyOf(settings))) return;
    if (workbook) {
      const sheet = settings.chips[SHEET];
      cacheXlsxReply(await host.read({ kind: 'read', reader: 'xlsx', ...(sheet === undefined ? {} : { sheet }) }, signal), settings);
      return;
    }
    const encoding = encodingOf(settings, first);
    const delimiter = delimiterOf(settings);
    const reply = await host.read({ kind: 'read', reader: 'table', ...(encoding === undefined ? {} : { encoding }), ...(delimiter === undefined ? {} : { delimiter }) }, signal);
    cacheCsvReply(reply, settings);
  };

  const cachedFor = (settings: PreviewSettings): CachedTable | undefined => cache.get(keyOf(settings)) ?? cache.values().next().value as CachedTable | undefined;

  const shapeFor = (settings: PreviewSettings) => {
    const cached = cachedFor(settings);
    if (cached === undefined) return undefined;
    const rows = cached.kind === 'csv' ? cached.parse.rows : cached.rows;
    const shape = tableColumns(rows, headerOf(settings));
    const mode = modeOf(settings);
    const guessed = guessColumnRoles(shape.columns, mode);
    const remembered = storedRoles(mode, shape.columns);
    const roles = shape.columns.map((_, index) => validRole(mode, settings.chips[roleId(mode, index)]) ?? remembered[index] ?? guessed[index] ?? 'ignore');
    return { cached, mode, ...shape, guessed, roles };
  };

  const timelineRowsFor = (settings: PreviewSettings) => {
    const shape = shapeFor(settings);
    if (shape === undefined || shape.mode !== 'timeline') return { shape, rows: [], losses: [] };
    return { shape, ...buildTimelineRows(shape.columns, shape.data, shape.roles, { dateFormat: (settings.chips[DATE_FORMAT] as 'iso' | 'dmy' | 'mdy' | undefined) ?? 'iso' }) };
  };

  const typeValuesOf = (settings: PreviewSettings): string[] => {
    const shape = shapeFor(settings);
    if (shape === undefined || shape.mode !== 'codex') return [];
    const index = shape.roles.indexOf('type');
    if (index < 0) return [];
    return [...new Set(shape.data.map((row) => tableCellText(row.cells[index] ?? '')).filter((value) => value !== ''))];
  };
  const typeId = (index: number): string => `${TYPE_PREFIX}${index}`;
  const typeOptions = (): { value: string; label: string }[] => [
    { value: 'character', label: t`Character` },
    { value: 'location', label: t`Location` },
    { value: 'object', label: t`Object` },
    { value: 'lore', label: t`Lore` },
    { value: 'subplot', label: t`Subplot` },
    { value: 'other', label: t`Other` },
  ];

  const chips = (): PreviewChip[] => {
    const settings = currentSettings;
    const shape = shapeFor(settings);
    const mode = shape?.mode ?? modeOf(settings);
    const rows = timelineRowsFor(settings).rows;
    const anchored = rows.filter((row) => row.startAbsolute === true);
    return [
      { id: MODE, label: t`Rows become`, value: mode, options: [{ value: 'codex', label: t`Codex entries` }, { value: 'timeline', label: t`Timeline scenes` }] },
      { id: HEADER, label: t`First row`, value: headerOf(settings) ? 'header' : 'data', options: [{ value: 'header', label: t`Column names` }, { value: 'data', label: t`Data` }] },
      ...(workbook && shape?.cached.kind === 'xlsx' && shape.cached.sheets.length > 1 ? [{ id: SHEET, label: t`Worksheet`, value: settings.chips[SHEET] ?? shape.cached.sheet, options: shape.cached.sheets.map((name) => ({ value: name, label: name })) }] : []),
      ...(workbook ? [] : [{ id: DELIMITER, label: t`Delimiter`, value: delimiterOf(settings) ?? 'auto', options: [{ value: 'auto', label: t`Automatic` }, { value: ',', label: t`Comma` }, { value: ';', label: t`Semicolon` }, { value: '\t', label: t`Tab` }, { value: '|', label: t`Pipe` }] }]),
      ...(workbook || first === null || first.choices.length === 0 ? [] : [{ id: ENCODING, label: t`Encoding`, value: settings.chips[ENCODING] ?? first.suggested, options: first.choices.map((encoding) => ({ value: encoding, label: encodingLabel(encoding) })) }]),
      ...(mode === 'timeline' ? [
        { id: DATE_FORMAT, label: t`Date format`, value: settings.chips[DATE_FORMAT] ?? 'iso', options: [{ value: 'iso', label: t`ISO year-month-day` }, { value: 'dmy', label: t`Day/month/year` }, { value: 'mdy', label: t`Month/day/year` }] },
        { id: DAY_ZERO, label: t`Day zero`, value: settings.chips[DAY_ZERO] ?? 'earliest', options: [{ value: 'earliest', label: t`The earliest dated row` }, ...anchored.slice(0, 30).map((row) => ({ value: `row:${row.row}`, label: t`Row ${{ line: row.row }} — ${{ row: row.title }}` }))] },
      ] : []),
      ...(mode === 'codex' ? typeValuesOf(settings).map((value, index) => {
        return { id: typeId(index), label: t`Type “${{ value }}” becomes`, value: settings.chips[typeId(index)] ?? storedType(value) ?? typeWord(value) ?? 'other', options: typeOptions() };
      }) : []),
    ];
  };

  const codexRows = (settings: PreviewSettings): PreviewCodexRow[] => {
    const shape = shapeFor(settings);
    if (shape === undefined) return [];
    if (shape.mode === 'timeline') {
      const mapped = buildTimelineRows(shape.columns, shape.data, shape.roles, { dateFormat: (settings.chips[DATE_FORMAT] as 'iso' | 'dmy' | 'mdy' | undefined) ?? 'iso' });
      const people = new Map<string, string>();
      for (const row of mapped.rows) {
        if (row.pov !== undefined && row.pov !== '') people.set(row.pov, 'character');
        for (const name of row.participants) people.set(name, 'character');
        for (const name of row.locations) people.set(name, 'location');
      }
      return [...people.entries()].map(([name, type], index) => ({
        id: `timeline-codex-${index}`,
        name,
        type,
        cite: { quote: name },
        page: { title: name, body: `${name}\n\n${type === 'location' ? t`A timeline row names this location.` : t`A timeline row names this character.`}` },
        preferPage: true,
      }));
    }
    return mapCodexRows(shape.columns, shape.data, shape.roles).rows.map((row) => {
      const long = [...row.description].length > 2000;
      const description = long ? `${[...row.description].slice(0, 1997).join('')}…` : row.description;
      const sections = [
        row.name,
        row.description,
        row.longText,
        ...(row.imageFile === undefined ? [] : [`${roleWord('image-file')}: ${row.imageFile}`]),
        ...Object.entries(row.keptFields).map(([key, value]) => `${key}: ${value}`),
      ].filter((part) => part !== '');
      return {
        id: `row-${row.row}`,
        name: row.name,
        type: row.scope?.trim().toLowerCase() === 'world' ? 'lore' : (() => {
          const index = row.sourceType === undefined ? -1 : typeValuesOf(settings).indexOf(row.sourceType);
          return index >= 0 ? (settings.chips[typeId(index)] ?? storedType(row.sourceType ?? '') ?? row.type) : row.type;
        })(),
        description,
        keywords: [...row.keywords, ...(row.vendorType === undefined ? [] : [row.vendorType])],
        aliases: row.aliases,
        ...(row.includePolicy === undefined ? {} : { includePolicy: row.includePolicy }),
        cite: { quote: row.name },
        page: { title: row.name, body: sections.join('\n\n') },
        preferPage: true,
      };
    });
  };

  type MutablePreviewNode = {
    -readonly [K in keyof PreviewNode]: PreviewNode[K];
  } & { children?: MutablePreviewNode[] };

  const orderedTimelineRows = (rows: readonly MappedTimelineRow[]): MappedTimelineRow[] =>
    rows.length > 0 && rows.every((row) => row.order !== undefined) ? [...rows].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : [...rows];

  const timelineTree = (rows: readonly MappedTimelineRow[], settings: PreviewSettings): { tree: PreviewNode[]; losses: PreviewLoss[]; scenes: number; words: number } => {
    const losses: PreviewLoss[] = [];
    const ordered = orderedTimelineRows(rows);
    const absolute = ordered.flatMap((row) => row.startAbsolute === true && row.start !== undefined ? [row.start] : []);
    const chosen = settings.chips[DAY_ZERO];
    const chosenRow = chosen?.startsWith('row:') === true ? ordered.find((row) => `row:${row.row}` === chosen) : undefined;
    const anchor = chosenRow?.start !== undefined ? chosenRow.start : absolute.length === 0 ? 0 : Math.min(...absolute);
    const roots: MutablePreviewNode[] = [];
    const scenes: MutablePreviewNode[] = [];
    let words = 0;

    const folderAt = (path: readonly string[], block: number): MutablePreviewNode => {
      let list = roots;
      let folder: MutablePreviewNode | undefined;
      for (const [depth, title] of path.entries()) {
        folder = list.find((node) => node.title === title && node.children !== undefined) as MutablePreviewNode | undefined;
        if (folder === undefined) {
          folder = { id: `folder-${path.slice(0, depth + 1).join('\u001f')}`, role: 'chapter', title, startBlock: block, endBlock: block, words: 0, children: [] };
          list.push(folder);
        }
        folder.endBlock = block;
        list = folder.children as MutablePreviewNode[];
      }
      return folder as MutablePreviewNode;
    };

    for (const [index, row] of ordered.entries()) {
      const body = row.body || row.summary;
      const start = row.start === undefined ? undefined : row.start - (row.startAbsolute === true ? anchor : 0);
      words += body.split(/\s+/).filter(Boolean).length;
      const sceneMeta: NonNullable<PreviewNode['sceneMeta']> = {
        ...(row.pov === undefined ? {} : { pov: row.pov }),
        ...(start === undefined ? {} : { dayOffset: start }),
        ...(row.duration === undefined ? {} : { durationDays: row.duration }),
        ...(row.participants.length === 0 ? {} : { expectedPresent: row.participants }),
        ...(row.locations.length === 0 ? {} : { locations: row.locations }),
        ...(row.part?.trim().toLowerCase() === 'prologue' || row.part?.trim().toLowerCase() === 'epilogue' ? { storyPart: row.part.trim().toLowerCase() as 'prologue' | 'epilogue' } : row.part?.trim().toLowerCase() === 'main' ? { mainStory: true } : {}),
      };
      const scene: MutablePreviewNode = {
        id: `scene-${index}`,
        role: 'scene',
        title: row.title,
        startBlock: index,
        endBlock: index,
        words: body.split(/\s+/).filter(Boolean).length,
        body,
        synopsis: row.summary,
        ...(Object.keys(sceneMeta).length === 0 ? {} : { sceneMeta }),
      };
      scenes.push(scene);
      const marker = row.folder?.trim() ?? '';
      const path = marker === '' || marker.toLowerCase() === 'main' ? [t`Imported timeline`] : marker.split('/').map((part) => part.trim()).filter((part) => part !== '');
      const folder = folderAt(path.length === 0 ? [t`Imported timeline`] : path, index);
      folder.endBlock = index;
      (folder.children as MutablePreviewNode[]).push(scene);
    }

    // Import arcs as Caotang threads. The format carries no payoff scene, so the last scene in reading order is the fallback payoff;
    // a one-scene import cannot use itself as payoff and names the loss instead.
    const documents = scenes;
    const fallback = documents[documents.length - 1] as MutablePreviewNode | undefined;
    const missingArcs = new Set<string>();
    for (const row of ordered) {
      if (row.arcs.length === 0) continue;
      const scene = scenes[ordered.indexOf(row)] as MutablePreviewNode;
      const payoff = fallback === scene && documents.length > 1 ? documents[0] : fallback;
      if (payoff === undefined || payoff === scene) {
        for (const arc of row.arcs) missingArcs.add(arc);
        continue;
      }
      scene.sceneMeta = { ...(scene.sceneMeta ?? {}), threads: row.arcs.map((arc) => ({ id: arc, payoff: `pending-node:${payoff.id}`, note: t`Imported plotline` })) };
    }
    if (missingArcs.size > 0) losses.push({ message: t`A plotline needs a different scene as its payoff, so a one-scene import cannot keep it: ${{ value: [...missingArcs].join(', ') }}` });
    return { tree: roots, losses, scenes: scenes.length, words };
  };

  const plan = (settings: PreviewSettings): PreviewPlan => {
    currentSettings = settings;
    const shape = shapeFor(settings);
    const empty = { words: 0, parts: 0, chapters: 0, scenes: 0, images: 0, comments: 0, footnotes: 0 };
    if (shape === undefined) return { blocks: [], markers: [], tree: [], counts: empty, losses: [], flags: [] };
    saveRoles(shape.mode, shape.columns, shape.roles);
    if (shape.mode === 'codex') {
      for (const [index, value] of typeValuesOf(settings).entries()) saveType(value, settings.chips[typeId(index)] ?? storedType(value) ?? typeWord(value) ?? 'other');
    }
    const tableLosses = shape.cached.kind === 'csv' ? parseLosses(shape.cached.parse) : workbookLosses(shape.cached);
    if (shape.mode === 'codex') {
      const mapped = mapCodexRows(shape.columns, shape.data, shape.roles);
      const rows = codexRows(settings);
      const body = rows.map((row) => `- ${row.name}`).join('\n');
      const worldRows = mapped.rows.filter((row) => row.scope?.trim().toLowerCase() === 'world').length;
      const tree: PreviewNode[] = [{ id: 'index', role: 'front', title: worldRows > 0 ? t`World history` : t`${{ file: fileName }} codex index`, startBlock: 0, endBlock: 0, words: rows.length, body, place: 'research' }];
      return {
        blocks: [{ kind: 'para', text: body }],
        markers: [],
        tree,
        counts: { ...empty, words: rows.length },
        losses: [...tableLosses, ...mapped.losses.map((loss) => ({ message: mappingLossSentence(loss.code, loss.row, loss.column, loss.value) }))],
        flags: [],
      };
    }
    const mapped = buildTimelineRows(shape.columns, shape.data, shape.roles, { dateFormat: (settings.chips[DATE_FORMAT] as 'iso' | 'dmy' | 'mdy' | undefined) ?? 'iso' });
    const built = timelineTree(mapped.rows, settings);
    const blocks = orderedTimelineRows(mapped.rows).map((row) => ({ kind: 'para' as const, text: row.body || row.summary }));
    return {
      blocks,
      markers: [],
      tree: built.tree,
      counts: { ...empty, scenes: built.scenes, chapters: built.tree.length, words: built.words },
      losses: [...tableLosses, ...mapped.losses.map((loss) => ({ message: mappingLossSentence(loss.code, loss.row, loss.column, loss.value) })), ...built.losses],
      flags: [],
    };
  };

  return {
    ok: true,
    source: {
      fileName,
      title: t`Import ${{ file: fileName }}`,
      intro: t`Choose what the rows become and what each column means. Nothing is written before Import.`,
      load,
      prepare,
      prepared: (settings) => cache.has(keyOf(settings)),
      dispose: () => host.dispose(),
      chips,
      options: () => [],
      plan,
      codexRows: () => codexRows(currentSettings),
      grid: (settings) => {
        const shape = shapeFor(settings);
        if (shape === undefined) return { columns: [], rows: [] };
        const options = roleOptions(shape.mode);
        return {
          columns: shape.columns.map((column, index) => ({ key: `${index}-${column}`, label: column, chipId: roleId(shape.mode, index), value: shape.roles[index] ?? 'ignore', options })),
          rows: shape.data.slice(0, 20).map((row) => row.cells),
        };
      },
      scanExtra: () => [],
      report: () => {
        const shape = shapeFor(currentSettings);
        const lines = [];
        if (shape !== undefined) lines.push(t`Rows are read as ${{ count: formatCount(shape.data.length) }} data rows. The column mapping is reapplied when this same column layout is imported again.`);
        if (shape?.cached.kind === 'xlsx') {
          lines.push(t`Rows come from the worksheet ${{ value: shape.cached.sheet }}.`);
          if (shape.cached.formulas > 0) lines.push(t`${plural({ count: shape.cached.formulas }, { one: '# formula is', other: '# formulas are' })} read as a cached value; formulas are never calculated.`);
          if (shape.cached.errors > 0) lines.push(t`${plural({ count: shape.cached.errors }, { one: '# cell holds', other: '# cells hold' })} a workbook error, kept as its text.`);
        }
        if (!workbook && first?.guessed === true) lines.push(t`The file is read as ${{ encoding: encodingLabel(encodingOf(currentSettings, first) ?? first.suggested) }}, a guess. If letters look wrong, choose another encoding.`);
        return [{ heading: t`Table`, label: t`Table`, lines }];
      },
      importLabel: (plan) => t`Import ${plural({ count: plan.counts.scenes > 0 ? plan.counts.scenes : plan.counts.words }, { one: '# row', other: '# rows' })}`,
    },
  };
}
