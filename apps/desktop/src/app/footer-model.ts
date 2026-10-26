/**
 * The binder footer's words, as pure functions: the goal sentence (goals-progress §2.2), the state of a goal in words, the
 * sprint timer's remaining time (sprint.ts), and the sprint lengths the picker offers. What the footer says is testable here
 * without a page.
 *
 * Every sentence is one catalogue message (i18n.md §4.2, I5): a plural is ICU `plural`, never a "1 vs not 1" choice, and a
 * writer's node title is isolated once (§5.3). The formatter locale is the interface language's (§4.1).
 */
/* lingui-set comment="Interpolated values: about, by, clock, count, day, degree, perDay, target, title" */

import type { ProjectGoal } from '@caotang/furniture';
import { SPRINT_MAX_MINUTES, SPRINT_MIN_MINUTES } from '@caotang/furniture';
import type { GoalState } from '@caotang/furniture';
import { dateFormat, isolate, numberFormat } from '@caotang/i18n';
import { plural, select, selectOrdinal, t } from '@lingui/core/macro';

import { formatterLocale } from '../i18n/format-locale.js';

/** A count as the footer shows it, grouped the way the formatter locale groups numbers (i18n.md §4.2). */
export function countText(value: number, locale: string = formatterLocale()): string {
  return numberFormat(locale).format(value);
}

/** The sprint lengths the picker offers, in minutes. The timer bounds the free value (sprint.ts); these are the common ones. */
export const SPRINT_CHOICES: readonly number[] = [5, 10, 15, 25, 30, 45, 60].filter(
  (choice) => choice >= SPRINT_MIN_MINUTES && choice <= SPRINT_MAX_MINUTES,
);

/**
 * A local calendar day ("2026-10-31") as a short date for a person ("31 Oct 2026", or "Oct 31, 2026" under a US system), in the
 * formatter locale (i18n.md §4.1). An unreadable day is shown as it is.
 */
export function formatDay(day: string, locale: string = formatterLocale()): string {
  const [year, month, date] = day.split('-').map(Number);
  if (year === undefined || month === undefined || date === undefined) return day;
  return dateFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(year, month - 1, date));
}

/** What a goal counts, in the words the footer uses: "words", or "characters" for the `chars` metric (goals-progress §9.2). */
export function unitOf(goal: { readonly metric?: string }): string {
  return goal.metric === 'chars' ? t`characters` : t`words`;
}

/** A pace line's count and noun, in the goal's own unit: "1 word", "850 characters" (goals-progress §2.2, §9.2). */
export function paceCountOf(goal: { readonly metric?: string }, perDay: number, locale: string = formatterLocale()): string {
  // The count is formatted for the formatter locale, which can differ from the active UI catalogue;
  // the ICU plural still chooses the noun's form, so a translator sees both inside one message.
  const count = countText(perDay, locale);
  return goal.metric === 'chars'
    ? t`${{ count }} ${plural(perDay, { one: 'character', other: 'characters' })}`
    : t`${{ count }} ${plural(perDay, { one: 'word', other: 'words' })}`;
}

/**
 * The comparator as a sentence (goals-progress §2.2, §9.2, §9.3): "at least 12,000 words on The Manuscript by 31 Oct 2026", or
 * "at least 12,000 characters on The Manuscript". A session goal is a window rather than a node, so it reads "at least 7,000 words
 * this week" or "this month", and takes no date. Each branch is one ICU message, so the count's plural form and the comparator are
 * part of the sentence a translator sees; the node title is isolated once (i18n.md §4.2, §5.3).
 */
export function goalSentence(
  goal: Pick<ProjectGoal, 'comparator' | 'target' | 'deadline'> & Partial<Pick<ProjectGoal, 'metric' | 'kind'>>,
  nodeTitle: string,
  locale: string = formatterLocale(),
): string {
  const degree = goal.comparator === 'at-least' ? 'least' : goal.comparator === 'at-most' ? 'most' : 'about';
  // A plural count must be a bare name to reach the catalogue as `{target, plural, …}` rather than a positional `{0}`.
  const target = goal.target;
  const title = isolate(nodeTitle);
  // The count is grouped for the formatter locale, which can differ from the active UI catalogue.
  const count = countText(target, locale);
  if (goal.kind === 'weekly') {
    return goal.metric === 'chars'
      ? t`${select(degree, { least: 'at least', most: 'at most', other: 'about' })} ${{ count }} ${plural(target, { one: 'character', other: 'characters' })} this week`
      : t`${select(degree, { least: 'at least', most: 'at most', other: 'about' })} ${{ count }} ${plural(target, { one: 'word', other: 'words' })} this week`;
  }
  if (goal.kind === 'monthly') {
    return goal.metric === 'chars'
      ? t`${select(degree, { least: 'at least', most: 'at most', other: 'about' })} ${{ count }} ${plural(target, { one: 'character', other: 'characters' })} this month`
      : t`${select(degree, { least: 'at least', most: 'at most', other: 'about' })} ${{ count }} ${plural(target, { one: 'word', other: 'words' })} this month`;
  }
  if (goal.deadline === undefined) {
    return goal.metric === 'chars'
      ? t`${select(degree, { least: 'at least', most: 'at most', other: 'about' })} ${{ count }} ${plural(target, { one: 'character', other: 'characters' })} on ${{ title }}`
      : t`${select(degree, { least: 'at least', most: 'at most', other: 'about' })} ${{ count }} ${plural(target, { one: 'word', other: 'words' })} on ${{ title }}`;
  }
  const by = formatDay(goal.deadline, locale);
  return goal.metric === 'chars'
    ? t`${select(degree, { least: 'at least', most: 'at most', other: 'about' })} ${{ count }} ${plural(target, { one: 'character', other: 'characters' })} on ${{ title }} by ${{ by }}`
    : t`${select(degree, { least: 'at least', most: 'at most', other: 'about' })} ${{ count }} ${plural(target, { one: 'word', other: 'words' })} on ${{ title }} by ${{ by }}`;
}

/** The ICU select key for a weekday, 0 (Sunday) to 6 (Saturday), as `Date.getDay` counts them. */
const WEEKDAY_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** A weekday as a reset day names it, 0 (Sunday) to 6 (Saturday), as `Date.getDay` counts them (goals-progress §9.3). */
export function weekdayName(day: number): string {
  switch (day) {
    case 0:
      return t`Sunday`;
    case 1:
      return t`Monday`;
    case 2:
      return t`Tuesday`;
    case 3:
      return t`Wednesday`;
    case 4:
      return t`Thursday`;
    case 5:
      return t`Friday`;
    case 6:
      return t`Saturday`;
    default:
      return t`Monday`;
  }
}

/** A day of the month as a person says it: 1st, 2nd, 3rd, 4th, 11th, 21st, 22nd, 28th (ICU `selectOrdinal`). */
export function ordinalDay(day: number): string {
  return t`${selectOrdinal(day, { one: '#st', two: '#nd', few: '#rd', other: '#th' })}`;
}

/**
 * When a weekly or monthly goal's window starts, as a sentence (goals-progress §9.3): "The week starts on Sunday.", "The month starts
 * on the 15th.", "The month starts on its last day." A goal with no reset day of its own starts on `firstWeekday` (the locale's) or
 * the 1st. A project goal has no window, so it has no sentence.
 */
export function resetSentence(goal: Partial<Pick<ProjectGoal, 'kind' | 'resetDay'>>, firstWeekday: number): string | undefined {
  if (goal.kind === 'weekly') {
    // The day name is a select branch, not a translated value: German can then say "am Samstag".
    const day = typeof goal.resetDay === 'number' ? goal.resetDay : firstWeekday;
    const weekday = WEEKDAY_KEY[day] ?? 'mon';
    return t`The week starts on ${select(weekday, {
      sun: 'Sunday',
      mon: 'Monday',
      tue: 'Tuesday',
      wed: 'Wednesday',
      thu: 'Thursday',
      fri: 'Friday',
      sat: 'Saturday',
      other: 'Monday',
    })}.`;
  }
  if (goal.kind === 'monthly') {
    if (goal.resetDay === 'last') return t`The month starts on its last day.`;
    // The ordinal is ICU selectOrdinal inside the sentence, so the article and suffix stay inflectable.
    const day = typeof goal.resetDay === 'number' ? goal.resetDay : 1;
    return t`The month starts on the ${selectOrdinal(day, { one: '#st', two: '#nd', few: '#rd', other: '#th' })}.`;
  }
  return undefined;
}

/** A goal's state in the words the footer uses. */
export function goalStateWords(state: GoalState): string {
  switch (state) {
    case 'open':
      return t`in progress`;
    case 'met':
      return t`met`;
    case 'exceeded':
      return t`over the limit`;
    case 'overdue':
      return t`past the deadline`;
    case 'target-missing':
      return t`its folder is gone`;
  }
}

/** mm:ss left, rounded up, so the last second of a sprint still reads as a second. */
export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const clock = `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  return t`${{ clock }} left`;
}
