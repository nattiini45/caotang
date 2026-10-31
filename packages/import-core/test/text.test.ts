import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { breakMarkerOf, countWords, firstWords, headingStyleLevel, isBackMatterTitle, isShortLine, isTitleStyle, matchFamily, numberValue, specialOf, stripChapterNumber, tocKey } from '../src/text.js';

describe('chapter-pattern families', () => {
  it.each([
    ['Chapter 3', 'chapter-word', '3', ''],
    ['CHAPTER THREE', 'chapter-word', 'THREE', ''],
    ['Chapter Twenty-One: The Storm', 'chapter-word', 'Twenty-One', 'The Storm'],
    ['Ch. 12 – Salt', 'chapter-word', '12', 'Salt'],
    ['Chapter IV.', 'chapter-word', 'IV', ''],
    ['Chapter: The Landing', 'chapter-word', undefined, 'The Landing'],
    ['Kapitel 1', 'chapter-word', '1', ''],
    ['Kapitel eins', 'chapter-word', 'eins', ''],
    ['1. Kapitel', 'chapter-word', '1', ''],
    ['Chapitre II', 'chapter-word', 'II', ''],
    ['Capítulo uno', 'chapter-word', 'uno', ''],
    ['Глава 5', 'chapter-word', '5', ''],
    ['Rozdział 7', 'chapter-word', '7', ''],
    ['Part One', 'part-word', 'One', ''],
    ['Book II: Winter', 'part-word', 'II', 'Winter'],
    ['Teil 2', 'part-word', '2', ''],
    ['2. Teil', 'part-word', '2', ''],
    ['第一章 风起', 'cjk-chapter', '一', '风起'],
    ['第12回', 'cjk-chapter', '12', ''],
    ['第三部', 'cjk-part', '三', ''],
    ['제 1 장', 'korean-chapter', '1', ''],
    ['제2부', 'korean-part', '2', ''],
    ['12', 'number', '12', ''],
    ['— IV —', 'number', 'IV', ''],
    ['7.', 'number', '7', ''],
  ])('%s → %s', (text, family, num, rest) => {
    const m = matchFamily(text);
    expect(m?.family).toBe(family);
    expect(m?.num).toBe(num);
    expect(m?.rest).toBe(rest);
  });

  it.each(['Part of the problem', 'Chapters', 'Bookends', 'Chapter3x', 'mid', 'Partial', 'The Chapter 3', 'iv'])('%s is not a chapter line', (text) => {
    expect(matchFamily(text)).toBeNull();
  });

  it('names the story part of prologue, epilogue and interlude lines in several languages', () => {
    expect(['Prologue', 'Prolog', 'Prólogo: Fire', '序章', '楔子'].map(specialOf)).toEqual(['prologue', 'prologue', 'prologue', 'prologue', 'prologue']);
    expect(['Epilogue', 'Epilog', 'Épilogue', '尾声'].map(specialOf)).toEqual(['epilogue', 'epilogue', 'epilogue', 'epilogue']);
    expect(['Interlude', 'Zwischenspiel'].map(specialOf)).toEqual(['interlude', 'interlude']);
    expect(specialOf('Prologues are hard')).toBeNull();
  });

  it('strips the chapter number only, keeping titles that would be empty', () => {
    expect(stripChapterNumber('Chapter 3: The Landing')).toBe('The Landing');
    expect(stripChapterNumber('Chapter Three')).toBe('Chapter Three');
    expect(stripChapterNumber('第一章 风起')).toBe('风起');
    expect(stripChapterNumber('Part One: Arrival')).toBe('Part One: Arrival');
    expect(stripChapterNumber('The Landing')).toBe('The Landing');
  });

  it('reads chapter numbers in digits, Roman numerals, words and CJK numerals', () => {
    expect(['12', '１２', 'IV', 'xiv', 'three', 'Twenty-One', 'zwölf', '十', '十二', '二十三', '一百零五', 'banana'].map(numberValue)).toEqual([
      12, 12, 4, 14, 3, 21, 12, 10, 12, 23, 105, null,
    ]);
  });
});

describe('lines, breaks and words', () => {
  it('a short line has at most 60 characters and 8 words and no sentence end, except after a numeral', () => {
    expect(isShortLine('Chapter 3')).toBe(true);
    expect(isShortLine('Chapter 3.')).toBe(true);
    expect(isShortLine('IV.')).toBe(true);
    expect(isShortLine('She left.')).toBe(false);
    expect(isShortLine('"Chapter 3," she said.')).toBe(false);
    expect(isShortLine('one two three four five six seven eight nine')).toBe(false);
    expect(isShortLine('x'.repeat(61))).toBe(false);
    expect(isShortLine('第一章 风起')).toBe(true);
  });

  it('break markers: symbol-only lines up to 15 characters (40 centred) and o0o', () => {
    expect(breakMarkerOf(' * * * ', false)).toBe('* * *');
    expect(breakMarkerOf('#', false)).toBe('#');
    expect(breakMarkerOf('oOo', false)).toBe('oOo');
    expect(breakMarkerOf('*'.repeat(16), false)).toBeNull();
    expect(breakMarkerOf('*'.repeat(16), true)).toBe('*'.repeat(16));
    expect(breakMarkerOf('A * B', false)).toBeNull();
    expect(breakMarkerOf('', false)).toBeNull();
  });

  it('counts words: CJK characters one each, tokens with a letter or digit one each', () => {
    expect(countWords('The ferry came at noon.')).toBe(5);
    expect(countWords('  — and then — 3 more  ')).toBe(4);
    expect(countWords('海风吹过灯塔')).toBe(6);
    expect(countWords('Caotang 草堂 app')).toBe(4);
    expect(countWords('한국어 문장 입니다')).toBe(3);
    expect(countWords('Ünïcödé wörds')).toBe(2);
    expect(countWords('')).toBe(0);
  });

  it('first words: the first sentence, at most 40 characters, cut at a word', () => {
    expect(firstWords('The ferry came at noon. Then it rained.')).toBe('The ferry came at noon.');
    expect(firstWords('She closed the door behind her and listened to the wind for a long time')).toBe('She closed the door behind her and…');
    expect(firstWords('')).toBe('');
  });
});

describe('styles and headings', () => {
  it('reads heading levels from localized style names and recognises Title styles', () => {
    expect(['Heading 1', 'heading 3', 'Überschrift 2', 'Titre 1', 'Body Text', undefined].map(headingStyleLevel)).toEqual([1, 3, 2, 1, 0, 0]);
    expect(['Title', 'Titel', 'Heading 1'].map(isTitleStyle)).toEqual([true, true, false]);
  });

  it('recognises back-matter headings', () => {
    expect(['Acknowledgements', 'Acknowledgments', 'About the Author', 'Also by Jane Writer', 'Danksagung', 'Über die Autorin', 'Remerciements', '致谢'].every(isBackMatterTitle)).toBe(true);
    expect(['The Author', 'Acknowledged', 'About the war'].some(isBackMatterTitle)).toBe(false);
  });

  it('keys a TOC line by its text without dot leaders, tabs or page numbers', () => {
    expect(tocKey('Chapter One ........ 3')).toBe('chapter one');
    expect(tocKey('Chapter Two\t12')).toBe('chapter two');
    expect(tocKey('The Landing  ·  ·  ·  iv')).toBe('the landing');
    expect(tocKey('Chapter Three')).toBe('chapter three');
  });
});

describe('hostile input', () => {
  it('long lines of separators and leaders are read in linear time (no polynomial backtracking)', () => {
    const long = 50_000;
    const lines = [
      `序章${'\t'.repeat(long)}x`,
      `Chapter${' '.repeat(long)}!`,
      `Chapter 1${' :'.repeat(long)}x`,
      `第一章${'·'.repeat(long)}`,
      `Prologue${' '.repeat(long)}-`,
      `${'I'.repeat(long)}.`,
      `x${'. '.repeat(long)}1`,
    ];
    const t = performance.now();
    for (const line of lines) {
      matchFamily(line);
      specialOf(line);
      isShortLine(line);
      tocKey(line);
      firstWords(line);
      countWords(line);
    }
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('the package stays pure', () => {
  const srcDir = resolve(__dirname, '../src');
  const sources = readdirSync(srcDir).map((f) => [f, readFileSync(resolve(srcDir, f), 'utf8')] as const);

  it('imports nothing outside itself: no dependency, no DOM, no Node module', () => {
    for (const [file, text] of sources) {
      for (const m of text.matchAll(/from '([^']+)'/gu)) expect(`${file}: ${m[1]}`).toMatch(/: \.\/[a-z-]+\.js$/u);
    }
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.dependencies).toBeUndefined();
  });

  it('uses no browser global, eval or Function constructor (CSP script-src self; Workers and Node)', () => {
    for (const [file, text] of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
      expect(code, file).not.toMatch(/\b(?:window|document|DOMParser|localStorage|indexedDB|navigator|eval|new Function)\b/u);
    }
  });
});
