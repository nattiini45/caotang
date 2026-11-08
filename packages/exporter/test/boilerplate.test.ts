import { describe, expect, it } from 'vitest';
import { defaultTitleOf } from '@caotang/i18n';

import { boilerplateFor, generatedChapterHeading } from '../src/boilerplate.js';

describe('boilerplateFor', () => {
  it('names the contents list in each language it has a word for', () => {
    expect(boilerplateFor('en').contents).toBe('Contents');
    expect(boilerplateFor('de').contents).toBe('Inhalt');
    expect(boilerplateFor('fr-CA').contents).toBe('Table des matières');
    expect(boilerplateFor('ja').contents).toBe('目次');
    expect(boilerplateFor('ar').contents).toBe('المحتويات');
    expect(boilerplateFor('he').contents).toBe('תוכן עניינים');
  });

  it('falls back to English for an absent or unknown language', () => {
    expect(boilerplateFor(undefined).contents).toBe('Contents');
    expect(boilerplateFor('').contents).toBe('Contents');
    expect(boilerplateFor('tlh').contents).toBe('Contents');
  });

  it('tells Traditional from Simplified Chinese', () => {
    expect(boilerplateFor('zh').contents).toBe('目录');
    expect(boilerplateFor('zh-Hans').contents).toBe('目录');
    expect(boilerplateFor('zh-Hant').contents).toBe('目錄');
    expect(boilerplateFor('zh_hk').contents).toBe('目錄');
  });

  it('puts a recipe’s label over the language’s word, and a blank label over nothing', () => {
    expect(boilerplateFor('de', { contents: ' Kapitel ' }).contents).toBe('Kapitel');
    expect(boilerplateFor('de', { contents: '  ' }).contents).toBe('Inhalt');
    expect(boilerplateFor('de', {}).contents).toBe('Inhalt');
  });

  it('names a chapter the writer left untitled, with the number where each language puts it', () => {
    expect(generatedChapterHeading(boilerplateFor('en'), 3)).toBe('Chapter 3');
    expect(generatedChapterHeading(boilerplateFor('de'), 3)).toBe('Kapitel 3');
    expect(generatedChapterHeading(boilerplateFor('ja'), 3)).toBe('3章');
    expect(generatedChapterHeading(boilerplateFor('zh'), 3)).toBe('第3章');
    expect(generatedChapterHeading(boilerplateFor('zh-Hant'), 3)).toBe('第3章');
    expect(generatedChapterHeading(boilerplateFor('tlh'), 3)).toBe('Chapter 3');
  });

  it('names a blank title and the landmarks in each language', () => {
    expect(boilerplateFor('en')).toMatchObject({
      untitled: 'Untitled',
      landmarks: 'Landmarks',
      beginReading: 'Begin Reading',
      cover: 'Cover',
    });
    expect(boilerplateFor('de')).toMatchObject({
      untitled: 'Ohne Titel',
      landmarks: 'Orientierungspunkte',
      beginReading: 'Textbeginn',
      cover: 'Umschlag',
    });
    expect(boilerplateFor('ja')).toMatchObject({ untitled: '無題', landmarks: 'ランドマーク', beginReading: '本文へ', cover: '表紙' });
    expect(boilerplateFor('tlh').untitled).toBe('Untitled');
  });

  it('agrees with the default titles the store writes, wherever both have a word', () => {
    for (const language of ['en', 'de', 'fr', 'es', 'ja', 'de-AT', 'ja-JP']) {
      expect(boilerplateFor(language).untitled, language).toBe(defaultTitleOf('document', language));
    }
  });
});
