import { formatAt } from '../../i18n/use-format.js';
import { formatterLocale } from '../../i18n/format-locale.js';

/**
 * A count the timeline writes as digits, grouped for the interface language (i18n.md §4.1). It reads the locale when it is called,
 * so a count drawn after a language switch follows it; it takes no hook, so a static render of the controls or the shelf works too.
 */
export function formatCount(value: number): string {
  return formatAt(formatterLocale()).number(value);
}
