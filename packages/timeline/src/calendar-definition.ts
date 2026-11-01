/**
 * A custom calendar as data — [timeline.md §3.8](../../../docs/architecture/timeline.md), "Custom calendars".
 *
 * A definition is plain JSON, versioned (`version: 1`), and describes how story days are *named*: the length and names of
 * the months, which years are leap years, the days that belong to no month, and the eras that count years. It never
 * changes a stored day, a duration or a part, so switching or editing a calendar is always safe.
 *
 * Nothing here is arithmetic. This file only reads and checks the shape: every collection is bounded, every number is a
 * safe integer in a stated range, every name can be written into a label and read back out of it. The cycle arithmetic is
 * `calendar-cycle.ts`, and the last check — that every label of a definition parses back to its own day — is run by
 * `validateCalendarDefinition` in `calendar-lens.ts`, which is the function a caller uses.
 *
 * Years in a definition are *shown* years: with `yearZero: 'skip'` there is no year 0 (1 follows −1), and with `'include'`
 * there is. `leap` rules count years without that gap, so a rule such as "every 4th year" has no seam at the turn of the era.
 */

export const CALENDAR_VERSION = 1 as const;

/** Every bound a definition keeps, so a calendar can be stored, drawn and read back at a known cost. */
export const CALENDAR_LIMITS = {
  idChars: 40,
  titleChars: 60,
  nameChars: 40,
  months: 64,
  intercalary: 32,
  leapRules: 8,
  eras: 32,
  /** Days of one month or one intercalary entry. */
  entryDays: 1000,
  /** Days of any one year, leap or not. */
  yearDays: 10_000,
  /** How many years the leap pattern may take to repeat. */
  cycleYears: 10_000,
  /** The largest `every` of a leap rule. */
  everyYears: 10_000,
  /** The largest year an epoch or an era may name, either side of 0. */
  yearMagnitude: 1_000_000_000,
} as const;

export type YearZeroPolicy = 'include' | 'skip';
export type LeapEffect = 'include' | 'exclude';

export interface CalendarEpoch {
  /** The shown year day 0 falls in. */
  year: number;
  /** 1-based index into `months`. */
  month: number;
  /** 1-based day of that month. */
  day: number;
}

export interface CalendarMonth {
  name: string;
  days: number;
  /** Days added to this month in a leap year. Absent is none. */
  leapDays?: number;
}

export interface CalendarIntercalary {
  name: string;
  days: number;
  /** How many months come before it in the year: 0 puts it before the first month, `months.length` after the last. */
  after: number;
  /** True when it exists only in leap years. */
  leapOnly?: boolean;
}

export interface CalendarLeapRule {
  /** Matches every year that is `offset` plus a multiple of this. */
  every: number;
  /** Default 0. */
  offset?: number;
  /** The last rule that matches a year decides it: `include` makes it a leap year, `exclude` makes it a common year. */
  rule: LeapEffect;
}

export interface CalendarEra {
  name: string;
  /** The shown year the era begins at. The first era has none: it reaches back without end. */
  startYear?: number;
  /** The first era only: its years count down toward the next era's start, as BCE does. */
  reversed?: boolean;
}

export interface CalendarDefinition {
  version: typeof CALENDAR_VERSION;
  /** Lower-case letters, digits and hyphens. The lens's id is `calendar:` plus this. */
  id: string;
  name: string;
  yearZero: YearZeroPolicy;
  epoch: CalendarEpoch;
  months: CalendarMonth[];
  intercalary?: CalendarIntercalary[];
  leap?: CalendarLeapRule[];
  eras?: CalendarEra[];
}

export type CalendarProblemCode =
  | 'not-an-object'
  | 'version'
  | 'unknown-key'
  | 'wrong-type'
  | 'blank'
  | 'too-long'
  | 'too-many'
  | 'out-of-range'
  | 'id-format'
  | 'name-comma'
  | 'name-digit-start'
  | 'name-spacing'
  | 'duplicate'
  | 'year-zero'
  | 'era-first-start'
  | 'era-start-required'
  | 'era-order'
  | 'era-reversed'
  | 'leap-no-effect'
  | 'leap-no-rule'
  | 'leap-never'
  | 'cycle-too-long'
  | 'year-too-long'
  | 'epoch-day'
  | 'round-trip';

/** One thing wrong with a definition. `field` is a path such as `months[2].days`; `message` names it in plain words. */
export interface CalendarProblem {
  field: string;
  code: CalendarProblemCode;
  message: string;
  /** The numbers and words the message was written from, so a caller can write it again in its own language. */
  values?: Readonly<Record<string, string | number>>;
}

export type CalendarValidation =
  | { readonly ok: true; readonly definition: CalendarDefinition }
  | { readonly ok: false; readonly problems: readonly CalendarProblem[] };

/** The most problems one check reports: enough to fix a definition in one pass, few enough to read. */
const MAX_PROBLEMS = 20;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** What a person sees when a number is out of range, with the digits grouped. */
const grouped = (value: number): string => value.toLocaleString('en-US');

/** A name is folded the same way when it is compared and when a label is parsed, so "rains" finds "Rains". */
export function foldName(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

/** The year as a contiguous integer: with no year 0, −1 is the year before 1, so it counts as 0 and −2 as −1. */
export function contiguousYear(shown: number, yearZero: YearZeroPolicy): number {
  return yearZero === 'skip' && shown < 0 ? shown + 1 : shown;
}

/** The inverse of {@link contiguousYear}. */
export function shownYear(contiguous: number, yearZero: YearZeroPolicy): number {
  return yearZero === 'skip' && contiguous <= 0 ? contiguous - 1 : contiguous;
}

class Collector {
  readonly problems: CalendarProblem[] = [];

  add(field: string, code: CalendarProblemCode, message: string, values?: Readonly<Record<string, string | number>>): void {
    if (this.problems.length >= MAX_PROBLEMS) return;
    this.problems.push({ field, code, message: `${field}: ${message}`, ...(values === undefined ? {} : { values }) });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function closedKeys(value: Record<string, unknown>, allowed: readonly string[], field: string, out: Collector): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      out.add(field === '' ? key : `${field}.${key}`, 'unknown-key', `is not a part of a calendar; a calendar has only ${allowed.join(', ')}.`, { key });
    }
  }
}

function wholeNumber(value: unknown, field: string, min: number, max: number, out: Collector): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    out.add(field, 'wrong-type', 'must be a whole number.', { expected: 'a whole number' });
    return undefined;
  }
  if (value < min || value > max) {
    out.add(field, 'out-of-range', `must be a whole number from ${grouped(min)} to ${grouped(max)}.`, { min, max });
    return undefined;
  }
  return value;
}

function optionalWholeNumber(source: Record<string, unknown>, key: string, field: string, min: number, max: number, out: Collector): number | undefined {
  return source[key] === undefined ? undefined : wholeNumber(source[key], `${field}.${key}`, min, max, out);
}

function trueOrFalse(source: Record<string, unknown>, key: string, field: string, out: Collector): boolean | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    out.add(`${field}.${key}`, 'wrong-type', 'must be true or false.', { expected: 'true or false' });
    return undefined;
  }
  return value;
}

function listOf(source: Record<string, unknown>, key: string, max: number, out: Collector): unknown[] | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    out.add(key, 'wrong-type', 'must be a list.', { expected: 'a list' });
    return undefined;
  }
  if (value.length > max) {
    out.add(key, 'too-many', `can hold at most ${max} entries, and this one holds ${value.length}.`, { max });
    return undefined;
  }
  return value;
}

/**
 * A name as it will be written into a label. A comma ends the day-and-month part of a label, a leading digit would make a
 * month read as a day count, and a space that is doubled or trimmed would not survive being typed back, so each is refused
 * by name rather than quietly mended.
 */
function readName(value: unknown, field: string, max: number, out: Collector): string | undefined {
  if (typeof value !== 'string') {
    out.add(field, 'wrong-type', 'must be text.', { expected: 'text' });
    return undefined;
  }
  const text = value.normalize('NFC');
  if (text.trim() === '') {
    out.add(field, 'blank', 'must not be blank.');
    return undefined;
  }
  if ([...text].length > max) {
    out.add(field, 'too-long', `can be at most ${max} characters long.`, { max });
    return undefined;
  }
  if (text.includes(',')) {
    out.add(field, 'name-comma', 'must not contain a comma, because a comma ends the day and month in a label.');
    return undefined;
  }
  // `\p{Cc}` is the control characters (tab, line breaks, NUL and the C1 range); `\s` that is not a plain space is the rest.
  if (/\p{Cc}|[\u2028\u2029]/u.test(text) || text !== text.trim() || /[^\S ]/.test(text) || text.includes('  ')) {
    out.add(field, 'name-spacing', 'must not start or end with a space, hold two spaces in a row, or hold a tab or a line break.');
    return undefined;
  }
  if (/^\p{Nd}/u.test(text)) {
    out.add(field, 'name-digit-start', 'must not start with a digit, because a label starts with the day number.');
    return undefined;
  }
  return text;
}

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

/** How many years the leap pattern takes to repeat, or `undefined` past the limit. No rules repeats every year. */
export function leapCycleYears(rules: readonly { every: number }[]): number | undefined {
  let cycle = 1;
  for (const rule of rules) {
    cycle = (cycle / gcd(cycle, rule.every)) * rule.every;
    if (cycle > CALENDAR_LIMITS.cycleYears) return undefined;
  }
  return cycle;
}

/**
 * Reads a definition as data and returns it in canonical form: keys in a fixed order, defaults left out, names in NFC.
 * Everything that can be decided from the definition's own fields is decided here; what needs the calendar's arithmetic
 * (the epoch's day against the real length of its month, whether a leap rule ever fires, whether the labels parse back) is
 * `validateCalendarDefinition`'s.
 */
export function normalizeCalendarDefinition(input: unknown): CalendarValidation {
  const out = new Collector();
  if (!isRecord(input)) {
    out.add('calendar', 'not-an-object', 'must be an object.');
    return { ok: false, problems: out.problems };
  }
  if (input['version'] !== CALENDAR_VERSION) {
    out.add('version', 'version', `must be ${CALENDAR_VERSION}; this calendar was written for a version this build cannot read.`, { expected: CALENDAR_VERSION });
    return { ok: false, problems: out.problems };
  }
  closedKeys(input, ['version', 'id', 'name', 'yearZero', 'epoch', 'months', 'intercalary', 'leap', 'eras'], '', out);

  let id: string | undefined;
  if (typeof input['id'] !== 'string') out.add('id', 'wrong-type', 'must be text.', { expected: 'text' });
  else if ([...input['id']].length > CALENDAR_LIMITS.idChars) out.add('id', 'too-long', `can be at most ${CALENDAR_LIMITS.idChars} characters long.`, { max: CALENDAR_LIMITS.idChars });
  else if (!ID_PATTERN.test(input['id'])) out.add('id', 'id-format', 'must use lower-case letters, digits and hyphens, and start with a letter or digit.');
  else id = input['id'];

  const name = readName(input['name'], 'name', CALENDAR_LIMITS.titleChars, out);

  let yearZero: YearZeroPolicy | undefined;
  if (input['yearZero'] !== 'include' && input['yearZero'] !== 'skip') {
    out.add('yearZero', 'wrong-type', 'must be "include" or "skip".', { expected: '"include" or "skip"' });
  } else yearZero = input['yearZero'];

  const used = new Map<string, string>();
  const claim = (label: string, field: string): void => {
    const key = foldName(label);
    const other = used.get(key);
    if (other !== undefined) out.add(field, 'duplicate', `repeats the name of ${other}; every month and every day outside the months needs its own name.`, { other });
    else used.set(key, field);
  };

  const monthList = listOf(input, 'months', CALENDAR_LIMITS.months, out);
  const months: CalendarMonth[] = [];
  if (monthList === undefined) {
    if (input['months'] === undefined) out.add('months', 'wrong-type', 'must be a list of at least one month.', { expected: 'a list' });
  } else if (monthList.length === 0) {
    out.add('months', 'wrong-type', 'must hold at least one month.', { expected: 'a list' });
  }
  for (const [index, raw] of (monthList ?? []).entries()) {
    const field = `months[${index}]`;
    if (!isRecord(raw)) {
      out.add(field, 'wrong-type', 'must be an object with a name and a number of days.', { expected: 'an object' });
      continue;
    }
    closedKeys(raw, ['name', 'days', 'leapDays'], field, out);
    const monthName = readName(raw['name'], `${field}.name`, CALENDAR_LIMITS.nameChars, out);
    const days = wholeNumber(raw['days'], `${field}.days`, 1, CALENDAR_LIMITS.entryDays, out);
    const leapDays = optionalWholeNumber(raw, 'leapDays', field, 0, CALENDAR_LIMITS.entryDays, out);
    if (monthName === undefined || days === undefined) continue;
    claim(monthName, `${field}.name`);
    months.push({ name: monthName, days, ...(leapDays === undefined || leapDays === 0 ? {} : { leapDays }) });
  }

  const interList = listOf(input, 'intercalary', CALENDAR_LIMITS.intercalary, out);
  const intercalary: CalendarIntercalary[] = [];
  for (const [index, raw] of (interList ?? []).entries()) {
    const field = `intercalary[${index}]`;
    if (!isRecord(raw)) {
      out.add(field, 'wrong-type', 'must be an object with a name, a number of days and a position.', { expected: 'an object' });
      continue;
    }
    closedKeys(raw, ['name', 'days', 'after', 'leapOnly'], field, out);
    const entryName = readName(raw['name'], `${field}.name`, CALENDAR_LIMITS.nameChars, out);
    const days = wholeNumber(raw['days'], `${field}.days`, 1, CALENDAR_LIMITS.entryDays, out);
    const after = wholeNumber(raw['after'], `${field}.after`, 0, Math.max(months.length, monthList?.length ?? 0), out);
    const leapOnly = trueOrFalse(raw, 'leapOnly', field, out);
    if (entryName === undefined || days === undefined || after === undefined) continue;
    // A many-day entry is written "Name 2", so its labels must not collide with another entry's name.
    if (days === 1) claim(entryName, `${field}.name`);
    else for (let day = 1; day <= days; day += 1) claim(`${entryName} ${day}`, `${field}.name`);
    intercalary.push({ name: entryName, days, after, ...(leapOnly === true ? { leapOnly } : {}) });
  }

  const leapList = listOf(input, 'leap', CALENDAR_LIMITS.leapRules, out);
  const leap: CalendarLeapRule[] = [];
  for (const [index, raw] of (leapList ?? []).entries()) {
    const field = `leap[${index}]`;
    if (!isRecord(raw)) {
      out.add(field, 'wrong-type', 'must be an object with an "every" and a "rule".', { expected: 'an object' });
      continue;
    }
    closedKeys(raw, ['every', 'offset', 'rule'], field, out);
    const every = wholeNumber(raw['every'], `${field}.every`, 1, CALENDAR_LIMITS.everyYears, out);
    const offset = every === undefined ? undefined : optionalWholeNumber(raw, 'offset', field, 0, every - 1, out);
    if (raw['rule'] !== 'include' && raw['rule'] !== 'exclude') {
      out.add(`${field}.rule`, 'wrong-type', 'must be "include" or "exclude".', { expected: '"include" or "exclude"' });
      continue;
    }
    if (every === undefined) continue;
    leap.push({ every, ...(offset === undefined || offset === 0 ? {} : { offset }), rule: raw['rule'] });
  }
  if (leap.length > 0 && leapCycleYears(leap) === undefined) {
    out.add('leap', 'cycle-too-long', `repeats only after more than ${grouped(CALENDAR_LIMITS.cycleYears)} years; use rules that repeat sooner.`, { max: CALENDAR_LIMITS.cycleYears });
  }
  const hasLeapEffect = months.some((month) => month.leapDays !== undefined) || intercalary.some((entry) => entry.leapOnly === true);
  if (leap.length > 0 && !hasLeapEffect) {
    out.add('leap', 'leap-no-effect', 'has rules, but no month has leap days and no day outside the months is leap-only, so a leap year would not differ.');
  } else if (leap.length === 0 && hasLeapEffect) {
    const firstMonth = months.findIndex((month) => month.leapDays !== undefined);
    const field = firstMonth >= 0 ? `months[${firstMonth}].leapDays` : `intercalary[${intercalary.findIndex((entry) => entry.leapOnly === true)}].leapOnly`;
    out.add(field, 'leap-no-rule', 'needs a leap rule, because without one no year is a leap year.');
  }

  const yearLength = (leapYear: boolean): number =>
    months.reduce((sum, month) => sum + month.days + (leapYear ? (month.leapDays ?? 0) : 0), 0) +
    intercalary.reduce((sum, entry) => sum + (entry.leapOnly === true && !leapYear ? 0 : entry.days), 0);
  for (const leapYear of [false, true]) {
    const total = yearLength(leapYear);
    if (total > CALENDAR_LIMITS.yearDays) {
      out.add('months', 'year-too-long', `make a ${leapYear ? 'leap ' : ''}year of ${grouped(total)} days; a year can hold at most ${grouped(CALENDAR_LIMITS.yearDays)}.`, { total, max: CALENDAR_LIMITS.yearDays });
      break;
    }
  }

  const epochRaw = input['epoch'];
  let epoch: CalendarEpoch | undefined;
  if (!isRecord(epochRaw)) out.add('epoch', 'wrong-type', 'must be an object with a year, a month and a day.', { expected: 'an object' });
  else {
    closedKeys(epochRaw, ['year', 'month', 'day'], 'epoch', out);
    const year = wholeNumber(epochRaw['year'], 'epoch.year', -CALENDAR_LIMITS.yearMagnitude, CALENDAR_LIMITS.yearMagnitude, out);
    const month = wholeNumber(epochRaw['month'], 'epoch.month', 1, Math.max(months.length, 1), out);
    const maxDay = month === undefined ? CALENDAR_LIMITS.entryDays : (months[month - 1]?.days ?? 0) + (months[month - 1]?.leapDays ?? 0);
    const day = wholeNumber(epochRaw['day'], 'epoch.day', 1, Math.max(maxDay, 1), out);
    if (year === 0 && yearZero === 'skip') out.add('epoch.year', 'year-zero', 'cannot be 0, because this calendar has no year 0.');
    else if (year !== undefined && month !== undefined && day !== undefined) epoch = { year, month, day };
  }

  const eraList = listOf(input, 'eras', CALENDAR_LIMITS.eras, out);
  const eras: CalendarEra[] = [];
  const eraNames = new Set<string>();
  let previousStart: number | undefined;
  for (const [index, raw] of (eraList ?? []).entries()) {
    const field = `eras[${index}]`;
    if (!isRecord(raw)) {
      out.add(field, 'wrong-type', 'must be an object with a name.', { expected: 'an object' });
      continue;
    }
    closedKeys(raw, ['name', 'startYear', 'reversed'], field, out);
    const eraName = readName(raw['name'], `${field}.name`, CALENDAR_LIMITS.nameChars, out);
    if (eraName !== undefined) {
      const key = foldName(eraName);
      if (eraNames.has(key)) out.add(`${field}.name`, 'duplicate', 'repeats the name of another era.', { other: 'another era' });
      eraNames.add(key);
    }
    const reversed = trueOrFalse(raw, 'reversed', field, out);
    let startYear: number | undefined;
    if (index === 0) {
      if (raw['startYear'] !== undefined) out.add(`${field}.startYear`, 'era-first-start', 'must be left out: the first era reaches back without end, and the next era says where it stops.');
    } else if (raw['startYear'] === undefined) {
      out.add(`${field}.startYear`, 'era-start-required', 'is needed: every era after the first begins in a year.');
    } else {
      startYear = wholeNumber(raw['startYear'], `${field}.startYear`, -CALENDAR_LIMITS.yearMagnitude, CALENDAR_LIMITS.yearMagnitude, out);
      if (startYear === 0 && yearZero === 'skip') {
        out.add(`${field}.startYear`, 'year-zero', 'cannot be 0, because this calendar has no year 0.');
        startYear = undefined;
      }
      if (startYear !== undefined && yearZero !== undefined) {
        const contiguous = contiguousYear(startYear, yearZero);
        if (previousStart !== undefined && contiguous <= previousStart) {
          out.add(`${field}.startYear`, 'era-order', 'must come after the year the era before it begins in.');
        }
        previousStart = contiguous;
      }
    }
    if (reversed === true && index !== 0) out.add(`${field}.reversed`, 'era-reversed', 'is only for the first era, whose years count down toward the second.');
    if (reversed === true && index === 0 && (eraList?.length ?? 0) < 2) out.add(`${field}.reversed`, 'era-reversed', 'needs a second era to count down toward.');
    if (eraName === undefined) continue;
    eras.push({ name: eraName, ...(startYear === undefined ? {} : { startYear }), ...(reversed === true && index === 0 ? { reversed } : {}) });
  }

  if (out.problems.length > 0 || id === undefined || name === undefined || yearZero === undefined || epoch === undefined || months.length !== (monthList?.length ?? 0)) {
    return { ok: false, problems: out.problems };
  }
  const definition: CalendarDefinition = {
    version: CALENDAR_VERSION,
    id,
    name,
    yearZero,
    epoch,
    months,
    ...(intercalary.length === 0 ? {} : { intercalary }),
    ...(leap.length === 0 ? {} : { leap }),
    ...(eras.length === 0 ? {} : { eras }),
  };
  return { ok: true, definition };
}
