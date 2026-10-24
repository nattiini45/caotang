/**
 * `@caotang/i18n` — the pure localisation contracts: which locale is the interface's, which locale
 * formats it, its direction, the isolated interpolation of writer content, the cached `Intl`
 * formatters, and the `MessageRef` a package hands to a UI.
 *
 * This package has no React and no message library. Catalogs and the locale runtime arrive in L2/L4;
 * they consume what is here. See [i18n.md §3.2](docs/architecture/i18n.md).
 */

export { directionOf, formatLocale, resolveUiLocale } from './locale.js';
export {
  collatorFor,
  currencyFormat,
  dateFormat,
  displayNames,
  listFormat,
  numberFormat,
  relativeTimeFormat,
  timeFormat,
} from './format.js';
export { isolate } from './isolation.js';
export type { MessageRef } from './message-ref.js';
