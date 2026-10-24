/**
 * The interface's locale and its direction — [i18n.md §3.1, §3.2, §4.1, §5.1](docs/architecture/i18n.md),
 * decisions D3 and D8.
 *
 * Two locale questions live here, and they are different questions:
 *
 * - **Which catalogue renders the interface?** {@link resolveUiLocale}. The answer is always one of
 *   the shipped tags, because a catalogue that is not shipped cannot be activated.
 * - **Which locale formats its numbers, dates and lists?** {@link formatLocale}. The UI language plus
 *   the system's region *when the languages match*, so a British writer keeps en-GB dates under an
 *   English interface while a German interface on an American machine formats as de-DE.
 *
 * Nothing here reads `navigator` or `document`: the caller passes `navigator.languages`, which keeps the
 * function pure, headless-testable and usable from Node as well as the app.
 */

/** The spec's right-to-left languages, for an engine without `Intl.Locale#getTextInfo` (§3.2, §5.5). */
const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb']);

/** The source locale. It is always shipped (§3.3), so it is the fallback that satisfies "never unshipped". */
const SOURCE_LOCALE = 'en';

/**
 * A tag's language subtag, lower-cased. A malformed tag falls back to the text before its first
 * hyphen, so one bad `navigator.languages` entry cannot throw while the UI is starting.
 */
function languageOf(tag: string): string {
  try {
    return new Intl.Locale(tag).language;
  } catch {
    return (tag.split('-')[0] ?? '').toLowerCase();
  }
}

/**
 * The locale the interface renders in (§3.1, §3.2).
 *
 * - A shipped tag is returned as itself: the writer chose it, and availability thresholds were the
 *   picker's concern before this list was handed in.
 * - `'system'` takes the first `navigator.languages` entry whose **language** is shipped (so `en-GB`
 *   selects the `en` catalogue), and English when none matches.
 * - A stored tag that is not in the shipped list (a catalogue below the release gate) resolves like
 *   `'system'` rather than being returned, because this function must never name an unshipped tag.
 */
export function resolveUiLocale(setting: string, navigatorLanguages: readonly string[], shipped: readonly string[]): string {
  const stored = shipped.find((tag) => tag.toLowerCase() === setting.toLowerCase());
  if (stored !== undefined) return stored;

  for (const candidate of navigatorLanguages) {
    const language = languageOf(candidate);
    const match = shipped.find((tag) => languageOf(tag) === language);
    if (match !== undefined) return match;
  }

  return shipped.find((tag) => languageOf(tag) === SOURCE_LOCALE) ?? shipped[0] ?? SOURCE_LOCALE;
}

/**
 * The locale formatters use (§4.1, D3): the UI language plus the system's region **only when the
 * languages match**, and the language's default region otherwise.
 *
 * `formatLocale('en', ['en-GB'])` is `'en-GB'`. `formatLocale('de', ['en-US'])` is `'de-DE'`, the
 * language default — not the first system tag, which would format German dates as American ones.
 */
export function formatLocale(ui: string, navigatorLanguages: readonly string[]): string {
  const language = languageOf(ui);
  for (const candidate of navigatorLanguages) {
    if (languageOf(candidate) === language) return candidate;
  }
  return defaultRegionOf(ui);
}

/** `en` → `en-US`, `de` → `de-DE`, `zh-Hant` → `zh-Hant-TW`: the tag's own language and script, the likely region. */
function defaultRegionOf(tag: string): string {
  try {
    const locale = new Intl.Locale(tag);
    const region = locale.maximize().region;
    if (region === undefined) return locale.toString();
    return `${locale.language}${locale.script === undefined ? '' : `-${locale.script}`}-${region}`;
  } catch {
    return tag;
  }
}

/**
 * Which way a locale reads (§3.2, §5.5): `Intl.Locale#getTextInfo()` where the engine has it, else the
 * spec's list of right-to-left languages.
 *
 * It takes **language tags**, never catalogue or message ids: an opaque id is not a locale, and an id
 * passed by mistake reads left to right instead of throwing during a render.
 */
export function directionOf(tag: string): 'ltr' | 'rtl' {
  try {
    const locale = new Intl.Locale(tag) as Intl.Locale & { getTextInfo?: () => { direction?: string } };
    const direction = locale.getTextInfo?.().direction;
    if (direction === 'rtl' || direction === 'ltr') return direction;
  } catch {
    // Not a tag: fall through to the list, which answers 'ltr' for anything it does not name.
  }
  return RTL_LANGUAGES.has(languageOf(tag)) ? 'rtl' : 'ltr';
}
