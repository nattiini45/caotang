import { expect, test } from '@playwright/test';

import {
  SHELL_KEY,
  initShell,
  keptFromEarlierVisit,
  settleShell,
  shellFor,
  shellUndecided,
  storedShell,
  type KeyList,
} from '../../apps/desktop/src/app/shell.js';

/**
 * The interface shell's default (app/shell.ts, ui-modules.md §5.1): the writer's stored choice wins; with none, Modern for a new
 * writer and Classic for a returning one, and nothing is decided while it is not known whether the writer is returning.
 *
 * The page's globals are stood in for: a `window` with a local storage and a `document` whose root carries the attribute.
 */

/** A local storage of these keys, readable and writable as the browser's. */
function storage(initial: Record<string, string> = {}): Storage & { readonly map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

/** Stands up the page's globals for one test and returns the root's dataset. */
function page(store: Storage | 'throws'): Record<string, string> {
  const dataset: Record<string, string> = {};
  const host = globalThis as unknown as Record<string, unknown>;
  host['document'] = { documentElement: { dataset } };
  host['window'] =
    store === 'throws'
      ? Object.defineProperty({}, 'localStorage', {
          get() {
            throw new Error('SecurityError: blocked site data');
          },
        })
      : { localStorage: store };
  return dataset;
}

test.afterEach(() => {
  const host = globalThis as unknown as Record<string, unknown>;
  delete host['document'];
  delete host['window'];
});

test('the stored choice wins over the default, for a new and a returning writer alike', () => {
  for (const returning of [true, false, null]) {
    expect(shellFor({ stored: 'classic', returning })).toBe('classic');
    expect(shellFor({ stored: 'modern', returning })).toBe('modern');
  }
});

test('with no stored choice a new writer gets Modern, a returning writer Classic, and nothing is decided while it is unknown', () => {
  expect(shellFor({ stored: null, returning: false })).toBe('modern');
  expect(shellFor({ stored: null, returning: true })).toBe('classic');
  expect(shellFor({ stored: null, returning: null })).toBeNull();
});

test('a Caotang key from an earlier visit marks a returning writer; the shell key alone, other sites’ keys and no store do not', () => {
  expect(keptFromEarlierVisit(storage({ 'caotang.theme': 'dark' }))).toBe(true);
  expect(keptFromEarlierVisit(storage({ 'caotang.pending.p1': '{}' }))).toBe(true);
  expect(keptFromEarlierVisit(storage({ 'caotang.unsent.p1:d1': 'words' }))).toBe(true);
  expect(keptFromEarlierVisit(storage({ [SHELL_KEY]: 'modern' }))).toBe(false);
  expect(keptFromEarlierVisit(storage({ 'other.app': '1' }))).toBe(false);
  expect(keptFromEarlierVisit(storage())).toBe(false);
  expect(keptFromEarlierVisit(null)).toBe(false);
  const broken: KeyList = {
    get length(): number {
      throw new Error('blocked');
    },
    key: () => null,
  };
  expect(keptFromEarlierVisit(broken)).toBe(false);
});

test('a stored value that is not a shell reads as no choice', () => {
  page(storage({ [SHELL_KEY]: 'glass' }));
  expect(storedShell()).toBeNull();
  page(storage({ [SHELL_KEY]: 'classic' }));
  expect(storedShell()).toBe('classic');
  page('throws');
  expect(storedShell()).toBeNull();
});

test('a returning writer with no stored choice is put on Classic before the first paint, and the default is stored', async () => {
  const store = storage({ 'caotang.theme': 'light' });
  const dataset = page(store);
  await initShell();
  expect(dataset['shell']).toBe('classic');
  expect(store.map.get(SHELL_KEY)).toBe('classic');
  expect(shellUndecided()).toBe(false);
  // Already decided, so the stores' answer changes nothing.
  await settleShell(false);
  expect(dataset['shell']).toBe('classic');
});

test('with nothing in local storage the first paint is a provisional Classic, and the stores settle it once', async () => {
  const store = storage();
  const dataset = page(store);
  await initShell();
  expect(dataset['shell']).toBe('classic');
  expect(shellUndecided()).toBe(true);
  expect(store.map.has(SHELL_KEY)).toBe(false);

  // A settings record or a project from an earlier visit: Classic, stored, so the writer's interface never changes under them.
  await settleShell(true);
  expect(dataset['shell']).toBe('classic');
  expect(store.map.get(SHELL_KEY)).toBe('classic');
  expect(shellUndecided()).toBe(false);
});

test('a new writer is settled on Modern, stored, so making a first project does not switch them back', async () => {
  const store = storage();
  const dataset = page(store);
  await initShell();
  // Modern's stylesheet is a Vite chunk, which a bare Node host cannot load; the attribute and the stored choice are what count here.
  await settleShell(false).catch(() => undefined);
  expect(dataset['shell']).toBe('modern');
  expect(store.map.get(SHELL_KEY)).toBe('modern');
  // The next visit reads the stored choice, whatever the stores now hold.
  expect(shellFor({ stored: storedShell(), returning: true })).toBe('modern');
});

test('a browser that refuses local storage still gets a shell: Classic at first paint, then the stores decide', async () => {
  const dataset = page('throws');
  await initShell();
  expect(dataset['shell']).toBe('classic');
  expect(shellUndecided()).toBe(true);
  await settleShell(true);
  expect(dataset['shell']).toBe('classic');
});
