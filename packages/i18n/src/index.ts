/**
 * `@caotang/i18n` — interface locale resolution, the formatter locale, cached `Intl` formatters, collation, bidi isolation
 * and the `MessageRef` type (i18n.md §3.2, §4). No React and no message library: packages and the app share it, and the
 * catalogs (Lingui, #193) live in `apps/desktop/src/i18n/`.
 */

export {
  PACKAGE_TEXT_LOCALE,
  SHIPPED_UI_LOCALES,
  SOURCE_LOCALE,
  directionOf,
  formatLocale,
  resolveUiLocale,
  type Direction,
  type UiLocaleSetting,
} from './locale.js';
export {
  collatorFor,
  dateTimeFormat,
  displayNames,
  formatNumber,
  listFormat,
  numberFormat,
  pluralRules,
  relativeTimeFormat,
} from './format.js';

/** First strong isolate (U+2068): opens a run whose direction comes from its own first strong character. */
export const FSI = '\u2068';
/** Pop directional isolate (U+2069): closes the run {@link FSI} opened. */
export const PDI = '\u2069';

/**
 * `text` isolated for a plain string or an attribute (i18n.md §5.3): FSI…PDI, so a Hebrew title or a number beside it does
 * not reorder the sentence around it. JSX uses `<bdi>` instead.
 */
export function isolate(text: string): string {
  return `${FSI}${text}${PDI}`;
}

/** Text a package hands to a UI: a stable id, its values, and the English it renders as today (i18n.md §3.2). */
export interface MessageRef {
  readonly id: string;
  readonly values?: Readonly<Record<string, string | number>>;
  /** English, ICU MessageFormat. */
  readonly message: string;
}
