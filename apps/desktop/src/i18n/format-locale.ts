/**
 * The app's one answer to "which locale formats this screen?" — [i18n.md §4.1, §3.1](docs/architecture/i18n.md),
 * decision D3.
 *
 * **This module is the single place the app decides.** Models that format take a `locale` argument
 * defaulting to {@link formatterLocale}, and components that format inline call it; neither carries a
 * literal `'en-US'`, `'en-GB'` or `undefined`. The decision is made here and nowhere else.
 *
 * **The interface catalogue is the source of truth.** In I3 the only shipped catalogue was English, so
 * the setting was the constant `'system'`. I4 activated a catalogue from the stored preference (System
 * or a tag), and this file reads the tag the runtime actually activated: {@link setUiLocaleTag} is
 * called only after a successful load and activation. Formatting is then the interface language plus
 * the system's region when the languages match (`en-GB` on a British machine under an English
 * interface, `de-DE` for a German interface on any machine).
 *
 * Nothing here reads `navigator` at module load: {@link formatterLocale} asks for the system languages
 * only when it is called, so a test can pass its own list.
 */

import { formatLocale } from '@caotang/i18n';

import { catalogueTags } from './catalogues.js';

/** The interface catalogues this build ships to writers. Pseudo catalogues are dev/test only. */
export const SHIPPED_UI_LOCALES: readonly string[] = catalogueTags(false);

/** The catalogue tag the runtime activated. English until {@link setUiLocaleTag} says otherwise. */
let activeUiLocale = 'en';

/** Records the tag the runtime activated. Called by the switcher after `i18n.activate`, never before. */
export function setUiLocaleTag(tag: string): void {
  activeUiLocale = tag;
}

/** The catalogue the interface renders in (§3.1): the tag that is actually active, never one that is not shipped. */
export function uiLocale(): string {
  return activeUiLocale;
}

/** The browser's languages, most preferred first. A runtime with no `navigator` (a test, Node) has none. */
export function systemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  const languages = navigator.languages;
  if (languages !== undefined && languages.length > 0) return languages;
  return typeof navigator.language === 'string' && navigator.language !== '' ? [navigator.language] : [];
}

/**
 * The locale every formatter uses (§4.1, D3): the UI language plus the system's region when the
 * languages match, else the language's default region. This is what a formatting call site passes
 * when it does not name a locale itself.
 */
export function formatterLocale(languages: readonly string[] = systemLanguages()): string {
  return formatLocale(activeUiLocale, languages);
}
