/**
 * The collator for a project's writer content — [i18n.md §4.3](docs/architecture/i18n.md), decision D9.
 *
 * The codex, the POV and knowledge candidate lists, the keyword suggestions and the codex sections all
 * sort the writer's own names by the **project language**: a Swedish novel sorts å after z whatever the
 * interface. A project that names no language sorts with the interface's formatter locale, and a stored
 * tag the engine cannot read is handled by `collatorFor` (it sorts like English rather than throwing).
 *
 * The fallback is an argument so a model test can pin both branches without a browser; call sites pass
 * only the project's language.
 */

import { collatorFor } from '@caotang/i18n';

import { formatterLocale } from './format-locale.js';

export function projectCollator(projectLanguage: string | undefined, fallback: string = formatterLocale()): Intl.Collator {
  const tag = projectLanguage?.trim();
  return collatorFor(tag === undefined || tag === '' ? fallback : tag);
}
