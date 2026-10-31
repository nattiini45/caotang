/**
 * The `CalendarLens` contract — [timeline.md §3.8](../../../docs/architecture/timeline.md).
 *
 * A lens only maps integer days to labels, spans and ticks, and reads a label back to a day. It is display-only and pure,
 * so switching or redefining one never changes a stored day, a duration, a part or the binder order.
 */

export interface Tick {
  day: number;
  /** 0 is the finest level. */
  level: 0 | 1 | 2 | 3;
  label: string;
}

export interface CalendarLens {
  id: string;
  name: string;
  lensApi: 1;
  label(day: number, form: 'short' | 'long'): string;
  /** A length between two days, for fold and break labels: "about 10 years". */
  span(fromDay: number, toDay: number): string;
  /** Boundaries inside `range` (inclusive), thinned so the count stays bounded whatever the range. */
  ticks(range: readonly [number, number], pxPerDay: number): Tick[];
  /**
   * The day a label names, or `null`. It reads what `label` writes in either form, so `label(parse(s)) === s` for a label
   * the lens wrote, and it is a little more generous for typing: grouped digits, a hyphen for the minus, no comma.
   */
  parse(text: string): number | null;
}

/** The most ticks a lens returns for one range. */
export const MAX_TICKS = 400;
