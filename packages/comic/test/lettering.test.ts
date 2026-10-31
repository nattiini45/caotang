import { describe, expect, it } from 'vitest';
import {
  breakLines,
  emDashToDoubleDash,
  findEmDashes,
  layoutLettering,
  letteringDisplayText,
  parseEmphasis,
  stripEmphasis,
  toLetteringCaps,
  type CapsOptions,
} from '../src/index.js';

const caps = (over: Partial<CapsOptions> = {}): CapsOptions => ({ capsTransform: true, esszett: false, language: 'en', ...over });
const mono = (text: string): number => [...text].length;

describe('toLetteringCaps', () => {
  it('upper-cases Latin text', () => {
    expect(toLetteringCaps('Who is there?', caps())).toBe('WHO IS THERE?');
  });

  it('letters German ß as SS unless the book opts into ẞ', () => {
    expect(toLetteringCaps('Die Straße ist heiß.', caps({ language: 'de' }))).toBe('DIE STRASSE IST HEISS.');
    expect(toLetteringCaps('Die Straße ist heiß.', caps({ language: 'de', esszett: true }))).toBe('DIE STRAẞE IST HEIẞ.');
    expect(toLetteringCaps('STRASSE', caps({ language: 'de', esszett: true }))).toBe('STRASSE');
  });

  it('leaves caseless scripts untouched', () => {
    for (const text of ['你好，世界！', 'こんにちは カタカナ', 'مرحبا بالعالم', 'שלום עולם', 'नमस्ते दुनिया', 'สวัสดี']) {
      expect(toLetteringCaps(text, caps())).toBe(text);
    }
  });

  it('upper-cases the cased part of mixed text and leaves the rest', () => {
    expect(toLetteringCaps('hello 世界 world', caps())).toBe('HELLO 世界 WORLD');
    expect(toLetteringCaps('ok שלום ok', caps())).toBe('OK שלום OK');
  });

  it('does not capitalise Georgian, which is never lettered in capitals', () => {
    expect(toLetteringCaps('გამარჯობა hi', caps())).toBe('გამარჯობა HI');
  });

  it('upper-cases Cyrillic and Greek', () => {
    expect(toLetteringCaps('привет', caps({ language: 'ru' }))).toBe('ПРИВЕТ');
    expect(toLetteringCaps('γειά', caps({ language: 'el' }))).toBe('ΓΕΙΑ');
  });

  it('follows the project language for the dotted I', () => {
    expect(toLetteringCaps('istanbul', caps({ language: 'tr' }))).toBe('İSTANBUL');
    expect(toLetteringCaps('istanbul', caps({ language: 'en' }))).toBe('ISTANBUL');
  });

  it('is the identity when the book keeps mixed case', () => {
    const text = 'Straße, Who?';
    expect(toLetteringCaps(text, caps({ capsTransform: false }))).toBe(text);
  });

  it('survives a language tag it does not know', () => {
    expect(toLetteringCaps('abc', caps({ language: 'not a tag!!' }))).toBe('ABC');
  });
});

describe('emphasis', () => {
  it('reads **word** as bold italic and keeps where it sits', () => {
    const source = 'I said **never** again';
    const runs = parseEmphasis(source);
    expect(runs.map((r) => [r.text, r.emphasis])).toEqual([
      ['I said ', false],
      ['never', true],
      [' again', false],
    ]);
    const never = runs[1]!;
    expect(source.slice(never.from, never.to)).toBe('never');
  });

  it('reads several in a row, and one that is the whole text', () => {
    expect(parseEmphasis('**a** and **b c**').filter((r) => r.emphasis).map((r) => r.text)).toEqual(['a', 'b c']);
    expect(parseEmphasis('**all of it**')).toEqual([{ text: 'all of it', emphasis: true, from: 2, to: 11 }]);
  });

  it('leaves unpaired and empty markers as typed', () => {
    expect(parseEmphasis('**unpaired').map((r) => r.text)).toEqual(['**unpaired']);
    expect(parseEmphasis('a **** b').every((r) => !r.emphasis)).toBe(true);
    expect(parseEmphasis('** spaced **').every((r) => !r.emphasis)).toBe(true);
    expect(parseEmphasis('')).toEqual([]);
  });

  it('strips markers for counting and shows caps without them', () => {
    expect(stripEmphasis('a **b** c')).toBe('a b c');
    expect(letteringDisplayText('say **Straße**', caps({ language: 'de' }))).toBe('SAY STRASSE');
  });

  it('works inside Han text', () => {
    expect(parseEmphasis('你好**世界**').map((r) => r.text)).toEqual(['你好', '世界']);
  });
});

describe('dashes', () => {
  it('finds em dashes and leaves the double dash alone', () => {
    expect(findEmDashes('wait -- no')).toEqual([]);
    expect(findEmDashes('wait — no')).toEqual([{ from: 5, to: 6 }]);
    expect(findEmDashes('a——b')).toEqual([{ from: 1, to: 3 }]);
  });

  it('offers the double dash as a suggestion and never changes the source', () => {
    const source = 'wait — no';
    expect(emDashToDoubleDash(source)).toBe('wait -- no');
    expect(source).toBe('wait — no');
    expect(letteringDisplayText(source, caps())).toBe('WAIT — NO');
  });

  it('shows a double dash as a double dash', () => {
    expect(letteringDisplayText('wait--no', caps())).toBe('WAIT--NO');
  });
});

describe('breakLines', () => {
  it('breaks at spaces without exceeding the width', () => {
    const lines = breakLines('aaa bbb ccc ddd', 7, mono);
    expect(lines.map((l) => l.text)).toEqual(['aaa bbb', 'ccc ddd']);
  });

  it('returns offsets that slice the text back', () => {
    const text = 'one two  three four';
    for (const l of breakLines(text, 8, mono)) expect(text.slice(l.from, l.to)).toBe(l.text);
  });

  it('honours a hard line break', () => {
    expect(breakLines('ab\ncd', 100, mono).map((l) => l.text)).toEqual(['ab', 'cd']);
    expect(breakLines('ab\n\ncd', 100, mono).map((l) => l.text)).toEqual(['ab', 'cd']);
  });

  it('cuts a word wider than the line, and never produces an empty line', () => {
    const lines = breakLines('abcdefghij', 4, mono);
    expect(lines.map((l) => l.text)).toEqual(['abcd', 'efgh', 'ij']);
    expect(breakLines('x', 0.5, mono).map((l) => l.text)).toEqual(['x']);
  });

  it('keeps a double dash with the word it is written against', () => {
    expect(breakLines('wait--no more', 8, mono).map((l) => l.text)).toEqual(['wait--no', 'more']);
  });

  it('returns no lines for no text', () => {
    expect(breakLines('', 10, mono)).toEqual([]);
  });

  it('breaks Han text between characters, but not before closing punctuation', () => {
    const lines = breakLines('你好世界，再见！', 4, mono).map((l) => l.text);
    expect(lines.join('')).toBe('你好世界，再见！');
    for (const l of lines) {
      expect([...l].length).toBeLessThanOrEqual(5);
      expect('，！。'.includes([...l][0] ?? '')).toBe(false);
    }
  });

  it('breaks right-to-left text at its spaces, in logical order', () => {
    const lines = breakLines('مرحبا بالعالم الجميل', 13, mono).map((l) => l.text);
    expect(lines).toEqual(['مرحبا بالعالم', 'الجميل']);
  });

  it('keeps an emoji or combining sequence whole when it must cut', () => {
    const family = '👩‍👩‍👧‍👦';
    const count = (s: string): number => [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(s)].length;
    expect(breakLines(family + family, 1, count).map((l) => l.text)).toEqual([family, family]);
  });

  it('survives a measure that makes every character too wide', () => {
    expect(breakLines('ab cd', 1, () => 10).map((l) => l.text)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('layoutLettering', () => {
  const options = (maxWidth: number): Parameters<typeof layoutLettering>[1] => ({
    ...caps(),
    maxWidth,
    measure: (text, style) => [...text].length * (style.emphasis ? 2 : 1),
  });

  it('sets caps text in lines of runs and measures emphasis with its own face', () => {
    const lines = layoutLettering('no **really** now', options(16));
    const flat = lines.map((l) => l.runs.map((r) => r.text).join(''));
    expect(flat).toEqual(['NO REALLY', 'NOW']);
    expect(lines[0]?.runs.find((r) => r.emphasis)?.text).toBe('REALLY');
  });

  it('splits an emphasised phrase across lines, keeping its style on both', () => {
    const lines = layoutLettering('**aaa bbb ccc**', options(8));
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.runs.every((r) => r.emphasis)).toBe(true);
    expect(lines.map((l) => l.runs.map((r) => r.text).join('')).join(' ')).toBe('AAA BBB CCC');
  });

  it('returns nothing for empty text and does not touch the source', () => {
    expect(layoutLettering('', options(10))).toEqual([]);
    const source = 'straße';
    layoutLettering(source, { ...options(10), language: 'de' });
    expect(source).toBe('straße');
  });

  it('lays out Han text with the book caps setting on', () => {
    const lines = layoutLettering('你好世界你好世界', options(4));
    expect(lines.map((l) => l.runs.map((r) => r.text).join(''))).toEqual(['你好世界', '你好世界']);
  });
});
