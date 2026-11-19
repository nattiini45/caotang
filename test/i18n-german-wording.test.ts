/**
 * German word counts and turn actions in the real catalogue (#573).
 *
 * A standalone count is nominative — "22 Wörter", "0 Wörter heute" — while a preposition takes the dative, so "bei # Wörtern"
 * and "von # Wörtern" stay as they are. Both live in the same catalogue, which is why this reads the compiled German messages
 * the writer sees instead of searching the file for a word. "Turn actions" names what the writer can do with one request, so
 * the labels say "Anfrage", not "Durchgang".
 *
 * The catalogue is the committed one; nothing here extracts or compiles the repository.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { i18n } from '@lingui/core';
import { parsePoFile } from '@lingui/format-po';
import { describe, expect, it } from 'vitest';

const catalog = parsePoFile(readFileSync(resolve(__dirname, '../apps/desktop/src/i18n/locales/de/messages.po'), 'utf8'));

/** Every translated message by its id, which is the English sentence the app wrote. */
const german: Record<string, string> = Object.fromEntries(
  catalog.items.flatMap((item) => {
    const form = Array.isArray(item.msgstr) ? item.msgstr[0] : item.msgstr;
    return form === undefined || form === null || form.trim() === '' ? [] : [[item.msgid, form]];
  }),
);

i18n.load('de', german);
i18n.activate('de');
expect(i18n._('Request log')).toBe('Anfrageprotokoll');

function germanOf(id: string, values: Record<string, unknown>): string {
  return i18n._(id, values);
}

describe('a German standalone word count is nominative (#573)', () => {
  it.each([
    { name: 'one word', id: '{count} {n, plural, one {word} other {words}}', values: { count: 1, n: 1 }, expected: '1 Wort' },
    { name: 'no words', id: '{count} {n, plural, one {word} other {words}}', values: { count: 0, n: 0 }, expected: '0 Wörter' },
    { name: 'many words', id: '{count} {n, plural, one {word} other {words}}', values: { count: 22, n: 22 }, expected: '22 Wörter' },
    {
      name: 'today, with no daily target yet',
      id: '{count} {words, plural, one {word} other {words}} today · set a daily target',
      values: { count: 0, words: 0, target: false },
      expected: '0 Wörter heute · tägliches Ziel setzen',
    },
    {
      name: 'today, many',
      id: '{count} {words, plural, one {word} other {words}} today',
      values: { count: 344, words: 344, target: true },
      expected: '344 Wörter heute',
    },
    {
      name: 'one day of the writing history',
      id: '{day}: {count} {words, plural, one {word} other {words}}',
      values: { day: '14. November', count: 1204, words: 1204, days: 1 },
      expected: '14. November: 1204 Wörter',
    },
    {
      name: 'a folder goal',
      id: '{degree, select, least {at least} most {at most} other {about}} {count} {target, plural, one {word} other {words}} on {title}',
      values: { degree: 'least', count: 500, target: 500, title: 'Kapitel 1', about: false, by: '', clock: '', day: '', perDay: '' },
      expected: 'mindestens 500 Wörter in Kapitel 1',
    },
  ])('reads $name', ({ id, values, expected }) => {
    expect(germanOf(id, values)).toBe(expected);
  });

  it.each([
    {
      name: 'a second read that differs',
      id: '{count, plural, one {The second read differs on # word: } other {The second read differs on # words: }}',
      values: { count: 3 },
      expected: 'Die zweite Lesung weicht bei 3 Wörtern ab: ',
    },
    {
      name: 'progress toward a goal',
      id: '{current} of {target, plural, one {# word} other {# words}} · {stateKey, select, open {in progress} met {met} exceeded {over the limit} overdue {past the deadline} missing {its folder is gone} other {in progress}}',
      values: { current: '1200', target: 2000, stateKey: 'open' },
      expected: '1200 von 2.000 Wörtern · in Bearbeitung',
    },
  ])('keeps the dative the preposition needs for $name', ({ id, values, expected }) => {
    expect(germanOf(id, values)).toBe(expected);
  });
});

describe('German turn actions name the writer’s request (#573)', () => {
  it('labels the menu and its toggle with the request, not a passage through something', () => {
    expect(germanOf('Turn actions', {})).toBe('Aktionen zu dieser Anfrage');
    expect(germanOf('Turn actions for “{intent}”', { intent: 'die Eröffnungsszene entwerfen' })).toBe(
      'Aktionen zur Anfrage „die Eröffnungsszene entwerfen“',
    );
    expect(Object.values(german).filter((text) => text.includes('Durchgangsaktion'))).toEqual([]);
  });
});

describe('German Codex copy names the policy the entry editor shows (#734)', () => {
  it('says Manuell, the include policy’s own label, instead of the English word', () => {
    const hint = germanOf('Attached to no items yet. A Manual entry is sent only in the items it is attached to.', {});
    expect(hint).toBe(
      'Noch an keine Elemente angehängt. Ein Eintrag mit der Richtlinie „Manuell“ wird nur in den Elementen gesendet, an die er angehängt ist.',
    );
    // The label the sentence points at is the one the policy control beside it carries.
    expect(germanOf('Manual', {})).toBe('Manuell');
    expect(hint).not.toContain('Manual');
  });
});
