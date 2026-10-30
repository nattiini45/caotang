/**
 * Which locale the interface speaks, which locale formats its numbers and dates, and which way a language runs
 * (i18n.md §3.1, §3.2, §4.1). Pure functions over BCP-47 tags: the caller passes `navigator.languages`, so nothing here
 * reads a browser global and every rule is testable in Node.
 */

/** The source locale: the language the interface is written in, and the one every other locale falls back to per message. */
export const SOURCE_LOCALE = 'en';

/**
 * The interface languages this build ships. Only the source today; Lingui (#193) and the first translation (#203) add to it.
 * A locale in this list is one the interface can be shown in, before the release gates (D5) decide which are listed.
 */
export const SHIPPED_UI_LOCALES: readonly string[] = [SOURCE_LOCALE];

/**
 * The locale for numbers inside English text that a package hands to every host at once (the CLI, the MCP server and the
 * app): compile-log notes, validation messages. That text stays English (D10) until it carries a {@link MessageRef} (#198),
 * so its grouping stays the en-US one it has always had.
 */
export const PACKAGE_TEXT_LOCALE = 'en-US';

/** The interface-language setting: `'system'` follows the browser's languages, or a shipped tag pins one. */
export type UiLocaleSetting = 'system' | (string & {});

/** The direction a language is written in. */
export type Direction = 'ltr' | 'rtl';

/** Languages written right to left, for engines whose `Intl.Locale` has no text info (i18n.md §3.2). */
const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb']);

/** `tag` as an `Intl.Locale`, or `undefined` when it is not a well-formed BCP-47 tag. */
function localeOf(tag: string): Intl.Locale | undefined {
  if (tag.trim() === '') return undefined;
  try {
    return new Intl.Locale(tag);
  } catch {
    return undefined;
  }
}

/**
 * The tags a system language may match a shipped locale by, most specific first: the tag itself, its language and script
 * (so `zh-TW` reaches a shipped `zh-Hant`), and its bare language.
 */
function candidatesOf(tag: string): readonly string[] {
  const locale = localeOf(tag);
  if (locale === undefined) return [];
  const out = [locale.baseName];
  let script = locale.script;
  if (script === undefined) {
    try {
      script = locale.maximize().script;
    } catch {
      script = undefined;
    }
  }
  if (script !== undefined) out.push(`${locale.language}-${script}`);
  out.push(locale.language);
  return out;
}

/** The shipped tag that `tag` names, compared case-insensitively, or `undefined`. */
function shippedMatch(tag: string, shipped: readonly string[]): string | undefined {
  const byLower = new Map(shipped.map((entry) => [entry.toLowerCase(), entry] as const));
  for (const candidate of candidatesOf(tag)) {
    const hit = byLower.get(candidate.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * The interface language (i18n.md §3.1). A pinned setting wins when it is shipped. `'system'` takes the first of the
 * browser's languages that matches a shipped locale, by tag, then language and script, then language. Anything else is the
 * source locale, or the first shipped locale when a build ships no source.
 */
export function resolveUiLocale(
  setting: UiLocaleSetting,
  navigatorLanguages: readonly string[],
  shipped: readonly string[] = SHIPPED_UI_LOCALES,
): string {
  if (setting !== 'system') {
    const pinned = shippedMatch(setting, shipped);
    if (pinned !== undefined) return pinned;
  }
  for (const language of navigatorLanguages) {
    const hit = shippedMatch(language, shipped);
    if (hit !== undefined) return hit;
  }
  return shipped.includes(SOURCE_LOCALE) ? SOURCE_LOCALE : (shipped[0] ?? SOURCE_LOCALE);
}

/**
 * The formatter locale (D3, i18n.md §4.1): the interface language plus the system's region when the languages match.
 * An `en` interface on an `en-GB` system formats as `en-GB`; a `de` interface on an `en-US` system formats as `de-DE`, the
 * language's own default region. A tag that cannot be read formats as `en-US`.
 */
export function formatLocale(ui: string, navigatorLanguages: readonly string[]): string {
  const interfaceLocale = localeOf(ui);
  if (interfaceLocale === undefined) return 'en-US';
  const base = interfaceLocale.script === undefined ? interfaceLocale.language : `${interfaceLocale.language}-${interfaceLocale.script}`;
  if (interfaceLocale.region !== undefined) return `${base}-${interfaceLocale.region}`;
  for (const tag of navigatorLanguages) {
    const system = localeOf(tag);
    if (system === undefined || system.language !== interfaceLocale.language) continue;
    if (system.region !== undefined) return `${base}-${system.region}`;
  }
  try {
    const region = interfaceLocale.maximize().region;
    return region === undefined ? base : `${base}-${region}`;
  } catch {
    return base;
  }
}

/** The `Intl.Locale` text info, where the engine has it: `getTextInfo()` (the current proposal) or the older `textInfo` getter. */
function textDirection(locale: Intl.Locale): Direction | undefined {
  const withInfo = locale as Intl.Locale & {
    getTextInfo?: () => { direction?: string };
    textInfo?: { direction?: string };
  };
  const info = typeof withInfo.getTextInfo === 'function' ? withInfo.getTextInfo() : withInfo.textInfo;
  const direction = info?.direction;
  return direction === 'rtl' || direction === 'ltr' ? direction : undefined;
}

/**
 * The direction `tag` is written in (i18n.md §3.2): the engine's text info where present, else the list of right-to-left
 * languages. An unreadable tag is left to right.
 */
export function directionOf(tag: string): Direction {
  const locale = localeOf(tag);
  if (locale === undefined) return 'ltr';
  const fromEngine = textDirection(locale);
  if (fromEngine !== undefined) return fromEngine;
  return RTL_LANGUAGES.has(locale.language) ? 'rtl' : 'ltr';
}
