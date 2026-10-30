/**
 * Cached `Intl` formatter factories (i18n.md §4.2, §4.3). Building an `Intl` formatter is the slow part, so each factory
 * keeps one per locale and option set. The caller chooses the locale: the formatter locale for interface text
 * ({@link formatLocale}), the project language for the writer's own names ({@link collatorFor}, D9).
 */

import { SOURCE_LOCALE } from './locale.js';

const cache = new Map<string, unknown>();

/** One stable key for an option bag, whatever order its properties were written in. */
function keyOf(kind: string, locale: string, options: object | undefined): string {
  if (options === undefined) return `${kind}|${locale}|`;
  const entries = Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${kind}|${locale}|${JSON.stringify(entries)}`;
}

/**
 * The formatter for `locale`, built once. A tag the engine refuses (a project language typed by hand, say) falls back to the
 * source locale rather than throwing into a render.
 */
function cached<T>(kind: string, locale: string, options: object | undefined, make: (tag: string) => T): T {
  const key = keyOf(kind, locale, options);
  const hit = cache.get(key) as T | undefined;
  if (hit !== undefined) return hit;
  let made: T;
  try {
    made = make(locale);
  } catch (error) {
    if (!(error instanceof RangeError) || locale === SOURCE_LOCALE) throw error;
    made = make(SOURCE_LOCALE);
  }
  cache.set(key, made);
  return made;
}

/** Counts, tokens, words and prices (`style: 'currency'`). */
export function numberFormat(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cached('number', locale, options, (tag) => new Intl.NumberFormat(tag, options));
}

/** Dates and times. */
export function dateTimeFormat(locale: string, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached('date', locale, options, (tag) => new Intl.DateTimeFormat(tag, options));
}

/** "3 minutes ago", "yesterday". `numeric: 'auto'` unless the caller says otherwise. */
export function relativeTimeFormat(locale: string, options: Intl.RelativeTimeFormatOptions = { numeric: 'auto' }): Intl.RelativeTimeFormat {
  return cached('relative', locale, options, (tag) => new Intl.RelativeTimeFormat(tag, options));
}

/** "Chapter 1, Chapter 2 and Chapter 3". A conjunction unless the caller says otherwise. */
export function listFormat(locale: string, options: Intl.ListFormatOptions = { type: 'conjunction' }): Intl.ListFormat {
  return cached('list', locale, options, (tag) => new Intl.ListFormat(tag, options));
}

/** CLDR plural categories, for code that must pick a form outside a message (messages use ICU `plural`). */
export function pluralRules(locale: string, options?: Intl.PluralRulesOptions): Intl.PluralRules {
  return cached('plural', locale, options, (tag) => new Intl.PluralRules(tag, options));
}

/** Language, region and script names, such as a language's name in its own language for the picker. */
export function displayNames(locale: string, options: Intl.DisplayNamesOptions): Intl.DisplayNames {
  return cached('names', locale, options, (tag) => new Intl.DisplayNames(tag, options));
}

/**
 * The collator for the writer's own names (D9, i18n.md §4.3): the project language, accents and case ignored, and digits
 * compared as numbers so "Chapter 10" follows "Chapter 9".
 */
export function collatorFor(tag: string, options: Intl.CollatorOptions = { sensitivity: 'base', numeric: true }): Intl.Collator {
  return cached('collator', tag, options, (locale) => new Intl.Collator(locale, options));
}

/** `value` as a number in `locale`: a shorthand for `numberFormat(locale, options).format(value)`. */
export function formatNumber(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
  return numberFormat(locale, options).format(value);
}
