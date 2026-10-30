/**
 * The binder footer's words, as pure functions: the goal sentence (goals-progress §2.2), the state of a goal in words, the
 * sprint timer's remaining time (sprint.ts), and the sprint lengths the picker offers. What the footer says is testable here
 * without a page.
 */

import type { ProjectGoal } from '@caotang/furniture';
import { SPRINT_MAX_MINUTES, SPRINT_MIN_MINUTES, paceWords } from '@caotang/furniture';
import type { GoalState } from '@caotang/furniture';

import { appFormatLocale, formatCount, formatDateTime } from '../i18n/locale.js';

/** A count as the footer shows it: thousands separated in the formatter locale, as the rest of the app does (D3). */
export function countText(value: number): string {
  return formatCount(value);
}

/** The sprint lengths the picker offers, in minutes. The timer bounds the free value (sprint.ts); these are the common ones. */
export const SPRINT_CHOICES: readonly number[] = [5, 10, 15, 25, 30, 45, 60].filter(
  (choice) => choice >= SPRINT_MIN_MINUTES && choice <= SPRINT_MAX_MINUTES,
);

/**
 * A local calendar day ("2026-10-31") as a short date for a person, in the formatter locale (D3): "31 Oct 2026" in en-GB,
 * "Oct 31, 2026" in en-US. An unreadable day is shown as it is.
 */
export function formatDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (year === undefined || month === undefined || date === undefined) return day;
  return formatDateTime(new Date(year, month - 1, date), { day: 'numeric', month: 'short', year: 'numeric' });
}

/** What a goal counts, in the words the footer uses: "words", or "characters" for the `chars` metric (goals-progress §9.2). */
export function unitOf(goal: { readonly metric?: string }): string {
  return goal.metric === 'chars' ? 'characters' : 'words';
}

/** A pace line's count and noun, in the goal's own unit: "1 word", "850 characters" (goals-progress §2.2, §9.2). */
export function paceCountOf(goal: { readonly metric?: string }, perDay: number): string {
  if (unitOf(goal) === 'words') return paceWords(perDay, appFormatLocale());
  return `${countText(perDay)} ${perDay === 1 ? 'character' : 'characters'}`;
}

/**
 * The comparator as a sentence (goals-progress §2.2, §9.2, §9.3): "at least 12,000 words on The Manuscript by 31 Oct 2026", or
 * "at least 12,000 characters on The Manuscript". A session goal is a window rather than a node, so it reads "at least 7,000 words
 * this week" or "this month", and takes no date.
 */
export function goalSentence(
  goal: Pick<ProjectGoal, 'comparator' | 'target' | 'deadline'> & Partial<Pick<ProjectGoal, 'metric' | 'kind'>>,
  nodeTitle: string,
): string {
  const comparator = goal.comparator === 'at-least' ? 'at least' : goal.comparator === 'at-most' ? 'at most' : 'about';
  const amount = `${comparator} ${countText(goal.target)} ${unitOf(goal)}`;
  if (goal.kind === 'weekly') return `${amount} this week`;
  if (goal.kind === 'monthly') return `${amount} this month`;
  const deadline = goal.deadline === undefined ? '' : ` by ${formatDay(goal.deadline)}`;
  return `${amount} on ${nodeTitle}${deadline}`;
}

/** The weekdays as a reset day names them, 0 (Sunday) to 6 (Saturday), as `Date.getDay` counts them (goals-progress §9.3). */
export const WEEKDAY_NAMES: readonly string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A day of the month as a person says it: 1st, 2nd, 3rd, 4th, 11th, 21st, 22nd, 28th. */
export function ordinalDay(day: number): string {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const suffix = teen ? 'th' : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
  return `${day}${suffix}`;
}

/**
 * When a weekly or monthly goal's window starts, as a sentence (goals-progress §9.3): "The week starts on Sunday.", "The month starts
 * on the 15th.", "The month starts on its last day." A goal with no reset day of its own starts on `firstWeekday` (the locale's) or
 * the 1st. A project goal has no window, so it has no sentence.
 */
export function resetSentence(goal: Partial<Pick<ProjectGoal, 'kind' | 'resetDay'>>, firstWeekday: number): string | undefined {
  if (goal.kind === 'weekly') {
    const day = typeof goal.resetDay === 'number' ? goal.resetDay : firstWeekday;
    return `The week starts on ${WEEKDAY_NAMES[day] ?? 'Monday'}.`;
  }
  if (goal.kind === 'monthly') {
    if (goal.resetDay === 'last') return 'The month starts on its last day.';
    return `The month starts on the ${ordinalDay(typeof goal.resetDay === 'number' ? goal.resetDay : 1)}.`;
  }
  return undefined;
}

/** A goal's state in the words the footer uses. */
export function goalStateWords(state: GoalState): string {
  switch (state) {
    case 'open':
      return 'in progress';
    case 'met':
      return 'met';
    case 'exceeded':
      return 'over the limit';
    case 'overdue':
      return 'past the deadline';
    case 'target-missing':
      return 'its folder is gone';
  }
}

/** mm:ss left, rounded up, so the last second of a sprint still reads as a second. */
export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')} left`;
}
