import { describe, expect, it } from 'vitest';

import { boilerplateFor } from '../src/boilerplate.js';

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
});
