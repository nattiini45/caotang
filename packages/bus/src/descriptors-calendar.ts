/**
 * The project's timeline calendar: the descriptor of `project.setCalendar` ([timeline.md §3.8](docs/architecture/timeline.md)). Its
 * apply is the store's (`packages/store/src/commands-calendar.ts`), because the setting is the manifest's `timeline` member.
 *
 * **`agentRisk: 'never'`.** How a story's days are named is the writer's choice, made in the timeline's calendar dialog; the agent
 * has no use for it and no tool for it. The stored days, durations and parts are never touched by this command, so there is
 * nothing to migrate when it changes.
 *
 * The bus cannot read the calendar's rules — `@caotang/timeline` sits above it and owns the schema — so this check is the part
 * that needs no calendar: a closed set of keys, JSON that can be written, and a size that is bounded. The editor and the loader
 * run the schema itself (`validateCalendarDefinition`), and a stored definition that fails it is never used to draw a label:
 * the timeline falls back to the day lens and says why.
 */

import type { CommandDescriptor } from './command.js';
import { invalid, limitExceeded, showValue } from './params.js';
import { err, ok } from './result.js';

/** What a project may keep of its lens setting. `null` clears the calendar or the choice; leaving a key out leaves it as it is. */
export type ProjectSetCalendarParams = {
  readonly calendar?: Readonly<Record<string, unknown>> | null;
  readonly lens?: 'day' | 'calendar' | null;
};

/** The keys of `project.setCalendar`; the registry's closed-key table lists the same two. */
export const SET_CALENDAR_KEYS = ['calendar', 'lens'] as const;

/** The longest a stored calendar may be when written as JSON: far above a real calendar, far below a file that is a burden. */
export const CALENDAR_JSON_MAX_CHARS = 32_768;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const projectSetCalendar: CommandDescriptor<ProjectSetCalendarParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'inverse',
  validate: (params) => {
    if (!isRecord(params)) {
      return invalid('params must be an object', `pass ${SET_CALENDAR_KEYS.join(' and/or ')}`);
    }
    const unexpected = Object.keys(params).filter((key) => !(SET_CALENDAR_KEYS as readonly string[]).includes(key));
    if (unexpected.length > 0) {
      const named = unexpected.map((key) => `"${key}"`).join(', ');
      return invalid(`project.setCalendar takes no ${unexpected.length === 1 ? 'param' : 'params'} ${named}`, `project.setCalendar accepts only: ${SET_CALENDAR_KEYS.join(', ')}`, unexpected[0]);
    }
    const typed: { calendar?: Record<string, unknown> | null; lens?: 'day' | 'calendar' | null } = {};

    const lens = params['lens'];
    if (lens !== undefined) {
      if (lens !== null && lens !== 'day' && lens !== 'calendar') {
        return invalid(`params.lens must be "day", "calendar" or null, got ${showValue(lens)}`, 'pass "day" for the built-in lens, "calendar" for the project calendar, or null to clear the choice', 'lens');
      }
      typed.lens = lens;
    }

    const calendar = params['calendar'];
    if (calendar !== undefined) {
      if (calendar === null) typed.calendar = null;
      else {
        if (!isRecord(calendar)) {
          return invalid(`params.calendar must be an object or null, got ${showValue(calendar)}`, 'pass a calendar definition, or null to remove the calendar', 'calendar');
        }
        if (typeof calendar['version'] !== 'number' || !Number.isSafeInteger(calendar['version'])) {
          return invalid('params.calendar.version must be a whole number', 'a calendar definition starts with "version": 1', 'calendar.version');
        }
        let text: string | undefined;
        try {
          text = JSON.stringify(calendar);
        } catch {
          text = undefined;
        }
        if (text === undefined) return invalid('params.calendar cannot be written as JSON', 'a calendar is plain data: text, whole numbers, true or false, lists and objects', 'calendar');
        if (text.length > CALENDAR_JSON_MAX_CHARS) {
          return limitExceeded(`the calendar is ${text.length.toLocaleString('en-US')} characters, and a project keeps at most ${CALENDAR_JSON_MAX_CHARS.toLocaleString('en-US')}`, 'shorten the names or remove months, eras or days outside the months', 'calendar');
        }
        // A copy, so the project never holds an object a caller can still change.
        typed.calendar = JSON.parse(text) as Record<string, unknown>;
      }
    }

    if (typed.calendar === undefined && typed.lens === undefined) {
      return err({ code: 'invalid-params', message: 'project.setCalendar needs calendar or lens', correctiveHint: 'pass the calendar to keep, the lens to use, or both', target: 'calendar' });
    }
    return ok(typed);
  },
};
