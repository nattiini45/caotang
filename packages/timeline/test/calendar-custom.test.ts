import { describe, expect, it } from 'vitest';

import {
  CALENDAR_LIMITS,
  MAX_TICKS,
  buildTimeline,
  createCalendarCycle,
  createCalendarLens,
  dayLens,
  normalizeCalendarDefinition,
  projectLensOf,
  validateCalendarDefinition,
  type CalendarDefinition,
  type CalendarLens,
} from '../src/index.js';

import { CALENDARS, FANTASY, GREGORIAN, JULIAN, WEEKLY } from './calendars.js';
import { coherence, project } from './fixtures.js';

const lensOf = (definition: CalendarDefinition, locale = 'en'): CalendarLens => createCalendarLens(definition, { locale });

/** The platform's own proleptic Gregorian count, as an oracle: whole days from 1 January 2000. */
function oracleDay(year: number, month: number, day: number): number {
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  const base = new Date(0);
  base.setUTCFullYear(2000, 0, 1);
  return Math.round((at.getTime() - base.getTime()) / 86_400_000);
}

describe('definition checks', () => {
  it('accepts the shipped shapes and returns them in canonical form', () => {
    for (const definition of CALENDARS) {
      const result = validateCalendarDefinition(definition);
      expect(result.ok, definition.id).toBe(true);
    }
    const messy = { ...WEEKLY, months: [{ name: 'Moon', days: 7, leapDays: 0 }], leap: [], intercalary: [], eras: [] };
    const result = normalizeCalendarDefinition(messy);
    expect(result).toEqual({ ok: true, definition: WEEKLY });
  });

  const refusals: [string, unknown, string][] = [
    ['not an object', 'a calendar', 'calendar'],
    ['a newer version', { ...WEEKLY, version: 2 }, 'version'],
    ['an unknown key', { ...WEEKLY, colour: 'red' }, 'colour'],
    ['a blank name', { ...WEEKLY, name: '  ' }, 'name'],
    ['a bad id', { ...WEEKLY, id: 'Has Space' }, 'id'],
    ['no months', { ...WEEKLY, months: [] }, 'months'],
    ['too many months', { ...WEEKLY, months: Array.from({ length: 65 }, (_, i) => ({ name: `M${i}`, days: 1 })) }, 'months'],
    ['a zero-day month', { ...WEEKLY, months: [{ name: 'Moon', days: 0 }] }, 'months[0].days'],
    ['a fractional month', { ...WEEKLY, months: [{ name: 'Moon', days: 7.5 }] }, 'months[0].days'],
    ['an unsafe number', { ...WEEKLY, months: [{ name: 'Moon', days: Number.MAX_SAFE_INTEGER + 2 }] }, 'months[0].days'],
    ['a name with a comma', { ...WEEKLY, months: [{ name: 'Moon, Old', days: 7 }] }, 'months[0].name'],
    ['a name that starts with a digit', { ...WEEKLY, months: [{ name: '1st Moon', days: 7 }] }, 'months[0].name'],
    ['a name with doubled spaces', { ...WEEKLY, months: [{ name: 'Old  Moon', days: 7 }] }, 'months[0].name'],
    ['a repeated month name', { ...WEEKLY, months: [{ name: 'Moon', days: 7 }, { name: 'moon', days: 7 }] }, 'months[1].name'],
    ['a year longer than the limit', { ...WEEKLY, months: [{ name: 'Moon', days: 1000 }, ...Array.from({ length: 10 }, (_, i) => ({ name: `M${i}`, days: 1000 }))] }, 'months'],
    ['an epoch month that does not exist', { ...WEEKLY, epoch: { year: 1, month: 2, day: 1 } }, 'epoch.month'],
    ['an epoch day past its month', { ...WEEKLY, epoch: { year: 1, month: 1, day: 8 } }, 'epoch.day'],
    ['year 0 as the epoch of a calendar with none', { ...WEEKLY, yearZero: 'skip', epoch: { year: 0, month: 1, day: 1 } }, 'epoch.year'],
    ['an intercalary day that collides with a numbered day', { ...WEEKLY, intercalary: [{ name: 'Hollow', days: 2, after: 0 }, { name: 'Hollow 1', days: 1, after: 1 }] }, 'intercalary[1].name'],
    ['an intercalary position past the last month', { ...WEEKLY, intercalary: [{ name: 'Eve', days: 1, after: 2 }] }, 'intercalary[0].after'],
    ['a leap rule with no effect', { ...WEEKLY, leap: [{ every: 4, rule: 'include' }] }, 'leap'],
    ['leap days with no rule', { ...WEEKLY, months: [{ name: 'Moon', days: 7, leapDays: 1 }] }, 'months[0].leapDays'],
    ['a leap-only day with no rule', { ...WEEKLY, intercalary: [{ name: 'Eve', days: 1, after: 0, leapOnly: true }] }, 'intercalary[0].leapOnly'],
    ['a leap cycle that never repeats in time', { ...GREGORIAN, leap: [{ every: 9973, rule: 'include' }, { every: 9967, rule: 'include' }] }, 'leap'],
    ['a leap rule that matches no year', { ...GREGORIAN, leap: [{ every: 4, rule: 'exclude' }] }, 'leap'],
    ['a leap offset outside the period', { ...GREGORIAN, leap: [{ every: 4, offset: 4, rule: 'include' }] }, 'leap[0].offset'],
    ['a first era with a start', { ...WEEKLY, eras: [{ name: 'AR', startYear: 5 }] }, 'eras[0].startYear'],
    ['a later era with no start', { ...WEEKLY, eras: [{ name: 'AR' }, { name: 'BR' }] }, 'eras[1].startYear'],
    ['eras out of order', { ...WEEKLY, eras: [{ name: 'A' }, { name: 'B', startYear: 10 }, { name: 'C', startYear: 10 }] }, 'eras[2].startYear'],
    ['a reversed era with nothing after it', { ...WEEKLY, eras: [{ name: 'BCE', reversed: true }] }, 'eras[0].reversed'],
    ['a reversed later era', { ...WEEKLY, eras: [{ name: 'A' }, { name: 'B', startYear: 3, reversed: true }] }, 'eras[1].reversed'],
    ['a year-zero era start in a calendar with none', { ...WEEKLY, yearZero: 'skip', eras: [{ name: 'A' }, { name: 'B', startYear: 0 }] }, 'eras[1].startYear'],
  ];

  it.each(refusals)('refuses %s, naming the field', (_label, input, field) => {
    const result = validateCalendarDefinition(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.field)).toContain(field);
    for (const problem of result.problems) expect(problem.message).toContain(problem.field);
  });

  it('refuses an epoch day past the month in the epoch year only when the month is shorter than the leap day allows', () => {
    const february = { ...GREGORIAN, epoch: { year: 1900, month: 2, day: 29 } };
    const result = validateCalendarDefinition(february);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatchObject({ field: 'epoch.day', code: 'epoch-day', values: { days: 28, year: 1900 } });
    expect(validateCalendarDefinition({ ...GREGORIAN, epoch: { year: 1904, month: 2, day: 29 } }).ok).toBe(true);
  });

  it('bounds every collection', () => {
    expect(CALENDAR_LIMITS.months).toBe(64);
    const many = { ...WEEKLY, intercalary: Array.from({ length: 33 }, (_, i) => ({ name: `Eve${i}`, days: 1, after: 0 })) };
    const result = validateCalendarDefinition(many);
    expect(result.ok).toBe(false);
  });

  it('reports at most a bounded list of problems', () => {
    const result = validateCalendarDefinition({ version: 1, id: 1, name: 2, yearZero: 3, epoch: 4, months: Array.from({ length: 64 }, () => 5) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.length).toBeLessThanOrEqual(20);
  });
});

describe('cycle arithmetic', () => {
  it('matches the platform calendar across leap exceptions and re-inclusion, in both directions', () => {
    const cycle = createCalendarCycle(GREGORIAN);
    expect(cycle.cycleYears).toBe(400);
    expect(cycle.cycleDays).toBe(146_097);
    expect(cycle.leapYearsPerCycle).toBe(97);
    for (const year of [1600, 1700, 1800, 1896, 1900, 1904, 1999, 2000, 2001, 2023, 2024, 2100, 2399, 2400, 2401, 3000]) {
      for (const [month, day] of [[1, 1], [2, 28], [3, 1], [12, 31]] as const) {
        const expected = oracleDay(year, month, day);
        expect(cycle.dayOf({ absoluteYear: year, kind: 'month', slot: month - 1, day }), `${year}-${month}-${day}`).toBe(expected);
        expect(cycle.dateOf(expected)).toMatchObject({ absoluteYear: year, slot: month - 1, day });
      }
    }
    expect([1900, 2100, 2200, 2300].map((year) => cycle.isLeap(year))).toEqual([false, false, false, false]);
    expect([1600, 2000, 2400, 1904, 2024].map((year) => cycle.isLeap(year))).toEqual([true, true, true, true, true]);
    expect(cycle.dayOf({ absoluteYear: 1900, kind: 'month', slot: 1, day: 29 })).toBeNull();
    expect(cycle.dayOf({ absoluteYear: 2000, kind: 'month', slot: 1, day: 29 })).toBe(59);
  });

  it('walks negative years like the platform: year 0 exists and is a leap year', () => {
    const cycle = createCalendarCycle(GREGORIAN);
    for (const year of [-1, 0, 1, -4, -100, -101, -400, -401, -1000, -9999]) {
      const expected = oracleDay(year, 3, 1);
      expect(cycle.dayOf({ absoluteYear: year, kind: 'month', slot: 2, day: 1 }), String(year)).toBe(expected);
      expect(cycle.dateOf(expected), String(year)).toMatchObject({ absoluteYear: year, slot: 2, day: 1 });
    }
    expect(cycle.isLeap(0)).toBe(true);
    expect(cycle.isLeap(-100)).toBe(false);
    expect(cycle.isLeap(-400)).toBe(true);
  });

  it('is consistent day by day: every day has one date, successive days are successive, and a date gives its day back', () => {
    for (const definition of CALENDARS) {
      const cycle = createCalendarCycle(definition);
      let previous = cycle.dateOf(-6000);
      for (let day = -5999; day <= 6000; day += 1) {
        const date = cycle.dateOf(day);
        expect(date, `${definition.id} ${day}`).not.toBeNull();
        if (date === null || previous === null) return;
        expect(cycle.dayOf({ absoluteYear: date.absoluteYear, kind: date.kind, slot: date.slot, day: date.day })).toBe(day);
        const rolled = date.absoluteYear !== previous.absoluteYear || date.slot !== previous.slot || date.kind !== previous.kind;
        if (rolled) expect(date.day, `${definition.id} ${day}`).toBe(1);
        else expect(date.day).toBe(previous.day + 1);
        previous = date;
      }
    }
  });

  it('keeps year lengths and year starts in step, so a year starts where the one before it ends', () => {
    for (const definition of CALENDARS) {
      const cycle = createCalendarCycle(definition);
      for (let year = -60; year <= 60; year += 1) {
        if (definition.yearZero === 'skip' && year === 0) continue;
        const next = definition.yearZero === 'skip' && year === -1 ? 1 : year + 1;
        const start = cycle.yearStart(year) as number;
        expect((cycle.yearStart(next) as number) - start, `${definition.id} ${year}`).toBe(cycle.yearLength(year));
        expect(cycle.layoutOf(year).reduce((sum, slot) => sum + slot.days, 0)).toBe(cycle.yearLength(year));
        expect(cycle.dateOf(start)).toMatchObject({ absoluteYear: year, dayOfYear: 0 });
      }
    }
  });

  it('puts day 0 on the epoch', () => {
    expect(createCalendarCycle(GREGORIAN).dateOf(0)).toMatchObject({ absoluteYear: 2000, slot: 0, day: 1 });
    expect(createCalendarCycle(FANTASY).dateOf(0)).toMatchObject({ absoluteYear: 3, kind: 'month', slot: 1, day: 7 });
    expect(createCalendarCycle(JULIAN).dateOf(0)).toMatchObject({ absoluteYear: 1, slot: 0, day: 1 });
  });

  it('skips year 0 when the policy says so: 1 BCE is followed by 1 CE, and 1 BCE is a leap year', () => {
    const cycle = createCalendarCycle(JULIAN);
    expect(cycle.dateOf(-1)).toMatchObject({ absoluteYear: -1, era: 0, year: 1, slot: 11, day: 31, leap: true });
    expect(cycle.dateOf(0)).toMatchObject({ absoluteYear: 1, era: 1, year: 1 });
    expect(cycle.dayOf({ absoluteYear: 0, kind: 'month', slot: 0, day: 1 })).toBeNull();
    expect(cycle.dayOf({ absoluteYear: -1, kind: 'month', slot: 1, day: 29 })).not.toBeNull();
    expect(cycle.dateOf(-366)).toMatchObject({ absoluteYear: -1, era: 0, year: 1, slot: 0, day: 1 });
    expect(cycle.dateOf(-367)).toMatchObject({ absoluteYear: -2, year: 2, slot: 11, day: 31 });
    expect(cycle.yearLength(-1)).toBe(366);
    expect(cycle.yearLength(-2)).toBe(365);
    expect(cycle.yearLength(3)).toBe(365);
    expect(cycle.yearLength(4)).toBe(366);
  });

  it('places intercalary days where they are declared, and a leap-only one only in leap years', () => {
    const cycle = createCalendarCycle(FANTASY);
    const names = (year: number): string[] => cycle.layoutOf(year).map((slot) => slot.name);
    expect(names(4)).toEqual(['Hollow Days', 'Rains', 'Deep Ash', 'Frost']);
    expect(names(5)).toEqual(['Hollow Days', 'Rains', 'Deep Ash', 'Frost', 'Midwinter']);
    expect(cycle.yearLength(4)).toBe(5 + 30 + 40 + 25);
    expect(cycle.yearLength(5)).toBe(5 + 30 + 41 + 25 + 1);
    expect(cycle.dayOf({ absoluteYear: 4, kind: 'intercalary', slot: 1, day: 1 })).toBeNull();
    const midwinter = cycle.dayOf({ absoluteYear: 5, kind: 'intercalary', slot: 1, day: 1 }) as number;
    expect(cycle.dateOf(midwinter)).toMatchObject({ absoluteYear: 5, kind: 'intercalary', slot: 1, day: 1, leap: true });
    expect(cycle.dateOf(midwinter + 1)).toMatchObject({ absoluteYear: 6, kind: 'intercalary', slot: 0, day: 1 });
    expect(cycle.dayOf({ absoluteYear: 5, kind: 'intercalary', slot: 0, day: 6 })).toBeNull();
  });

  it('knows where each era begins and which era a year is in', () => {
    const cycle = createCalendarCycle(FANTASY);
    const start = cycle.eraStartDay(1) as number;
    expect(cycle.eraStartYear(1)).toBe(300);
    expect(cycle.dateOf(start)).toMatchObject({ era: 1, year: 1, absoluteYear: 300, dayOfYear: 0 });
    expect(cycle.dateOf(start - 1)).toMatchObject({ era: 0, year: 299, absoluteYear: 299 });
    expect(cycle.eraOf(-50)).toEqual({ era: 0, year: -50 });
    expect(cycle.absoluteYearOf(1, 1)).toBe(300);
    expect(cycle.absoluteYearOf(0, 300)).toBeNull();
    expect(cycle.absoluteYearOf(1, 0)).toBeNull();
  });

  it('is safe at the edges of a safe integer, and says so with null', () => {
    const cycle = createCalendarCycle(GREGORIAN);
    expect(cycle.dateOf(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(cycle.dateOf(1.5)).toBeNull();
    expect(cycle.dateOf(10_000_000)).not.toBeNull();
    expect(cycle.dateOf(-10_000_000)).not.toBeNull();
  });
});

describe('labels and parsing', () => {
  it('writes the spec examples', () => {
    const lens = lensOf(FANTASY);
    expect(lens).toMatchObject({ id: 'calendar:reckoning', name: 'Reckoning of Ash', lensApi: 1 });
    expect(lens.label(0, 'short')).toBe('7 Deep Ash, 3 AR');
    expect(lensOf(GREGORIAN).label(0, 'long')).toBe('1 January, 2,000');
    expect(lensOf(GREGORIAN).label(0, 'short')).toBe('1 January, 2000');
    expect(lensOf(GREGORIAN).label(59, 'short')).toBe('29 February, 2000');
    expect(lensOf(GREGORIAN).label(-1, 'short')).toBe('31 December, 1999');
    expect(lensOf(JULIAN).label(-1, 'short')).toBe('31 December, 1 BCE');
    expect(lensOf(JULIAN).label(0, 'short')).toBe('1 January, 1 CE');
  });

  it('writes a day outside the months by its name, numbered when the entry has many days', () => {
    const lens = lensOf(FANTASY);
    const cycle = createCalendarCycle(FANTASY);
    const hollow = cycle.dayOf({ absoluteYear: 4, kind: 'intercalary', slot: 0, day: 3 }) as number;
    expect(lens.label(hollow, 'short')).toBe('Hollow Days 3, 4 AR');
    const midwinter = cycle.dayOf({ absoluteYear: 5, kind: 'intercalary', slot: 1, day: 1 }) as number;
    expect(lens.label(midwinter, 'short')).toBe('Midwinter, 5 AR');
    expect(lens.parse('Hollow Days 3, 4 AR')).toBe(hollow);
    expect(lens.parse('Hollow Days 3 4 AR')).toBe(hollow);
    expect(lens.parse('midwinter 5 ar')).toBe(midwinter);
    expect(lens.parse('Midwinter, 4 AR')).toBeNull();
    expect(lens.parse('Hollow Days 6, 4 AR')).toBeNull();
  });

  it('reads back every label it writes, in both forms, for every calendar over a long run of days', () => {
    for (const definition of CALENDARS) {
      const lens = lensOf(definition);
      for (let day = -4000; day <= 4000; day += 1) {
        for (const form of ['short', 'long'] as const) {
          const text = lens.label(day, form);
          expect(lens.parse(text), `${definition.id} ${text}`).toBe(day);
          expect(lens.label(lens.parse(text) as number, form)).toBe(text);
        }
      }
    }
  });

  it('reads back far from the epoch, across year 0 and across leap exceptions', () => {
    for (const definition of [GREGORIAN, JULIAN, FANTASY]) {
      const lens = lensOf(definition);
      for (const day of [-10_000_000, -3_650_000, -146_098, -146_097, -366, 366, 146_097, 146_098, 3_650_000, 10_000_000]) {
        for (let delta = -2; delta <= 2; delta += 1) {
          const text = lens.label(day + delta, 'long');
          expect(lens.parse(text), `${definition.id} ${text}`).toBe(day + delta);
        }
      }
    }
  });

  it('writes the real minus for a negative year, groups the long form, and reads hyphens and groups back', () => {
    const lens = lensOf(FANTASY);
    const cycle = createCalendarCycle(FANTASY);
    const early = cycle.dayOf({ absoluteYear: -1203, kind: 'month', slot: 0, day: 2 }) as number;
    expect(lens.label(early, 'short')).toBe('2 Rains, \u22121203 AR');
    expect(lens.label(early, 'long')).toBe('2 Rains, \u22121,203 AR');
    expect(lens.parse('2 Rains, -1203 AR')).toBe(early);
    expect(lens.parse('2 Rains, \u22121,203 AR')).toBe(early);
    expect(lens.parse('2 Rains, -1.203 AR')).toBe(early);
    expect(lens.parse('2 Rains, -1,20 AR')).toBeNull();
  });

  it('reads the typed forms: no comma, any case, spare spaces', () => {
    const lens = lensOf(FANTASY);
    expect(lens.parse('7 Deep Ash 3 AR')).toBe(0);
    expect(lens.parse('  7  deep ash,   3 ar ')).toBe(0);
    expect(lens.parse('7 DEEP ASH, 3')).toBeNull();
    expect(lensOf(GREGORIAN).parse('1 January 2000')).toBe(0);
  });

  it('refuses what is not a date of the calendar', () => {
    const lens = lensOf(FANTASY);
    for (const bad of ['', 'Rains', '0 Rains, 3 AR', '31 Rains, 3 AR', '41 Deep Ash, 3 AR', '7 Deep Ash', '7 Deep Ash, 3 BC', '7 Deep Ash, x AR', 'Day 5', '7 Smoke, 3 AR']) {
      expect(lens.parse(bad), bad).toBeNull();
    }
    expect(lens.parse('41 Deep Ash, 5 AR')).not.toBeNull();
    expect(lens.parse('41 Deep Ash, 6 AR')).toBeNull();
  });

  it('keeps an era to its years: a year outside it does not read', () => {
    const lens = lensOf(FANTASY);
    const cycle = createCalendarCycle(FANTASY);
    const first = cycle.eraStartDay(1) as number;
    expect(lens.label(first, 'short')).toBe('Hollow Days 1, 1 Third Age');
    expect(lens.parse('Hollow Days 1, 1 Third Age')).toBe(first);
    expect(lens.parse('Hollow Days 1, 300 AR')).toBeNull();
    expect(lens.parse('Hollow Days 1, 0 Third Age')).toBeNull();
    expect(lens.label(first - 1, 'short').endsWith(', 299 AR')).toBe(true);
  });

  it('counts a reversed era down toward the next, so BCE years fall as days rise', () => {
    const lens = lensOf(JULIAN);
    expect(lens.parse('1 January, 1 BCE')).toBe(-366);
    expect(lens.parse('1 January, 2 BCE')).toBe(-366 - 365);
    expect(lens.parse('1 January, 0 BCE')).toBeNull();
    expect(lens.parse('1 January, 0 CE')).toBeNull();
    expect(lens.parse('1 January, -1 CE')).toBeNull();
    expect(lens.parse('1 January, -1')).toBeNull();
  });

  it('writes its digits in the locale and reads them back', () => {
    for (const locale of ['de', 'fr', 'ar', 'hi', 'sv', 'de-CH', 'ru']) {
      const lens = lensOf(FANTASY, locale);
      const cycle = createCalendarCycle(FANTASY);
      for (const year of [3, 1203, -1203, 12_345]) {
        const day = cycle.dayOf({ absoluteYear: year, kind: 'month', slot: 2, day: 9 }) as number;
        for (const form of ['short', 'long'] as const) {
          const text = lens.label(day, form);
          expect(lens.parse(text), `${locale} ${text}`).toBe(day);
        }
      }
    }
    expect(lensOf(GREGORIAN, 'de').label(0, 'long')).toBe('1 January, 2.000');
  });

  it('falls back to the day lens for a day no calendar year can hold', () => {
    const lens = lensOf(GREGORIAN);
    expect(lens.label(Number.MAX_SAFE_INTEGER, 'short')).toBe(dayLens.label(Number.MAX_SAFE_INTEGER, 'short'));
    expect(lens.parse('1 January, 99999999999999999')).toBeNull();
  });
});

describe('span', () => {
  it('counts months and years of the calendar, and says "about" only when it rounds', () => {
    const lens = lensOf(FANTASY);
    // A common year here is 100 days and a leap year 102, so five years hold 502.
    expect(lens.span(0, 5)).toBe('5 days');
    expect(lens.span(0, 502)).toBe('5 years');
    expect(lens.span(502, 0)).toBe('5 years');
    expect(lens.span(0, 5020)).toBe('50 years');
    expect(lens.span(0, 5021)).toBe('about 50 years');
    expect(lens.span(-5020, 0)).toBe('50 years');
    expect(lens.span(0, 40)).toMatch(/months?$/);
  });

  it('uses the words it is given', () => {
    const german = createCalendarLens(WEEKLY, {
      locale: 'de',
      messages: { day: (n) => `Tag ${n}`, week: (n) => n, month: (n) => n, year: (n) => n, days: (n) => `${n} Tage`, months: (n) => `${n} Monate`, years: (n) => `${n} Jahre`, about: (t) => `etwa ${t}` },
    });
    expect(german.span(0, 3)).toBe('3 Tage');
    expect(german.span(0, 7 * 3)).toBe('3 Jahre');
  });
});

describe('ticks', () => {
  it('ticks days, month starts and year starts at day zoom, labelled for the calendar', () => {
    const lens = lensOf(FANTASY);
    const cycle = createCalendarCycle(FANTASY);
    const start = cycle.yearStart(4) as number;
    const ticks = lens.ticks([start - 2, start + 12], 48);
    expect(ticks).toHaveLength(15);
    expect(ticks.find((tick) => tick.day === start)).toMatchObject({ level: 2, label: '4 AR' });
    expect(ticks.find((tick) => tick.day === start + 5)).toMatchObject({ level: 1, label: 'Rains' });
    expect(ticks.find((tick) => tick.day === start + 7)).toMatchObject({ level: 0, label: '3' });
    expect(ticks.find((tick) => tick.day === start + 1)).toMatchObject({ level: 0, label: 'Hollow Days 2' });
  });

  it('marks each era boundary at the highest level, with the era name', () => {
    const lens = lensOf(FANTASY);
    const cycle = createCalendarCycle(FANTASY);
    const start = cycle.eraStartDay(1) as number;
    for (const pxPerDay of [48, 2, 0.05, 0.0001]) {
      const ticks = lens.ticks([start - 400, start + 400], pxPerDay);
      expect(ticks.find((tick) => tick.day === start), String(pxPerDay)).toMatchObject({ level: 3, label: 'Third Age' });
    }
  });

  it('thins as the scale falls, from days to months to years to runs of years', () => {
    const lens = lensOf(GREGORIAN);
    const levels = (pxPerDay: number): Set<number> => new Set(lens.ticks([-4000, 4000], pxPerDay).map((tick) => tick.level));
    expect(new Set(lens.ticks([-100, 100], 48).map((tick) => tick.level))).toContain(0);
    expect(levels(3)).not.toContain(0);
    expect(levels(3)).toContain(1);
    expect(levels(0.2)).toEqual(new Set([2]));
    const wide = lens.ticks([-400_000, 400_000], 0.001);
    expect(wide.length).toBeGreaterThan(1);
    expect(wide.every((tick) => tick.level === 2)).toBe(true);
  });

  it('bounds the ticks whatever the range, the scale or the calendar', () => {
    for (const definition of CALENDARS) {
      const lens = lensOf(definition);
      for (const range of [[-10_000_000, 10_000_000], [0, 100_000], [-500, 100_000_000], [-3, 3]] as const) {
        for (const pxPerDay of [100, 48, 1, 0.01, 0.00001]) {
          const ticks = lens.ticks(range, pxPerDay);
          expect(ticks.length, `${definition.id} ${range.join('..')} ${pxPerDay}`).toBeLessThanOrEqual(MAX_TICKS);
          expect(ticks.every((tick) => tick.day >= range[0] && tick.day <= range[1])).toBe(true);
          expect(ticks.map((tick) => tick.day)).toEqual([...new Set(ticks.map((tick) => tick.day))].sort((a, b) => a - b));
        }
      }
    }
    expect(lensOf(GREGORIAN).ticks([0, 10], 0)).toEqual([]);
    expect(lensOf(GREGORIAN).ticks([10, 0], 48)).toHaveLength(11);
  });

  it('keeps the era boundaries inside the cap even when the range holds many', () => {
    const eras: CalendarDefinition = {
      ...WEEKLY,
      id: 'many',
      eras: [{ name: 'E0' }, ...Array.from({ length: 31 }, (_, i) => ({ name: `E${i + 1}`, startYear: (i + 1) * 3 }))],
    };
    const ticks = lensOf(eras).ticks([-10_000_000, 10_000_000], 48);
    expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS);
    expect(ticks.filter((tick) => tick.level === 3)).toHaveLength(31);
  });
});

describe('the lens in a project', () => {
  it('is the day lens when no calendar is chosen, or when the day lens is chosen over one', () => {
    expect(projectLensOf(undefined).source).toBe('day');
    expect(projectLensOf({}).source).toBe('day');
    expect(projectLensOf({ calendar: GREGORIAN, lens: 'day' }).lens.id).toBe('day');
    const chosen = projectLensOf({ calendar: GREGORIAN });
    expect(chosen).toMatchObject({ source: 'calendar', problems: [] });
    expect(chosen.lens.id).toBe('calendar:gregorian');
    expect(projectLensOf({ calendar: GREGORIAN, lens: 'calendar' }).source).toBe('calendar');
  });

  it('falls back to the day lens, with the reasons, for a calendar it cannot use, and never throws', () => {
    for (const bad of [{ version: 2 }, 'nope', { ...GREGORIAN, months: [] }, null, 7]) {
      const chosen = projectLensOf({ calendar: bad });
      expect(chosen.source).toBe('day');
      expect(chosen.problems.length).toBeGreaterThan(0);
      expect(chosen.lens.label(5, 'short')).toBe('Day 5');
    }
  });

  it('takes the locale and words for the day lens it falls back to', () => {
    const words = { day: (n: string) => `Tag ${n}`, week: (n: string) => n, month: (n: string) => n, year: (n: string) => n, days: (n: string) => n, months: (n: string) => n, years: (n: string) => n, about: (t: string) => t };
    expect(projectLensOf(undefined, { locale: 'de', messages: words }).lens.label(4380, 'long')).toBe('Tag 4.380');
    expect(projectLensOf({ calendar: { version: 2 } }, { locale: 'de', messages: words }).lens.label(4380, 'long')).toBe('Tag 4.380');
  });

  it('does not touch story data: flipping the lens leaves every date, duration and part as it was', () => {
    const state = project({ folders: [{ id: 'pro' }, { id: 'epi' }], scenes: [{ id: 'a', parent: 'pro' }, { id: 'b' }, { id: 'c' }, { id: 'd', parent: 'epi' }, { id: 'e' }] });
    const file = coherence({
      a: { dayOffset: -3650, storyPart: 'prologue' },
      b: { dayOffset: 0, durationDays: 3 },
      c: { dayOffset: 400, durationDays: 20 },
      d: { dayOffset: 9000, storyPart: 'epilogue' },
    });
    const before = JSON.stringify([state.manifest.tree, file]);
    const days = buildTimeline(state, file, { axis: 'story', zoom: 'week', lens: dayLens });
    const calendar = buildTimeline(state, file, { axis: 'story', zoom: 'week', lens: lensOf(FANTASY) });
    const braid = buildTimeline(state, file, { axis: 'braid', zoom: 'day', lens: lensOf(GREGORIAN) });
    const shape = (model: typeof days): unknown[] =>
      model.items.map((item) => [item.nodeId, item.part, item.start, item.end, item.dayOffset, item.durationDays, item.readingIndex, item.lane, item.row]);
    expect(shape(calendar)).toEqual(shape(days));
    expect(calendar.zones).toEqual(days.zones);
    expect(calendar.unscheduled).toEqual(days.unscheduled);
    expect(shape(braid).length).toBeGreaterThan(0);
    expect(JSON.stringify([state.manifest.tree, file])).toBe(before);
    expect(calendar.items.find((item) => item.nodeId === 'b')?.a11yLabel).toContain('7 Deep Ash, 3 AR');
    expect(days.items.find((item) => item.nodeId === 'b')?.a11yLabel).toContain('Day 0');
    // The fold between the zones is named through the lens, in the calendar's own years.
    expect(calendar.axis.folds.map((fold) => fold.label).join(' ')).toMatch(/years? before/);
  });
});
