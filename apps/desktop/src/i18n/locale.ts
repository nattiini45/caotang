/**
 * The app's interface and formatter locales, and the formatters bound to them (i18n.md §3.1, §4.1). The interface language is
 * `'system'` until the setting exists (#194), so today it is English on every system and the formatter locale is English with
 * the system's region (D3): `en-GB` on a British system, `en-US` on an American one.
 *
 * Model files are plain functions with no React, so the locale is module state rather than a hook. The setting (#194) calls
 * {@link setInterfaceLanguage}; unit specs call {@link pinFormatLocale} so their expectations do not follow the machine.
 */

import {
  SHIPPED_UI_LOCALES,
  collatorFor,
  dateTimeFormat,
  formatLocale,
  numberFormat,
  resolveUiLocale,
  type UiLocaleSetting,
} from '@caotang/i18n';

let setting: UiLocaleSetting = 'system';
let pinned: string | undefined;
let resolved: { readonly ui: string; readonly format: string } | undefined;

/** The browser's languages, most preferred first. Empty where there is no `navigator` (a bare Node host). */
function systemLanguages(): readonly string[] {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  if (nav === undefined) return [];
  if (nav.languages !== undefined && nav.languages.length > 0) return nav.languages;
  return nav.language === undefined ? [] : [nav.language];
}

function current(): { readonly ui: string; readonly format: string } {
  if (resolved === undefined) {
    const languages = systemLanguages();
    const ui = resolveUiLocale(setting, languages, SHIPPED_UI_LOCALES);
    resolved = { ui, format: pinned ?? formatLocale(ui, languages) };
  }
  return resolved;
}

/** The interface language (i18n.md §3.1): a shipped tag, `en` today. */
export function interfaceLocale(): string {
  return current().ui;
}

/** The locale every number and date in the interface is formatted in (D3). */
export function appFormatLocale(): string {
  return current().format;
}

/** Changes the interface-language setting and re-resolves both locales. The setting itself arrives with #194. */
export function setInterfaceLanguage(next: UiLocaleSetting): void {
  setting = next;
  resolved = undefined;
}

/** Pins the formatter locale (unit specs, so a count or a date reads the same on every machine); `undefined` unpins it. */
export function pinFormatLocale(tag: string | undefined): void {
  pinned = tag;
  resolved = undefined;
}

/** A count as the interface shows it, grouped in the formatter locale: "12,000" in English. */
export function formatCount(value: number, options?: Intl.NumberFormatOptions): string {
  return numberFormat(appFormatLocale(), options).format(value);
}

/** A provider price in US dollars, up to six decimals and no padding ("$3", "$0.0025" in en-US; "US$3" in en-GB). */
export function formatUsd(value: number): string {
  return numberFormat(appFormatLocale(), { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 6 }).format(value);
}

/**
 * An instant or a date in the formatter locale. An invalid date reads "Invalid Date", as `Date#toLocaleString` has it, rather
 * than throwing the `RangeError` that `Intl.DateTimeFormat#format` throws into a render.
 */
export function formatDateTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  const time = typeof value === 'number' ? value : value.getTime();
  if (Number.isNaN(time)) return 'Invalid Date';
  return dateTimeFormat(appFormatLocale(), options).format(value);
}

/** What `Date#toLocaleString()` shows with no options, numeric date and time with seconds, in the formatter locale. */
export const DATE_AND_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
};

/** What `Date#toLocaleTimeString()` shows with no options, in the formatter locale. */
export const TIME_OF_DAY: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: 'numeric', second: 'numeric' };

/**
 * The collator for the writer's own names (D9, i18n.md §4.3): codex names, characters, keywords. They are content, so they
 * sort by the project language whatever the interface language is; a project with no language sorts by the interface's.
 */
export function namesCollator(projectLanguage: string | undefined): Intl.Collator {
  const tag = projectLanguage?.trim() ?? '';
  return collatorFor(tag === '' ? interfaceLocale() : tag);
}

/** The collator for lists the interface itself orders, such as the projects on Home: the formatter locale. */
export function interfaceCollator(): Intl.Collator {
  return collatorFor(appFormatLocale());
}
