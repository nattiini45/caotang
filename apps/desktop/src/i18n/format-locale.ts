/**
 * The PR-era names for the app's locale decision ([i18n.md §4.1, §3.1](docs/architecture/i18n.md), D3), kept as thin
 * delegates. **`locale.ts` is the single place the app decides** which locale the interface speaks and which formats it;
 * this module only re-exports that decision under the names the catalogue runtime, the switcher and the models call.
 *
 * Models that format take a `locale` argument defaulting to {@link formatterLocale}, and components that format inline call
 * it; neither carries a literal `'en-US'`, `'en-GB'` or `undefined`.
 *
 * Nothing here reads `navigator` at module load: {@link formatterLocale} asks for the system languages only when it is
 * called, so a test can pass its own list.
 */

import { appFormatLocale, formatLocaleFor, interfaceLocale, setActivatedInterfaceLocale, systemLanguageList } from './locale.js';
import { catalogueTags } from './catalogues.js';

/** The interface catalogues this build ships to writers. Pseudo catalogues are dev/test only. */
export const SHIPPED_UI_LOCALES: readonly string[] = catalogueTags(false);

/** Records the tag the runtime activated. Called by the switcher after `i18n.activate`, never before. */
export function setUiLocaleTag(tag: string): void {
  setActivatedInterfaceLocale(tag);
}

/** The catalogue the interface renders in (§3.1): the tag that is actually active, never one that is not shipped. */
export function uiLocale(): string {
  return interfaceLocale();
}

/** The browser's languages, most preferred first. A runtime with no `navigator` (a test, Node) has none. */
export function systemLanguages(): readonly string[] {
  return systemLanguageList();
}

/**
 * The locale every formatter uses (§4.1, D3): the UI language plus the system's region when the languages match, else the
 * language's own default region. With no list this is `locale.ts`'s `appFormatLocale()` (which a unit spec may pin).
 */
export function formatterLocale(languages?: readonly string[]): string {
  return languages === undefined ? appFormatLocale() : formatLocaleFor(languages);
}
