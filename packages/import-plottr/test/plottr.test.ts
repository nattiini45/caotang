// The two small Plottr fixtures and the large Hamlet outline are MIT-licensed Kindling fixtures (copyright 2025 Josh Smith), copied as data, never as parser code.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readPlottr, slateMarkdown } from '../src/index.js';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(__dirname, 'fixtures', name)));

describe('readPlottr', () => {
  it('reads the older flat-beat simple-story fixture', () => {
    const read = readPlottr(fixture('simple-story.pltr'));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.books).toEqual([{ id: '1', title: 'Simple Story' }]);
    expect(read.value.beats.map((beat) => beat.title)).toEqual(['Act 1', 'Act 2', 'Act 3']);
    const v2 = readPlottr(fixture('simple-story-v2.pltr'));
    expect(v2.ok).toBe(true);
    if (v2.ok) expect(v2.value.beats.length).toBe(3);
    expect(read.value.cards).toHaveLength(5);
    expect(read.value.cards[0]).toMatchObject({ title: 'The Beginning', beatId: '1', lineId: '1' });
    expect(read.value.cards[0]?.description).toContain('Opening scene.');
  });

  it('reads the current heap/index beat shape, people, places, threads, notes, tags and images', () => {
    const read = readPlottr(fixture('hamlet.pltr'));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.title).toBe('Hamlet');
    expect(read.value.beats.map((beat) => beat.title)).toEqual(['Act 1', 'Act 2', 'Act 3', 'Act 4', 'Act 5']);
    expect(read.value.lines.map((line) => line.title)).toContain('Summary');
    expect(read.value.characters.find((entity) => entity.name === 'Hamlet')).toMatchObject({ description: 'Prince of Denmark', imageId: '1' });
    expect(read.value.characters.find((entity) => entity.name === 'Hamlet')?.attributes.Role).toBe('Protagonist');
    expect(read.value.places.find((entity) => entity.name === 'Elsinore Castle')).toMatchObject({ imageId: '9' });
    expect(read.value.notes.length).toBeGreaterThan(0);
    expect(read.value.tags['7']).toBe('THEME: Mortality');
    expect(read.value.images.length).toBeGreaterThan(0);
    expect(read.value.images[0]?.bytes.length).toBeGreaterThan(100);
  });

  it('reads a series file with both books and tolerates unknown keys', () => {
    const file = {
      series: { name: 'Series' },
      books: { allIds: [1, 2], 1: { title: 'First' }, 2: { title: 'Second' } },
      beats: {
        1: { index: { 10: { id: 10, title: 'Act', position: 0 } }, children: { null: [10], 10: [] } },
        2: { index: { 20: { id: 20, title: 'Second act', position: 0 } }, children: { null: [20], 20: [] } },
      },
      cards: [],
      futureFeature: { enabled: true },
    };
    const read = readPlottr(new TextEncoder().encode(JSON.stringify(file)));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.books).toEqual([{ id: '1', title: 'First' }, { id: '2', title: 'Second' }]);
    expect(read.value.beats.map((beat) => `${beat.bookId}:${beat.title}`)).toEqual(['1:Act', '2:Second act']);
    expect(read.value.unknownKeys).toEqual(['futureFeature']);
  });

  it('names malformed JSON and non-Plottr JSON instead of throwing', () => {
    expect(readPlottr(new TextEncoder().encode('{')).ok).toBe(false);
    expect(readPlottr(new TextEncoder().encode('{"hello":true}')).ok).toBe(false);
  });
});

describe('slateMarkdown', () => {
  it('keeps paragraphs, headings and inline marks as Markdown', () => {
    expect(slateMarkdown([
      { type: 'heading-2', children: [{ text: 'A heading' }] },
      { type: 'paragraph', children: [{ text: 'plain ' }, { text: 'bold', bold: true }, { text: ' and ' }, { text: 'italic', italic: true }] },
    ])).toBe('## A heading\n\nplain **bold** and *italic*');
  });
});
