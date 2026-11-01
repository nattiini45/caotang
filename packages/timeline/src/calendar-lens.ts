/**
 * A `CalendarLens` made from a calendar definition — [timeline.md §3.8](../../../docs/architecture/timeline.md).
 *
 * `validateCalendarDefinition` is the one door a definition goes through: shape, then arithmetic, then a round-trip check
 * that every label the calendar can write reads back as the same day. `createCalendarLens` takes what it returns.
 * `projectLensOf` is the one place a project's stored setting becomes a lens, so the view, the exports and the MCP read all
 * name a day the same way.
 *
 * Labels are `12 Rains, 3 AR` (a day of a month), `Midwinter, 3 AR` (a day outside the months) and, with no eras, `12 Rains,
 * 3`. A many-day entry outside the months numbers its days: `Epagomenal 2, 3`. The long form groups the year's digits as the
 * locale does; the short form does not. A year of the first era that reaches back without end is signed with the real minus.
 */

import { foldName, normalizeCalendarDefinition, type CalendarDefinition, type CalendarProblem, type CalendarValidation } from './calendar-definition.js';
import { createCalendarCycle, type CalendarCycle, type CalendarDate } from './calendar-cycle.js';
import { MAX_TICKS, type CalendarLens, type Tick } from './calendar.js';
import { createDayLens, ENGLISH_DAY_LENS_MESSAGES, type DayLensOptions } from './day-lens.js';
import { createIntegerCodec } from './integer-text.js';

/** Labels closer than this many pixels are thinned to the next level, as the day lens does. */
const MIN_TICK_PX = 40;

/** Tick levels of a calendar lens: 0 a day, 1 a month or a day outside the months, 2 a year, 3 an era. */
const LEVEL_DAY = 0;
const LEVEL_MONTH = 1;
const LEVEL_YEAR = 2;
const LEVEL_ERA = 3;

/** The year steps a tick row thins by once years are closer together than a label is wide. */
const YEAR_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000];

interface NameEntry {
  readonly fold: string;
  readonly kind: 'month' | 'intercalary';
  readonly index: number;
  readonly name: string;
  readonly days: number;
}

export function createCalendarLens(definition: CalendarDefinition, options: DayLensOptions = {}): CalendarLens {
  const cycle = createCalendarCycle(definition);
  return lensOf(definition, cycle, options);
}

function lensOf(definition: CalendarDefinition, cycle: CalendarCycle, options: DayLensOptions): CalendarLens {
  const locale = options.locale ?? 'en';
  const messages = options.messages ?? ENGLISH_DAY_LENS_MESSAGES;
  const codec = createIntegerCodec(locale);
  const numbers = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 });
  const fallback = createDayLens({ locale, messages });
  const eras = definition.eras ?? [];
  const months = definition.months;
  const intercalary = definition.intercalary ?? [];

  const dayText = (date: CalendarDate): string => {
    if (date.kind === 'month') return `${date.day} ${months[date.slot]?.name ?? ''}`;
    const entry = intercalary[date.slot];
    return entry !== undefined && entry.days === 1 ? entry.name : `${entry?.name ?? ''} ${date.day}`;
  };

  const yearText = (date: CalendarDate, grouped: boolean): string => {
    const number = codec.format(date.year, grouped);
    return date.era === null ? number : `${number} ${eras[date.era]?.name ?? ''}`;
  };

  const label = (day: number, form: 'short' | 'long'): string => {
    const date = cycle.dateOf(day);
    if (date === null) return fallback.label(day, form);
    return `${dayText(date)}, ${yearText(date, form === 'long')}`;
  };

  // Names are matched folded, longest first, so a name that begins with another still reads as itself.
  const entries: NameEntry[] = [
    ...months.map((month, index): NameEntry => ({ fold: foldName(month.name), kind: 'month', index, name: month.name, days: month.days })),
    ...intercalary.map((entry, index): NameEntry => ({ fold: foldName(entry.name), kind: 'intercalary', index, name: entry.name, days: entry.days })),
  ].sort((a, b) => b.name.length - a.name.length);
  const eraFolds = eras.map((era) => foldName(era.name));

  /** The year and era after the day part: `3 AR`, `3`, or `3 Third Age`. */
  const resolveYear = (right: string): { absoluteYear: number } | null => {
    const tokens = right.split(' ').filter((token) => token !== '');
    for (let count = tokens.length; count >= 1; count -= 1) {
      const year = codec.parse(tokens.slice(0, count).join(' '));
      if (year === null) continue;
      const rest = tokens.slice(count).join(' ');
      let era: number | null;
      if (eras.length === 0) {
        if (rest !== '') continue;
        era = null;
      } else if (rest === '') {
        if (eras.length !== 1) continue;
        era = 0;
      } else {
        const found = eraFolds.indexOf(foldName(rest));
        if (found < 0) continue;
        era = found;
      }
      const absoluteYear = cycle.absoluteYearOf(era, year);
      if (absoluteYear !== null) return { absoluteYear };
    }
    return null;
  };

  const dayOfLeft = (entry: NameEntry, dayInEntry: number, right: string): number | null => {
    const year = resolveYear(right);
    if (year === null) return null;
    return cycle.dayOf({ absoluteYear: year.absoluteYear, kind: entry.kind, slot: entry.index, day: dayInEntry });
  };

  /** The left part exactly: `12 Rains`, `Midwinter` or `Epagomenal 2`. */
  const readLeft = (left: string): { entry: NameEntry; day: number } | null => {
    const regular = /^(\d+) (.+)$/.exec(left);
    if (regular !== null) {
      const fold = foldName(regular[2] as string);
      const entry = entries.find((candidate) => candidate.kind === 'month' && candidate.fold === fold);
      return entry === undefined ? null : { entry, day: Number(regular[1]) };
    }
    const fold = foldName(left);
    const whole = entries.find((candidate) => candidate.kind === 'intercalary' && candidate.days === 1 && candidate.fold === fold);
    if (whole !== undefined) return { entry: whole, day: 1 };
    const numbered = /^(.+) (\d+)$/.exec(left);
    if (numbered === null) return null;
    const head = foldName(numbered[1] as string);
    const entry = entries.find((candidate) => candidate.kind === 'intercalary' && candidate.days > 1 && candidate.fold === head);
    return entry === undefined ? null : { entry, day: Number(numbered[2]) };
  };

  /** Every way the start of a comma-less text can be a left part, with what is left over. */
  const prefixReads = (text: string): { entry: NameEntry; day: number; rest: string }[] => {
    const reads: { entry: NameEntry; day: number; rest: string }[] = [];
    const startsWith = (source: string, name: string): boolean => foldName(source.slice(0, name.length)) === foldName(name) && (source.length === name.length || source[name.length] === ' ');
    const leading = /^(\d+) /.exec(text);
    for (const entry of entries) {
      if (entry.kind === 'month') {
        if (leading === null) continue;
        const after = text.slice(leading[0].length);
        if (startsWith(after, entry.name)) reads.push({ entry, day: Number(leading[1]), rest: after.slice(entry.name.length).trim() });
      } else if (startsWith(text, entry.name)) {
        const tail = text.slice(entry.name.length);
        if (entry.days === 1) reads.push({ entry, day: 1, rest: tail.trim() });
        else {
          const numbered = /^ (\d+)(?= |$)/.exec(tail);
          if (numbered !== null) reads.push({ entry, day: Number(numbered[1]), rest: tail.slice(numbered[0].length).trim() });
        }
      }
    }
    return reads;
  };

  const parse = (text: string): number | null => {
    const normalized = text.normalize('NFC').replace(/[ \t\r\n]+/g, ' ').trim();
    if (normalized === '') return null;
    const comma = normalized.indexOf(',');
    if (comma >= 0) {
      const left = readLeft(normalized.slice(0, comma).trim());
      return left === null ? null : dayOfLeft(left.entry, left.day, normalized.slice(comma + 1).trim());
    }
    for (const read of prefixReads(normalized)) {
      const day = dayOfLeft(read.entry, read.day, read.rest);
      if (day !== null) return day;
    }
    return null;
  };

  const span = (fromDay: number, toDay: number): string => {
    const days = Math.abs(toDay - fromDay);
    if (!Number.isSafeInteger(days)) return fallback.span(fromDay, toDay);
    const { cycleYears, cycleDays } = cycle;
    const perCycleMonths = cycleYears * months.length;
    // Whole counts of an average month or year, as exact fractions of the cycle: no float decides "about".
    const inMonths = days * perCycleMonths;
    const inYears = days * cycleYears;
    if (Number.isSafeInteger(inMonths) && Number.isSafeInteger(inYears)) {
      if (inMonths < cycleDays) return messages.days(numbers.format(days), days);
      if (inYears < cycleDays) {
        const count = Math.max(1, Math.round(inMonths / cycleDays));
        if (count < months.length) {
          const text = messages.months(numbers.format(count), count);
          return inMonths % cycleDays === 0 ? text : messages.about(text);
        }
      }
      const count = Math.max(1, Math.round(inYears / cycleDays));
      const text = messages.years(numbers.format(count), count);
      return inYears % cycleDays === 0 ? text : messages.about(text);
    }
    const count = Math.max(1, Math.round((days / cycleDays) * cycleYears));
    return messages.about(messages.years(numbers.format(count), count));
  };

  const tickLabel = (date: CalendarDate, level: number): string => {
    if (level === LEVEL_ERA) return eras[date.era ?? 0]?.name ?? '';
    if (level === LEVEL_YEAR) return yearText(date, false);
    if (level === LEVEL_MONTH) return date.kind === 'month' ? (months[date.slot]?.name ?? '') : dayText(date);
    return date.kind === 'month' ? String(date.day) : dayText(date);
  };

  const ticks = (range: readonly [number, number], pxPerDay: number): Tick[] => {
    const lo = Math.min(range[0], range[1]);
    const hi = Math.max(range[0], range[1]);
    if (!(pxPerDay > 0) || !Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) return [];
    const byDay = new Map<number, Tick>();

    // Era boundaries always show, and are reserved a place in the budget before anything else.
    for (let index = 1; index < eras.length; index += 1) {
      const day = cycle.eraStartDay(index);
      if (day === null || day < lo || day > hi) continue;
      const date = cycle.dateOf(day);
      if (date !== null) byDay.set(day, { day, level: LEVEL_ERA, label: tickLabel(date, LEVEL_ERA) });
    }
    const budget = Math.max(0, MAX_TICKS - byDay.size);
    const add = (day: number, level: 0 | 1 | 2 | 3, date: CalendarDate): void => {
      if (day < lo || day > hi || byDay.has(day)) return;
      byDay.set(day, { day, level, label: tickLabel(date, level) });
    };

    const averageYear = cycle.cycleDays / cycle.cycleYears;
    const averageMonth = averageYear / months.length;
    const yearsInRange = (hi - lo) / averageYear;
    const firstDate = cycle.dateOf(lo);
    const lastDate = cycle.dateOf(hi);
    if (firstDate === null || lastDate === null) return [...byDay.values()].sort((a, b) => a.day - b.day);

    if (pxPerDay >= MIN_TICK_PX && hi - lo + 1 <= budget) {
      for (let day = lo; day <= hi; day += 1) {
        const date = cycle.dateOf(day);
        if (date === null) continue;
        const level = date.dayOfYear === 0 ? LEVEL_YEAR : date.day === 1 ? LEVEL_MONTH : LEVEL_DAY;
        add(day, level, date);
      }
    } else if (averageMonth * pxPerDay >= MIN_TICK_PX && yearsInRange * (months.length + intercalary.length) + 2 <= budget) {
      for (let year = firstDate.absoluteYear; year <= lastDate.absoluteYear; year = year === -1 && definition.yearZero === 'skip' ? 1 : year + 1) {
        const start = cycle.yearStart(year);
        if (start === null) continue;
        for (const [position, slot] of cycle.layoutOf(year).entries()) {
          const day = start + slot.start;
          const date = cycle.dateOf(day);
          if (date !== null) add(day, position === 0 ? LEVEL_YEAR : LEVEL_MONTH, date);
        }
      }
    } else {
      let step = YEAR_STEPS.find((candidate) => candidate * averageYear * pxPerDay >= MIN_TICK_PX && yearsInRange / candidate + 2 <= budget);
      step ??= YEAR_STEPS.find((candidate) => yearsInRange / candidate + 2 <= budget) ?? YEAR_STEPS[YEAR_STEPS.length - 1] ?? 1;
      let year = Math.ceil(firstDate.absoluteYear / step) * step;
      while (year <= lastDate.absoluteYear + 1) {
        if (year === 0 && definition.yearZero === 'skip') year += step;
        const start = cycle.yearStart(year);
        if (start !== null) {
          const date = cycle.dateOf(start);
          if (date !== null) add(start, LEVEL_YEAR, date);
        }
        year += step;
      }
    }
    return [...byDay.values()].sort((a, b) => a.day - b.day).slice(0, MAX_TICKS);
  };

  return { id: `calendar:${definition.id}`, name: definition.name, lensApi: 1, label, span, ticks, parse };
}

/** How many years either side of the epoch the round-trip check walks slot by slot. */
const ROUND_TRIP_YEARS_SMALL = 2;

/** Years sampled by the round-trip check: around the epoch, around year 0, at each era boundary, and one leap and one common year far out either way. */
function sampleYears(definition: CalendarDefinition, cycle: CalendarCycle): { full: number[]; edges: number[] } {
  const valid = (year: number): boolean => !(definition.yearZero === 'skip' && year === 0);
  const full = new Set<number>();
  const edges = new Set<number>();
  for (let offset = -ROUND_TRIP_YEARS_SMALL; offset <= ROUND_TRIP_YEARS_SMALL; offset += 1) full.add(definition.epoch.year + offset);
  for (let year = -4; year <= 4; year += 1) full.add(year);
  for (let index = 1; index < (definition.eras?.length ?? 0); index += 1) {
    const start = cycle.eraStartYear(index);
    if (start === null) continue;
    for (let offset = -1; offset <= 1; offset += 1) edges.add(start + offset);
  }
  for (const direction of [1, -1]) {
    let wantLeap = true;
    let wantCommon = true;
    for (let year = 1000 * direction; Math.abs(year) < 1000 + cycle.cycleYears + 2 && (wantLeap || wantCommon); year += direction) {
      if (cycle.isLeap(year) ? wantLeap : wantCommon) {
        edges.add(year);
        if (cycle.isLeap(year)) wantLeap = false;
        else wantCommon = false;
      }
    }
  }
  return { full: [...full].filter(valid), edges: [...edges].filter(valid) };
}

function roundTripProblem(definition: CalendarDefinition, cycle: CalendarCycle, lens: CalendarLens): CalendarProblem | undefined {
  const { full, edges } = sampleYears(definition, cycle);
  const check = (day: number | null, kind: 'month' | 'intercalary', slot: number): CalendarProblem | undefined => {
    if (day === null) return undefined;
    for (const form of ['short', 'long'] as const) {
      const text = lens.label(day, form);
      if (lens.parse(text) !== day) {
        const field = kind === 'month' ? `months[${slot}].name` : `intercalary[${slot}].name`;
        return {
          field,
          code: 'round-trip',
          message: `${field}: the label “${text}” does not read back as the same day; change the names of the months, of the days outside the months, or of the eras so that each label is read one way.`,
          values: { label: text },
        };
      }
    }
    return undefined;
  };
  const visit = (year: number, everySlot: boolean): CalendarProblem | undefined => {
    const slots = cycle.layoutOf(year);
    const chosen = everySlot ? slots : [slots[0], slots[slots.length - 1]].filter((slot): slot is NonNullable<typeof slot> => slot !== undefined);
    for (const slot of chosen) {
      for (const day of new Set([1, slot.days])) {
        const problem = check(cycle.dayOf({ absoluteYear: year, kind: slot.kind, slot: slot.index, day }), slot.kind, slot.index);
        if (problem !== undefined) return problem;
      }
    }
    return undefined;
  };
  for (const year of full) {
    const problem = visit(year, true);
    if (problem !== undefined) return problem;
  }
  for (const year of edges) {
    const problem = visit(year, false);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/**
 * A calendar definition read as data and proven usable: its shape is valid (`normalizeCalendarDefinition`), its epoch day
 * exists, its leap rules take effect, and the labels it writes read back as the same days. A definition that fails any of
 * these comes back as problems that name the field, and is never made into a lens.
 */
export function validateCalendarDefinition(input: unknown): CalendarValidation {
  const shape = normalizeCalendarDefinition(input);
  if (!shape.ok) return shape;
  const { definition } = shape;
  let cycle: CalendarCycle;
  try {
    cycle = createCalendarCycle(definition);
  } catch {
    return { ok: false, problems: [{ field: 'leap', code: 'cycle-too-long', message: 'leap: the rules repeat too slowly to be used.' }] };
  }
  const problems: CalendarProblem[] = [];
  if ((definition.leap?.length ?? 0) > 0 && cycle.leapYearsPerCycle === 0) {
    problems.push({ field: 'leap', code: 'leap-never', message: 'leap: no year matches these rules, so no year is a leap year; an "exclude" rule needs an "include" rule before it.' });
  }
  const epochMonth = cycle.layoutOf(definition.epoch.year).find((slot) => slot.kind === 'month' && slot.index === definition.epoch.month - 1);
  if (epochMonth !== undefined && definition.epoch.day > epochMonth.days) {
    problems.push({
      field: 'epoch.day',
      code: 'epoch-day',
      message: `epoch.day: month ${definition.epoch.month} has only ${epochMonth.days} days in year ${definition.epoch.year}.`,
      values: { days: epochMonth.days, year: definition.epoch.year },
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  const roundTrip = roundTripProblem(definition, cycle, lensOf(definition, cycle, {}));
  return roundTrip === undefined ? { ok: true, definition } : { ok: false, problems: [roundTrip] };
}

/** What a project stores about its lens: which one is chosen and the calendar definition it may hold. */
export interface ProjectLensSettings {
  readonly lens?: 'day' | 'calendar';
  readonly calendar?: unknown;
}

export interface ProjectLens {
  readonly lens: CalendarLens;
  /** Which lens `lens` is: the project's calendar, or the built-in day lens. */
  readonly source: 'day' | 'calendar';
  /** Why a chosen calendar was not used; empty when it was, or when none was chosen. */
  readonly problems: readonly CalendarProblem[];
}

const validated = new WeakMap<object, CalendarValidation>();

function validatedOnce(calendar: unknown): CalendarValidation {
  if (typeof calendar !== 'object' || calendar === null) return validateCalendarDefinition(calendar);
  let result = validated.get(calendar);
  if (result === undefined) {
    result = validateCalendarDefinition(calendar);
    validated.set(calendar, result);
  }
  return result;
}

/**
 * The lens a project's stored setting names. The project's calendar when it chose one and the definition is usable;
 * otherwise the built-in day lens, with the reasons beside it, so a calendar this build cannot read never stops the
 * timeline from drawing and never changes a stored day.
 */
export function projectLensOf(settings: ProjectLensSettings | undefined, options: DayLensOptions = {}): ProjectLens {
  const day = (problems: readonly CalendarProblem[]): ProjectLens => ({ lens: createDayLens(options), source: 'day', problems });
  if (settings === undefined || settings.calendar === undefined || settings.lens === 'day') return day([]);
  const result = validatedOnce(settings.calendar);
  if (!result.ok) return day(result.problems);
  return { lens: createCalendarLens(result.definition, options), source: 'calendar', problems: [] };
}
