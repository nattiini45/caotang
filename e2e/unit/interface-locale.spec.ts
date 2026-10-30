import { expect, test } from '@playwright/test';

import type { CodexEntry } from '../../packages/store/src/index.js';
import { groupByType } from '../../apps/desktop/src/app/codex-model.js';
import { povCandidates } from '../../apps/desktop/src/app/findings-model.js';
import { characterCandidates } from '../../apps/desktop/src/app/knowledge-model.js';
import {
  DATE_AND_TIME,
  TIME_OF_DAY,
  appFormatLocale,
  formatCount,
  formatDateTime,
  formatUsd,
  interfaceLocale,
  namesCollator,
  pinFormatLocale,
  setInterfaceLanguage,
} from '../../apps/desktop/src/i18n/locale.js';

function entry(id: string, name: string, type = 'character'): CodexEntry {
  return { id, name, type, aliases: [], attachments: [], fields: {} } as unknown as CodexEntry;
}

test.describe('the interface and formatter locales (i18n.md §3.1, §4.1, D3)', () => {
  test.afterEach(() => {
    pinFormatLocale(undefined);
    setInterfaceLanguage('system');
  });

  test('the interface is English on every system while only English ships', () => {
    expect(interfaceLocale()).toBe('en');
    setInterfaceLanguage('de');
    expect(interfaceLocale()).toBe('en');
  });

  test('the formatter locale is English with the system region when the system is English', () => {
    const system = (globalThis as { navigator?: { language?: string } }).navigator?.language ?? '';
    const tag = appFormatLocale();
    expect(tag.startsWith('en')).toBe(true);
    if (system.startsWith('en-')) expect(tag).toBe(`en-${new Intl.Locale(system).region}`);
  });

  test('en-US output is what the pinned call sites gave', () => {
    pinFormatLocale('en-US');
    for (const n of [0, 1, 999, 12_000, 1_234_567]) expect(formatCount(n)).toBe(n.toLocaleString('en-US'));
    for (const n of [3, 0.0025, 0.000125]) expect(formatUsd(n)).toBe(`$${n.toLocaleString('en-US', { maximumFractionDigits: 6 })}`);
    const at = new Date(2026, 9, 31, 18, 5, 9);
    expect(formatDateTime(at, DATE_AND_TIME)).toBe(at.toLocaleString('en-US'));
    expect(formatDateTime(at, TIME_OF_DAY)).toBe(at.toLocaleTimeString('en-US'));
  });

  test('a British system keeps its day-first dates and gets the same grouping', () => {
    pinFormatLocale('en-GB');
    expect(formatCount(1_234_567)).toBe('1,234,567');
    expect(formatDateTime(new Date(2026, 9, 31), { day: 'numeric', month: 'short', year: 'numeric' })).toBe('31 Oct 2026');
    expect(formatUsd(3)).toBe('US$3');
  });

  test('an invalid date reads as Date#toLocaleString has it, rather than throwing', () => {
    expect(formatDateTime(new Date(Number.NaN), DATE_AND_TIME)).toBe('Invalid Date');
  });
});

test.describe("the writer's own names sort by the project language (D9, i18n.md §4.3)", () => {
  const names = [entry('c_3', 'Åsa'), entry('c_1', 'Zelda'), entry('c_2', 'anna'), entry('c_4', 'Chapter 10', 'place'), entry('c_5', 'Chapter 9', 'place')];

  test('a Swedish project puts Å after Z, an English one beside A', () => {
    expect(characterCandidates(names, 'sv').map((e) => e.name)).toEqual(['anna', 'Zelda', 'Åsa']);
    expect(characterCandidates(names, 'en').map((e) => e.name)).toEqual(['anna', 'Åsa', 'Zelda']);
    expect(povCandidates(names, 'sv').map((e) => e.name)).toEqual(['anna', 'Zelda', 'Åsa', 'Chapter 9', 'Chapter 10']);
  });

  test('numbers in names compare by value, and a project with no language sorts by the interface', () => {
    const places = groupByType(names, undefined).find((group) => group.type === 'place');
    expect(places?.entries.map((e) => e.name)).toEqual(['Chapter 9', 'Chapter 10']);
    expect(namesCollator(undefined).resolvedOptions().locale).toBe('en');
    expect(namesCollator('  ').resolvedOptions().locale).toBe('en');
    expect(namesCollator('sv').resolvedOptions().locale).toBe('sv');
  });
});
