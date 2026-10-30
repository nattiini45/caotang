import { expect, test } from '@playwright/test';

import { formatDay, formatRemaining, goalSentence, goalStateWords, SPRINT_CHOICES } from '../../apps/desktop/src/app/footer-model.js';
import { providerLabel } from '../../apps/desktop/src/app/provider-label.js';
import { SPRINT_MAX_MINUTES, SPRINT_MIN_MINUTES } from '../../packages/furniture/src/index.js';
import { pinFormatLocale } from '../../apps/desktop/src/i18n/locale.js';

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
  // The dates below are British: the formatter locale (D3) is pinned to en-GB, so they read the same on every machine.
  test.beforeAll(() => pinFormatLocale('en-GB'));
  test.afterAll(() => pinFormatLocale(undefined));

  test('a goal reads as a sentence with its comparator, its place and its deadline', () => {
    expect(goalSentence({ comparator: 'at-least', target: 12_000, deadline: '2026-10-31' }, 'The Manuscript')).toBe(
      'at least 12,000 words on The Manuscript by 31 Oct 2026',
    );
    expect(goalSentence({ comparator: 'at-most', target: 2_000 }, 'Prologue')).toBe('at most 2,000 words on Prologue');
    expect(goalSentence({ comparator: 'about', target: 900 }, 'Chapter 1')).toBe('about 900 words on Chapter 1');
  });

  test('a day reads as a short date, and an unreadable day is shown as it is', () => {
    expect(formatDay('2026-01-05')).toBe('5 Jan 2026');
    expect(formatDay('soon')).toBe('soon');
  });

  test('a day and a count follow the formatter locale: an American system reads the month first (D3, i18n.md §4.1)', () => {
    pinFormatLocale('en-US');
    try {
      expect(formatDay('2026-01-05')).toBe('Jan 5, 2026');
      expect(goalSentence({ comparator: 'at-least', target: 12_000, deadline: '2026-10-31' }, 'The Manuscript')).toBe(
        'at least 12,000 words on The Manuscript by Oct 31, 2026',
      );
    } finally {
      pinFormatLocale('en-GB');
    }
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
