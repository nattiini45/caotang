import { describe, expect, it } from 'vitest';

import { DEFAULT_FAIL_ON, FAIL_ON_VALUES, SCAN_EXIT, exitCodeFor, isFailOn } from '../src/index.js';

const none = { error: 0, warning: 0, info: 0 };

describe('exitCodeFor', () => {
  it('freezes 7 as the code for open findings at or above the threshold', () => {
    expect(SCAN_EXIT).toEqual({ Clean: 0, Findings: 7, Unread: 8 });
  });

  it.each([
    ['error', { ...none, error: 1 }, 7],
    ['error', { ...none, warning: 3, info: 2 }, 0],
    ['warning', { ...none, warning: 1 }, 7],
    ['warning', { ...none, error: 1 }, 7],
    ['warning', { ...none, info: 4 }, 0],
    ['info', { ...none, info: 1 }, 7],
    ['info', none, 0],
    ['never', { error: 5, warning: 5, info: 5 }, 0],
  ] as const)('--fail-on %s with %j is %i', (failOn, counts, code) => {
    expect(exitCodeFor(counts, failOn)).toBe(code);
  });

  it('exits 8 for an unread file when no finding fails the run, and 7 when one does', () => {
    expect(exitCodeFor(none, 'error', 1)).toBe(8);
    expect(exitCodeFor({ ...none, warning: 1 }, 'error', 2)).toBe(8);
    expect(exitCodeFor({ ...none, error: 1 }, 'error', 1)).toBe(7);
    expect(exitCodeFor(none, 'error', 0)).toBe(0);
  });

  it('keeps --fail-on never as a run that only reports, unread files included', () => {
    expect(exitCodeFor(none, 'never', 3)).toBe(0);
  });

  it('fails on an error by default', () => {
    expect(DEFAULT_FAIL_ON).toBe('error');
  });

  it('knows the four --fail-on values and nothing else', () => {
    expect(FAIL_ON_VALUES).toEqual(['error', 'warning', 'info', 'never']);
    expect(isFailOn('warning')).toBe(true);
    expect(isFailOn('warn')).toBe(false);
  });
});
