import { expect, test } from '@playwright/test';

import { INTERFACE_KEY, initInterface } from '../../apps/desktop/src/app/interface.js';
import { DEFAULT_SKIN, SKIN_KEY, applySkin, builtSkins, resolveSkin } from '../../apps/desktop/src/app/skin.js';

/**
 * The skin hook (app/skin.ts; modern-interface.md §2.2, D9): `caotang.skin` puts `data-skin` on `<html>` only for a skin in the build,
 * and only in Classic. No skin ships, so today the key is reserved and ignored. The page's globals are stood in for, as in
 * interface.spec.ts.
 */

function page(stored: Record<string, string>): Record<string, string> {
  const dataset: Record<string, string> = {};
  const host = globalThis as unknown as Record<string, unknown>;
  host['document'] = { documentElement: { dataset } };
  host['window'] = { localStorage: { getItem: (key: string) => stored[key] ?? null, setItem: () => undefined, length: 0, key: () => null } };
  return dataset;
}

test.afterEach(() => {
  const host = globalThis as unknown as Record<string, unknown>;
  delete host['document'];
  delete host['window'];
});

test('resolveSkin: a stored skin in the build, in Classic, is worn; anything else is the default', () => {
  const built = ['calm'];
  expect(resolveSkin('calm', 'classic', built)).toBe('calm');
  expect(resolveSkin('calm', 'modern', built), 'Modern has no skin axis').toBeNull();
  expect(resolveSkin(null, 'classic', built), 'absent').toBeNull();
  expect(resolveSkin(DEFAULT_SKIN, 'classic', built), 'the default').toBeNull();
  expect(resolveSkin('glass', 'classic', built), 'not in the build').toBeNull();
  expect(resolveSkin('calm', 'classic', []), 'no skin ships').toBeNull();
});

test('no skin ships: a bare host finds none, and a stored key is ignored', async () => {
  expect(builtSkins()).toEqual({});
  const dataset = page({ [SKIN_KEY]: 'calm', [INTERFACE_KEY]: 'classic' });
  await initInterface();
  expect(dataset['shell']).toBe('classic');
  expect(dataset['skin']).toBeUndefined();
});

test('a chosen skin in the build is put on the page and its stylesheet loaded; Modern takes it off', async () => {
  const loads: string[] = [];
  const sheets = { calm: async () => void loads.push('calm') };
  const dataset = page({ [SKIN_KEY]: 'calm' });
  await applySkin('classic', sheets);
  expect(dataset['skin']).toBe('calm');
  expect(loads).toEqual(['calm']);
  await applySkin('modern', sheets);
  expect(dataset['skin']).toBeUndefined();
  expect(loads).toEqual(['calm']);
});

test('a store that throws means the default skin', async () => {
  const dataset: Record<string, string> = { skin: 'calm' };
  const host = globalThis as unknown as Record<string, unknown>;
  host['document'] = { documentElement: { dataset } };
  host['window'] = Object.defineProperty({}, 'localStorage', {
    get() {
      throw new Error('SecurityError: blocked site data');
    },
  });
  await applySkin('classic', { calm: async () => undefined });
  expect(dataset['skin']).toBeUndefined();
});
