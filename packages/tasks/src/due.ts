/**
 * When a task is due (agent-harness.md §12).
 *
 * Pure: the caller passes the instant and the time zone, and nothing here reads a clock or the host's default zone. A schedule is
 * a local wall-clock rule, so "due" compares wall-clock minutes: the most recent occurrence of the rule at or before `now`, against
 * the wall-clock minute of the task's last handled run. That makes a task missed for several days due once, a spring-forward gap
 * a task that runs when the clock first passes its time, and a fall-back repeat of the hour a task that does not run twice.
 */

import { WEEKDAYS, type AgentTask, type TaskSchedule, type TasksFile } from './model.js';

const MINUTES_PER_DAY = 1440;

interface LocalTime {
  /** Whole days from 1970-01-01 to the local calendar date. */
  readonly day: number;
  /** Minutes since local midnight. */
  readonly minutes: number;
  /** 0 = Monday. */
  readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock date and time `instant` shows in `timeZone`. */
export function localTime(instant: Date, timeZone: string): LocalTime {
  const parts = new Map<string, string>();
  for (const part of formatterFor(timeZone).formatToParts(instant)) parts.set(part.type, part.value);
  const number = (type: string): number => Number(parts.get(type));
  const hour = number('hour') % 24;
  return {
    day: Math.floor(Date.UTC(number('year'), number('month') - 1, number('day')) / (MINUTES_PER_DAY * 60_000)),
    minutes: hour * 60 + number('minute'),
    weekday: (['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const).indexOf(parts.get('weekday') as 'Mon'),
  };
}

const wallMinute = (time: LocalTime): number => time.day * MINUTES_PER_DAY + time.minutes;

function minutesOf(at: string): number {
  return Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5));
}

/** The wall-clock minute of the schedule's latest occurrence at or before `now`, or `undefined` for a schedule that has none. */
function latestOccurrence(schedule: TaskSchedule, now: LocalTime): number | undefined {
  if (schedule.kind === 'daily') {
    const today = now.day * MINUTES_PER_DAY + minutesOf(schedule.at);
    return today > wallMinute(now) ? today - MINUTES_PER_DAY : today;
  }
  if (schedule.kind === 'weekly') {
    const back = (now.weekday - WEEKDAYS.indexOf(schedule.day) + 7) % 7;
    const thisWeek = (now.day - back) * MINUTES_PER_DAY + minutesOf(schedule.at);
    return thisWeek > wallMinute(now) ? thisWeek - 7 * MINUTES_PER_DAY : thisWeek;
  }
  return undefined;
}

/**
 * The tasks that are due at `now`, in file order. `lastRuns` is the ISO-8601 instant each task was last handled (run or skipped) on
 * this machine, by task id. `opening` is true for the one evaluation made as the project opens, which is when an `on-open` task is due.
 * A manual, disabled or unreadable (`problem`) task is never due.
 */
export function dueTasks(
  file: TasksFile,
  lastRuns: Readonly<Record<string, string>>,
  now: Date,
  timeZone: string,
  opening = false,
): AgentTask[] {
  const here = localTime(now, timeZone);
  return file.tasks.filter((task) => {
    if (!task.enabled || task.problem !== undefined || task.schedule.kind === 'manual') return false;
    if (task.schedule.kind === 'on-open') return opening;
    const occurrence = latestOccurrence(task.schedule, here);
    if (occurrence === undefined) return false;
    const last = lastRuns[task.id];
    const lastAt = last === undefined ? Number.NaN : Date.parse(last);
    if (Number.isNaN(lastAt)) return true;
    return wallMinute(localTime(new Date(lastAt), timeZone)) < occurrence;
  });
}
