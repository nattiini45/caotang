/**
 * The Plottr reader's tests (#290, epic #263). The fixture is kindling's `hamlet.pltr` (MIT), a real 698 kB file
 * written by Plottr 2023.7, plus small synthetic files for the shapes the demo does not hold.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readPlottr, slateToMarkdown, SYNOPSIS_CHARS } from '../src/index.js';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const EMPTY_BEATS = { children: { 'null': [] }, heap: {}, index: {} };

describe('the Plottr reader (#290)', () => {
  it('refuses a file that is not a Plottr outline', () => {
    const result = readPlottr(json({ hello: 'world' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not-plottr');
  });

  it('refuses malformed JSON with its own error', () => {
    const result = readPlottr(new TextEncoder().encode('{not json'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('bad-json');
  });

  it('refuses an outline with no books', () => {
    const result = readPlottr(json({ file: {}, series: {}, books: {}, beats: EMPTY_BEATS }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('empty');
  });

  it('reads the real hamlet.pltr into folders, scenes, codex and research', () => {
    const result = readPlottr(fixture('hamlet.pltr'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const read = result.value;
    expect(read.seriesName).toBe('Hamlet');
    expect(read.books).toEqual([{ id: '1', title: 'Hamlet' }]);
    // Five acts as top folders.
    expect(read.folders.map((folder) => folder.title)).toEqual(['Act 1', 'Act 2', 'Act 3', 'Act 4', 'Act 5']);
    const scenes = read.folders.flatMap((folder) => folder.scenes);
    expect(scenes.length).toBeGreaterThan(10);
    const duel = scenes.find((scene) => scene.title === 'The duel between Laertes and Hamlet');
    expect(duel).toBeDefined();
    expect(duel?.synopsis).toContain('Back at Elsinore');
    expect(duel?.synopsis.length).toBeLessThanOrEqual(SYNOPSIS_CHARS);
    // The book's plotlines, including the series line notice.
    expect(read.threads).toContain('Scenes');
    expect(read.seriesThreads).toContain('Main Plot');
    // Codex: Hamlet the character, Elsinore the place.
    const hamlet = read.codex.find((row) => row.name === 'Hamlet');
    expect(hamlet?.kind).toBe('character');
    expect(hamlet?.description).toBe('Prince of Denmark');
    expect(hamlet?.page.body).toContain('Protagonist');
    const els = read.codex.find((row) => row.name === 'Elsinore Castle');
    expect(els?.kind).toBe('place');
    // Research notes.
    expect(read.research.some((note) => note.title === 'Character Chart')).toBe(true);
    // Pictures decoded and sniffed (the file labels PNGs as jpeg).
    expect(read.assets.length).toBeGreaterThan(0);
    for (const asset of read.assets) {
      expect(read.assetData.get(asset.ref)?.length).toBeGreaterThan(0);
    }
  });

  it('keeps a series file\'s books for the picker and reads the chosen one', () => {
    const outline = json({
      file: {},
      series: { name: 'Saga' },
      books: { 1: { id: 1, title: 'First' }, 2: { id: 2, title: 'Second' }, allIds: [1, 2] },
      beats: {
        1: { children: { 'null': [10], 10: [] }, heap: {}, index: { 10: { id: 10, bookId: 1, title: 'Part A' } } },
        2: { children: { 'null': [20], 20: [] }, heap: {}, index: { 20: { id: 20, bookId: 2, title: 'Part B' } } },
      },
      cards: [
        { id: 1, beatId: 10, lineId: 1, position: 0, title: 'Opening', description: [{ type: 'paragraph', children: [{ text: 'It began.' }] }], tags: [], characters: [], places: [] },
        { id: 2, beatId: 20, lineId: 2, position: 0, title: 'Climax', description: [{ type: 'paragraph', children: [{ text: 'It ended.' }] }], tags: [], characters: [], places: [] },
      ],
      lines: [
        { id: 1, bookId: 1, title: 'A-plot' },
        { id: 2, bookId: 2, title: 'B-plot' },
      ],
      characters: [], places: [], notes: [], tags: [], images: {},
    });
    const first = readPlottr(outline);
    expect(first.ok && first.value.books.length).toBe(2);
    expect(first.ok && first.value.folders[0]?.title).toBe('Part A');
    const second = readPlottr(outline, { bookId: '2' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.book.title).toBe('Second');
    expect(second.value.folders[0]?.title).toBe('Part B');
    expect(second.value.folders[0]?.scenes[0]?.title).toBe('Climax');
    expect(second.value.threads).toEqual(['B-plot']);
  });

  it('sends cards without a beat into the orphans and tolerates the flat beats array', () => {
    const outline = json({
      file: {},
      series: {},
      books: { 1: { id: 1, title: 'Solo' }, allIds: [1] },
      beats: { 1: [{ id: 3, title: 'Chapter', children: [] }] },
      cards: [
        { id: 7, beatId: null, lineId: 5, position: 0, title: 'Loose', description: [], tags: [], characters: [], places: [] },
        { id: 8, beatId: 3, lineId: 5, position: 0, title: 'Seated', description: [], tags: [], characters: [], places: [] },
      ],
      lines: [{ id: 5, bookId: 1, title: 'Scenes' }],
      characters: [], places: [], notes: [], tags: [], images: {},
    });
    const result = readPlottr(outline);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.folders[0]?.scenes.map((scene) => scene.title)).toEqual(['Seated']);
    expect(result.value.orphans.map((scene) => scene.title)).toEqual(['Loose']);
  });

  it('sniffs a PNG mislabeled JPEG and turns tags into keywords', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const outline = json({
      file: {},
      series: {},
      books: { 1: { id: 1, title: 'Solo' }, allIds: [1] },
      beats: { 1: { children: { 'null': [3], 3: [] }, heap: {}, index: { 3: { id: 3, bookId: 1, title: 'Beat' } } } },
      cards: [{ id: 1, beatId: 3, lineId: 5, position: 0, title: 'Card', description: [], tags: [9], characters: [1], places: [] }],
      lines: [{ id: 5, bookId: 1, title: 'Main' }],
      characters: [{ id: 1, name: 'Ada', description: '', notes: [], tags: [], imageId: 4, bookIds: [1], Rank: 'Captain' }],
      places: [], notes: [],
      tags: [{ id: 9, title: 'STAGE: Setup' }],
      images: { 4: { id: 4, name: 'ada', data: `data:image/jpeg;base64,${png.toString('base64')}` } },
    });
    const result = readPlottr(outline, { labels: { details: 'Details', attributes: 'Attributes' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value.folders[0]?.scenes[0];
    expect(scene?.keywords).toEqual(['STAGE: Setup', 'Plotline: Main']);
    expect(scene?.characters).toEqual(['Ada']);
    const ada = result.value.codex.find((row) => row.name === 'Ada');
    expect(ada?.page.body).toContain('**Rank**: Captain');
    const asset = result.value.assets[0];
    expect(asset?.mime).toBe('image/png');
    expect(asset?.name).toBe('ada.png');
  });

  it('reports keys a newer Plottr writes that it does not know', () => {
    const outline = json({ file: {}, series: {}, books: { 1: { id: 1, title: 'Solo' }, allIds: [1] }, beats: { 1: EMPTY_BEATS }, cards: [], lines: [], characters: [], places: [], notes: [], tags: [], images: {}, brandNewThing: true });
    const result = readPlottr(outline);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unknownKeys).toEqual(['brandNewThing']);
    expect(result.value.losses.some((loss) => loss.message?.includes('brandNewThing'))).toBe(true);
  });
});

describe('the Slate walker (#290)', () => {
  it('renders paragraphs, marks, links and lists', () => {
    const md = slateToMarkdown([
      { type: 'paragraph', children: [{ text: 'A ' }, { text: 'bold', bold: true }, { text: ' and ' }, { text: 'lean', italic: true }, { text: '.' }] },
      { type: 'heading-two', children: [{ text: 'Middle' }] },
      { type: 'bulleted-list', children: [{ type: 'list-item', children: [{ text: 'one' }] }, { type: 'list-item', children: [{ text: 'two' }] }] },
      { type: 'paragraph', children: [{ type: 'link', url: 'https://example.com', children: [{ text: 'a link' }] }] },
    ]);
    expect(md).toBe('A **bold** and *lean*.\n\n## Middle\n\n- one\n- two\n\n[a link](https://example.com)');
  });

  it('keeps an unsafe link as text only', () => {
    expect(slateToMarkdown([{ type: 'paragraph', children: [{ type: 'link', url: 'javascript:alert(1)', children: [{ text: 'click' }] }] }])).toBe('click');
  });
});
