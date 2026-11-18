/**
 * The Markdown reader (#280, epic #263): the body parser, the front-matter
 * mapping, and the single-file / folder / zip reads. Synthetic fixtures only.
 */

import { describe, expect, it } from 'vitest';
import {
  parseMarkdownBody,
  splitFrontMatter,
  mapFrontMatter,
  readMarkdownFile,
  readMarkdownArchive,
  naturalCompare,
} from '../src/index.js';
import { openZip } from '@caotang/import-read/zip';
import { textZip } from '../../import-read/test/zip-fixtures.js';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

describe('Markdown body parser', () => {
  it('reads ATX headings with their level and keeps an empty heading empty', () => {
    const { blocks } = parseMarkdownBody('# Chapter\n\n## Scene\n\n#\n\nText.');
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: 'Chapter' });
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 2, text: 'Scene' });
    expect(blocks[2]).toMatchObject({ kind: 'heading', level: 1, text: '' });
    expect(blocks[3]).toMatchObject({ kind: 'para', text: 'Text.' });
  });

  it('reads a setext underline as a heading, not a thematic break', () => {
    const { blocks } = parseMarkdownBody('The Landing\n---\n\nText.');
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2, text: 'The Landing' });
    expect(blocks[1]).toMatchObject({ kind: 'para', text: 'Text.' });
  });

  it('reads === setext as a level-1 heading', () => {
    const { blocks } = parseMarkdownBody('Part One\n===');
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: 'Part One' });
  });

  it('reads thematic breaks as break blocks with their marker', () => {
    const { blocks } = parseMarkdownBody('One.\n\n***\n\nTwo.\n\n* * *\n\nThree.');
    expect(blocks.filter((b) => b.kind === 'break')).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ kind: 'break', marker: '***' });
  });

  it('keeps footnote references inline and collects definitions', () => {
    const { blocks, footnotes } = parseMarkdownBody('A claim[^1].\n\n[^1]: The note.');
    expect(blocks[0]).toMatchObject({ kind: 'para' });
    expect((blocks[0] as { text: string }).text).toContain('[^1]');
    expect(footnotes).toHaveLength(1);
    expect(footnotes[0]).toMatchObject({ label: '1', md: 'The note.' });
  });

  it('degrades a table to prose with a table loss', () => {
    const { blocks, losses } = parseMarkdownBody('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(blocks[0]).toMatchObject({ kind: 'other', loss: 'table' });
    expect(losses.some((l) => l.code === 'table')).toBe(true);
  });

  it('degrades a task list to prose with a formatting loss', () => {
    const { blocks, losses } = parseMarkdownBody('- [ ] todo\n- [x] done');
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { text: string }).text).toContain('[todo]');
    expect((blocks[1] as { text: string }).text).toContain('[done]');
    expect(losses.some((l) => l.code === 'formatting')).toBe(true);
  });

  it('reads a standalone image as an image block with an import token', () => {
    const { blocks, imageRefs, imageTargets } = parseMarkdownBody('![A pier](assets/pier.png)');
    expect(blocks[0]).toMatchObject({ kind: 'image', assetRef: 'import:markdown-image-1', alt: 'A pier' });
    expect(imageRefs).toEqual(['import:markdown-image-1']);
    expect(imageTargets.get('import:markdown-image-1')).toBe('assets/pier.png');
  });

  it('rewrites an inline image to its token without breaking the paragraph', () => {
    const { blocks, imageRefs } = parseMarkdownBody('See ![pier](assets/pier.png) here.');
    expect(blocks[0]).toMatchObject({ kind: 'para' });
    expect((blocks[0] as { md: string }).md).toContain('](import:markdown-image-1)');
    expect(imageRefs).toEqual(['import:markdown-image-1']);
  });

  it('keeps a fenced code block whole as one block', () => {
    const { blocks } = parseMarkdownBody('```\ncode\n```\n\nAfter.');
    expect(blocks[0]).toMatchObject({ kind: 'para' });
    expect((blocks[0] as { md: string }).md).toContain('code');
    expect(blocks[1]).toMatchObject({ kind: 'para', text: 'After.' });
  });

  it('tags every block with its source unit', () => {
    const { blocks } = parseMarkdownBody('# Chapter', '01/chapter.md');
    expect(blocks[0]).toMatchObject({ src: { sourceUnit: '01/chapter.md' } });
  });
});

describe('front matter split and mapping', () => {
  it('splits a YAML fence from the body', () => {
    const { front, format, body } = splitFrontMatter('---\ntitle: The Landing\n---\n\nText.');
    expect(format).toBe('yaml');
    expect(front).toBe('title: The Landing');
    expect(body).toBe('Text.');
  });

  it('splits a TOML fence from the body', () => {
    const { front, format, body } = splitFrontMatter('+++\ntitle = "The Landing"\n+++\n\nText.');
    expect(format).toBe('toml');
    expect(front).toBe('title = "The Landing"');
    expect(body).toBe('Text.');
  });

  it('leaves text without a fence untouched', () => {
    const { front, body } = splitFrontMatter('Just text.');
    expect(front).toBeNull();
    expect(body).toBe('Just text.');
  });

  it('does not treat an unclosed opener as front matter', () => {
    const { front, body } = splitFrontMatter('---\ntitle: X\n\nNo closer.');
    expect(front).toBeNull();
    expect(body).toContain('---');
  });

  it('maps the known keys and keeps every other key as notes', () => {
    const front = [
      'title: The Landing',
      'synopsis: Elena returns.',
      'tags:',
      '  - sea',
      '  - grief',
      'pov: Elena',
      'day: 3',
      'prologue: true',
      'custom: keep me',
    ].join('\n');
    const mapped = mapFrontMatter(front, 'yaml');
    expect(mapped.metadata.title).toBe('The Landing');
    expect(mapped.scene.synopsis).toBe('Elena returns.');
    expect(mapped.scene.keywords).toEqual(['sea', 'grief']);
    expect(mapped.scene.pov).toBe('Elena');
    expect(mapped.scene.dayOffset).toBe(3);
    expect(mapped.scene.storyPart).toBe('prologue');
    expect(mapped.notes).toContain('custom: keep me');
    expect(mapped.notes).not.toContain('title:');
  });

  it('maps summary and keywords aliases, and storyDay', () => {
    const mapped = mapFrontMatter('summary: A short one.\nkeywords: [a, b]\nstoryDay: 7', 'yaml');
    expect(mapped.scene.synopsis).toBe('A short one.');
    expect(mapped.scene.keywords).toEqual(['a', 'b']);
    expect(mapped.scene.dayOffset).toBe(7);
  });

  it('reads TOML title and tags', () => {
    const mapped = mapFrontMatter('title = "The Landing"\ntags = ["sea", "grief"]', 'toml');
    expect(mapped.metadata.title).toBe('The Landing');
    expect(mapped.scene.keywords).toEqual(['sea', 'grief']);
  });
});

describe('single-file read', () => {
  it('reads a file with front matter into blocks and facts', () => {
    const result = readMarkdownFile(bytes('---\ntitle: The Landing\npov: Elena\n---\n\n# Chapter\n\nText.'), 'novel.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('The Landing');
    expect(result.value.document.blocks[0]).toMatchObject({ kind: 'heading', text: 'Chapter' });
    expect(result.value.frontMatter['novel.md']?.scene.pov).toBe('Elena');
  });

  it('falls back to the file name for the title', () => {
    const result = readMarkdownFile(bytes('# Chapter'), '01-the-landing.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('the-landing');
  });
});

describe('natural sort', () => {
  it('orders numeric prefixes numerically, not lexicographically', () => {
    const sorted = ['10.md', '2.md', '1.md'].sort(naturalCompare);
    expect(sorted).toEqual(['1.md', '2.md', '10.md']);
  });
});

describe('archive read', () => {
  it('reads a zip of chapters and scenes in natural order with source units', async () => {
    const zip = textZip({
      '01-start/02-scene.md': 'Second scene.',
      '01-start/01-scene.md': '---\npov: Elena\n---\n\nFirst scene.',
      '02-end/01-scene.md': 'Last scene.',
    });
    const opened = await openZip(zip);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = await readMarkdownArchive(opened.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const units = result.value.document.blocks.map((b) => (b.kind === 'para' ? b.src?.sourceUnit : undefined));
    expect(units).toEqual(['01-start/01-scene.md', '01-start/02-scene.md', '02-end/01-scene.md']);
    expect(result.value.frontMatter['01-start/01-scene.md']?.scene.pov).toBe('Elena');
  });

  it('refuses an archive with no Markdown', async () => {
    const opened = await openZip(textZip({ 'notes.txt': 'hello' }));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = await readMarkdownArchive(opened.value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-markdown');
  });

  it('resolves a relative image against the archive', async () => {
    const zip = textZip({
      'chapter/scene.md': '![pier](assets/pier.png)',
      'chapter/assets/pier.png': 'fake-png-bytes',
    });
    const opened = await openZip(zip);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = await readMarkdownArchive(opened.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asset = result.value.document.assets?.find((a) => a.ref === 'import:markdown-image-0-1');
    expect(asset?.bytes).toBe('fake-png-bytes'.length);
    expect(new TextDecoder().decode(result.value.assetData.get('import:markdown-image-0-1'))).toBe('fake-png-bytes');
  });

  it('keeps two files’ pictures apart: each keeps its own bytes', async () => {
    const zip = textZip({
      'one.md': '![first](assets/one.png)',
      'two.md': '![second](assets/two.png)',
      'assets/one.png': 'the-first-picture',
      'assets/two.png': 'the-second-picture-longer',
    });
    const opened = await openZip(zip);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = await readMarkdownArchive(opened.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const assets = result.value.document.assets ?? [];
    expect(assets).toHaveLength(2);
    const bytes = assets.map((asset) => new TextDecoder().decode(result.value.assetData.get(asset.ref)));
    expect(bytes).toEqual(['the-first-picture', 'the-second-picture-longer']);
    expect(assets.map((asset) => asset.bytes)).toEqual(['the-first-picture'.length, 'the-second-picture-longer'.length]);
  });
});
