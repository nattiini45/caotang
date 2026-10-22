/**
 * Which characters the Arabic and Hebrew fonts print and how a line is cut into runs (rtl-script.ts).
 */

import { describe, expect, it } from 'vitest';
import { graphemesOf } from '../src/emoji.js';
import { countMarks, hasRtlScript, isBidiControl, isRtlMark, rtlFontPrints, rtlRunKind, rtlScriptOf, scriptRuns, withoutMarks } from '../src/rtl-script.js';

describe('rtlScriptOf and rtlFontPrints', () => {
  it('name the font of a character by its block, and whether the font has it', () => {
    expect(rtlScriptOf(0x0627)).toBe('arabic');
    expect(rtlScriptOf(0xfe8d)).toBe('arabic');
    expect(rtlScriptOf(0x05d0)).toBe('hebrew');
    expect(rtlScriptOf(0xfb2a)).toBe('hebrew');
    expect(rtlScriptOf(0x0041)).toBeUndefined();
    expect(rtlScriptOf(0x4e2d)).toBeUndefined();
    expect(rtlFontPrints('ا')).toBe('arabic');
    expect(rtlFontPrints('؟')).toBe('arabic');
    expect(rtlFontPrints('א')).toBe('hebrew');
    // Courier Prime and the other fonts print these, so the Arabic and Hebrew fonts do not claim them.
    expect(rtlFontPrints('a')).toBeUndefined();
    expect(rtlFontPrints('1')).toBeUndefined();
    // In an Arabic block, but the font has no glyph for it.
    expect(rtlFontPrints(String.fromCodePoint(0x0892))).toBeUndefined();
  });

  it('hasRtlScript is the cheap test for text that needs any of this', () => {
    expect(hasRtlScript('Hello, world — 你好 🎬')).toBe(false);
    expect(hasRtlScript('Hello שלום')).toBe(true);
    expect(hasRtlScript('مرحبا')).toBe(true);
  });
});

describe('marks', () => {
  it('are the combining marks of the two scripts, and are left out of the text that is shaped', () => {
    expect(isRtlMark('َ')).toBe(true);
    expect(isRtlMark('ְ')).toBe(true);
    expect(isRtlMark('ب')).toBe(false);
    // A mark of another script is not this module's to leave out.
    expect(isRtlMark('́')).toBe(false);
    expect(withoutMarks('بِسْمِ')).toBe('بسم');
    expect(withoutMarks('שָׁלוֹם')).toBe('שלום');
    expect(withoutMarks('plain')).toBe('plain');
    expect(countMarks('بِسْمِ')).toBe(3);
    expect(countMarks('שָׁלוֹם')).toBe(3);
    expect(countMarks('שלום')).toBe(0);
  });

  it('leave ZWNJ in place, which Persian writes inside a word', () => {
    expect(withoutMarks('می‌خواهم')).toBe('می‌خواهم');
  });
});

describe('rtlRunKind and scriptRuns', () => {
  it('call letters and their marks letters, and digits and punctuation single', () => {
    expect(rtlRunKind('ب')).toBe('letters');
    expect(rtlRunKind('بِ')).toBe('letters');
    expect(rtlRunKind('٣')).toBe('single');
    expect(rtlRunKind('،')).toBe('single');
    expect(rtlRunKind('a')).toBeUndefined();
  });

  it('cut a line into words of one font, one run for each single character, and the text between', () => {
    const runs = scriptRuns(graphemesOf('say مرحبا؟ שלום 42'));
    expect(runs.map((run) => `${run.kind}:${run.script ?? '-'}:${run.text}`)).toEqual([
      'other:-:say ',
      'letters:arabic:مرحبا',
      'single:arabic:؟',
      'other:-: ',
      'letters:hebrew:שלום',
      'other:-: 42',
    ]);
  });

  it('keep a joiner and the marks with their letter, so a run is never cut inside a cluster', () => {
    const runs = scriptRuns(graphemesOf('می‌خواهم'));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.text).toBe('می‌خواهم');
  });
});

describe('isBidiControl', () => {
  it('is true for the marks and embeddings that print nothing', () => {
    for (const ch of ['‎', '‏', '؜', '‫', '⁧', '⁩']) expect(isBidiControl(ch), ch.codePointAt(0)?.toString(16)).toBe(true);
    expect(isBidiControl('a')).toBe(false);
    expect(isBidiControl('‍')).toBe(false);
  });
});
