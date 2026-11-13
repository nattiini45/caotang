import { describe, expect, it } from 'vitest';

import { preprocessObsidian } from '../src/obsidian.js';

describe('the Obsidian preprocessor (#281)', () => {
  it('turns wikilinks into their display text', () => {
    const read = preprocessObsidian('See [[The Ferry]], [[The Ferry|the ferry]], [[Note#Heading]] and [[Note#^block]].');
    expect(read.body).toBe('See The Ferry, the ferry, Note and Note.');
    expect(read.wikilinks).toBe(4);
  });

  it('names image and note embeds with tokens', () => {
    const read = preprocessObsidian('![[cover.png|300]] and ![[Other Note]]');
    expect(read.embeds).toHaveLength(2);
    expect(read.embeds[0]).toMatchObject({ target: 'cover.png', isImage: true, alt: '300' });
    expect(read.embeds[1]).toMatchObject({ target: 'Other Note', isImage: false });
    expect(read.body).toContain(read.embeds[0]?.token ?? '');
    expect(read.body).toContain(read.embeds[1]?.token ?? '');
  });

  it('keeps inline and multi-line %%comments%% as notes', () => {
    const inline = preprocessObsidian('A line. %% hidden %% The rest.');
    expect(inline.body).toBe('A line.  The rest.');
    expect(inline.notes).toEqual(['hidden']);
    const multi = preprocessObsidian('%% hidden aside\nstill hidden %%\nAfter.');
    expect(multi.notes).toEqual(['hidden aside\nstill hidden']);
    expect(multi.body).toBe('\n\nAfter.');
  });

  it('keeps an unclosed comment to the end of the file', () => {
    const read = preprocessObsidian('Text. %% trailing thought');
    expect(read.notes).toEqual(['trailing thought']);
    expect(read.body).toBe('Text. ');
  });

  it('strips ==highlights== and counts them', () => {
    const read = preprocessObsidian('The ==quick brown== fox.');
    expect(read.body).toBe('The quick brown fox.');
    expect(read.highlights).toBe(1);
  });

  it('turns a callout into a labelled blockquote', () => {
    const read = preprocessObsidian('> [!warning] Careful\n> The bridge is out.');
    expect(read.body).toBe('> **Warning** Careful\n> The bridge is out.');
    expect(read.callouts).toBe(1);
  });

  it('strips a trailing ^block-id', () => {
    const read = preprocessObsidian('A paragraph. ^abc-123');
    expect(read.body).toBe('A paragraph.');
    expect(read.blockIds).toBe(1);
  });

  it('collects #tags as keywords but leaves headings alone', () => {
    const read = preprocessObsidian('# Chapter One\n\nA line with #sea and #grief/deep.');
    expect(read.body).toContain('# Chapter One');
    expect(read.keywords).toEqual(['sea', 'grief/deep']);
  });

  it('reads own-line and inline Dataview fields', () => {
    const read = preprocessObsidian('Status:: draft\n\nShe was [mood:: tense] today.');
    expect(read.dataview['Status']).toBe('draft');
    expect(read.dataview['mood']).toBe('tense');
    expect(read.body).not.toContain('Status::');
    expect(read.body).toContain('She was tense today.');
  });

  it('leaves fenced code and inline code untouched', () => {
    const read = preprocessObsidian('Use `[[Not A Link]]` here.\n\n```\n[[Also Not A Link]] #notag\n```\n\n[[Real Link]]');
    expect(read.body).toContain('`[[Not A Link]]`');
    expect(read.body).toContain('[[Also Not A Link]] #notag');
    expect(read.wikilinks).toBe(1);
    expect(read.keywords).toEqual([]);
  });
});
