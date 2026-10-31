/**
 * Calendar definitions the tests share. Each is a real shape a writer might build, and each is checked against what it
 * claims: the Gregorian one against the platform's own proleptic calendar, the Julian one against the historical BCE/CE
 * count, the fantasy one against its own leap table.
 */

import type { CalendarDefinition } from '../src/index.js';

/** 1 January 2000 is day 0, and the leap rule is the Gregorian one: every 4, except every 100, except every 400. */
export const GREGORIAN: CalendarDefinition = {
  version: 1,
  id: 'gregorian',
  name: 'Gregorian',
  yearZero: 'include',
  epoch: { year: 2000, month: 1, day: 1 },
  months: [
    { name: 'January', days: 31 },
    { name: 'February', days: 28, leapDays: 1 },
    { name: 'March', days: 31 },
    { name: 'April', days: 30 },
    { name: 'May', days: 31 },
    { name: 'June', days: 30 },
    { name: 'July', days: 31 },
    { name: 'August', days: 31 },
    { name: 'September', days: 30 },
    { name: 'October', days: 31 },
    { name: 'November', days: 30 },
    { name: 'December', days: 31 },
  ],
  leap: [
    { every: 4, rule: 'include' },
    { every: 100, rule: 'exclude' },
    { every: 400, rule: 'include' },
  ],
};

/** A year count with no year 0, counted down in BCE: 1 BCE is followed by 1 CE. Leap rule: every 4th contiguous year. */
export const JULIAN: CalendarDefinition = {
  ...GREGORIAN,
  id: 'julian',
  name: 'Julian',
  yearZero: 'skip',
  epoch: { year: 1, month: 1, day: 1 },
  leap: [{ every: 4, rule: 'include' }],
  eras: [{ name: 'BCE', reversed: true }, { name: 'CE', startYear: 1 }],
};

/**
 * Three months, five days outside them, a leap year every fifth year with a leap day in Ash and a leap-only Midwinter,
 * and two eras, the second of which restarts the count.
 */
export const FANTASY: CalendarDefinition = {
  version: 1,
  id: 'reckoning',
  name: 'Reckoning of Ash',
  yearZero: 'include',
  epoch: { year: 3, month: 2, day: 7 },
  months: [
    { name: 'Rains', days: 30 },
    { name: 'Deep Ash', days: 40, leapDays: 1 },
    { name: 'Frost', days: 25 },
  ],
  intercalary: [
    { name: 'Hollow Days', days: 5, after: 0 },
    { name: 'Midwinter', days: 1, after: 3, leapOnly: true },
  ],
  leap: [{ every: 5, rule: 'include' }],
  eras: [{ name: 'AR' }, { name: 'Third Age', startYear: 300 }],
};

/** One month of seven days, no leap, no eras: the smallest useful calendar. */
export const WEEKLY: CalendarDefinition = {
  version: 1,
  id: 'weekly',
  name: 'Weekly',
  yearZero: 'include',
  epoch: { year: 1, month: 1, day: 1 },
  months: [{ name: 'Moon', days: 7 }],
};

export const CALENDARS = [GREGORIAN, JULIAN, FANTASY, WEEKLY] as const;
