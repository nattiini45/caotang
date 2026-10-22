/**
 * The reading of the sessions log waits for its window (session-progress.ts).
 *
 * The log only moves when a sitting is recorded, which is not a keystroke. Reading every project's
 * log on every change of the session is what this waits out: a burst of changes costs one reading,
 * not one per change.
 */

import { expect, test } from '@playwright/test';

import { nextReadDelay, SESSIONS_RELOAD_MS } from '../../apps/desktop/src/app/session-progress.js';

test.describe('the reading of the sessions log', () => {
  test('the first reading runs at once', () => {
    expect(nextReadDelay(null, 1_000)).toBe(0);
  });

  test('a change inside the window waits for it', () => {
    expect(nextReadDelay(1_000, 1_000 + SESSIONS_RELOAD_MS - 1)).toBe(1);
  });

  test('a change after the window reads at once', () => {
    expect(nextReadDelay(1_000, 1_000 + SESSIONS_RELOAD_MS)).toBe(0);
  });

  test('a change long after the reading reads at once', () => {
    expect(nextReadDelay(1_000, 60_000)).toBe(0);
  });

  test('the window is a number the app names', () => {
    expect(SESSIONS_RELOAD_MS).toBeGreaterThan(0);
  });
});
