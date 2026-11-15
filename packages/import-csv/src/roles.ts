/**
 * What a column means (#288): the synonym table the reader guesses from, and the date reading the timeline mode
 * needs. A date is never guessed silently: the writer picks the format, and a value that does not fit it is
 * reported rather than read as something else.
 */

export type CsvMode = 'codex' | 'timeline';

export type CodexRole = 'name' | 'aliases' | 'type' | 'description' | 'text' | 'tags' | 'include' | 'image' | 'relation' | 'detail' | 'ignore';
export type TimelineRole = 'title' | 'start' | 'end' | 'duration' | 'order' | 'marker' | 'pov' | 'participants' | 'location' | 'arc' | 'summary' | 'body' | 'ignore';
export type CsvRole = CodexRole | TimelineRole;

export const CODEX_ROLES: readonly CodexRole[] = ['name', 'aliases', 'type', 'description', 'text', 'tags', 'include', 'image', 'relation', 'detail', 'ignore'];
export const TIMELINE_ROLES: readonly TimelineRole[] = ['title', 'start', 'end', 'duration', 'order', 'marker', 'pov', 'participants', 'location', 'arc', 'summary', 'body', 'ignore'];

const CODEX_SYNONYMS: Readonly<Record<CodexRole, readonly string[]>> = {
  name: ['name', 'title', 'character', 'entry', 'entity', 'subject', 'nom', 'nombre', 'titel'],
  aliases: ['aliases', 'alias', 'aka', 'also known as', 'nickname', 'nicknames', 'other names', 'alternative names'],
  type: ['type', 'kind', 'category', 'role', 'entity type', 'typ', 'categoría', 'categorie'],
  description: ['description', 'summary', 'synopsis', 'brief', 'excerpt', 'notes about', 'beschreibung', 'descripción'],
  text: ['text', 'body', 'entry text', 'long text', 'content', 'article', 'wiki', 'bio', 'biography', 'details'],
  tags: ['tags', 'tag', 'keywords', 'labels', 'themes', 'etiquetas', 'schlagwörter'],
  include: ['include', 'include policy', 'visibility', 'privacy', 'private'],
  image: ['image', 'image file', 'picture', 'photo', 'portrait', 'avatar', 'bild'],
  relation: ['relation', 'relations', 'relationship', 'relationships', 'related to', 'connections'],
  detail: ['detail', 'details field', 'property', 'properties', 'attribute', 'attributes', 'field'],
  ignore: [],
};

const TIMELINE_SYNONYMS: Readonly<Record<TimelineRole, readonly string[]>> = {
  title: ['title', 'name', 'event', 'scene', 'beat', 'summary title', 'titel', 'titre'],
  start: ['start', 'start date', 'date', 'day', 'begin', 'from', 'fecha', 'datum', 'début'],
  end: ['end', 'end date', 'to', 'until', 'finish', 'fin'],
  duration: ['duration', 'length', 'days', 'span', 'dauer'],
  order: ['order', 'position', 'index', 'sort', 'sequence', '#', 'no', 'number'],
  marker: ['level', 'kind', 'marker', 'scope', 'part', 'chapter', 'scene marker', 'type'],
  pov: ['pov', 'viewpoint', 'point of view', 'narrator', 'perspective'],
  participants: ['participants', 'characters', 'present', 'cast', 'who', 'people'],
  location: ['location', 'place', 'setting', 'where', 'ort'],
  arc: ['arc', 'plotline', 'plot line', 'thread', 'storyline', 'strand'],
  summary: ['summary', 'synopsis', 'description', 'brief', 'notes'],
  body: ['body', 'text', 'content', 'prose', 'scene text'],
  ignore: [],
};

const normalise = (header: string): string => header.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

/** The role a header suggests in this mode, or `ignore`. The first role whose synonym matches wins. */
export function guessRole(header: string, mode: CsvMode): CsvRole {
  const name = normalise(header);
  const table: Readonly<Record<string, readonly string[]>> = mode === 'codex' ? CODEX_SYNONYMS : TIMELINE_SYNONYMS;
  for (const [role, words] of Object.entries(table)) {
    if (words.some((word) => name === word || name.startsWith(`${word} `) || name.endsWith(` ${word}`))) return role as CsvRole;
  }
  return 'ignore';
}

/** A guess for every column: a role is used once, so two "name" columns do not both become the name. */
export function guessRoles(headers: readonly string[], mode: CsvMode): CsvRole[] {
  const taken = new Set<CsvRole>();
  return headers.map((header) => {
    const role = guessRole(header, mode);
    if (role === 'ignore' || taken.has(role)) return 'ignore';
    taken.add(role);
    return role;
  });
}

export type DateFormat = 'iso' | 'dmy' | 'mdy' | 'ymd' | 'day';

export const DATE_FORMATS: readonly DateFormat[] = ['iso', 'dmy', 'mdy', 'ymd', 'day'];

export interface DayReading {
  /** Whole days from the anchor, negative before it. */
  day: number | null;
  /** Why it could not be read, in the reader's own words. */
  problem?: string;
}

const DAY_WORD = /^(?:day|tag|jour|día)\s*(-?\d+)$/i;

/**
 * One cell as a day offset. `iso` reads `YYYY-MM-DD`; `dmy`, `mdy` and `ymd` read a separated date in that order;
 * `day` reads `Day N` or a plain integer. The anchor is the date day 0 stands for.
 */
export function readDay(value: string, format: DateFormat, anchor: Date): DayReading {
  const text = value.trim();
  if (text === '') return { day: null };
  const word = DAY_WORD.exec(text);
  if (word !== null) return { day: Number(word[1]) };
  if (/^-?\d+$/.test(text)) return { day: Number(text) };

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const parts = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/.exec(text);
  let year: number;
  let month: number;
  let day: number;
  if (iso !== null && (format === 'iso' || format === 'ymd')) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (parts !== null && format !== 'day' && format !== 'iso') {
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    const c = Number(parts[3]);
    if (format === 'dmy') {
      day = a;
      month = b;
      year = c;
    } else if (format === 'mdy') {
      month = a;
      day = b;
      year = c;
    } else {
      year = a;
      month = b;
      day = c;
    }
  } else {
    return { day: null, problem: `“${text}” is not a date in the chosen format` };
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return { day: null, problem: `“${text}” is not a real date` };
  const date = Date.UTC(year, month - 1, day);
  const base = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  return { day: Math.round((date - base) / 86_400_000) };
}

/** A duration cell: `3`, `3 days`, `2d`, `1 week`. Returns whole days, or null. */
export function readDuration(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (text === '') return null;
  const match = /^(-?\d+(?:\.\d+)?)\s*(d|day|days|w|week|weeks|tage|tag)?$/.exec(text);
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? 'd';
  return unit.startsWith('w') ? amount * 7 : amount;
}
