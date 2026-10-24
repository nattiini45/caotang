/**
 * The app's one answer to "which locale formats this screen?" — [i18n.md §4.1, §3.1](docs/architecture/i18n.md),
 * decision D3.
 *
 * **This module is the single place the app decides.** Models that format take a `locale` argument
 * defaulting to {@link formatterLocale}, and components that format inline call it; neither carries a
 * literal `'en-US'`, `'en-GB'` or `undefined`. The decision is made here and nowhere else.
 *
 * **L1 has no interface-language setting yet.** The setting is the constant `'system'` and the only
 * shipped catalogue is English, so the UI resolves to `en` and formats as `en` plus the system's
 * region when the system speaks English (`en-GB` on a British machine, `en-US` on an American one).
 * **L4 rebinds this file, not its callers**: `UI_LOCALE_SETTING` becomes the stored setting,
 * `SHIPPED_UI_LOCALES` grows with the shipped catalogues, and {@link formatterLocale} reads the
 * locale the provider activated. Every call site already asks this function at the moment it
 * formats, so nothing at the call sites changes when the value becomes live.
 */

import { formatLocale, resolveUiLocale } from '@caotang/i18n';

/** The interface catalogues this build ships. English is the source locale; a language joins when its catalogue does (§3.3). */
export const SHIPPED_UI_LOCALES: readonly string[] = ['en'];

/** The interface-language setting: `'system'` or a shipped tag. L4 replaces this with the settings store's value. */
export const UI_LOCALE_SETTING = 'system';

/** The browser's languages, most preferred first. A runtime with no `navigator` (a test, Node) has none. */
function systemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  const languages = navigator.languages;
  if (languages !== undefined && languages.length > 0) return languages;
  return typeof navigator.language === 'string' && navigator.language !== '' ? [navigator.language] : [];
}

/**
 * The catalogue the interface renders in (§3.1): a shipped tag, never one that is not shipped.
 * The injected list is for tests; production passes nothing and reads the browser.
 */
export function uiLocale(languages: readonly string[] = systemLanguages()): string {
  return resolveUiLocale(UI_LOCALE_SETTING, languages, SHIPPED_UI_LOCALES);
}

/**
 * The locale every formatter uses (§4.1, D3): the UI language plus the system's region when the
 * languages match, else the language's default region. This is what a formatting call site passes
 * when it does not name a locale itself.
 */
export function formatterLocale(languages: readonly string[] = systemLanguages()): string {
  return formatLocale(uiLocale(languages), languages);
}
