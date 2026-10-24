/**
 * The words of a pace line (goals-progress §2.2). A pace line reads "≈ 1 word/day to finish by 31 Dec 2030", so this gives the
 * count and the noun, and the caller adds "/day": one word is written in the singular, and every other count in the plural.
 * The count is grouped the way the supplied locale groups numbers (i18n.md §4.2): this package is below the app and never
 * reads a system locale of its own, so the caller passes the formatter locale.
 */
import { numberFormat } from '@caotang/i18n';

export function paceWords(perDay: number, locale: string): string {
  const count = numberFormat(locale).format(perDay);
  return `${count} ${perDay === 1 ? 'word' : 'words'}`;
}
