/**
 * The app's interface and formatter locales, and the formatters bound to them (i18n.md §3.1, §4.1). The interface language is
 * `'system'` until the setting exists (#194), so today it is English on every system and the formatter locale is English with
 * the system's region (D3): `en-GB` on a British system, `en-US` on an American one.
 *
 * Model files are plain functions with no React, so the locale is module state rather than a hook. The setting (#194) calls
 * {@link setInterfaceLanguage}; unit specs call {@link pinFormatLocale} so their expectations do not follow the machine. The
 * browser's `languagechange` event re-resolves both, so a system language changed mid-session shows on the next render, as the
 * `toLocaleString(undefined)` calls this replaced did.
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
/**
 * The catalogue the runtime actually activated (`language.ts`, through `format-locale.ts`). Once one is active it is the
 * interface language, whatever the setting resolves to: a catalogue that is still loading, or failed to, never decides it.
 */
let activated: string | undefined;
let resolved: { readonly ui: string; readonly format: string } | undefined;

/** The browser's languages, most preferred first. Empty where there is no `navigator` (a bare Node host). */
function systemLanguages(): readonly string[] {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  if (nav === undefined) return [];
  if (nav.languages !== undefined && nav.languages.length > 0) return nav.languages;
  return nav.language === undefined ? [] : [nav.language];
}

const events = globalThis as { addEventListener?: (type: string, listener: () => void) => void };
if (typeof events.addEventListener === 'function') {
  events.addEventListener('languagechange', () => {
    resolved = undefined;
  });
}

function current(): { readonly ui: string; readonly format: string } {
  if (resolved === undefined) {
    const languages = systemLanguages();
    const ui = activated ?? resolveUiLocale(setting, languages, SHIPPED_UI_LOCALES);
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

/**
 * Records the catalogue tag the runtime activated (I4). Called only after a successful load and `i18n.activate`, so the
 * interface and formatter locales follow the catalogue that is on screen; `undefined` returns the decision to the setting.
 */
export function setActivatedInterfaceLocale(tag: string | undefined): void {
  activated = tag;
  resolved = undefined;
}

/** The browser's languages, most preferred first, for callers that resolve a setting themselves (the language switcher). */
export function systemLanguageList(): readonly string[] {
  return systemLanguages();
}

/**
 * The formatter locale for an explicit list of system languages, under the interface language that is active now. Tests and
 * the switcher pass their own list; every other caller wants {@link appFormatLocale}, which also honours a pinned locale.
 */
export function formatLocaleFor(languages: readonly string[]): string {
  return formatLocale(interfaceLocale(), languages);
}

/** Pins the formatter locale (unit specs, so a count or a date reads the same on every machine); `undefined` unpins it. */
export function pinFormatLocale(tag: string | undefined): void {
  pinned = tag;
  resolved = undefined;
}

/**
 * A count as the interface shows it, grouped in the formatter locale: "12,000" in English. A model that takes a `locale` argument
 * (so a test can pin it) passes it first; every other caller passes options, or nothing.
 */
export function formatCount(value: number, options?: Intl.NumberFormatOptions): string;
export function formatCount(value: number, locale: string, options?: Intl.NumberFormatOptions): string;
export function formatCount(value: number, localeOrOptions?: string | Intl.NumberFormatOptions, options?: Intl.NumberFormatOptions): string {
  const locale = typeof localeOrOptions === 'string' ? localeOrOptions : appFormatLocale();
  return numberFormat(locale, typeof localeOrOptions === 'string' ? options : localeOrOptions).format(value);
}

/**
 * A provider's price per 1,000 tokens in US dollars, up to six decimals and no padding ("$3", "$0.0025" in en-US; "US$3" in
 * en-GB), for Settings. Not the cost lines of a plan (`plan-preview.ts` `formatUsd`), which stay fixed-decimal.
 */
export function formatUsdPrice(value: number): string {
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
export const DATE_AND_TIME: Readonly<Intl.DateTimeFormatOptions> = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
};

/** What `Date#toLocaleTimeString()` shows with no options, in the formatter locale. */
export const TIME_OF_DAY: Readonly<Intl.DateTimeFormatOptions> = { hour: 'numeric', minute: 'numeric', second: 'numeric' };

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
