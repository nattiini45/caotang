/** Which regional forms of Han a project's language takes (han-locale.ts). */

import { describe, expect, it } from 'vitest';
import { hanLocaleTag } from '../src/han-locale.js';

describe('hanLocaleTag', () => {
  it.each([
    ['ja', 'JAN '],
    ['ja-JP', 'JAN '],
    ['ko', 'KOR '],
    ['ko-KR', 'KOR '],
    ['zh-Hant', 'ZHT '],
    ['zh-TW', 'ZHT '],
    ['zh-MO', 'ZHT '],
    ['zh-Hant-TW', 'ZHT '],
    ['zh-HK', 'ZHH '],
    ['zh-Hant-HK', 'ZHH '],
    ['ZH-hk', 'ZHH '],
    ['zh_TW', 'ZHT '],
    [' ja ', 'JAN '],
  ])('%s takes %j', (language, tag) => {
    expect(hanLocaleTag(language)).toBe(tag);
  });

  it.each(['zh', 'zh-Hans', 'zh-CN', 'zh-SG', 'zh-Hans-HK', 'en', 'en-US', 'fr', 'ar', '', '   ', 'x', 'ja--JP', 'not a tag', 'zh-Hant-', '!!'])(
    '%j takes the font\'s own (Simplified Chinese) forms',
    (language) => {
      expect(hanLocaleTag(language)).toBeUndefined();
    },
  );

  it('takes the font\'s own forms for no language', () => {
    expect(hanLocaleTag(undefined)).toBeUndefined();
  });
});
