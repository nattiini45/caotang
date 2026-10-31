import { expect, test } from '@playwright/test';

import {
  INTERFACE_KEY,
  MODERN_DEFAULT_FOR_NEW_USERS,
  initInterface,
  interfacePending,
  otherCaotangKeys,
  resolveInterface,
  settleInterface,
  type InterfaceFacts,
  type KeyList,
} from '../../apps/desktop/src/app/interface.js';

/**
 * The interface's default rule (app/interface.ts; modern-interface.md §3.2, D3, D4): a stored choice wins; another `caotang.*`
 * key means Classic; then a project or a settings record means Classic, and neither means Modern only when the parity gate is
 * open. The answer is stored at once.
 *
 * The page's globals are stood in for: a `window` with a local storage and a `document` whose root carries the attribute.
 */

type Row = readonly [string, InterfaceFacts, 'classic' | 'modern' | null, 'classic' | 'modern' | null];

const unknown = { projects: null, settingsRecord: null } as const;
const fresh = { stored: null, otherKeys: false, projects: false, settingsRecord: false } as const;

/** Each row: what it is, the facts, the answer with the gate closed (today), the answer with it open (#313). */
const TABLE: readonly Row[] = [
  ['stored classic, nothing else known', { stored: 'classic', otherKeys: false, ...unknown }, 'classic', 'classic'],
  ['stored modern, nothing else known', { stored: 'modern', otherKeys: false, ...unknown }, 'modern', 'modern'],
  ['stored modern beats other keys and a project', { stored: 'modern', otherKeys: true, projects: true, settingsRecord: true }, 'modern', 'modern'],
  ['stored classic beats a fresh profile', { ...fresh, stored: 'classic' }, 'classic', 'classic'],
  ['a stored value that is not an interface is ignored', { ...fresh, stored: 'glass' }, 'classic', 'modern'],
  ['another caotang key, stores not open yet', { stored: null, otherKeys: true, ...unknown }, 'classic', 'classic'],
  ['another caotang key on a fresh store', { ...fresh, otherKeys: true }, 'classic', 'classic'],
  ['nothing in local storage, stores not open yet', { stored: null, otherKeys: false, ...unknown }, null, null],
  ['nothing in local storage, only the projects known', { stored: null, otherKeys: false, projects: false, settingsRecord: null }, null, null],
  ['a project', { ...fresh, projects: true }, 'classic', 'classic'],
  ['a settings record', { ...fresh, settingsRecord: true }, 'classic', 'classic'],
  ['a project and a settings record', { ...fresh, projects: true, settingsRecord: true }, 'classic', 'classic'],
  ['a fresh profile: nothing anywhere', fresh, 'classic', 'modern'],
];

for (const [name, facts, gated, open] of TABLE) {
  test(`resolveInterface: ${name}`, () => {
    expect(resolveInterface(facts, false), 'parity gate closed').toBe(gated);
    expect(resolveInterface(facts, true), 'parity gate open').toBe(open);
  });
}

test('the parity gate is closed until Modern is complete, so the default today is the closed column', () => {
  expect(MODERN_DEFAULT_FOR_NEW_USERS).toBe(false);
  expect(resolveInterface(fresh)).toBe('classic');
});

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

test('another caotang key counts; the interface key alone, other sites’ keys, no store and a store that throws do not', () => {
  expect(otherCaotangKeys(storage({ 'caotang.theme': 'dark' }))).toBe(true);
  expect(otherCaotangKeys(storage({ 'caotang.pending.p1': '{}' }))).toBe(true);
  expect(otherCaotangKeys(storage({ 'caotang.unsent.p1:d1': 'words' }))).toBe(true);
  expect(otherCaotangKeys(storage({ [INTERFACE_KEY]: 'modern' }))).toBe(false);
  expect(otherCaotangKeys(storage({ 'other.app': '1' }))).toBe(false);
  expect(otherCaotangKeys(storage())).toBe(false);
  expect(otherCaotangKeys(null)).toBe(false);
  const broken: KeyList = {
    get length(): number {
      throw new Error('blocked');
    },
    key: () => null,
  };
  expect(otherCaotangKeys(broken)).toBe(false);
});

test('a stored choice is applied before the first render and not written again', async () => {
  const store = storage({ [INTERFACE_KEY]: 'classic', 'caotang.theme': 'dark' });
  const dataset = page(store);
  await initInterface();
  expect(dataset['shell']).toBe('classic');
  expect(interfacePending()).toBe(false);
  expect(store.map.get(INTERFACE_KEY)).toBe('classic');
});

test('an existing writer (another caotang key) is decided as Classic before the first render, and the answer is stored', async () => {
  const store = storage({ 'caotang.theme': 'light' });
  const dataset = page(store);
  await initInterface();
  expect(dataset['shell']).toBe('classic');
  expect(store.map.get(INTERFACE_KEY)).toBe('classic');
  expect(interfacePending()).toBe(false);
  // Already decided, so the stores' answer changes nothing.
  await settleInterface(false, false);
  expect(dataset['shell']).toBe('classic');
});

test('with nothing in local storage the default waits for the stores, which settle it once and store it', async () => {
  const store = storage();
  const dataset = page(store);
  await initInterface();
  expect(interfacePending()).toBe(true);
  expect(store.map.has(INTERFACE_KEY)).toBe(false);

  await settleInterface(true, false);
  expect(dataset['shell']).toBe('classic');
  expect(store.map.get(INTERFACE_KEY)).toBe('classic');
  expect(interfacePending()).toBe(false);
});

test('a fresh profile settles as the parity gate says (Classic today), and the answer is stored', async () => {
  const store = storage();
  const dataset = page(store);
  await initInterface();
  await settleInterface(false, false).catch(() => undefined);
  const expected = MODERN_DEFAULT_FOR_NEW_USERS ? 'modern' : 'classic';
  expect(dataset['shell']).toBe(expected);
  expect(store.map.get(INTERFACE_KEY)).toBe(expected);
});

test('a stored Modern is applied before the first render (its stylesheet is a Vite chunk a bare Node host cannot load)', async () => {
  const store = storage({ [INTERFACE_KEY]: 'modern' });
  const dataset = page(store);
  await initInterface().catch(() => undefined);
  expect(dataset['shell']).toBe('modern');
  expect(interfacePending()).toBe(false);
});

test('a browser that refuses local storage still gets an interface: the stores decide, and nothing throws', async () => {
  const dataset = page('throws');
  await initInterface();
  expect(interfacePending()).toBe(true);
  await settleInterface(false, true);
  expect(dataset['shell']).toBe('classic');
});
