/**
 * **Import spreadsheet…** through the shared preview (import-csv.md, issue #288): the CSV reader (`@caotang/import-csv`) turns a
 * `.csv`, `.tsv` or `.txt` grid into codex rows or timeline scenes. The mode, the delimiter, the header, the date format and every
 * column's role are chips, so the writer chooses them and the file is read again. Nothing is written until Import, which commits
 * one `binder.importTree`.
 */
/* lingui-set comment="The spreadsheet import. Interpolated values: file (the file's name), column (a column's name), count (rows, entries), limit (the description limit)" */

import { plural, t } from '@lingui/core/macro';
import { CODEX_ROLES, TIMELINE_ROLES, type CsvError, type CsvImport, type CsvOptions, type CsvRole, type DateFormat, type Delimiter } from '@caotang/import-csv';

import type { ImportPreviewSource, PreviewBlock, PreviewChip, PreviewCodexRow, PreviewNode, PreviewPlan, PreviewReportList, PreviewSettings, ScanExtra } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';

export const CSV_CHIPS = { mode: 'csv-mode', delimiter: 'csv-delimiter', header: 'csv-header', dates: 'csv-dates', column: 'csv-column-' } as const;

/** What a codex description holds; the rest goes to the row's own page. */
const DESCRIPTION_LIMIT = 2000;

export function csvErrorText(error: CsvError): string {
  switch (error.kind) {
    case 'ask-encoding':
      return t`This file's encoding could not be read. Save it as UTF-8 and import it again.`;
    case 'empty':
      return t`This spreadsheet has no rows.`;
    case 'no-columns':
      return t`This spreadsheet has no columns.`;
  }
}

/** The words for a role, in the writer's language. */
function roleLabel(role: CsvRole): string {
  switch (role) {
    case 'name': return t`Name`;
    case 'aliases': return t`Aliases`;
    case 'type': return t`Type`;
    case 'description': return t`Description`;
    case 'text': return t`Long text (its own page)`;
    case 'tags': return t`Tags`;
    case 'include': return t`Include policy`;
    case 'image': return t`Image file`;
    case 'relation': return t`Relation`;
    case 'detail': return t`Detail field`;
    case 'title': return t`Title`;
    case 'start': return t`Start`;
    case 'end': return t`End`;
    case 'duration': return t`Duration`;
    case 'order': return t`Order`;
    case 'marker': return t`Marker`;
    case 'pov': return t`Point of view`;
    case 'participants': return t`Participants`;
    case 'location': return t`Location`;
    case 'arc': return t`Arc`;
    case 'summary': return t`Summary`;
    case 'body': return t`Body`;
    case 'ignore': return t`Leave out`;
  }
}

const modeOf = (settings: PreviewSettings): 'codex' | 'timeline' => (settings.chips[CSV_CHIPS.mode] === 'timeline' ? 'timeline' : 'codex');
const headerOf = (settings: PreviewSettings): boolean => settings.chips[CSV_CHIPS.header] !== 'no';

function delimiterOf(settings: PreviewSettings): Delimiter | 'auto' {
  const value = settings.chips[CSV_CHIPS.delimiter];
  return value === ',' || value === ';' || value === 'tab' || value === '|' ? (value === 'tab' ? '\t' : value) : 'auto';
}

function datesOf(settings: PreviewSettings): DateFormat {
  const value = settings.chips[CSV_CHIPS.dates];
  return value === 'dmy' || value === 'mdy' || value === 'ymd' || value === 'day' ? value : 'iso';
}

function rolesOf(settings: PreviewSettings, headers: readonly string[], mode: 'codex' | 'timeline'): CsvRole[] {
  const allowed: readonly CsvRole[] = mode === 'codex' ? CODEX_ROLES : TIMELINE_ROLES;
  return headers.map((_, index) => {
    const chosen = settings.chips[`${CSV_CHIPS.column}${index}`];
    return chosen !== undefined && (allowed as readonly string[]).includes(chosen) ? (chosen as CsvRole) : 'ignore';
  });
}

/** Whether the writer chose any column, so the reader's own guess is left alone when they did not. */
function anyRoleChosen(settings: PreviewSettings, headers: readonly string[]): boolean {
  return headers.some((_, index) => settings.chips[`${CSV_CHIPS.column}${index}`] !== undefined);
}

function optionsOf(settings: PreviewSettings, current: CsvImport | null): CsvOptions {
  const mode = modeOf(settings);
  const headers = current?.headers ?? [];
  const chosen = anyRoleChosen(settings, headers);
  return {
    delimiter: delimiterOf(settings),
    header: headerOf(settings),
    mode,
    dateFormat: datesOf(settings),
    ...(chosen ? { roles: rolesOf(settings, headers, mode) } : {}),
  };
}

const keyOf = (settings: PreviewSettings, current: CsvImport | null): string =>
  [modeOf(settings), delimiterOf(settings), headerOf(settings) ? 'header' : 'plain', datesOf(settings), ...(current?.headers ?? []).map((_, index) => settings.chips[`${CSV_CHIPS.column}${index}`] ?? '')].join('|');

function wordsIn(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/** The codex type a spreadsheet's own type word suggests; anything else is `other`, and the word stays a keyword. */
function codexTypeOf(type: string): string {
  const word = type.trim().toLowerCase();
  if (/^(character|person|people|figur|personaje)/.test(word)) return 'character';
  if (/^(location|place|ort|lugar|lieu)/.test(word)) return 'location';
  if (/^(object|item|thing|objekt|objeto)/.test(word)) return 'object';
  if (/^(subplot|plot|quest|handlung)/.test(word)) return 'subplot';
  if (/^(lore|world|note|journal|event|wissen)/.test(word)) return 'lore';
  return 'other';
}

/** A spreadsheet in the preview, read in the Worker. */
export function csvPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  const host = new ReaderHost();
  const openReq: ReaderOpen = { kind: 'open', reader: 'csv', bytes };
  const reads = new Map<string, CsvImport>();
  let current: CsvImport | null = null;

  const readAs = async (settings: PreviewSettings, signal: AbortSignal): Promise<CsvImport> => {
    const key = keyOf(settings, current);
    const held = reads.get(key);
    if (held !== undefined) {
      current = held;
      return held;
    }
    const reply = await host.read({ kind: 'read', reader: 'csv', options: optionsOf(settings, current) }, signal);
    if (reply.kind !== 'csv') throw new Error(t`It is not a spreadsheet import.`);
    if (!reply.result.ok) throw new Error(csvErrorText(reply.result.error));
    reads.set(key, reply.result.value);
    current = reply.result.value;
    return reply.result.value;
  };

  const chips = (): PreviewChip[] => {
    const read = current;
    const mode = read?.mode ?? 'codex';
    const base: PreviewChip[] = [
      {
        id: CSV_CHIPS.mode,
        label: t`Import as`,
        value: 'codex',
        options: [
          { value: 'codex', label: t`Codex entries` },
          { value: 'timeline', label: t`Timeline scenes` },
        ],
      },
      {
        id: CSV_CHIPS.delimiter,
        label: t`Columns separated by`,
        value: 'auto',
        options: [
          { value: 'auto', label: t`Detect it` },
          { value: ',', label: t`Comma` },
          { value: ';', label: t`Semicolon` },
          { value: 'tab', label: t`Tab` },
          { value: '|', label: t`Vertical bar` },
        ],
      },
      {
        id: CSV_CHIPS.header,
        label: t`First row`,
        value: 'yes',
        options: [
          { value: 'yes', label: t`Column names` },
          { value: 'no', label: t`Already data` },
        ],
      },
    ];
    if (mode === 'timeline') {
      base.push({
        id: CSV_CHIPS.dates,
        label: t`Dates are`,
        value: 'iso',
        options: [
          { value: 'iso', label: t`2026-01-31` },
          { value: 'dmy', label: t`31.01.2026 (day first)` },
          { value: 'mdy', label: t`01/31/2026 (month first)` },
          { value: 'ymd', label: t`2026/01/31 (year first)` },
          { value: 'day', label: t`Day numbers` },
        ],
      });
    }
    const roles: readonly CsvRole[] = mode === 'codex' ? CODEX_ROLES : TIMELINE_ROLES;
    for (const [index, header] of (read?.headers ?? []).entries()) {
      base.push({
        id: `${CSV_CHIPS.column}${index}`,
        label: header,
        value: read?.roles[index] ?? 'ignore',
        options: roles.map((role) => ({ value: role, label: roleLabel(role) })),
      });
    }
    return base;
  };

  /** The page a codex row's long text, image, relation and detail become. */
  const pageOf = (row: CsvImport['codex'][number]): { title: string; body: string } => {
    const parts = [`# ${row.name}`];
    if (row.type !== '') parts.push(row.type);
    if (row.text !== '') parts.push(row.text);
    else if (row.description !== '') parts.push(row.description);
    if (row.detail !== '') parts.push(`## ${t`Details`}\n${row.detail}`);
    if (row.relation !== '') parts.push(`## ${t`Connections`}\n${row.relation}`);
    if (row.image !== '') parts.push(`${t`Image file`}: ${row.image}`);
    return { title: row.name, body: parts.join('\n\n') };
  };

  const codexRows = (): PreviewCodexRow[] => {
    const read = current;
    if (read === null || read.mode !== 'codex') return [];
    return read.codex.map((row, index) => {
      const page = pageOf(row);
      const keywords = [...(row.type === '' ? [] : [row.type]), ...row.tags];
      const description = row.description === '' ? row.text.slice(0, 300) : row.description;
      return {
        id: `csv-row-${index}`,
        name: row.name,
        type: codexTypeOf(row.type),
        ...(description === '' ? {} : { description: [...description].slice(0, DESCRIPTION_LIMIT).join('') }),
        ...(row.aliases.length === 0 ? {} : { aliases: row.aliases }),
        ...(keywords.length === 0 ? {} : { keywords }),
        ...(row.include.toLowerCase().startsWith('man') || row.include.toLowerCase() === 'private' ? { includePolicy: 'manual' } : {}),
        page,
        preferPage: true,
      };
    });
  };

  /** The note a timeline row's own numbers become, since the import command carries no timeline fields. */
  const timelineNote = (row: CsvImport['timeline'][number]): string => {
    const lines: string[] = [];
    if (row.startDay !== null) lines.push(`${t`Start`}: ${t`day`} ${row.startDay}`);
    if (row.endDay !== null) lines.push(`${t`End`}: ${t`day`} ${row.endDay}`);
    if (row.durationDays !== null) lines.push(`${t`Duration`}: ${row.durationDays} ${t`days`}`);
    if (row.order !== null) lines.push(`${t`Order`}: ${row.order}`);
    if (row.marker !== '') lines.push(`${t`Marker`}: ${row.marker}`);
    return lines.join('\n');
  };

  const plan = (): PreviewPlan => {
    const read = current;
    const blocks: PreviewBlock[] = [];
    const tree: PreviewNode[] = [];
    let words = 0;
    if (read !== null && read.mode === 'timeline') {
      const rows = [...read.timeline].sort((a, b) => (a.order === null || b.order === null ? a.row - b.row : a.order - b.order));
      for (const [index, row] of rows.entries()) {
        const body = row.body;
        const start = blocks.length;
        for (const line of body.split('\n')) {
          if (line.trim() === '') continue;
          blocks.push({ kind: 'para', text: line });
          words += wordsIn(line);
        }
        const keywords = [row.pov, row.location, row.arc, ...row.participants].filter((word) => word !== '');
        const note = timelineNote(row);
        tree.push({
          id: `csv-scene-${index}`,
          role: 'scene',
          title: row.title,
          startBlock: start,
          endBlock: Math.max(start, blocks.length - 1),
          words: wordsIn(body),
          body,
          ...(row.summary === '' ? {} : { synopsis: row.summary }),
          ...(keywords.length === 0 ? {} : { keywords }),
          ...(note === '' ? {} : { notes: note }),
        });
      }
    }
    return {
      blocks,
      markers: [],
      tree,
      counts: { words, parts: 0, chapters: 0, scenes: tree.length, images: 0, comments: 0, footnotes: 0 },
      losses: (read?.problems ?? []).map((message) => ({ message })),
      flags: [],
    };
  };

  const report = (): PreviewReportList[] => {
    const read = current;
    if (read === null) return [];
    const lists: PreviewReportList[] = [];
    const rows = read.mode === 'codex' ? read.codex.length : read.timeline.length;
    const carried: string[] = [
      read.mode === 'codex'
        ? plural(rows, { one: '# row is offered as a codex entry with its own Research page', other: '# rows are offered as codex entries with their own Research pages' })
        : plural(rows, { one: '# row became a scene', other: '# rows became scenes' }),
    ];
    const mapped = read.roles.filter((role) => role !== 'ignore').length;
    carried.push(plural(mapped, { one: '# column was mapped', other: '# columns were mapped' }));
    if (read.mode === 'timeline') {
      const anchor = read.anchor;
      carried.push(t`Days are counted from ${anchor}, the first date in the file.`);
    }
    lists.push({ heading: t`Spreadsheet`, label: t`What the file carried`, lines: carried });

    const approximated: string[] = [];
    if (read.mode === 'codex') {
      const withImage = read.codex.filter((row) => row.image !== '').length;
      const withRelation = read.codex.filter((row) => row.relation !== '').length;
      const withDetail = read.codex.filter((row) => row.detail !== '').length;
      if (withImage > 0) approximated.push(plural(withImage, { one: '# image file name is kept as text; the picture itself is not in a spreadsheet', other: '# image file names are kept as text; the pictures themselves are not in a spreadsheet' }));
      if (withRelation > 0) approximated.push(plural(withRelation, { one: '# relation is written as text on its page, not as a typed relation', other: '# relations are written as text on their pages, not as typed relations' }));
      if (withDetail > 0) approximated.push(plural(withDetail, { one: '# detail field is written as text on its page, not as a field', other: '# detail fields are written as text on their pages, not as fields' }));
    } else {
      const dated = read.timeline.filter((row) => row.startDay !== null || row.endDay !== null || row.durationDays !== null).length;
      const arcs = read.timeline.filter((row) => row.arc !== '').length;
      if (dated > 0) approximated.push(plural(dated, { one: '# row’s days are kept as a note on its scene, not as a timeline date', other: '# rows’ days are kept as notes on their scenes, not as timeline dates' }));
      if (arcs > 0) approximated.push(plural(arcs, { one: '# arc became a keyword, not a plotline', other: '# arcs became keywords, not plotlines' }));
    }
    if (approximated.length > 0) lists.push({ heading: t`Spreadsheet`, label: t`What was approximated`, lines: approximated });
    return lists;
  };

  const scanExtra = (): ScanExtra[] => {
    const read = current;
    if (read === null) return [];
    const label = t`Codex pages`;
    return read.mode === 'codex' ? read.codex.map((row) => ({ label, text: pageOf(row).body })) : [];
  };

  const first: PreviewSettings = { chips: {}, options: {} };

  return {
    fileName,
    title: t`Import “${{ file: fileName }}”`,
    load: async (progress, signal) => {
      progress(t`Reading ${{ file: fileName }}…`);
      await host.open(openReq, signal);
      await readAs(first, signal);
    },
    prepare: async (settings, signal) => {
      await readAs(settings, signal);
    },
    prepared: (settings) => reads.has(keyOf(settings, current)),
    dispose: () => host.dispose(),
    chips,
    options: () => [],
    plan,
    codexRows,
    scanExtra,
    report,
    importLabel: () => {
      const read = current;
      const rows = read === null ? 0 : read.mode === 'codex' ? read.codex.length : read.timeline.length;
      if (rows === 0) return t`Import`;
      return read?.mode === 'codex' ? plural(rows, { one: 'Import # entry', other: 'Import # entries' }) : plural(rows, { one: 'Import # scene', other: 'Import # scenes' });
    },
  };
}
