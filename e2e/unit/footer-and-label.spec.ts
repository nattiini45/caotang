import { expect, test } from '@playwright/test';

import { formatDay, formatRemaining, goalSentence, goalStateWords, SPRINT_CHOICES } from '../../apps/desktop/src/app/footer-model.js';
import { providerLabel } from '../../apps/desktop/src/app/provider-label.js';
import { SPRINT_MAX_MINUTES, SPRINT_MIN_MINUTES } from '../../packages/furniture/src/index.js';

test.describe('the provider label (polish: the demo profile is marked once)', () => {
  test('the built-in profile already says it is a demo, so the panel adds no second mark', () => {
    expect(providerLabel('Demo (no key)', true)).toBe('Demo (no key)');
    expect(providerLabel('Demo, renamed', true)).toBe('Demo, renamed');
  });

  test('a demo profile whose name does not say so is marked once, and a real provider is never marked', () => {
    expect(providerLabel('Trial run', true)).toBe('Trial run (demo)');
    expect(providerLabel('Fake endpoint', false)).toBe('Fake endpoint');
  });
});

test.describe('the binder footer words (goals-progress §2.2, sprint timer)', () => {
  test('a goal reads as a sentence with its comparator, its place and its deadline', () => {
    // The formatter locale is passed in; the locale decision itself is the app's accessor (i18n.md §4.1, D3).
    expect(goalSentence({ comparator: 'at-least', target: 12_000, deadline: '2026-10-31' }, 'The Manuscript', 'en-GB')).toBe(
      'at least 12,000 words on \u2068The Manuscript\u2069 by 31 Oct 2026',
    );
    expect(goalSentence({ comparator: 'at-most', target: 2_000 }, 'Prologue', 'en-GB')).toBe(
      'at most 2,000 words on \u2068Prologue\u2069',
    );
    expect(goalSentence({ comparator: 'about', target: 900 }, 'Chapter 1', 'en-GB')).toBe(
      'about 900 words on \u2068Chapter 1\u2069',
    );
  });

  test('the same sentence under the formatter locale’s own grouping and date order', () => {
    // This is the deliberate change: a US-English system now reads its own date order and grouping (D3), where
    // the footer used to pin en-GB dates and en-US numbers whatever the system said.
    expect(goalSentence({ comparator: 'at-least', target: 12_000, deadline: '2026-10-31' }, 'The Manuscript', 'en-US')).toBe(
      'at least 12,000 words on \u2068The Manuscript\u2069 by Oct 31, 2026',
    );
    expect(goalSentence({ comparator: 'at-least', target: 12_000, deadline: '2026-10-31' }, 'The Manuscript', 'de-DE')).toBe(
      'at least 12.000 words on \u2068The Manuscript\u2069 by 31. Okt. 2026',
    );
  });

  test('a day reads as a short date in the formatter locale, and an unreadable day is shown as it is', () => {
    expect(formatDay('2026-01-05', 'en-GB')).toBe('5 Jan 2026');
    expect(formatDay('2026-01-05', 'en-US')).toBe('Jan 5, 2026');
    expect(formatDay('2026-01-05', 'de-DE')).toBe('5. Jan. 2026');
    expect(formatDay('soon', 'en-US')).toBe('soon');
  });

  test('each goal state has its words', () => {
    expect(goalStateWords('open')).toBe('in progress');
    expect(goalStateWords('met')).toBe('met');
    expect(goalStateWords('exceeded')).toBe('over the limit');
    expect(goalStateWords('overdue')).toBe('past the deadline');
    expect(goalStateWords('target-missing')).toBe('its folder is gone');
  });

  test('the time left reads as minutes and seconds, rounded up, and never below zero', () => {
    expect(formatRemaining(90_000)).toBe('1:30 left');
    expect(formatRemaining(999)).toBe('0:01 left');
    expect(formatRemaining(0)).toBe('0:00 left');
    expect(formatRemaining(-5)).toBe('0:00 left');
  });

  test('the sprint picker offers only lengths the timer accepts', () => {
    expect(SPRINT_CHOICES).toContain(25);
    expect(SPRINT_CHOICES.every((minutes) => minutes >= SPRINT_MIN_MINUTES && minutes <= SPRINT_MAX_MINUTES)).toBe(true);
  });
});
