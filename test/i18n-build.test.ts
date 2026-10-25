/**
 * The compiled-catalogue and toolchain gate (I3 / #193), as a test of what actually runs rather than
 * of configuration text.
 *
 * Five things are proved here:
 *
 * 1. **The Vitest transform runs the macros.** `test/fixtures/i18n-macro.tsx` holds a real `msg` macro;
 *    if the transform is missing the imported value is Lingui's untransformed stub and has no `id`.
 * 2. **English is compiled and present.** The `en` catalogue is the synchronously imported one the entry
 *    activates; its witness id renders its English text byte for byte.
 * 3. **The loader's contract.** It resolves a tag, rejects an unknown tag, and never hands a catalogue
 *    id to `Intl` — pseudo ids map to `en-XA`/`ar-XB` first.
 * 4. **Pseudo is a dev/test catalogue.** It is padded, bracketed and accented, the RTL one reads right
 *    to left, and the production branch refuses pseudo tags before any import. The no-pseudo-chunk claim
 *    about `dist/` is checked by `e2e/prod-smoke.spec.ts`, which runs after a build.
 * 5. **English is the per-message fallback.** An id the active catalogue does not translate renders its
 *    compiled English message; a translated id still wins; activating English again replaces the
 *    previously active catalogue.
 */
import { i18n } from '@lingui/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { directionOf, formatLocale } from '../packages/i18n/src/index.js';
import linguiConfig from '../lingui.config.js';
import {
  activateCatalogue,
  activateEnglish,
  activeTag,
  catalogueForTag,
  loadMessages,
  PSEUDO_CATALOGUES,
  PseudoCatalogueUnavailableError,
  tagForCatalogueId,
  UnknownCatalogueError,
  withEnglishFallback,
} from '../apps/desktop/src/i18n/runtime.js';
import { fixtureMessage, witnessMessage } from './fixtures/i18n-macro.js';

const repoRoot = resolve(__dirname, '..');

/** The startup witness's catalogue key: Lingui's generated id for the source text `Settings`. */
const WITNESS_ID = witnessMessage.id;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the repository transform compiles Lingui macros', () => {
  it('compiles the fixture macro to a real descriptor, not an untransformed stub', () => {
    // The positive control: an untransformed `msg` is a function whose result has no descriptor fields.
    // Lingui 6 derives the id from the source text (a generated hash); the English message travels
    // beside it, which is what a translator edits in the `.po` file.
    expect(fixtureMessage).toBeTypeOf('object');
    expect(fixtureMessage.id).toMatch(/^[A-Za-z0-9_-]{6}$/);
    expect(fixtureMessage.message).toBe('A macro fixture message');
  });
});

describe('the English catalogue is the compiled source catalogue', () => {
  it('contains the startup witness and renders its English text byte for byte', async () => {
    const messages = await loadMessages('en');
    expect(Object.prototype.hasOwnProperty.call(messages, WITNESS_ID)).toBe(true);

    i18n.load('en', messages);
    i18n.activate('en');
    expect(i18n._(WITNESS_ID)).toBe('Settings');
  });

  it('is what the entry activates before the first render', () => {
    const main = readFileSync(resolve(repoRoot, 'apps/desktop/src/main.tsx'), 'utf8');
    const activate = main.indexOf('activateEnglish()');
    const render = main.indexOf('createRoot(');
    expect(activate, 'main.tsx calls activateEnglish()').toBeGreaterThanOrEqual(0);
    expect(render, 'main.tsx mounts the app').toBeGreaterThanOrEqual(0);
    expect(activate, 'activation happens before the first render').toBeLessThan(render);
  });
});

describe('a locale falls back to English per message', () => {
  it('renders the compiled English message for an id the active catalogue does not translate', () => {
    // A synthetic catalogue stands in for a partly translated locale. The compiled pseudo catalogues
    // cover every id, so this direction cannot be shown with them; the merge is the same one
    // `loadMessages`/`activateCatalogue` apply.
    i18n.load('fallback-test', withEnglishFallback({}));
    i18n.activate('fallback-test');
    expect(i18n._(WITNESS_ID)).toBe('Settings');
  });

  it('lets a translated id win over the English fallback', () => {
    i18n.load('fallback-test', withEnglishFallback({ [WITNESS_ID]: ['Traduction'] }));
    i18n.activate('fallback-test');
    expect(i18n._(WITNESS_ID)).toBe('Traduction');
  });

  it('activateEnglish() replaces whichever catalogue was active and restores the English text', async () => {
    await activateCatalogue('en-XA');
    expect(i18n._(WITNESS_ID)).not.toBe('Settings');

    activateEnglish();
    expect(activeTag()).toBe('en');
    expect(i18n._(WITNESS_ID)).toBe('Settings');
  });
});

describe('the loader', () => {
  it('resolves the English catalogue for its tag', async () => {
    await expect(loadMessages('en')).resolves.toBeTypeOf('object');
  });

  it('rejects an unknown tag, and names it', async () => {
    await expect(loadMessages('de')).rejects.toBeInstanceOf(UnknownCatalogueError);
    expect(() => catalogueForTag('de', false)).toThrow(/de/);
  });

  it('activates a tag only after its catalogue has loaded, and reports the tag it activated', async () => {
    const catalogue = await activateCatalogue('en');
    expect(catalogue.tag).toBe('en');
    expect(activeTag()).toBe('en');
  });
});

describe('pseudo catalogue ids never become language tags', () => {
  it('maps both pseudo ids to valid BCP-47 root tags', () => {
    expect(tagForCatalogueId('pseudo-LOCALE')).toBe('en-XA');
    expect(tagForCatalogueId('pseudo-RTL')).toBe('ar-XB');
    expect(tagForCatalogueId('en')).toBe('en');

    for (const { id, tag } of PSEUDO_CATALOGUES) {
      expect(id).not.toBe(tag);
      expect(Intl.getCanonicalLocales(tag)[0]).toBe(tag);
      expect(directionOf(tag)).toBe(id === 'pseudo-RTL' ? 'rtl' : 'ltr');
    }
  });

  it('hands Intl the mapped tag, never the catalogue id', () => {
    // `formatLocale` is the caller that reaches `Intl.Locale`; this is the boundary I2 asked callers to
    // respect. A raw pseudo id must never be what it receives.
    const locale = vi.spyOn(Intl, 'Locale');
    formatLocale(tagForCatalogueId('pseudo-RTL'), []);
    const tags = locale.mock.calls.map((call) => call[0]);
    expect(tags).toContain('ar-XB');
    expect(tags).not.toContain('pseudo-RTL');
    expect(tags).not.toContain('pseudo-LOCALE');
  });

  it('rejects an unknown catalogue id rather than guessing a tag', () => {
    expect(() => tagForCatalogueId('pseudo-NOPE')).toThrow(UnknownCatalogueError);
  });
});

describe('pseudo catalogues are dev/test only', () => {
  it('loads the padded LTR pseudo catalogue through the same loader path', async () => {
    const messages = await loadMessages('en-XA');
    expect(Object.prototype.hasOwnProperty.call(messages, WITNESS_ID)).toBe(true);

    await activateCatalogue('en-XA');
    const rendered = i18n._(WITNESS_ID);
    expect(rendered.startsWith('⟦')).toBe(true);
    expect(rendered.endsWith('⟧')).toBe(true);
    expect(rendered).not.toBe('Settings');
    expect(rendered.length).toBeGreaterThan('Settings'.length + 2);
    expect(activeTag()).toBe('en-XA');
  });

  it('loads the RTL pseudo catalogue and it reads right to left', async () => {
    const messages = await loadMessages('ar-XB');
    expect(Object.prototype.hasOwnProperty.call(messages, WITNESS_ID)).toBe(true);

    await activateCatalogue('ar-XB');
    const rendered = i18n._(WITNESS_ID);
    expect(rendered).toContain('\u202E');
    expect(rendered).toContain('\u202C');
    expect(directionOf(activeTag())).toBe('rtl');
  });

  it('refuses a pseudo tag in production, before importing anything', async () => {
    expect(() => catalogueForTag('en-XA', false)).toThrow(PseudoCatalogueUnavailableError);
    expect(() => catalogueForTag('ar-XB', false)).toThrow(PseudoCatalogueUnavailableError);
    await expect(loadMessages('en-XA', false)).rejects.toBeInstanceOf(PseudoCatalogueUnavailableError);
    await expect(loadMessages('ar-XB', false)).rejects.toBeInstanceOf(PseudoCatalogueUnavailableError);
  });

  it('keeps the pseudo imports behind import.meta.env.DEV, so the production graph cannot reach them', () => {
    const runtime = readFileSync(resolve(repoRoot, 'apps/desktop/src/i18n/runtime.ts'), 'utf8');
    expect(runtime).not.toMatch(/^import .*pseudo/m);
    const devGuard = runtime.indexOf('if (import.meta.env.DEV)');
    expect(devGuard).toBeGreaterThanOrEqual(0);
    const guarded = runtime.slice(devGuard);
    expect(guarded).toContain("import('./locales/pseudo-LOCALE/messages.po')");
    expect(guarded).toContain("import('./locales/pseudo-RTL/messages.po')");
  });
});

describe('the Lingui configuration', () => {
  it('names English as the source and includes the two pseudo catalogues', () => {
    expect(linguiConfig.sourceLocale).toBe('en');
    expect(linguiConfig.locales).toEqual(['en', 'pseudo-LOCALE', 'pseudo-RTL']);
  });

  it('defines an accented padded LTR pseudo and an RTL one, with the spec\'s brackets', () => {
    const pseudo = Array.isArray(linguiConfig.pseudoLocale) ? linguiConfig.pseudoLocale : [linguiConfig.pseudoLocale];
    const ltr = pseudo.find((entry) => typeof entry === 'object' && entry.locale === 'pseudo-LOCALE');
    const rtl = pseudo.find((entry) => typeof entry === 'object' && entry.locale === 'pseudo-RTL');
    expect(ltr).toMatchObject({ prepend: '⟦', append: '⟧', extend: 0.4 });
    expect(rtl).toMatchObject({ prepend: '⟦', append: '⟧', extend: 0.4, rightToLeft: true });
  });

  it('extracts from the app source into the app catalogue directory', () => {
    const catalog = linguiConfig.catalogs?.[0];
    expect(catalog?.path).toContain('apps/desktop/src/i18n/locales/{locale}/messages');
    expect(catalog?.include).toContain('<rootDir>/apps/desktop/src');
  });
});
