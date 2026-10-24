/**
 * The cached `Intl` factories — [i18n.md §4.2, §4.3](docs/architecture/i18n.md), decisions D3 and D9.
 *
 * Every factory is memoised by locale and by the options it was called with. The set of keys is fixed
 * by the call sites (a handful of option records per locale), so a panel formatting on every render
 * builds no formatter after the first one, and the cache grows with the shipped locales in use rather
 * than with the number of calls.
 */

/** The option records the call sites use are flat and hold primitives, so their content is their identity. */
function keyOf(locale: string, options: object | undefined): string {
  if (options === undefined) return locale;
  const entries = Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `${locale}\u0000${JSON.stringify(entries)}`;
}

const NUMBER_FORMATS = new Map<string, Intl.NumberFormat>();
const CURRENCY_FORMATS = new Map<string, Intl.NumberFormat>();
const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();
const TIME_FORMATS = new Map<string, Intl.DateTimeFormat>();
const RELATIVE_TIME_FORMATS = new Map<string, Intl.RelativeTimeFormat>();
const LIST_FORMATS = new Map<string, Intl.ListFormat>();
const DISPLAY_NAMES = new Map<string, Intl.DisplayNames>();
const COLLATORS = new Map<string, Intl.Collator>();

/** Counts, tokens and other bare numbers: the formatter locale's grouping (§4.2). */
export function numberFormat(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = keyOf(locale, options);
  const cached = NUMBER_FORMATS.get(key);
  if (cached !== undefined) return cached;
  const made = new Intl.NumberFormat(locale, options);
  NUMBER_FORMATS.set(key, made);
  return made;
}

/**
 * Provider prices in USD (§4.2): at most six fraction digits and no trailing zeros, so `0.0015` reads
 * `$0.0015` and `3` reads `$3`. The locale decides grouping, the currency's name (`US$` in en-GB) and
 * where it sits.
 */
export function currencyFormat(locale: string): Intl.NumberFormat {
  const cached = CURRENCY_FORMATS.get(locale);
  if (cached !== undefined) return cached;
  const made = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
  CURRENCY_FORMATS.set(locale, made);
  return made;
}

/** A day, in the styles the app uses: `dateStyle`, or explicit day/month/year fields (§4.2). */
export function dateFormat(locale: string, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = keyOf(locale, options);
  const cached = DATE_FORMATS.get(key);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat(locale, options);
  DATE_FORMATS.set(key, made);
  return made;
}

/**
 * A clock time (§4.2). The default is the one `Date#toLocaleTimeString` gives: the hour, minute and
 * second, in the locale's own day-period convention.
 */
export function timeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: 'numeric', second: 'numeric' },
): Intl.DateTimeFormat {
  const key = keyOf(locale, options);
  const cached = TIME_FORMATS.get(key);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat(locale, options);
  TIME_FORMATS.set(key, made);
  return made;
}

/** "3 minutes ago", "yesterday": `numeric: 'auto'` names the day instead of counting it (§4.2). */
export function relativeTimeFormat(locale: string): Intl.RelativeTimeFormat {
  const cached = RELATIVE_TIME_FORMATS.get(locale);
  if (cached !== undefined) return cached;
  const made = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  RELATIVE_TIME_FORMATS.set(locale, made);
  return made;
}

/** A UI list — "Chapter 1, Chapter 2 and Chapter 3" (§4.2). For interface lists only; export output keeps its own writing. */
export function listFormat(locale: string): Intl.ListFormat {
  const cached = LIST_FORMATS.get(locale);
  if (cached !== undefined) return cached;
  const made = new Intl.ListFormat(locale, { type: 'conjunction' });
  LIST_FORMATS.set(locale, made);
  return made;
}

/** A language (or region) named in a locale, for the picker (§4.2): each language in its own name. */
export function displayNames(locale: string, type: Intl.DisplayNamesType = 'language'): Intl.DisplayNames {
  const key = keyOf(locale, { type });
  const cached = DISPLAY_NAMES.get(key);
  if (cached !== undefined) return cached;
  const made = new Intl.DisplayNames([locale], { type });
  DISPLAY_NAMES.set(key, made);
  return made;
}

/**
 * The collator for a tag (§4.3, D9): base sensitivity (case and accents do not decide) and numeric
 * ordering ("Chapter 10" after "Chapter 9"). Writer content passes the **project language**; UI terms
 * pass the formatter locale.
 */
export function collatorFor(tag: string): Intl.Collator {
  const cached = COLLATORS.get(tag);
  if (cached !== undefined) return cached;
  const made = new Intl.Collator(tag, { sensitivity: 'base', numeric: true });
  COLLATORS.set(tag, made);
  return made;
}
