import { describe, expect, it } from 'vitest';

import { defaultTitleOf, isDefaultTitle } from '../src/index.js';

describe('defaultTitleOf', () => {
  it('names each kind in English by default and for an unknown language', () => {
    expect(defaultTitleOf('document')).toBe('Untitled');
    expect(defaultTitleOf('scene', 'en-GB')).toBe('Untitled scene');
    expect(defaultTitleOf('section', 'tlh')).toBe('Untitled section');
    expect(defaultTitleOf('shot', '')).toBe('New shot');
  });

  it('follows the project language', () => {
    expect(defaultTitleOf('scene', 'de')).toBe('Szene ohne Titel');
    expect(defaultTitleOf('document', 'ja-JP')).toBe('無題');
    expect(defaultTitleOf('storyboard', 'fr')).toBe('Storyboard');
    expect(defaultTitleOf('comic')).toBe('Untitled comic');
    expect(defaultTitleOf('comicPage', 'de')).toBe('Neue Seite');
  });
});

describe('isDefaultTitle', () => {
  it('recognises the default of any language, so a rename prompt does not depend on the language it was made in', () => {
    expect(isDefaultTitle('Untitled')).toBe(true);
    expect(isDefaultTitle('Ohne Titel')).toBe(true);
    expect(isDefaultTitle('Chapter 1')).toBe(false);
    expect(isDefaultTitle('Szene ohne Titel', 'scene')).toBe(true);
    expect(isDefaultTitle('Untitled', 'scene')).toBe(false);
  });
});
