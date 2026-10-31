/**
 * The apply of `project.setCalendar` — the project's timeline calendar and which lens names its days
 * ([timeline.md §3.8](docs/architecture/timeline.md)). The descriptor is the bus's (`calendarCommands.projectSetCalendar`), which checks
 * the keys, the JSON and the size; the calendar's own rules are `@caotang/timeline`'s, run by the editor before it asks and by every
 * reader before it uses what is stored, so a definition this build cannot read is kept as it is and never labels a day.
 *
 * The setting is the manifest's `timeline` member and nothing else: no scene declaration, duration, part or binder order is read or
 * written here, which is what makes switching or editing a calendar always safe. The apply registers its exact inverse, which puts
 * back both members as they were, so one undo restores a calendar and the choice of lens together.
 */

import {
  ApplyRefusal,
  calendarCommands,
  type ApplyContext,
  type Command,
  type CommandApply,
  type CommandRegistry,
  type ProjectSetCalendarParams,
} from '@caotang/bus';
import { newId } from '@caotang/ids';

import { jsonValueProblem } from './json-value.js';
import type { ProjectTimelineSettings } from './manifest.js';
import type { ProjectState } from './state.js';

/** The command's name. The bus's name list holds it; it is a constant here so the apply and its inverse agree on one spelling. */
export const SET_CALENDAR_COMMAND = 'project.setCalendar';

/** The clock seam the inverse command is stamped from. Structural, so the store's `CommandClock` satisfies it. */
export interface CalendarClock {
  now(): number;
}

type CalendarApply = CommandApply<ProjectSetCalendarParams, ProjectState>;

function nameOf(calendar: Record<string, unknown> | undefined): string {
  const name = calendar?.['name'];
  return typeof name === 'string' && name !== '' ? `“${name}”` : 'the calendar';
}

export function setCalendarApply(clock: CalendarClock): CalendarApply {
  return (state, params, context: ApplyContext) => {
    const before = state.manifest.timeline;
    const next: ProjectTimelineSettings = { ...(before ?? {}) };

    if (params.calendar !== undefined) {
      if (params.calendar === null) delete next.calendar;
      else {
        const problem = jsonValueProblem(params.calendar);
        if (problem !== undefined) {
          throw new ApplyRefusal({ code: 'invalid-params', message: `the calendar cannot be saved: ${problem.reason}`, target: 'calendar', correctiveHint: 'a calendar is plain data: text, whole numbers, true or false, lists and objects' });
        }
        next.calendar = params.calendar as Record<string, unknown>;
      }
    }
    if (params.lens !== undefined) {
      if (params.lens === null) delete next.lens;
      else next.lens = params.lens;
    }
    // Choosing the calendar with none to choose would name nothing; a calendar removed under a standing choice takes the choice with it.
    if (next.lens === 'calendar' && next.calendar === undefined) {
      if (params.lens === 'calendar') {
        throw new ApplyRefusal({ code: 'invalid-params', message: 'the project has no calendar to use', target: 'lens', correctiveHint: 'save a calendar first, or choose the day lens' });
      }
      delete next.lens;
    }

    if (next.lens === undefined && next.calendar === undefined) delete state.manifest.timeline;
    else state.manifest.timeline = next;

    const inverse: ProjectSetCalendarParams = { calendar: before?.calendar ?? null, lens: before?.lens ?? null };
    const command: Command<ProjectSetCalendarParams> = {
      id: newId('cmd'),
      name: SET_CALENDAR_COMMAND,
      params: inverse,
      issuedBy: 'user',
      createdAt: clock.now(),
    };
    context.undo.inverse(command);

    const summary =
      params.calendar === null
        ? 'removed the timeline calendar'
        : params.calendar !== undefined
          ? `saved the timeline calendar ${nameOf(next.calendar)}`
          : next.lens === 'day'
            ? 'chose the day lens for the timeline'
            : 'chose the project calendar for the timeline';
    context.report({ affected: [], summary });
    return { lens: next.lens ?? (next.calendar === undefined ? 'day' : 'calendar'), hasCalendar: next.calendar !== undefined };
  };
}

/** The apply, narrowed to the registry's state type (the bus does not type project state; see `commands.ts`'s `narrow`). */
function narrow<P>(apply: CommandApply<P, ProjectState>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/** The registration for the store's registry: the bus's descriptor with this apply. */
export function calendarCommandRegistrations(options: { readonly clock: CalendarClock }): Partial<CommandRegistry> {
  const entry = { descriptor: calendarCommands.projectSetCalendar, apply: narrow(setCalendarApply(options.clock)) };
  return { [SET_CALENDAR_COMMAND]: entry };
}
