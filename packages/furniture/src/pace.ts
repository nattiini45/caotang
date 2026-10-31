import { PACKAGE_TEXT_LOCALE, formatNumber } from '@caotang/i18n';

/**
 * The words of a pace line (goals-progress §2.2). A pace line reads "≈ 1 word/day to finish by 31 Dec 2030", so this gives the
 * count and the noun, and the caller adds "/day": one word is written in the singular, and every other count in the plural.
 * The count is grouped in `locale`: the app passes its formatter locale (D3, i18n.md §4.1); a host with none gets en-US.
 */
export function paceWords(perDay: number, locale: string = PACKAGE_TEXT_LOCALE): string {
  const count = formatNumber(perDay, locale);
  return `${count} ${perDay === 1 ? 'word' : 'words'}`;
}
