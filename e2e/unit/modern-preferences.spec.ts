import { expect, test } from '@playwright/test';

import {
  MOTION_KEY,
  TRANSPARENCY_KEY,
  preferenceAttributes,
  readModernPreferences,
  type PreferenceStore,
} from '../../apps/desktop/src/app/modern-preferences.js';
import { geometryProperties } from '../../apps/desktop/src/components/shell/modern/stage.js';

/**
 * Modern's view preferences (app/modern-preferences.ts; modern-interface.md §5.3, §9.4) and the stage's geometry
 * (components/shell/modern/stage.tsx, §8.4, §11): what is read from storage, which attributes stand for it, and the custom properties a
 * geometry writes through the CSSOM.
 */

function memory(initial: Record<string, string> = {}): PreferenceStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

test('nothing stored, or anything but "reduced", means both switches off', () => {
  expect(readModernPreferences(memory())).toEqual({ reduceTransparency: false, reduceMotion: false });
  expect(readModernPreferences(memory({ [TRANSPARENCY_KEY]: 'on', [MOTION_KEY]: '1' }))).toEqual({ reduceTransparency: false, reduceMotion: false });
  expect(readModernPreferences(null)).toEqual({ reduceTransparency: false, reduceMotion: false });
});

test('"reduced" under each key turns that switch on, and only that one', () => {
  expect(readModernPreferences(memory({ [TRANSPARENCY_KEY]: 'reduced' }))).toEqual({ reduceTransparency: true, reduceMotion: false });
  expect(readModernPreferences(memory({ [MOTION_KEY]: 'reduced' }))).toEqual({ reduceTransparency: false, reduceMotion: true });
});

test('an unreadable store counts as nothing stored', () => {
  const broken: PreferenceStore = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  expect(readModernPreferences(broken)).toEqual({ reduceTransparency: false, reduceMotion: false });
});

test('the attributes are present only for a reduction', () => {
  expect(preferenceAttributes({ reduceTransparency: false, reduceMotion: false })).toEqual({ transparency: null, motion: null });
  expect(preferenceAttributes({ reduceTransparency: true, reduceMotion: true })).toEqual({ transparency: 'reduced', motion: 'reduced' });
});

test('the keys are Caotang keys under caotang.modern.*', () => {
  expect([TRANSPARENCY_KEY, MOTION_KEY]).toEqual(['caotang.modern.transparency', 'caotang.modern.motion']);
});

test('a geometry becomes the stage’s custom properties in whole px; none, or nothing finite, writes no style', () => {
  expect(geometryProperties(undefined)).toBeUndefined();
  expect(geometryProperties({})).toBeUndefined();
  expect(geometryProperties({ pageWidth: Number.NaN })).toBeUndefined();
  expect(geometryProperties({ pageWidth: 779.6, pageTop: 99, pageBottom: 112, areaStart: 332, areaEnd: -4 })).toEqual({
    '--page-w': '780px',
    '--page-top': '99px',
    '--page-bottom': '112px',
    '--area-start': '332px',
    '--area-end': '0px',
  });
});
