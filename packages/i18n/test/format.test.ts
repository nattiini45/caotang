/**
 * The cached Intl factories — [i18n.md §4.2, §4.3](docs/architecture/i18n.md), decisions D3 and D9.
 *
 * Every factory is memoised by locale (and by the options it was called with), so a panel that formats
 * on every render builds no formatter after the first.
 */
import { describe, expect, it } from 'vitest';

import {
  collatorFor,
  currencyFormat,
  dateFormat,
  displayNames,
  listFormat,
  numberFormat,
  relativeTimeFormat,
  timeFormat,
} from '../src/index.js';

describe('the factories are cached per locale and options (§4.2)', () => {
  it('returns the same instance for the same locale and the same options', () => {
    expect(numberFormat('de-DE')).toBe(numberFormat('de-DE'));
    expect(dateFormat('en-GB', { dateStyle: 'medium' })).toBe(dateFormat('en-GB', { dateStyle: 'medium' }));
    expect(currencyFormat('en-US')).toBe(currencyFormat('en-US'));
    expect(listFormat('en-US')).toBe(listFormat('en-US'));
    expect(relativeTimeFormat('de-DE')).toBe(relativeTimeFormat('de-DE'));
    expect(collatorFor('sv')).toBe(collatorFor('sv'));
    expect(displayNames('de')).toBe(displayNames('de'));
  });

  it('keeps a different instance for a different locale or a different option record', () => {
    expect(numberFormat('de-DE')).not.toBe(numberFormat('en-US'));
    expect(dateFormat('en-GB', { dateStyle: 'medium' })).not.toBe(dateFormat('en-GB', { dateStyle: 'long' }));
    expect(displayNames('de', 'language')).not.toBe(displayNames('de', 'region'));
  });

  it('memoises an option record by its content, not by the order the keys were written in', () => {
    const written = dateFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const reordered = dateFormat('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
    expect(reordered).toBe(written);
  });
});

describe('numbers and prices (§4.2)', () => {
  it('groups thousands the way the formatter locale does', () => {
    expect(numberFormat('en-US').format(1_234_567)).toBe('1,234,567');
    expect(numberFormat('de-DE').format(1_234_567)).toBe('1.234.567');
    expect(numberFormat('de-DE').format(1200)).toBe('1.200');
  });

  it('prices provider USD with up to six fraction digits, and writes no trailing zeros the value does not have', () => {
    const us = currencyFormat('en-US');
    expect(us.format(0.0015)).toBe('$0.0015');
    expect(us.format(0.002)).toBe('$0.002');
    expect(us.format(1.5)).toBe('$1.5');
    expect(us.format(3)).toBe('$3');
    expect(us.resolvedOptions()).toMatchObject({ style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
  });

  it('names USD the way the locale does, rather than assuming a bare dollar sign', () => {
    // en-GB disambiguates the dollar; de-DE puts the amount first. Both are USD, not the local currency.
    expect(currencyFormat('en-GB').format(0.002)).toBe('US$0.002');
    expect(currencyFormat('de-DE').resolvedOptions().currency).toBe('USD');
  });
});

describe('dates and times (§4.2)', () => {
  const local = (year: number, month: number, day: number, hour = 9, minute = 0, second = 0): Date =>
    new Date(year, month - 1, day, hour, minute, second);

  it('reads a day as a short date in the formatter locale', () => {
    const options = { day: 'numeric', month: 'short', year: 'numeric' } as const;
    expect(dateFormat('en-GB', options).format(local(2026, 10, 31))).toBe('31 Oct 2026');
    expect(dateFormat('en-US', options).format(local(2026, 10, 31))).toBe('Oct 31, 2026');
    expect(dateFormat('de-DE', options).format(local(2026, 10, 31))).toBe('31. Okt. 2026');
  });

  it('reads a stamp as a medium day and a short time', () => {
    expect(dateFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(local(2026, 10, 8))).toBe('Oct 8, 2026, 9:00 AM');
    expect(dateFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(local(2026, 10, 8))).toBe('08.10.2026, 09:00');
  });

  it('reads a clock time with a day period only where the locale uses one', () => {
    expect(timeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(local(2026, 10, 31, 3, 4, 5))).toBe('03:04:05 AM');
    expect(timeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(local(2026, 10, 31, 3, 4, 5))).toBe('03:04:05');
  });

  it('gives a bare clock time all three fields, as `toLocaleTimeString` does', () => {
    expect(timeFormat('en-US').format(local(2026, 10, 31, 3, 4, 5))).toBe('3:04:05 AM');
    expect(timeFormat('de-DE').format(local(2026, 10, 31, 3, 4, 5))).toBe('03:04:05');
  });
});

describe('relative time and lists (§4.2)', () => {
  it('says "yesterday" rather than "-1 day"', () => {
    const source = relativeTimeFormat('en-US');
    expect(source.format(-1, 'day')).toBe('yesterday');
    expect(source.format(3, 'minute')).toBe('in 3 minutes');
    expect(relativeTimeFormat('de-DE').format(-1, 'day')).toBe('gestern');
  });

  it('joins a list with the locale’s conjunction', () => {
    expect(listFormat('en-US').format(['Chapter 1', 'Chapter 2', 'Chapter 3'])).toBe('Chapter 1, Chapter 2, and Chapter 3');
    expect(listFormat('de-DE').format(['Kapitel 1', 'Kapitel 2'])).toBe('Kapitel 1 und Kapitel 2');
  });

  it('names a language in the locale it is named for, for the picker', () => {
    expect(displayNames('de').of('en')).toBe('Englisch');
    expect(displayNames('en').of('de')).toBe('German');
    expect(displayNames('de', 'region').of('DE')).toBe('Deutschland');
  });
});

describe('sorting (§4.3)', () => {
  it('sorts numbers numerically, so Chapter 10 follows Chapter 9', () => {
    expect(['Chapter 10', 'Chapter 9', 'Chapter 1'].sort((a, b) => collatorFor('en').compare(a, b))).toEqual([
      'Chapter 1',
      'Chapter 9',
      'Chapter 10',
    ]);
  });

  it('ignores case and accents at the base sensitivity it is given', () => {
    expect(collatorFor('en').compare('a', 'A')).toBe(0);
    expect(collatorFor('en').compare('Anna', 'anna')).toBe(0);
  });

  it('sorts writer content by the language it is written in, which is the whole point of passing a tag', () => {
    // D9: a Swedish novel sorts å after z under an English interface.
    const names = ['öre', 'zebra', 'åland', 'äpple'];
    expect([...names].sort((a, b) => collatorFor('sv').compare(a, b))).toEqual(['zebra', 'åland', 'äpple', 'öre']);
    expect([...names].sort((a, b) => collatorFor('en').compare(a, b))).toEqual(['åland', 'äpple', 'öre', 'zebra']);
  });
});
