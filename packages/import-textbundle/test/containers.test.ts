/**
 * The containers issue #282 names beside a lone TextBundle: a Bear `.bear2bk` backup (many bundles, dates, tags), a Ulysses group
 * export, and an iA Writer project whose index lists Content Blocks. Synthetic fixtures only.
 */
import { describe, expect, it } from 'vitest';
import { openZip } from '@caotang/import-read/zip';
import { textZip } from '../../import-read/test/zip-fixtures.js';
import { bundleDates, readTextBundle } from '../src/index.js';

const bearInfo = (title: string, created: string, modified: string): string =>
  JSON.stringify({ version: 2, creatorIdentifier: 'net.shinyfrog.bear', title, 'net.shinyfrog.bear': { creationDate: created, modificationDate: modified } });

const BACKUP = {
  'Bear Notes/BBB.textbundle/info.json': bearInfo('The Lamp', '2024-05-02T10:00:00Z', '2024-06-02T10:00:00Z'),
  'Bear Notes/BBB.textbundle/text.md': '# The Lamp\n\nShe lit the lamp. #sea #harbour/night\n',
  'Bear Notes/AAA.textbundle/info.json': bearInfo('The Landing', '2024-05-01T10:00:00Z', '2024-05-03T10:00:00Z'),
  'Bear Notes/AAA.textbundle/text.md': '# The Landing\n\nThe ferry came. #sea and #a closed tag#\n',
  'Bear Notes/AAA.textbundle/assets/pier.png': 'the-pier-picture',
};

const headings = (blocks: readonly { kind: string; text?: string }[]): string[] =>
  blocks.filter((block) => block.kind === 'heading').map((block) => block.text ?? '');

async function read(files: Record<string, string>) {
  const opened = await openZip(textZip(files));
  if (!opened.ok) throw new Error(opened.error.message);
  return readTextBundle(opened.value);
}

describe('a Bear .bear2bk backup', () => {
  it('imports every note as a chapter, oldest first, with its title from info.json', async () => {
    const result = await read(BACKUP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.app).toBe('bear');
    expect(result.value.container).toBe('bear-backup');
    expect(result.value.bundles.map((note) => note.title)).toEqual(['The Landing', 'The Lamp']);
    expect(headings(result.value.document.blocks)).toEqual(['The Landing', 'The Lamp']);
    const text = JSON.stringify(result.value.document.blocks);
    expect(text).toContain('The ferry came.');
    expect(text).toContain('She lit the lamp.');
    // The leading H1 equal to the note's title is stripped, so the title is not written twice.
    expect(text).not.toContain('# The Landing\\n');
  });

  it('keeps each note’s tags on its own scene, not on the whole import', async () => {
    const result = await read(BACKUP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [landing, lamp] = result.value.bundles;
    expect(landing?.keywords).toEqual(['sea', 'a closed tag']);
    expect(lamp?.keywords).toEqual(['sea', 'harbour/night']);
    expect(result.value.frontMatter[landing!.unit]?.scene.keywords).toEqual(['sea', 'a closed tag']);
    expect(result.value.frontMatter[lamp!.unit]?.scene.keywords).toEqual(['sea', 'harbour/night']);
    expect(result.value.notices).toContainEqual({ kind: 'bear-tags', count: 4 });
  });

  it('reads the creation and modification dates and says how many notes carry them', async () => {
    const result = await read(BACKUP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundles[0]?.created).toBe('2024-05-01T10:00:00Z');
    expect(result.value.bundles[0]?.modified).toBe('2024-05-03T10:00:00Z');
    expect(result.value.notices).toContainEqual({ kind: 'bear-dates', count: 2 });
  });

  it('reads the dates from the TextBundle fields too, and reports none when there are none', () => {
    expect(bundleDates({ creationDate: '2024-01-01', modificationDate: '2024-02-02' })).toEqual({ created: '2024-01-01', modified: '2024-02-02' });
    expect(bundleDates({})).toEqual({});
    expect(bundleDates({ 'net.shinyfrog.bear': { creationDate: '' } })).toEqual({});
  });
});

describe('a Ulysses group export', () => {
  const GROUP = {
    'Group/01 Sheet.textbundle/info.json': JSON.stringify({ creatorIdentifier: 'com.ulyssesapp.mac', title: 'Chapter One' }),
    'Group/01 Sheet.textbundle/text.md': 'The ferry came. %%cut this\n\nMore ++inline++ here.',
    'Group/02 Sheet.textbundle/info.json': JSON.stringify({ creatorIdentifier: 'com.ulyssesapp.mac', title: 'Chapter Two' }),
    'Group/02 Sheet.textbundle/text.md': 'The letter arrived.',
    'Group/10 Sheet.textbundle/info.json': JSON.stringify({ creatorIdentifier: 'com.ulyssesapp.mac', title: 'Chapter Ten' }),
    'Group/10 Sheet.textbundle/text.md': 'Much later.',
  };

  it('imports the sheets in folder order, numbers natural, with their comments as notes', async () => {
    const result = await read(GROUP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.container).toBe('group');
    expect(result.value.bundles.map((note) => note.title)).toEqual(['Chapter One', 'Chapter Two', 'Chapter Ten']);
    expect(result.value.notices).toContainEqual({ kind: 'ulysses-comments', count: 2 });
    const unit = result.value.bundles[0]!.unit;
    expect(result.value.frontMatter[unit]?.notes).toBe('cut this\n\ninline');
    expect(JSON.stringify(result.value.document.blocks)).not.toContain('%%');
  });

  it('keeps each sheet’s picture with its own bytes', async () => {
    const result = await read({
      'G/01.textbundle/info.json': JSON.stringify({ creatorIdentifier: 'com.ulyssesapp.mac', title: 'One' }),
      'G/01.textbundle/text.md': '![pier](assets/pier.png)',
      'G/01.textbundle/assets/pier.png': 'the-first-picture',
      'G/02.textbundle/info.json': JSON.stringify({ creatorIdentifier: 'com.ulyssesapp.mac', title: 'Two' }),
      'G/02.textbundle/text.md': '![lamp](assets/lamp.png)',
      'G/02.textbundle/assets/lamp.png': 'the-second-picture-longer',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const assets = result.value.document.assets ?? [];
    expect(assets).toHaveLength(2);
    expect(assets.map((asset) => new TextDecoder().decode(result.value.assetData.get(asset.ref)))).toEqual([
      'the-first-picture',
      'the-second-picture-longer',
    ]);
    expect(assets.map((asset) => asset.name)).toEqual(['pier.png', 'lamp.png']);
  });
});

describe('an iA Writer project archive', () => {
  const PROJECT = {
    'Book.textbundle/info.json': JSON.stringify({ creatorIdentifier: 'pro.writer.mac', title: 'The Book' }),
    'Book.textbundle/text.md': ['# The Book', '', '/Chapter 2.md', '/images/lamp.png "The lamp"', '/data.csv', '/Chapter 1.md', '', '---', 'author: Jane', '...'].join('\n'),
    'Book.textbundle/Chapter 1.md': '# Chapter One\n\nThe ferry came.',
    'Book.textbundle/Chapter 2.md': '# Chapter Two\n\nThe letter arrived.',
    'Book.textbundle/data.csv': 'Name,Place\nAda,The Rock',
    'Book.textbundle/images/lamp.png': 'the-lamp-picture',
  };

  it('takes the blocks in index order, strips the Authorship block and imports the picture', async () => {
    const result = await read(PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.container).toBe('single');
    expect(result.value.app).toBe('ia-writer');
    const text = JSON.stringify(result.value.document.blocks);
    expect(text.indexOf('The letter arrived.')).toBeLessThan(text.indexOf('The ferry came.'));
    expect(text).not.toContain('author: Jane');
    expect(result.value.notices).toContainEqual({ kind: 'ia-authorship' });
    expect(result.value.notices).toContainEqual({ kind: 'ia-content-blocks', count: 3 });
    const assets = result.value.document.assets ?? [];
    expect(assets).toHaveLength(1);
    expect(new TextDecoder().decode(result.value.assetData.get(assets[0]!.ref))).toBe('the-lamp-picture');
  });

  it('turns the CSV into paragraphs and names it as an approximation', async () => {
    const result = await read(PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = JSON.stringify(result.value.document.blocks);
    expect(text).toContain('Name, Place');
    expect(text).toContain('Ada, The Rock');
    expect(result.value.notices).toContainEqual({ kind: 'ia-csv', count: 1 });
  });

  it('names a block it cannot resolve and one it does not read, keeping their lines as text', async () => {
    const result = await read({
      'Book.textbundle/info.json': JSON.stringify({ creatorIdentifier: 'pro.writer.mac' }),
      'Book.textbundle/text.md': '/gone.md\n/notes.pdf',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notices).toContainEqual({ kind: 'ia-block-missing', paths: ['gone.md'] });
    expect(result.value.notices).toContainEqual({ kind: 'ia-block-unsupported', paths: ['notes.pdf'] });
    expect(JSON.stringify(result.value.document.blocks)).toContain('/gone.md');
  });
});

describe('a lone TextBundle still reads as one document', () => {
  it('keeps its file name as the unit and adds no chapter heading of its own', async () => {
    const result = await read({
      'info.json': JSON.stringify({ creatorIdentifier: 'com.ulyssesapp.mac', title: 'The Landing' }),
      'text.md': '# Chapter\n\nThe ferry came.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.container).toBe('single');
    expect(result.value.bundles).toHaveLength(1);
    expect(result.value.bundles[0]?.unit).toBe('text.md');
    expect(headings(result.value.document.blocks)).toEqual(['Chapter']);
    expect(result.value.title).toBe('The Landing');
  });
});
