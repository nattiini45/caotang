/**
 * The arithmetic of a custom calendar: whole days to a date and back, with no floating point and no `Date`.
 *
 * Leap years repeat with a period of P years (the least common multiple of the leap rules' `every`), so the days from the
 * start of year 0 to the start of year n are `floor(n / P) * D + before[n mod P]`, where D is the days in one period and
 * `before[k]` is the days before year k inside it. A day finds its year by taking that quotient and remainder and looking
 * the remainder up in `before`; a year finds its start the same way. Floor division and a floored modulo keep every step
 * correct for negative years and negative days.
 *
 * Years here are *contiguous* integers (`n`), with no gap where year 0 would be skipped; `absoluteYear` is the same year
 * as a person writes it under the calendar's year-zero policy. Leap rules see `n`.
 */

import {
  CALENDAR_LIMITS,
  contiguousYear,
  leapCycleYears,
  shownYear,
  type CalendarDefinition,
} from './calendar-definition.js';

const floorDiv = (a: number, b: number): number => Math.floor(a / b);
const floorMod = (a: number, b: number): number => ((a % b) + b) % b;

/** One stretch of a year: a month or a run of intercalary days, with where it starts. */
export interface YearSlot {
  readonly kind: 'month' | 'intercalary';
  /** Index into `months` or `intercalary`. */
  readonly index: number;
  readonly name: string;
  readonly days: number;
  /** Days from the start of the year to this slot's first day. */
  readonly start: number;
}

interface YearLayout {
  readonly length: number;
  readonly slots: readonly YearSlot[];
}

/** A day as a calendar names it. */
export interface CalendarDate {
  /** Index into `eras`, or `null` when the calendar has none. */
  readonly era: number | null;
  /** The year as a label writes it: counted inside its era, and signed only in a first era that is not reversed. */
  readonly year: number;
  /** The year before eras are applied: the year `epoch.year` and an era's `startYear` use. */
  readonly absoluteYear: number;
  readonly kind: 'month' | 'intercalary';
  /** Index into `months` or `intercalary`. */
  readonly slot: number;
  /** 1-based day of the month, or of the intercalary entry. */
  readonly day: number;
  readonly leap: boolean;
  /** 0-based day of the year. */
  readonly dayOfYear: number;
}

/** A date asked for by name: which year, which slot, which day. */
export interface CalendarDateRequest {
  readonly absoluteYear: number;
  readonly kind: 'month' | 'intercalary';
  readonly slot: number;
  readonly day: number;
}

export interface CalendarCycle {
  readonly definition: CalendarDefinition;
  /** The years after which the leap pattern repeats. */
  readonly cycleYears: number;
  /** The days in one of those periods. */
  readonly cycleDays: number;
  /** How many years of one period are leap years. */
  readonly leapYearsPerCycle: number;
  isLeap(absoluteYear: number): boolean;
  yearLength(absoluteYear: number): number;
  layoutOf(absoluteYear: number): readonly YearSlot[];
  /** The day number of the first day of a year, or `null` past what a safe integer can hold. */
  yearStart(absoluteYear: number): number | null;
  /** The first year of an era after the first, and so where it begins in days; `null` for an era that cannot be placed. */
  eraStartDay(eraIndex: number): number | null;
  /** The absolute year an era after the first begins in. */
  eraStartYear(eraIndex: number): number | null;
  dateOf(day: number): CalendarDate | null;
  dayOf(request: CalendarDateRequest): number | null;
  /** The era a year falls in and the year's number inside it. */
  eraOf(absoluteYear: number): { era: number | null; year: number };
  /** The absolute year that has this number inside this era, or `null` when the era does not reach that year. */
  absoluteYearOf(eraIndex: number | null, yearInEra: number): number | null;
}

function leapOf(definition: CalendarDefinition, contiguous: number): boolean {
  let leap = false;
  for (const rule of definition.leap ?? []) {
    if (floorMod(contiguous - (rule.offset ?? 0), rule.every) === 0) leap = rule.rule === 'include';
  }
  return leap;
}

function layoutFor(definition: CalendarDefinition, leap: boolean): YearLayout {
  const slots: YearSlot[] = [];
  let start = 0;
  const place = (kind: 'month' | 'intercalary', index: number, name: string, days: number): void => {
    slots.push({ kind, index, name, days, start });
    start += days;
  };
  const intercalary = definition.intercalary ?? [];
  const placeIntercalaryAfter = (after: number): void => {
    for (const [index, entry] of intercalary.entries()) {
      if (entry.after === after && (entry.leapOnly !== true || leap)) place('intercalary', index, entry.name, entry.days);
    }
  };
  placeIntercalaryAfter(0);
  for (const [index, month] of definition.months.entries()) {
    place('month', index, month.name, month.days + (leap ? (month.leapDays ?? 0) : 0));
    placeIntercalaryAfter(index + 1);
  }
  return { length: start, slots };
}

/**
 * Builds the arithmetic for a definition that has passed `normalizeCalendarDefinition`. It does not re-check the shape, but
 * it refuses to build a cycle longer than the limit, because the table it keeps has one entry per year of the cycle.
 */
export function createCalendarCycle(definition: CalendarDefinition): CalendarCycle {
  const cycleYears = leapCycleYears(definition.leap ?? []);
  if (cycleYears === undefined) throw new RangeError(`the leap rules repeat only after more than ${CALENDAR_LIMITS.cycleYears} years`);
  const { yearZero } = definition;
  const layouts = [layoutFor(definition, false), layoutFor(definition, true)] as const;

  const before = new Array<number>(cycleYears + 1);
  before[0] = 0;
  let leapYearsPerCycle = 0;
  for (let k = 0; k < cycleYears; k += 1) {
    const leap = leapOf(definition, k);
    if (leap) leapYearsPerCycle += 1;
    before[k + 1] = (before[k] as number) + layouts[leap ? 1 : 0].length;
  }
  const cycleDays = before[cycleYears] as number;

  const isLeapN = (n: number): boolean => leapOf(definition, n);
  const layoutN = (n: number): YearLayout => layouts[isLeapN(n) ? 1 : 0];
  /** Days from the start of year 0 to the start of year `n`. */
  const startN = (n: number): number => floorDiv(n, cycleYears) * cycleDays + (before[floorMod(n, cycleYears)] as number);

  const epochN = contiguousYear(definition.epoch.year, yearZero);
  const epochLayout = layoutN(epochN);
  const epochMonth = epochLayout.slots.find((slot) => slot.kind === 'month' && slot.index === definition.epoch.month - 1);
  // Day 0 sits this many days after the start of year 0.
  const day0 = startN(epochN) + (epochMonth?.start ?? 0) + definition.epoch.day - 1;

  const eras = definition.eras ?? [];
  const eraStartN = eras.map((era, index) => (index === 0 || era.startYear === undefined ? undefined : contiguousYear(era.startYear, yearZero)));
  const reversedFirst = eras[0]?.reversed === true;

  const eraIndexOfN = (n: number): number => {
    for (let index = eras.length - 1; index >= 1; index -= 1) {
      if (n >= (eraStartN[index] as number)) return index;
    }
    return 0;
  };

  const eraOfN = (n: number): { era: number | null; year: number } => {
    if (eras.length === 0) return { era: null, year: shownYear(n, yearZero) };
    const index = eraIndexOfN(n);
    if (index === 0) {
      const next = eraStartN[1];
      return { era: 0, year: reversedFirst && next !== undefined ? next - n : shownYear(n, yearZero) };
    }
    return { era: index, year: n - (eraStartN[index] as number) + 1 };
  };

  const safe = (value: number): number | null => (Number.isSafeInteger(value) ? value : null);

  const slotAt = (layout: YearLayout, dayOfYear: number): YearSlot => {
    let low = 0;
    let high = layout.slots.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((layout.slots[mid] as YearSlot).start <= dayOfYear) low = mid;
      else high = mid - 1;
    }
    return layout.slots[low] as YearSlot;
  };

  const cycle: CalendarCycle = {
    definition,
    cycleYears,
    cycleDays,
    leapYearsPerCycle,
    isLeap: (absoluteYear) => isLeapN(contiguousYear(absoluteYear, yearZero)),
    yearLength: (absoluteYear) => layoutN(contiguousYear(absoluteYear, yearZero)).length,
    layoutOf: (absoluteYear) => layoutN(contiguousYear(absoluteYear, yearZero)).slots,
    yearStart: (absoluteYear) => safe(startN(contiguousYear(absoluteYear, yearZero)) - day0),
    eraStartYear: (eraIndex) => {
      const n = eraStartN[eraIndex];
      return n === undefined ? null : shownYear(n, yearZero);
    },
    eraStartDay: (eraIndex) => {
      const n = eraStartN[eraIndex];
      return n === undefined ? null : safe(startN(n) - day0);
    },
    eraOf: (absoluteYear) => eraOfN(contiguousYear(absoluteYear, yearZero)),
    absoluteYearOf: (eraIndex, yearInEra) => {
      if (eras.length === 0) {
        if (eraIndex !== null || (yearZero === 'skip' && yearInEra === 0)) return null;
        return yearInEra;
      }
      if (eraIndex === null || eraIndex < 0 || eraIndex >= eras.length) return null;
      let n: number;
      if (eraIndex === 0) {
        const next = eraStartN[1];
        if (reversedFirst) {
          if (yearInEra < 1 || next === undefined) return null;
          n = next - yearInEra;
        } else {
          if (yearZero === 'skip' && yearInEra === 0) return null;
          n = contiguousYear(yearInEra, yearZero);
        }
      } else {
        if (yearInEra < 1) return null;
        n = (eraStartN[eraIndex] as number) + yearInEra - 1;
      }
      if (eraIndexOfN(n) !== eraIndex) return null;
      return shownYear(n, yearZero);
    },
    dateOf: (day) => {
      if (!Number.isSafeInteger(day)) return null;
      const t = day + day0;
      if (!Number.isSafeInteger(t)) return null;
      const q = floorDiv(t, cycleDays);
      const r = floorMod(t, cycleDays);
      let low = 0;
      let high = cycleYears - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if ((before[mid] as number) <= r) low = mid;
        else high = mid - 1;
      }
      const n = q * cycleYears + low;
      if (!Number.isSafeInteger(n)) return null;
      const dayOfYear = r - (before[low] as number);
      const leap = isLeapN(n);
      const slot = slotAt(layouts[leap ? 1 : 0], dayOfYear);
      const { era, year } = eraOfN(n);
      return {
        era,
        year,
        absoluteYear: shownYear(n, yearZero),
        kind: slot.kind,
        slot: slot.index,
        day: dayOfYear - slot.start + 1,
        leap,
        dayOfYear,
      };
    },
    dayOf: (request) => {
      if (yearZero === 'skip' && request.absoluteYear === 0) return null;
      const n = contiguousYear(request.absoluteYear, yearZero);
      const slot = layoutN(n).slots.find((candidate) => candidate.kind === request.kind && candidate.index === request.slot);
      if (slot === undefined || request.day < 1 || request.day > slot.days) return null;
      return safe(startN(n) + slot.start + request.day - 1 - day0);
    },
  };
  return cycle;
}
