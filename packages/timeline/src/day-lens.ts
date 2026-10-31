/**
 * The built-in lens: "Day N", weeks of 7 days, coarse months of 30 days and years of 365 days.
 *
 * Day 0 is the story's reference day. Negative days read "Day −14" with the real minus sign. A span that is rounded
 * to months or years says "about"; a span that is exact does not. The words come in as `messages` and the digits as
 * `locale`, so the interface and an export can each ask for their own.
 */

import { foldName } from './calendar-definition.js';
import { MAX_TICKS, type CalendarLens, type Tick } from './calendar.js';
import { createIntegerCodec } from './integer-text.js';

export const WEEK_DAYS = 7;
export const MONTH_DAYS = 30;
export const YEAR_DAYS = 365;

const MINUS = '\u2212';
/** Labels closer than this many pixels are thinned to the next level. */
const MIN_TICK_PX = 40;

export interface DayLensMessages {
  day(n: string): string;
  week(n: string): string;
  month(n: string): string;
  year(n: string): string;
  days(n: string, count: number): string;
  months(n: string, count: number): string;
  years(n: string, count: number): string;
  about(text: string): string;
}

export const ENGLISH_DAY_LENS_MESSAGES: DayLensMessages = {
  day: (n) => `Day ${n}`,
  week: (n) => `Week ${n}`,
  month: (n) => `Month ${n}`,
  year: (n) => `Year ${n}`,
  days: (n, count) => `${n} ${count === 1 ? 'day' : 'days'}`,
  months: (n, count) => `${n} ${count === 1 ? 'month' : 'months'}`,
  years: (n, count) => `${n} ${count === 1 ? 'year' : 'years'}`,
  about: (text) => `about ${text}`,
};

export interface DayLensOptions {
  locale?: string;
  messages?: DayLensMessages;
  id?: string;
  name?: string;
}

const LEVEL_STEPS = [1, WEEK_DAYS, MONTH_DAYS, YEAR_DAYS] as const;

function floorMod(value: number, step: number): number {
  return ((value % step) + step) % step;
}

export function createDayLens(options: DayLensOptions = {}): CalendarLens {
  const messages = options.messages ?? ENGLISH_DAY_LENS_MESSAGES;
  const numbers = new Intl.NumberFormat(options.locale ?? 'en', { useGrouping: true, maximumFractionDigits: 0 });
  const signed = (n: number, grouped: boolean): string => {
    const text = grouped ? numbers.format(Math.abs(n)) : String(Math.abs(n));
    return n < 0 ? `${MINUS}${text}` : text;
  };

  const label = (day: number, form: 'short' | 'long'): string => messages.day(signed(day, form === 'long'));

  const span = (fromDay: number, toDay: number): string => {
    const days = Math.abs(toDay - fromDay);
    if (days < MONTH_DAYS) return messages.days(numbers.format(days), days);
    if (days < YEAR_DAYS) {
      const months = Math.round(days / MONTH_DAYS);
      if (months < 12) {
        const text = messages.months(numbers.format(months), months);
        return days % MONTH_DAYS === 0 ? text : messages.about(text);
      }
    }
    const years = Math.max(1, Math.round(days / YEAR_DAYS));
    const text = messages.years(numbers.format(years), years);
    return days % YEAR_DAYS === 0 ? text : messages.about(text);
  };

  const tickLabel = (day: number, level: 0 | 1 | 2 | 3): string => {
    // Day 0 is the story's reference day, so it keeps its own name whatever boundary it also is.
    if (level === 0 || day === 0) return messages.day(signed(day, false));
    const step = LEVEL_STEPS[level];
    const n = signed(day / step, false);
    return level === 1 ? messages.week(n) : level === 2 ? messages.month(n) : messages.year(n);
  };

  const ticks = (range: readonly [number, number], pxPerDay: number): Tick[] => {
    const lo = Math.min(range[0], range[1]);
    const hi = Math.max(range[0], range[1]);
    if (!(pxPerDay > 0)) return [];
    let base = 0;
    while (base < 3 && (LEVEL_STEPS[base] ?? 1) * pxPerDay < MIN_TICK_PX) base += 1;
    let step: number = LEVEL_STEPS[base] ?? 1;
    while ((hi - lo) / step > MAX_TICKS && base < 3) {
      base += 1;
      step = LEVEL_STEPS[base] ?? YEAR_DAYS;
    }
    // Past the year level, thin by whole multiples of a year so the count stays bounded for any range.
    while ((hi - lo) / step > MAX_TICKS) step *= 2;
    const out: Tick[] = [];
    for (let day = Math.ceil(lo / step) * step; day <= hi; day += step) {
      let level: 0 | 1 | 2 | 3 = base as 0 | 1 | 2 | 3;
      for (let candidate = 3; candidate > level; candidate -= 1) {
        if (floorMod(day, LEVEL_STEPS[candidate] ?? 1) === 0) {
          level = candidate as 0 | 1 | 2 | 3;
          break;
        }
      }
      out.push({ day: day === 0 ? 0 : day, level, label: tickLabel(day, level) });
    }
    return out;
  };

  // The words around a day number come from the messages, so "Tag 4.380" reads back in German as "Day 4,380" does in English.
  const codec = createIntegerCodec(options.locale ?? 'en');
  const marker = messages.day('\u0000').split('\u0000');
  const [prefix, suffix] = marker.length === 2 ? [marker[0] ?? '', marker[1] ?? ''] : ['', ''];
  const parse = (text: string): number | null => {
    let body = text.normalize('NFC').trim();
    if (prefix !== '' && foldName(body.slice(0, prefix.length)) === foldName(prefix)) body = body.slice(prefix.length);
    if (suffix !== '' && foldName(body.slice(Math.max(0, body.length - suffix.length))) === foldName(suffix)) body = body.slice(0, body.length - suffix.length);
    return codec.parse(body);
  };

  return { id: options.id ?? 'day', name: options.name ?? 'Day', lensApi: 1, label, span, ticks, parse };
}

export const dayLens: CalendarLens = createDayLens();
