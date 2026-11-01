/**
 * Lingui's catalogs for the interface ([i18n.md §3.2–§3.3, §8.1](docs/architecture/i18n.md), decisions D1 and D5).
 *
 * - **`en` is the source locale.** Its compiled catalogue is imported synchronously by the app entry
 *   (`apps/desktop/src/i18n/runtime.ts`), so English is present before the first paint and is the
 *   per-message fallback.
 * - **Every other locale is one `.po` file** under `apps/desktop/src/i18n/locales/<locale>/messages.po`,
 *   loaded by its own dynamic import. No non-English catalogue ships in I3; the loader is exercised by
 *   tests and by the pseudo catalogues.
 * - **The pseudo catalogues are dev/test only.** They are real catalogue files (so the Vite plugin can
 *   compile them), but the only import of them sits behind `import.meta.env.DEV`, so the production
 *   build contains neither the catalogue nor its strings. Their ids are not language tags: the runtime
 *   maps them to `en-XA` (padded Latin) and `ar-XB` (right to left) before anything reaches `Intl`.
 *
 * The extractor scans only the app source: package-produced text is I7's, and model-facing text stays
 * English outside the catalogue (§3.4).
 */
import { defineConfig } from '@lingui/conf';
import { formatter } from '@lingui/format-po';
import { createBabelExtractor } from '@lingui/cli/api/extractors/babel';

import { packageRefsExtractor } from './tools/package-refs-extractor.js';

export default defineConfig({
  locales: ['en', 'de', 'pseudo-LOCALE', 'pseudo-RTL'],
  sourceLocale: 'en',
  catalogs: [
    {
      path: '<rootDir>/apps/desktop/src/i18n/locales/{locale}/messages',
      include: [
        '<rootDir>/apps/desktop/src',
        // I7: package code emits MessageRefs, not macros. The custom extractor reads only the files
        // marked `// i18n: package-refs`; the default extractor still handles the app's macros.
        '<rootDir>/packages/harness/src',
        '<rootDir>/packages/coherence/src',
        '<rootDir>/packages/bus/src',
        '<rootDir>/packages/store/src',
        '<rootDir>/packages/dialogue/src',
      ],
      exclude: ['<rootDir>/apps/desktop/src/i18n/locales'],
    },
  ],
  extractors: [packageRefsExtractor, createBabelExtractor({ parserOptions: {} })],
  // Line numbers move on every edit and are not evidence a translation is stale; the origin (file) stays.
  format: formatter({ lineNumbers: false }),
  pseudoLocale: [
    // Accented and padded by 40% in total (half on each side), bracketed so a truncated label shows its
    // cut. The padding character is a letter, so a padded label is one unbroken run rather than a gap
    // the layout can wrap (P10).
    { locale: 'pseudo-LOCALE', prepend: '⟦', append: '⟧', extend: 0.4, extendCharacter: 'ẍ' },
    { locale: 'pseudo-RTL', prepend: '⟦', append: '⟧', extend: 0.4, extendCharacter: 'ẍ', rightToLeft: true },
  ],
});
