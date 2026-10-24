/**
 * Counts and word labels as a panel shows them — [i18n.md §4.2](docs/architecture/i18n.md), decision D3.
 *
 * They live in the app's model layer rather than inside `components/shared.tsx` so a model test can pin their output
 * without a React render; `shared.tsx` re-exports them, which is where the panels import them from. The number is
 * grouped by the formatter locale (the app's accessor, `i18n/format-locale.ts`), and the noun stays English until I5/I6
 * converts the strings to ICU.
 */

import { numberFormat } from '@caotang/i18n';

import { formatterLocale } from '../i18n/format-locale.js';

/** A count, grouped the way the formatter locale groups numbers. */
export function formatCount(n: number, locale: string = formatterLocale()): string {
  return numberFormat(locale).format(n);
}

export function wordsLabel(n: number, locale: string = formatterLocale()): string {
  return `${formatCount(n, locale)} ${n === 1 ? 'word' : 'words'}`;
}
