/**
 * The small pure i18n helpers (i18n.md §3.1, §5.3, D5): the catalogue table's lookups, the picker's listed-languages hysteresis
 * on device storage, and the isolation marks an accessible name drops.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { accessibleText } from '../src/i18n/accessible-text.js';
import { catalogueTags, interfaceCatalogueForId, interfaceCatalogueForTag, pseudoCatalogues, sameLanguageSetting } from '../src/i18n/catalogues.js';
import { readListedLanguages, recordListedLanguages } from '../src/i18n/listed-languages.js';

describe('the catalogue table', () => {
  it('leaves the pseudo catalogues out of a production build and lists them in dev, English first', () => {
    expect(catalogueTags(false)).toEqual(['en', 'de']);
    expect(catalogueTags(true)).toEqual(['en', 'de', 'en-XA', 'ar-XB']);
    expect(pseudoCatalogues().map((entry) => entry.id)).toEqual(['pseudo-LOCALE', 'pseudo-RTL']);
  });

  it('compares settings without regard to case', () => {
    expect(sameLanguageSetting('en-GB', 'EN-gb')).toBe(true);
    expect(sameLanguageSetting('system', 'System')).toBe(true);
    expect(sameLanguageSetting('de', 'en')).toBe(false);
  });

  it('finds a catalogue by tag and by id, which are not the same thing for a pseudo catalogue', () => {
    expect(interfaceCatalogueForTag('de')).toEqual({ id: 'de', tag: 'de', pseudo: false });
    expect(interfaceCatalogueForTag('ar-XB')?.id).toBe('pseudo-RTL');
    expect(interfaceCatalogueForTag('pseudo-RTL')).toBeUndefined();
    expect(interfaceCatalogueForId('pseudo-LOCALE')?.tag).toBe('en-XA');
    expect(interfaceCatalogueForId('fr')).toBeUndefined();
  });
});

function memoryStorage(initial?: string): Storage {
  const values = new Map<string, string>(initial === undefined ? [] : [['caotang.listedLanguages', initial]]);
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

describe('the listed-languages hysteresis', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('remembers what was listed, keeps earlier tags and gives them sorted without repeats', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(readListedLanguages()).toEqual([]);
    recordListedLanguages(['en', 'de']);
    recordListedLanguages(['fr', 'de']);
    expect(readListedLanguages()).toEqual(['de', 'en', 'fr']);
  });

  it('reads a malformed stored value as nothing listed, and drops entries that are not tags', () => {
    for (const stored of ['not json', '42', 'null', '{"de":true}']) {
      vi.stubGlobal('localStorage', memoryStorage(stored));
      expect(readListedLanguages()).toEqual([]);
    }
    vi.stubGlobal('localStorage', memoryStorage('[1, "de", null, "en"]'));
    expect(readListedLanguages()).toEqual(['de', 'en']);
  });

  it('lists nothing and records nothing when the browser keeps no storage or refuses a write', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readListedLanguages()).toEqual([]);
    expect(() => recordListedLanguages(['de'])).not.toThrow();
    const full = memoryStorage();
    full.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    vi.stubGlobal('localStorage', full);
    expect(() => recordListedLanguages(['de'])).not.toThrow();
    expect(readListedLanguages()).toEqual([]);
  });
});

describe('accessibleText', () => {
  it('drops every isolation mark and leaves other text as it is', () => {
    expect(accessibleText('\u2068Hello\u2069')).toBe('Hello');
    expect(accessibleText('\u2066a\u2069 \u2067ب\u2069')).toBe('a ب');
    expect(accessibleText('Plain, with \u200f an RLM')).toBe('Plain, with \u200f an RLM');
    expect(accessibleText('')).toBe('');
  });
});
