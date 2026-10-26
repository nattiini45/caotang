/**
 * The formatters the shell binds to the live interface language ([i18n.md §3.2, §4.1](docs/architecture/i18n.md), I5).
 *
 * App re-renders the whole tree when a catalogue activates (`languageRevision`), without remounting
 * it. A component that formats calls {@link useFormat}, so the formatters and any line it derives
 * during render read the language that is active now, and a mounted footer or activity row follows
 * a switch without navigation. Pure models keep taking a `locale` argument defaulting to
 * `formatterLocale()`, so they too are right on every render.
 */
import { useSyncExternalStore } from 'react';
import {
  collatorFor,
  currencyFormat,
  dateFormat,
  displayNames,
  listFormat,
  numberFormat,
  relativeTimeFormat,
  timeFormat,
} from '@caotang/i18n';

import { formatterLocale } from './format-locale.js';
import { languageRevision, subscribeLanguage } from './language.js';

/** The formatter calls the shell needs, bound to one locale. */
export interface Format {
  readonly locale: string;
  readonly number: (value: number, options?: Intl.NumberFormatOptions) => string;
  /** A provider price in USD (§4.2). */
  readonly currency: (value: number) => string;
  readonly date: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly time: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly relative: (value: number, unit: Intl.RelativeTimeFormatUnit) => string;
  readonly list: (items: Iterable<string>) => string;
  /** A language named in its own language, for the picker (§4.2). */
  readonly languageName: (tag: string) => string;
  /** The collator for UI terms (§4.3). */
  readonly collator: () => Intl.Collator;
}

/** The formatters for a locale, without the React binding: a test or a model can call this directly. */
export function formatAt(locale: string): Format {
  return {
    locale,
    number: (value, options) => numberFormat(locale, options).format(value),
    currency: (value) => currencyFormat(locale).format(value),
    date: (value, options) => dateFormat(locale, options).format(value),
    time: (value, options) => timeFormat(locale, options).format(value),
    relative: (value, unit) => relativeTimeFormat(locale).format(value, unit),
    list: (items) => listFormat(locale).format(items),
    languageName: (tag) => displayNames(locale).of(tag) ?? tag,
    collator: () => collatorFor(locale),
  };
}

/**
 * The formatters for the active interface language. The subscription is what makes a mounted line
 * re-render after a switch; App's own subscription keeps the rest of the tree in step.
 */
export function useFormat(): Format {
  useSyncExternalStore(subscribeLanguage, languageRevision);
  return formatAt(formatterLocale());
}
