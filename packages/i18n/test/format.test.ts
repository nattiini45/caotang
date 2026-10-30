import { describe, expect, it } from 'vitest';

import {
  FSI,
  PDI,
  collatorFor,
  dateTimeFormat,
  displayNames,
  formatNumber,
  isolate,
  listFormat,
  numberFormat,
  pluralRules,
  relativeTimeFormat,
  type MessageRef,
} from '../src/index.js';

const DAY = new Date(2026, 9, 31);

describe('numberFormat (i18n.md §4.2): counts, tokens and words', () => {
  it('groups en-US exactly as the pinned call sites did', () => {
    for (const n of [0, 1, 999, 1_000, 12_000, 1_234_567, 32_767]) {
      expect(formatNumber(n, 'en-US')).toBe(n.toLocaleString('en-US'));
    }
    expect(formatNumber(1_234_567, 'en-US')).toBe('1,234,567');
  });

  it('groups en-GB the same way, and other locales their own way', () => {
    expect(formatNumber(1_234_567, 'en-GB')).toBe('1,234,567');
    expect(formatNumber(1_234_567, 'de-DE')).toBe('1.234.567');
  });

  it('formats a provider price in US dollars with up to six decimals and no padding', () => {
    const usd = { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 6 } as const;
    // The same text `$${n.toLocaleString('en-US', { maximumFractionDigits: 6 })}` gave in Settings.
    for (const n of [3, 0.0025, 0.000125, 1.5, 1_000]) expect(numberFormat('en-US', usd).format(n)).toBe(`$${n.toLocaleString('en-US', { maximumFractionDigits: 6 })}`);
    expect(numberFormat('en-GB', usd).format(3)).toBe('US$3');
  });

  it('builds one formatter per locale and option set, whatever order the options were written in', () => {
    expect(numberFormat('en-US')).toBe(numberFormat('en-US'));
    expect(numberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 })).toBe(
      numberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }),
    );
    expect(numberFormat('en-US')).not.toBe(numberFormat('en-GB'));
  });

  it('falls back to the source locale for a tag the engine refuses', () => {
    expect(formatNumber(1_234, 'not a tag')).toBe('1,234');
  });
});

describe('dateTimeFormat (i18n.md §4.2): dates and times', () => {
  const short = { day: 'numeric', month: 'short', year: 'numeric' } as const;

  it('writes the footer date in the day order of the locale', () => {
    expect(dateTimeFormat('en-GB', short).format(DAY)).toBe('31 Oct 2026');
    expect(dateTimeFormat('en-US', short).format(DAY)).toBe('Oct 31, 2026');
    // The text the pinned call gave, so British writers see no change.
    expect(dateTimeFormat('en-GB', short).format(DAY)).toBe(DAY.toLocaleDateString('en-GB', short));
  });

  it('is cached like the other formatters', () => {
    expect(dateTimeFormat('en-GB', short)).toBe(dateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: 'numeric' }));
  });
});

describe('relativeTimeFormat, listFormat, pluralRules, displayNames (i18n.md §4.2)', () => {
  it('says "yesterday" and "in 3 minutes"', () => {
    expect(relativeTimeFormat('en-US').format(-1, 'day')).toBe('yesterday');
    expect(relativeTimeFormat('en-US').format(3, 'minute')).toBe('in 3 minutes');
  });

  it('joins a list with the locale conjunction', () => {
    expect(listFormat('en-US').format(['Chapter 1', 'Chapter 2', 'Chapter 3'])).toBe('Chapter 1, Chapter 2, and Chapter 3');
    expect(listFormat('en-GB').format(['Chapter 1', 'Chapter 2', 'Chapter 3'])).toBe('Chapter 1, Chapter 2 and Chapter 3');
    expect(listFormat('de-DE').format(['A', 'B'])).toBe('A und B');
  });

  it("gives CLDR's plural categories, not one versus many", () => {
    expect(pluralRules('en').select(1)).toBe('one');
    expect(pluralRules('en').select(2)).toBe('other');
    expect(pluralRules('ar').select(2)).toBe('two');
    expect(pluralRules('pl').select(5)).toBe('many');
  });

  it('names a language in its own language', () => {
    expect(displayNames('de', { type: 'language' }).of('de')).toBe('Deutsch');
    expect(displayNames('en', { type: 'language' }).of('de')).toBe('German');
  });
});

describe('collatorFor (D9, i18n.md §4.3): the writer\'s own names', () => {
  it('ignores case and accents, and orders numbers by value', () => {
    const names = collatorFor('en');
    expect(names.compare('anna', 'Anna')).toBe(0);
    expect(names.compare('Éowyn', 'Eowyn')).toBe(0);
    expect(['Chapter 10', 'Chapter 9', 'chapter 1'].sort(names.compare)).toEqual(['chapter 1', 'Chapter 9', 'Chapter 10']);
  });

  it('sorts by the project language: a Swedish novel puts å after z', () => {
    expect(['Åsa', 'Zelda', 'Anna'].sort(collatorFor('sv').compare)).toEqual(['Anna', 'Zelda', 'Åsa']);
    expect(['Åsa', 'Zelda', 'Anna'].sort(collatorFor('en').compare)).toEqual(['Anna', 'Åsa', 'Zelda']);
  });

  it('takes other options, and falls back to the source locale for a tag it cannot read', () => {
    expect(collatorFor('en', { sensitivity: 'variant' }).compare('a', 'A')).not.toBe(0);
    expect(['b', 'a'].sort(collatorFor('not a tag').compare)).toEqual(['a', 'b']);
  });
});

describe('isolate and MessageRef (i18n.md §3.2, §5.3)', () => {
  it('wraps text in FSI…PDI', () => {
    expect(FSI).toBe('\u2068');
    expect(PDI).toBe('\u2069');
    expect(isolate('שלום')).toBe('\u2068שלום\u2069');
    expect(`Delete ${isolate('Chapter 1')}?`).toBe('Delete \u2068Chapter 1\u2069?');
  });

  it('types a package message as an id, its values and its English', () => {
    const ref: MessageRef = { id: 'coherence.timeline.orderDrift', values: { lateTitle: 'B', lateDay: 3 }, message: '{lateTitle} is on day {lateDay}' };
    expect(ref.message).toContain('{lateTitle}');
  });
});
