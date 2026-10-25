import { expect, test } from '@playwright/test';

import {
  DEFAULT_SETTINGS,
  applyPatch,
  normalizeInterfaceLanguage,
  normalizeSettings,
} from '../../apps/desktop/src/app/settings.js';
import type { InterfaceCatalogue } from '../../apps/desktop/src/i18n/catalogues.js';
import { languageChoices, type InterfaceLanguageStats } from '../../apps/desktop/src/i18n/picker.js';
import {
  ZIP_ENGINE,
  createEmptyManifest,
  createProjectState,
  exportProjectZip,
} from '../../packages/store/src/index.js';
import { localDayKey } from '../../packages/gateway/src/index.js';
import { localDayOfIso, targetProgress, todayLine, wordsWrittenOn } from '../../apps/desktop/src/app/session-progress.js';
import {
  dismissBannerForVisit,
  durabilitySentence,
  formatBytes,
  isBannerDismissedForVisit,
  readDurability,
  requestDurability,
  usageSentence,
  type StorageHost,
} from '../../apps/desktop/src/app/storage.js';

test.describe('settings (ui-modules §5.1)', () => {
  test('the Agent slice loads off, reads only a true as on, and a patch changes it alone', () => {
    const off = { loadEveryTool: false, defaultMode: 'ask', lockAuto: false, budget: {} };
    expect(DEFAULT_SETTINGS.agent).toEqual(off);
    // A record written before the slice existed has none, which reads as off.
    expect(normalizeSettings({ editor: {} }).agent).toEqual(off);
    expect(normalizeSettings({ agent: { loadEveryTool: 'yes' } }).agent).toEqual(off);
    expect(normalizeSettings({ agent: { loadEveryTool: true } }).agent).toEqual({ ...off, loadEveryTool: true });
    const on = applyPatch(DEFAULT_SETTINGS, { agent: { loadEveryTool: true } });
    expect(on.agent.loadEveryTool).toBe(true);
    expect(on.editor).toEqual(DEFAULT_SETTINGS.editor);
    expect(applyPatch(on, { editor: { autosaveDebounceMs: 1200 } }).agent.loadEveryTool).toBe(true);
  });

  test('the permission mode loads field by field: Ask unless the record names a mode, and never Auto while Auto is off (agent-harness §4)', () => {
    expect(normalizeSettings({ agent: { defaultMode: 'accept-edits' } }).agent.defaultMode).toBe('accept-edits');
    expect(normalizeSettings({ agent: { defaultMode: 'auto' } }).agent.defaultMode).toBe('auto');
    expect(normalizeSettings({ agent: { defaultMode: 'yolo' } }).agent.defaultMode).toBe('ask');
    expect(normalizeSettings({ agent: { defaultMode: 4 } }).agent.defaultMode).toBe('ask');
    expect(normalizeSettings({ agent: { defaultMode: 'auto', lockAuto: true } }).agent).toMatchObject({ defaultMode: 'ask', lockAuto: true });
    expect(normalizeSettings({ agent: { lockAuto: 'yes' } }).agent.lockAuto).toBe(false);
    // Locking Auto in a patch moves a stored Auto back to Ask, and the other fields stay.
    const auto = applyPatch(DEFAULT_SETTINGS, { agent: { defaultMode: 'auto', loadEveryTool: true } });
    expect(auto.agent).toMatchObject({ defaultMode: 'auto', loadEveryTool: true });
    expect(applyPatch(auto, { agent: { lockAuto: true } }).agent).toMatchObject({ defaultMode: 'ask', lockAuto: true, loadEveryTool: true });
  });

  test('the turn limits load clamped to their ranges, a bad one reads as unset, and a patch replaces the record', () => {
    const budget = { maxModelCalls: 12, maxActiveMinutes: 30, maxTokens: 50_000, maxWordsChanged: 2_000, maxDocuments: 10, maxSteps: 12, maxCostUsd: 0.5 };
    expect(normalizeSettings({ agent: { budget } }).agent.budget).toEqual(budget);
    expect(normalizeSettings({ agent: { budget: { maxTokens: 5, maxSteps: 1.5, maxDocuments: 'ten', maxCostUsd: -1, maxWordsChanged: 99_999_999, maxModelCalls: 0, maxActiveMinutes: 5_000 } } }).agent.budget).toEqual({});
    expect(normalizeSettings({ agent: { budget: 'all' } }).agent.budget).toEqual({});
    expect(applyPatch(normalizeSettings({ agent: { budget } }), { agent: { budget: { maxSteps: 3 } } }).agent.budget).toEqual({ maxSteps: 3 });
  });

  test('a missing or non-object record loads to the defaults, field by field', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('not a record')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ editor: 'wrong', retention: null }).editor.autosaveDebounceMs).toBe(800);
  });

  test('the autosave delay and the checkpoint limits are clamped, not trusted', () => {
    const low = normalizeSettings({ editor: { autosaveDebounceMs: 5 }, retention: { checkpointCap: 0, checkpointDays: 99_999 } });
    expect(low.editor.autosaveDebounceMs).toBe(100);
    expect(low.retention).toEqual({ checkpointCap: 1, checkpointDays: 3650 });
    expect(normalizeSettings({ editor: { autosaveDebounceMs: 9000 } }).editor.autosaveDebounceMs).toBe(5000);
    expect(normalizeSettings({ editor: { autosaveDebounceMs: Number.NaN } }).editor.autosaveDebounceMs).toBe(800);
  });

  test('the daily target is a whole number of words, and zero is no target', () => {
    expect(normalizeSettings({ session: { dailyTargetWords: 0 } }).session).toEqual({});
    expect(normalizeSettings({ session: { dailyTargetWords: 300.4 } }).session).toEqual({ dailyTargetWords: 300 });
    expect(normalizeSettings({ session: { dailyTargetWords: 9_000_000 } }).session).toEqual({ dailyTargetWords: 100_000 });
    expect(normalizeSettings({ session: { dailyTargetWords: 'lots' } }).session).toEqual({});
  });

  test('a patch changes only what it names, and a zero target clears the target', () => {
    const set = applyPatch(DEFAULT_SETTINGS, { session: { dailyTargetWords: 500 }, editor: { autosaveDebounceMs: 1200 } });
    expect(set.session.dailyTargetWords).toBe(500);
    expect(set.editor.autosaveDebounceMs).toBe(1200);
    expect(set.retention).toEqual(DEFAULT_SETTINGS.retention);
    const cleared = applyPatch(set, { session: { dailyTargetWords: 0 } });
    expect(cleared.session).toEqual({});
  });

  test('focus mode hides the rails unless the writer has turned that off, and a patch changes only the toggle', () => {
    expect(normalizeSettings(undefined).editor.focusModeHideRails).toBe(true);
    expect(normalizeSettings({ editor: { focusModeHideRails: 'yes' } }).editor.focusModeHideRails).toBe(true);
    expect(normalizeSettings({ editor: { focusModeHideRails: false } }).editor.focusModeHideRails).toBe(false);
    const shown = applyPatch(DEFAULT_SETTINGS, { editor: { focusModeHideRails: false } });
    expect(shown.editor.focusModeHideRails).toBe(false);
    expect(shown.editor.autosaveDebounceMs).toBe(800);
  });

  test('unknown keys are ignored, and a stored sample list keeps only ids', () => {
    const loaded = normalizeSettings({ theme: 'dark', sampleProjectIds: ['p_A', 3, '', 'p_B'], firstRun: { dismissed: 'yes' } });
    expect(loaded.sampleProjectIds).toEqual(['p_A', 'p_B']);
    expect(loaded.firstRun.dismissed).toBe(false);
    expect(Object.keys(loaded)).not.toContain('theme');
  });
});

test.describe('the writing session and its target (goals-progress §2.1)', () => {
  test('progress is the share of the target reached, and the line says what it is', () => {
    expect(targetProgress(0, undefined)).toEqual({ words: 0, target: undefined, fraction: 0, met: false });
    expect(targetProgress(412, 800).fraction).toBeCloseTo(0.515, 3);
    expect(targetProgress(900, 800)).toMatchObject({ fraction: 1, met: true });
    expect(todayLine(targetProgress(412, 800), 'en-US')).toBe('412 / 800 words today');
    expect(todayLine(targetProgress(1, undefined), 'en-US')).toBe('1 word today');
    expect(todayLine(targetProgress(2_000, undefined), 'en-US')).toBe('2,000 words today');
  });

  test('the status line groups its numbers the way the formatter locale does', () => {
    expect(todayLine(targetProgress(2_000, 5_000), 'de-DE')).toBe('2.000 / 5.000 words today');
    expect(todayLine(targetProgress(2_000, undefined), 'de-DE')).toBe('2.000 words today');
  });

  test('only sessions that ended on the device’s day count toward today', () => {
    const now = new Date(2026, 9, 8, 12).getTime();
    const today = localDayKey(now);
    const yesterday = localDayKey(now - 86_400_000);
    const at = (ms: number): string => new Date(ms).toISOString();
    const records = [
      { startedAt: at(now - 3_600_000), endedAt: at(now - 1_000), wordsWritten: 120, docIds: ['d'] },
      { startedAt: at(now - 90_000_000), endedAt: at(now - 86_400_000 - 1_000), wordsWritten: 900, docIds: ['d'] },
    ];
    expect(localDayOfIso(records[0]!.endedAt)).toBe(today);
    expect(localDayOfIso(records[1]!.endedAt)).toBe(yesterday);
    expect(wordsWrittenOn(records, today)).toBe(120);
    expect(localDayOfIso('not a date')).toBeNull();
  });
});

test.describe('browser storage (ui-modules §5.3)', () => {
  /** A storage manager that has not granted persistence, and counts the requests made of it. */
  function host(overrides: Partial<StorageHost> = {}): { storage: StorageHost; calls: { persist: number } } {
    const calls = { persist: 0 };
    const storage: StorageHost = {
      persisted: async () => false,
      persist: async () => {
        calls.persist += 1;
        return false;
      },
      estimate: async () => ({ usage: 5 * 1024 * 1024, quota: 2 * 1024 * 1024 * 1024 }),
      ...overrides,
    };
    return { storage, calls };
  }

  test('the sentence says what the browser granted, and says nothing it was not told', () => {
    expect(durabilitySentence({ persisted: true, usage: null, quota: null })).toBe('Browser storage: persistent ✓');
    expect(durabilitySentence({ persisted: false, usage: null, quota: null })).toBe(
      'Browser storage: persistence not granted — the browser may evict this project under storage pressure.',
    );
    expect(durabilitySentence({ persisted: null, usage: null, quota: null })).toContain('has not said');
    expect(usageSentence({ persisted: true, usage: 5 * 1024 * 1024, quota: 2 * 1024 * 1024 * 1024 })).toBe(
      'Using about 5.0 MB of about 2.0 GB this browser allows for this site.',
    );
    expect(usageSentence({ persisted: true, usage: null, quota: null })).toBeNull();
    expect(formatBytes(512)).toBe('1 KB');
  });

  test('the request is made only when the browser has not granted persistence, and the answer is read back', async () => {
    const asked = host();
    const answer = await requestDurability(asked.storage);
    expect(asked.calls.persist).toBe(1);
    expect(answer).toEqual({ persisted: false, usage: 5 * 1024 * 1024, quota: 2 * 1024 * 1024 * 1024 });

    const granted = host({ persisted: async () => true });
    await requestDurability(granted.storage);
    expect(granted.calls.persist).toBe(0);
  });

  test('a browser with no storage manager, or one that refuses, is an unknown answer and not an error', async () => {
    expect(await readDurability(null)).toEqual({ persisted: null, usage: null, quota: null });
    const refuses = host({
      persisted: async () => {
        throw new Error('no storage manager');
      },
    });
    expect(await requestDurability(refuses.storage)).toEqual({ persisted: null, usage: null, quota: null });
  });

  test('a dismissal lasts for the visit', () => {
    expect(isBannerDismissedForVisit()).toBe(false);
    dismissBannerForVisit();
    expect(isBannerDismissedForVisit()).toBe(true);
  });
});

/*
 * I4 / #194: the interface-language preference, the Appearance picker's D5 gates, and the proof that
 * the preference never enters a project bundle (i18n.md §3.1, §5.1, §9.2).
 */

test.describe('the interface-language preference', () => {
  test('loads as System when the record has no value, a wrong type or a non-tag', () => {
    expect(DEFAULT_SETTINGS.interfaceLanguage).toBe('system');
    expect(normalizeSettings({}).interfaceLanguage).toBe('system');
    expect(normalizeSettings({ interfaceLanguage: 7 }).interfaceLanguage).toBe('system');
    expect(normalizeSettings({ interfaceLanguage: '' }).interfaceLanguage).toBe('system');
    expect(normalizeSettings({ interfaceLanguage: 'not a language tag' }).interfaceLanguage).toBe('system');
  });

  test('keeps a stored catalogue tag, in canonical case, including a dev pseudo tag', () => {
    expect(normalizeInterfaceLanguage('en-XA')).toBe('en-XA');
    expect(normalizeInterfaceLanguage('EN-xa')).toBe('en-XA');
    expect(normalizeInterfaceLanguage('ar-XB')).toBe('ar-XB');
    // Whether this build ships the catalogue is the loader's question, not the record's.
    expect(normalizeInterfaceLanguage('de')).toBe('de');
  });

  test('a patch changes only the preference, and an invalid patch reads as System', () => {
    const current = normalizeSettings({ editor: { autosaveDebounceMs: 1200 } });
    const next = applyPatch(current, { interfaceLanguage: 'en-XA' });
    expect(next.interfaceLanguage).toBe('en-XA');
    expect(next.editor.autosaveDebounceMs).toBe(1200);
    expect(applyPatch(next, { interfaceLanguage: 'not a tag' }).interfaceLanguage).toBe('system');
  });
});

const REAL_AND_PSEUDO: readonly InterfaceCatalogue[] = [
  { id: 'en', tag: 'en', pseudo: false },
  { id: 'de', tag: 'de', pseudo: false },
  { id: 'fr', tag: 'fr', pseudo: false },
  { id: 'ja', tag: 'ja', pseudo: false },
  { id: 'pseudo-LOCALE', tag: 'en-XA', pseudo: true },
];

const LANGUAGE_STATS: InterfaceLanguageStats = {
  sourceLocale: 'en',
  locales: {
    de: { completion: 96 },
    fr: { completion: 72 },
    ja: { completion: 59 },
  },
};

function choices(options: { setting?: string; expose?: boolean } = {}) {
  return languageChoices({
    setting: options.setting ?? 'system',
    navigatorLanguages: ['en-US'],
    stats: LANGUAGE_STATS,
    exposeDeveloperLanguages: options.expose ?? false,
    catalogues: REAL_AND_PSEUDO,
  });
}

function settingsOf(list: ReturnType<typeof choices>): string[] {
  return list.map((entry) => entry.setting);
}

test.describe('the D5 picker gates', () => {
  test('lists ≥ 95 % plainly, 60–94 % as Preview, and hides below 60 %', () => {
    const list = choices();
    expect(settingsOf(list)).toEqual(['system', 'en', 'de', 'fr']);
    const de = list.find((entry) => entry.setting === 'de');
    const fr = list.find((entry) => entry.setting === 'fr');
    expect(de).toMatchObject({ completion: 96, preview: false });
    expect(fr).toMatchObject({ completion: 72, preview: true });
    expect(list.some((entry) => entry.setting === 'ja')).toBe(false);
  });

  test('the developer exposure reveals below-gate languages and the pseudo catalogues', () => {
    const list = choices({ expose: true });
    expect(settingsOf(list)).toEqual(['system', 'en', 'de', 'fr', 'ja', 'en-XA']);
    expect(list.find((entry) => entry.setting === 'ja')).toMatchObject({ completion: 59, preview: true });
    expect(list.find((entry) => entry.setting === 'en-XA')).toMatchObject({ pseudo: true, preview: false });
  });

  test('a below-gate language that is already selected stays visible, so the writer can switch away', () => {
    const list = choices({ setting: 'ja' });
    expect(settingsOf(list)).toContain('ja');
    expect(list.find((entry) => entry.setting === 'ja')).toMatchObject({ preview: true });
  });

  test('a selected pseudo catalogue stays visible without the exposure flag', () => {
    expect(settingsOf(choices({ setting: 'en-XA' }))).toContain('en-XA');
  });

  test('names each language in its own language', () => {
    const list = choices({ expose: true });
    const nameOf = (setting: string): string => list.find((entry) => entry.setting === setting)?.nativeName ?? '';
    expect(nameOf('en')).toBe('English');
    expect(nameOf('de')).toMatch(/Deutsch/);
    expect(nameOf('fr')).toMatch(/français/);
    expect(nameOf('ja')).toMatch(/日本語/);
    // The System row is named by the catalogue it resolves to on this machine (en-US → English).
    expect(nameOf('system')).toBe('English');
  });
});

test.describe('the project bundle and the interface preference', () => {
  const NOW = new Date('2026-10-25T00:00:00.000Z');

  test('carries no interface-language preference in any entry, and repeated exports of one state are byte-identical', async () => {
    const state = createProjectState(createEmptyManifest('Bundle Check', NOW));

    // The preference lives in app settings only; the state handed to the exporter has no field for it.
    // The every-entry scan below is the evidence, and the two exports prove the export is deterministic.
    const preference = normalizeSettings({ interfaceLanguage: 'en-XA' });
    expect(preference.interfaceLanguage).toBe('en-XA');

    const first = await exportProjectZip(state, { now: NOW });
    const second = await exportProjectZip(state, { now: NOW });
    expect(second.bytes).toEqual(first.bytes);

    const { unzipSync } = await ZIP_ENGINE.load();
    const entries = unzipSync(second.bytes);
    expect(Object.keys(entries)).toContain('caotang.json');
    for (const [path, bytes] of Object.entries(entries)) {
      const text = new TextDecoder().decode(bytes);
      expect(text, `${path} carries the interface preference`).not.toContain('interfaceLanguage');
      expect(text, `${path} carries the interface tag`).not.toContain('en-XA');
    }
  });
});
