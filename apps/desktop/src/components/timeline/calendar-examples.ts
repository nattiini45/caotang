/**
 * Two calendars a writer can start the editor from. They are data in the same format a project stores, so what the editor
 * shows is exactly what is saved ([timeline.md §3.8](docs/architecture/timeline.md)); the month, day and era names are messages,
 * so the invented example reads in the interface's language.
 */

import { t } from '@lingui/core/macro';

export interface CalendarExample {
  readonly key: 'gregorian' | 'invented';
  readonly definition: Readonly<Record<string, unknown>>;
}

/* lingui-set comment="The names of the invented example calendar a writer can start from: its calendar, months, extra days and eras. Translate them as names a story could use; the writer renames them." */

/** Built on each call, so the invented calendar's names follow the interface language. */
export function calendarExamples(): readonly CalendarExample[] {
  return [
    {
      key: 'gregorian',
      definition: {
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
      },
    },
    {
      key: 'invented',
      definition: {
        version: 1,
        id: 'reckoning',
        name: t`Reckoning of Ash`,
        yearZero: 'include',
        epoch: { year: 3, month: 2, day: 7 },
        months: [
          { name: t`Rains`, days: 30 },
          { name: t`Deep Ash`, days: 40, leapDays: 1 },
          { name: t`Frost`, days: 25 },
        ],
        intercalary: [
          { name: t`Hollow Days`, days: 5, after: 0 },
          { name: t`Midwinter`, days: 1, after: 3, leapOnly: true },
        ],
        leap: [{ every: 5, rule: 'include' }],
        eras: [{ name: t`AR` }, { name: t`Third Age`, startYear: 300 }],
      },
    },
  ];
}
