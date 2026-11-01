import { describe, expect, it } from 'vitest';
import { comicInfoXml, escapeXml } from '../src/index.js';

describe('escapeXml', () => {
  it('escapes & < > " and \'', () => {
    expect(escapeXml(`Tom & Jerry <"fast"> 'slow'`)).toBe('Tom &amp; Jerry &lt;&quot;fast&quot;&gt; &apos;slow&apos;');
  });

  it('does not escape twice', () => {
    expect(escapeXml('&amp;')).toBe('&amp;amp;');
  });

  it('drops the control characters XML 1.0 cannot carry and keeps tab and line feed', () => {
    expect(escapeXml('a\u0000b\u0008c\u000bd\u000ce\u001ff\u007fg\u0085h\ufffei\uffffj')).toBe('abcdefghij');
    expect(escapeXml('a\tb\nc')).toBe('a\tb\nc');
  });

  it('writes a carriage return as a character reference so a parser keeps it', () => {
    expect(escapeXml('a\r\nb')).toBe('a&#13;\nb');
  });

  it('keeps astral characters and drops a lone surrogate', () => {
    expect(escapeXml('x😀y')).toBe('x😀y');
    expect(escapeXml('a\ud83db')).toBe('ab');
    expect(escapeXml('a\ude00b')).toBe('ab');
  });

  it('leaves Han, Arabic and Hebrew text as it is', () => {
    expect(escapeXml('漫画 كتاب ספר')).toBe('漫画 كتاب ספר');
  });
});

describe('comicInfoXml', () => {
  const pages = [{ type: 'FrontCover' as const, width: 1400, height: 1988 }, { type: 'Story' as const, width: 2800, height: 1988, doublePage: true }, {}];

  it('writes a v2.0 file with the spec fields in schema order', () => {
    const xml = comicInfoXml({
      title: 'The Long Night',
      series: 'Lantern',
      number: 3,
      creators: { writer: ['Ana Ruiz'], penciller: ['Bo Lin', 'Cy Okafor'], letterer: ['Di Park'] },
      language: 'en-GB',
      pages,
    });
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
        '  <Title>The Long Night</Title>',
        '  <Series>Lantern</Series>',
        '  <Number>3</Number>',
        '  <Writer>Ana Ruiz</Writer>',
        '  <Penciller>Bo Lin, Cy Okafor</Penciller>',
        '  <Letterer>Di Park</Letterer>',
        '  <PageCount>3</PageCount>',
        '  <LanguageISO>en-GB</LanguageISO>',
        '  <Pages>',
        '    <Page Image="0" Type="FrontCover" ImageWidth="1400" ImageHeight="1988" />',
        '    <Page Image="1" Type="Story" DoublePage="true" ImageWidth="2800" ImageHeight="1988" />',
        '    <Page Image="2" />',
        '  </Pages>',
        '</ComicInfo>',
        '',
      ].join('\n'),
    );
  });

  it('escapes every text field', () => {
    const xml = comicInfoXml({
      title: `A & B <"C"> 'D'`,
      series: 'S\u0000\u0008eries',
      number: '1&2',
      creators: { writer: ['R&D <x>'], letterer: ['Q"uote'] },
      pages: [],
    });
    expect(xml).toContain('<Title>A &amp; B &lt;&quot;C&quot;&gt; &apos;D&apos;</Title>');
    expect(xml).toContain('<Series>Series</Series>');
    expect(xml).toContain('<Number>1&amp;2</Number>');
    expect(xml).toContain('<Writer>R&amp;D &lt;x&gt;</Writer>');
    expect(xml).toContain('<Letterer>Q&quot;uote</Letterer>');
    expect([...xml].some((character) => character.charCodeAt(0) < 0x20 && character !== '\n')).toBe(false);
  });

  it('writes Manga as YesAndRightToLeft only when the book reads right to left', () => {
    expect(comicInfoXml({ readingDirection: 'rtl', pages })).toContain('<Manga>YesAndRightToLeft</Manga>');
    expect(comicInfoXml({ readingDirection: 'ltr', pages })).not.toContain('<Manga>');
    expect(comicInfoXml({ pages })).not.toContain('<Manga>');
    expect(comicInfoXml({ readingDirection: 'vertical', pages })).not.toContain('<Manga>');
  });

  it('counts the pages it lists and numbers them from 0 in archive order', () => {
    const xml = comicInfoXml({ pages: [{}, {}, {}, {}] });
    expect(xml).toContain('<PageCount>4</PageCount>');
    expect([...xml.matchAll(/<Page Image="(\d+)"/g)].map((match) => match[1])).toEqual(['0', '1', '2', '3']);
  });

  it('writes no Pages element for a book with no pages, and still a PageCount of 0', () => {
    const xml = comicInfoXml({ pages: [] });
    expect(xml).toContain('<PageCount>0</PageCount>');
    expect(xml).not.toContain('<Pages>');
  });

  it('leaves out an empty, blank or absent field rather than writing it empty', () => {
    const xml = comicInfoXml({ title: '  ', series: '', creators: { writer: [], penciller: [' ', ''] }, language: '', pages: [{}] });
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
        '  <PageCount>1</PageCount>',
        '  <Pages>',
        '    <Page Image="0" />',
        '  </Pages>',
        '</ComicInfo>',
        '',
      ].join('\n'),
    );
  });

  it('leaves out a language that is not a BCP 47 tag and keeps one with a script and region', () => {
    expect(comicInfoXml({ language: 'zh-Hant-TW', pages })).toContain('<LanguageISO>zh-Hant-TW</LanguageISO>');
    expect(comicInfoXml({ language: 'en_US', pages })).not.toContain('LanguageISO');
    expect(comicInfoXml({ language: '<en>', pages })).not.toContain('LanguageISO');
  });

  it('leaves out a page type the schema does not list and dimensions that are not positive whole numbers', () => {
    const xml = comicInfoXml({
      pages: [
        { type: 'Cover' as never, width: 0, height: -5 },
        { width: 12.5, height: Number.NaN },
        { width: 640, height: 480, doublePage: false },
      ],
    });
    expect(xml).toContain('<Page Image="0" />');
    expect(xml).toContain('<Page Image="1" />');
    expect(xml).toContain('<Page Image="2" ImageWidth="640" ImageHeight="480" />');
  });

  it('writes only the elements the spec lists', () => {
    const xml = comicInfoXml({ title: 't', series: 's', number: 1, creators: { writer: ['w'], penciller: ['p'], letterer: ['l'] }, language: 'en', readingDirection: 'rtl', pages });
    const names = new Set([...xml.matchAll(/<([A-Za-z]+)[ >]/g)].map((match) => match[1]));
    expect([...names].sort()).toEqual(['ComicInfo', 'Letterer', 'LanguageISO', 'Manga', 'Number', 'Page', 'PageCount', 'Pages', 'Penciller', 'Series', 'Title', 'Writer'].sort());
  });

  it('is well-formed XML with the text a reader gets back', () => {
    const xml = comicInfoXml({ title: `Q&A "x" <y> 'z'\u0001`, pages: [{}] });
    const text = /<Title>(.*)<\/Title>/.exec(xml)?.[1] ?? '';
    const back = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    expect(back).toBe(`Q&A "x" <y> 'z'`);
    expect(text).not.toMatch(/[<>"']/);
  });
});
