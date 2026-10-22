/**
 * The writer's session target and its progress (goals-progress §2.1 and §3). "Today" is the device's local calendar day
 * (goals-progress A3), and progress is the words of every session that ended today, across the writer's projects, plus
 * the sitting that is open now. Nothing here is stored: the sessions log is the history, and this is a read of it.
 */

import { localDayKey } from '@caotang/gateway';
import { listProjectIds, readSessions, RuntimeStoreStaleError, type RuntimeStore, type SessionRecord } from '@caotang/store';

/** The local calendar day of an ISO instant, or `null` when the instant does not parse. */
export function localDayOfIso(iso: string): string | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : localDayKey(ms);
}

/** The words of the sessions that ended on `day`. A session that ended earlier is history, not today's progress. */
export function wordsWrittenOn(records: readonly SessionRecord[], day: string): number {
  let total = 0;
  for (const record of records) {
    if (localDayOfIso(record.endedAt) === day) total += record.wordsWritten;
  }
  return total;
}

/**
 * The last total this page read for each day, so a store another tab upgraded (RuntimeStoreStaleError) keeps the count it last showed
 * instead of rejecting into the page. The stopped-tab notice says why nothing is saved; the count is not a save.
 */
const lastTotalByDay = new Map<string, number>();

/** Today's words across every project in this browser, read from each project's sessions. */
export async function wordsWrittenToday(store: RuntimeStore, now: number): Promise<number> {
  const day = localDayKey(now);
  let total = 0;
  try {
    for (const projectId of await listProjectIds(store)) {
      total += wordsWrittenOn(await readSessions(store, projectId), day);
    }
  } catch (error) {
    if (!(error instanceof RuntimeStoreStaleError)) throw error;
    return lastTotalByDay.get(day) ?? 0;
  }
  lastTotalByDay.set(day, total);
  return total;
}

/**
 * Every session line in this browser, across the writer's projects. A weekly or monthly goal counts the words of the lines that
 * ended in its window (goals-progress §9.3), the same reading the daily target takes, so the window is not cut by project.
 */
export async function sessionsEverywhere(store: RuntimeStore): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  for (const projectId of await listProjectIds(store)) {
    records.push(...(await readSessions(store, projectId)));
  }
  return records;
}

/**
 * How long the reading of the sessions log waits between reads.
 *
 * The log only moves when a sitting is recorded, which is not a keystroke. Reading it on every
 * change of the session read every project's log on every keystroke, so the reading waits for this
 * window instead: a burst of changes costs one reading, not one per change.
 */
export const SESSIONS_RELOAD_MS = 1000;

/**
 * How long the next reading of the sessions log waits.
 *
 * `lastReadAt` is when the last reading started, and `null` when there has been none: then the
 * reading runs now. Otherwise it waits out the window that the last reading started, so a change
 * that arrives inside the window waits for it and a change that arrives after it reads at once.
 */
export function nextReadDelay(lastReadAt: number | null, now: number, window: number = SESSIONS_RELOAD_MS): number {
  if (lastReadAt === null) return 0;
  return Math.max(0, window - (now - lastReadAt));
}

/** The ring's reading: the words, the target if one is set, the share of the target reached (capped at 1), and whether it is met. */
export interface TargetProgress {
  readonly words: number;
  readonly target: number | undefined;
  readonly fraction: number;
  readonly met: boolean;
}

/** Pure: progress against a target. With no target the fraction is zero and nothing is met (goals-progress §2.1). */
export function targetProgress(words: number, target: number | undefined): TargetProgress {
  if (target === undefined) return { words, target, fraction: 0, met: false };
  const fraction = Math.min(1, words / target);
  return { words, target, fraction, met: words >= target };
}

/** The status-bar line for a progress reading: "412 / 800 words today", or the words alone with no target. */
export function todayLine(progress: TargetProgress): string {
  const words = `${new Intl.NumberFormat('en-US').format(progress.words)}`;
  if (progress.target === undefined) return `${words} ${progress.words === 1 ? 'word' : 'words'} today`;
  return `${words} / ${new Intl.NumberFormat('en-US').format(progress.target)} words today`;
}

/**
 * The one-shot notice of goals-progress §2.1: true on the reading where today's target is first met, and not yet noticed today.
 * `previous` is the last reading and the day its notice was given (kept in memory, so a reload may notice again the same day).
 * It is a completion notice only: nothing here asks the writer to keep going.
 */
export function crossedTarget(
  previous: { readonly met: boolean; readonly day: string | null },
  now: { readonly met: boolean; readonly day: string },
): boolean {
  return now.met && !previous.met && previous.day !== now.day;
}

/** The session ring's stroke offset for a share of the circle (goals-progress §2.1), clamped to 0 through 1. */
export function ringOffset(fraction: number, circumference: number): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  return circumference * (1 - clamped);
}
