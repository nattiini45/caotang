/**
 * The translation guardrails (I8 / #195). The real catalogues are green; each fixture proves one way
 * a check fires. The drift test runs the real `lingui extract` twice into temporary directories, so
 * it neither edits the tree nor trusts a stale generated file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parsePoFile } from '@lingui/format-po';
import { describe, expect, it } from 'vitest';

import {
  STATS_FILE,
  checkCompile,
  checkNoShippedFuzzy,
  checkDrift,
  checkPlaceholderParity,
  checkTranslatorHygiene,
  compareCatalogues,
  computeStats,
  extractToTemp,
  findConcatenations,
  findModelFacingImports,
  normalisePo,
  readCatalogues,
  readStats,
  renderStats,
  repositorySourceRoots,
  type Catalogue,
} from '../tools/check-translations.mjs';

const repoRoot = resolve(__dirname, '..');
const fixtures = resolve(repoRoot, 'test/fixtures/i18n-guards');

function catalogue(path: string): Catalogue {
  return { path, catalog: parsePoFile(readFileSync(path, 'utf8')) };
}

function one(path: string, locale = 'en'): Record<string, Catalogue> {
  return { [locale]: catalogue(path) };
}

describe('catalogue drift', () => {
  it('runs extraction twice, has no output difference, and matches every committed catalogue', () => {
    const first = extractToTemp(repoRoot);
    const second = extractToTemp(repoRoot);
    expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort());
    for (const locale of Object.keys(first)) {
      // The second run is the determinism control: same source, same catalogue bytes.
      expect(compareCatalogues(first[locale] ?? '', second[locale] ?? '')).toEqual([]);
    }
    expect(checkDrift(repoRoot, first)).toEqual([]);
  }, 120_000);

  it('ignores POT-Creation-Date, the header extraction rewrites on every run', () => {
    const committed = readFileSync(resolve(repoRoot, 'apps/desktop/src/i18n/locales/en/messages.po'), 'utf8');
    const earlier = committed.replace(/^"POT-Creation-Date:.*"$/m, '"POT-Creation-Date: 2020-01-01 00:00+0000\\n"');
    const later = committed.replace(/^"POT-Creation-Date:.*"$/m, '"POT-Creation-Date: 2030-12-31 23:59+0000\\n"');
    expect(earlier).not.toBe(later);
    expect(compareCatalogues(earlier, later)).toEqual([]);
    expect(normalisePo(earlier)).toBe(normalisePo(later));
  });

  it('fails a committed catalogue that has a message extraction no longer produces', () => {
    const problems = compareCatalogues(
      readFileSync(resolve(fixtures, 'translations/drift/committed.po'), 'utf8'),
      readFileSync(resolve(fixtures, 'translations/drift/generated.po'), 'utf8'),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Stale message');
  });
});

describe('whole-sentence ICU', () => {
  // A word that is itself a translated message cannot be inflected by the sentence around it, so the
  // reset day, the word count and the folder change kind must live inside the sentence's own ICU.
  const english = readFileSync(resolve(repoRoot, 'apps/desktop/src/i18n/locales/en/messages.po'), 'utf8');

  it('folds the footer reset words, the delete count and the folder change kind into the sentence', () => {
    expect(english).toMatch(/msgid "The week starts on \{weekday, select,/);
    expect(english).toMatch(/msgid "The month starts on the \{day, selectordinal,/);
    expect(english).toContain('This removes the item and its {words, plural,');
    expect(english).toContain('and {words, plural,');
    expect(english).toContain('msgid "{file}: {kind, select,');
    // The fragment forms are gone, not kept beside the folded ones.
    expect(english).not.toContain('msgid "The week starts on {day}."');
    expect(english).not.toContain('msgid "The month starts on the {day}."');
    expect(english).not.toContain('msgid "{file}: {change}"');
  });
});

describe('compilation and placeholder parity', () => {
  it('compiles the real catalogues and a missing translation does not fail', () => {
    const real = readCatalogues(resolve(repoRoot, 'apps/desktop/src/i18n/locales'));
    expect(checkCompile(real)).toEqual([]);
    expect(checkPlaceholderParity(real)).toEqual([]);
    expect(checkTranslatorHygiene(real)).toEqual([]);
    // The fixture has one missing German string; it is reported, never a failure.
    const good = readCatalogues(resolve(fixtures, 'translations/good'));
    expect(checkCompile(good)).toEqual([]);
    expect(checkPlaceholderParity(good)).toEqual([]);
    expect(computeStats(good).locales.de?.missing).toBe(1);
  });

  it('fails a malformed ICU message', () => {
    const problems = checkCompile(one(resolve(fixtures, 'translations/bad-icu/messages.po')));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ICU compile error');
  });

  it('fails a translation whose named placeholders differ from the source', () => {
    const bad = {
      ...one(resolve(fixtures, 'translations/bad-parity/en/messages.po'), 'en'),
      ...one(resolve(fixtures, 'translations/bad-parity/de/messages.po'), 'de'),
    };
    expect(checkPlaceholderParity(bad)).toEqual([expect.stringContaining('has arguments [nom], source has [name]')]);
  });

  it('reads the English msgstr behind an explicit id', () => {
    const en = parsePoFile('msgid "greeting.named"\nmsgstr "Hello {name}"\n');
    const de = parsePoFile('msgid "greeting.named"\nmsgstr "Hallo {name}"\n');
    expect(checkPlaceholderParity({ en: { path: 'en', catalog: en }, de: { path: 'de', catalog: de } })).toEqual([]);
    de.items[0]!.msgstr = 'Hallo {other}';
    expect(checkPlaceholderParity({ en: { path: 'en', catalog: en }, de: { path: 'de', catalog: de } })[0]).toContain('source has [name]');
  });
});

describe('fuzzy translations', () => {
  it('fails a fuzzy entry that has text, because Lingui would compile and ship it, and allows an emptied one', () => {
    const problems = checkNoShippedFuzzy(one(resolve(fixtures, 'translations/fuzzy-shipped/messages.po'), 'de'));
    expect(problems).toEqual([expect.stringContaining('"Save" is fuzzy but has text')]);
  });

  it('does not apply to the source language or the pseudo catalogues', () => {
    expect(checkNoShippedFuzzy(one(resolve(fixtures, 'translations/fuzzy-shipped/messages.po'), 'pseudo-LOCALE'))).toEqual([]);
  });
});

describe('translator hygiene', () => {
  it('fails a message with values and no translator comment', () => {
    expect(checkTranslatorHygiene(one(resolve(fixtures, 'translations/bad-comment/messages.po')))).toEqual([
      expect.stringContaining('has values but no translator comment'),
    ]);
  });

  it('fails a positional placeholder', () => {
    expect(checkTranslatorHygiene(one(resolve(fixtures, 'translations/bad-positional/messages.po')))).toEqual([
      expect.stringContaining('uses positional placeholder(s) 0'),
    ]);
  });

  it('finds a message built by concatenation, in both the tagged-template and call forms', () => {
    expect(findConcatenations([resolve(fixtures, 'translations')])).toEqual([
      expect.stringContaining('concatenation.ts:5'),
      expect.stringContaining('concatenation.ts:8'),
    ]);
    // The real tree has no message macros yet; the guard must not fire on ordinary `+`.
    expect(findConcatenations(repositorySourceRoots(repoRoot))).toEqual([]);
  }, 60_000);
});

describe('the model-facing marker', () => {
  /**
   * The fixture directory holds one static importer, one dynamic importer and one clean marked file.
   * Both tests assert the same three-file outcome, so the count lives here.
   */
  function modelFacingFixtureProblems(): string[] {
    const problems = findModelFacingImports([resolve(fixtures, 'model-facing')]);
    expect(problems).toHaveLength(2);
    return problems;
  }

  it('fails a marked file that imports the message runtime, statically or dynamically', () => {
    const problems = modelFacingFixtureProblems();
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('with-lingui.ts: a model-facing file imports @lingui/core/macro'),
        expect.stringContaining('dynamic-lingui.ts: a model-facing file imports @lingui/core'),
      ]),
    );
    expect(problems.some((problem) => problem.includes('without-lingui.ts'))).toBe(false);
  });

  it('finds none in the real tree; the marker alone is not a failure', () => {
    expect(findModelFacingImports(repositorySourceRoots(repoRoot))).toEqual([]);
    // The fixture directory holds both a failing and a clean marked file; only the importers are
    // reported, so the marker alone passes.
    modelFacingFixtureProblems();
  });
});

describe('statistics', () => {
  it('counts fuzzy and missing as untranslated, reports same-as-English, and omits obsolete entries', () => {
    const good = readCatalogues(resolve(fixtures, 'translations/good'));
    expect(computeStats(good)).toEqual({
      sourceLocale: 'en',
      locales: {
        de: { total: 5, translated: 3, untranslated: 2, missing: 1, fuzzy: 1, sameAsEnglish: 1, completion: 60 },
      },
    });
  });

  it('serialises deterministically and keeps only shippable target locales', () => {
    const good = readCatalogues(resolve(fixtures, 'translations/good'));
    const first = renderStats(computeStats(good));
    const second = renderStats(computeStats(good));
    expect(second).toBe(first);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(JSON.parse(first).locales)).toEqual(['de']); // `en` and the pseudo catalogues are not picker entries
  });

  it('matches the committed stats file', () => {
    const real = readCatalogues(resolve(repoRoot, 'apps/desktop/src/i18n/locales'));
    const committed = readStats(resolve(repoRoot, STATS_FILE));
    expect(committed).toBeDefined();
    expect(renderStats(committed ?? { sourceLocale: 'en', locales: {} })).toBe(renderStats(computeStats(real)));
  });

  it('fails a stale stats document, so a changed catalogue cannot leave the percentage behind', () => {
    const good = readCatalogues(resolve(fixtures, 'translations/good'));
    const stale = {
      sourceLocale: 'en',
      locales: {
        de: { total: 5, translated: 5, untranslated: 0, missing: 0, fuzzy: 0, sameAsEnglish: 1, completion: 100 },
      },
    };
    expect(renderStats(stale)).not.toBe(renderStats(computeStats(good)));
  });
});
