/**
 * The one gesture of the calendar editor: a single `project.setCalendar` dispatch ([timeline.md §3.8](docs/architecture/timeline.md)).
 * The bus's closed name and parameter sets hold the command, so the dialog's request needs no cast or parallel registration.
 */

import type { CommandError, ExecutionOutcome, Result } from '@caotang/bus';

import type { ProjectSession } from './session.js';

export interface SetCalendarRequest {
  /** The calendar to keep, `null` to remove it, absent to leave it as it is. */
  readonly calendar?: Readonly<Record<string, unknown>> | null;
  /** The lens to use, `null` to clear the choice, absent to leave it as it is. */
  readonly lens?: 'day' | 'calendar' | null;
}

export function setCalendar(session: ProjectSession, request: SetCalendarRequest): Result<ExecutionOutcome, CommandError> {
  return session.dispatch('project.setCalendar', request);
}
