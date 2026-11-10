import { beforeEach, expect, it, vi } from 'vitest';

import { type AppDb } from '../src/app/app-db.js';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/app/settings.js';
import { SettingsStore } from '../src/app/services.js';
import { activateEnglish } from '../src/i18n/runtime.js';

beforeEach(activateEnglish);

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function database(put: AppDb['put']): AppDb {
  return { put, get: async () => undefined, list: async () => [], delete: async () => {}, close: () => {} };
}

it('publishes the dismissal only after the delayed write commits', async () => {
  const gate = deferred();
  let kept: AppSettings | undefined;
  const db = database(async (_key, value) => { await gate.promise; kept = structuredClone(value as AppSettings); });
  const store = new SettingsStore(db, DEFAULT_SETTINGS);
  const listener = vi.fn();
  store.subscribe(listener);
  const result = store.update({ firstRun: { dismissed: true } }, { publishAfterSave: true });
  await Promise.resolve();
  expect(store.current().firstRun.dismissed).toBe(false);
  expect(listener).not.toHaveBeenCalled();
  expect(kept).toBeUndefined();
  gate.resolve();
  expect(await result).toBeNull();
  expect(store.current().firstRun.dismissed).toBe(true);
  expect(listener).toHaveBeenCalledOnce();
  expect(new SettingsStore(db, kept!).current().firstRun.dismissed).toBe(true);
});

it('keeps a refused dismissal visible and allows a successful retry', async () => {
  const gate = deferred();
  const put = vi.fn<AppDb['put']>().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
  const store = new SettingsStore(database(put), DEFAULT_SETTINGS);
  const listener = vi.fn();
  store.subscribe(listener);
  const result = store.update({ firstRun: { dismissed: true } }, { publishAfterSave: true });
  gate.reject(new Error('The disk is full.'));
  expect(await result).toContain('The disk is full.');
  expect(store.current().firstRun.dismissed).toBe(false);
  expect(listener).not.toHaveBeenCalled();
  expect(await store.update({ firstRun: { dismissed: true } }, { publishAfterSave: true })).toBeNull();
  expect(store.current().firstRun.dismissed).toBe(true);
});

it('serializes writes around a durable dismissal without losing a concurrent preference', async () => {
  const gate = deferred();
  const values: AppSettings[] = [];
  const db = database(async (_key, value) => {
    const next = structuredClone(value as AppSettings);
    if (values.length === 0) await gate.promise;
    values.push(next);
  });
  const store = new SettingsStore(db, DEFAULT_SETTINGS);
  const dismissal = store.update({ firstRun: { dismissed: true } }, { publishAfterSave: true });
  await Promise.resolve();
  const preference = store.update({ editor: { autosaveDebounceMs: 1200 } });
  expect(store.current().editor.autosaveDebounceMs).toBe(1200);
  expect(store.current().firstRun.dismissed).toBe(false);
  gate.resolve();
  expect(await dismissal).toBeNull();
  expect(await preference).toBeNull();
  expect(values).toHaveLength(2);
  expect(values[1]).toMatchObject({ firstRun: { dismissed: true }, editor: { autosaveDebounceMs: 1200 } });
  expect(store.current()).toEqual(values[1]);
});

it('keeps the versionless settings record free of queue state', async () => {
  const put = vi.fn<AppDb['put']>().mockResolvedValue(undefined);
  const store = new SettingsStore(database(put), DEFAULT_SETTINGS);
  await store.update({ editor: { autosaveDebounceMs: 1200 } });
  const record = put.mock.calls[0]![1] as AppSettings;
  expect(record).toEqual({ ...DEFAULT_SETTINGS, editor: { ...DEFAULT_SETTINGS.editor, autosaveDebounceMs: 1200 } });
  expect(Object.keys(record)).toEqual(Object.keys(DEFAULT_SETTINGS));
  expect(store.saveChannel.getSnapshot()).toEqual({ kind: 'idle', failure: null });
});
