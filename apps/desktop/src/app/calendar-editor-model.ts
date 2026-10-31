/**
 * The calendar editor's pure part: what the text in the box means, and what to save for it
 * ([timeline.md §3.8](docs/architecture/timeline.md)).
 *
 * The box holds the definition as plain JSON, the same data a project stores, so nothing the editor shows is lost on save and a writer
 * can paste a calendar from a friend or a wiki. The words the editor says around the result are the component's, in the interface's
 * language; this file returns the facts.
 */

import { CALENDAR_JSON_MAX_CHARS } from '@caotang/bus';
import {
  createCalendarLens,
  validateCalendarDefinition,
  type CalendarDefinition,
  type CalendarLens,
  type CalendarProblem,
  type DayLensOptions,
} from '@caotang/timeline';

export type CalendarDraft =
  | { readonly kind: 'empty' }
  | { readonly kind: 'too-long'; readonly length: number }
  | { readonly kind: 'syntax'; readonly detail: string }
  | { readonly kind: 'invalid'; readonly problems: readonly CalendarProblem[] }
  | { readonly kind: 'valid'; readonly definition: CalendarDefinition };

/** What a box of text means as a calendar: nothing yet, too much, not JSON, JSON that is not a usable calendar, or a calendar. */
export function draftOf(text: string): CalendarDraft {
  if (text.trim() === '') return { kind: 'empty' };
  if (text.length > CALENDAR_JSON_MAX_CHARS) return { kind: 'too-long', length: text.length };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: 'syntax', detail: error instanceof Error ? error.message : String(error) };
  }
  const result = validateCalendarDefinition(parsed);
  return result.ok ? { kind: 'valid', definition: result.definition } : { kind: 'invalid', problems: result.problems };
}

/** A stored calendar as the box shows it: two-space indented JSON, or the empty string when the project has none. */
export function textOfCalendar(calendar: unknown): string {
  return calendar === undefined ? '' : JSON.stringify(calendar, null, 2);
}

/** The days the preview names, whatever the calendar: the story's day 0, its first week and a year on. */
export const PREVIEW_DAYS = [0, 1, 30, 365] as const;

export function previewOf(definition: CalendarDefinition, options: DayLensOptions): readonly { readonly day: number; readonly label: string }[] {
  const lens: CalendarLens = createCalendarLens(definition, options);
  return PREVIEW_DAYS.map((day) => ({ day, label: lens.label(day, 'long') }));
}

/**
 * What a save sends for the choice made and the text in the box; `null` when there is nothing to send. A calendar that is usable is
 * always kept, even beside the day lens, so choosing the day numbers for a while never loses what was typed.
 */
export function savePlan(choice: 'day' | 'calendar', draft: CalendarDraft): { readonly calendar?: Readonly<Record<string, unknown>>; readonly lens: 'day' | 'calendar' } | null {
  const kept = (definition: CalendarDefinition): Readonly<Record<string, unknown>> => definition as unknown as Readonly<Record<string, unknown>>;
  if (choice === 'calendar') return draft.kind === 'valid' ? { calendar: kept(draft.definition), lens: 'calendar' } : null;
  return draft.kind === 'valid' ? { calendar: kept(draft.definition), lens: 'day' } : { lens: 'day' };
}