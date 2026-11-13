/**
 * The TextBundle / TextPack reader (#282, epic #263): app detection, the Ulysses / Bear / iA Writer mappings, and the bundle read.
 * Synthetic fixtures only.
 */

import { describe, expect, it } from 'vitest';
import { appOf, ulyssesComments, bearTags, iaAuthorship, readTextBundle } from '../src/index.js';
import { openZip } from '@caotang/import-read/zip';
import { textZip } from '../../import-read/test/zip-fixtures.js';

describe('app detection', () => {
  it('names Ulysses, Bear and iA Writer from creatorIdentifier', () => {
    expect(appOf({ creatorIdentifier: 'com.ulyssesapp.mac' })).toBe('ulysses');
    expect(appOf({ creatorIdentifier: 'net.shinyfrog.bear' })).toBe('bear');
    expect(appOf({ creatorIdentifier: 'pro.writer.mac' })).toBe('ia-writer');
    expect(appOf({})).toBe('generic');
  });
});

describe('Ulysses comments', () => {
  it('moves %% paragraphs and ++inline++ comments to notes', () => {
    const { body, notes } = ulyssesComments('Text %%a note\nMore ++inline++ here.');
    expect(body).not.toContain('%%');
    expect(body).not.toContain('++');
    expect(notes).toContain('a note');
    expect(notes).toContain('inline');
  });
});

describe('Bear tags', () => {
  it('collects open, nested and closed tags as keywords', () => {
    const { keywords } = bearTags('Text #sea #nested/tag and #multi word tag# here.', '');
    expect(keywords).toContain('sea');
    expect(keywords).toContain('nested/tag');
    expect(keywords).toContain('multi word tag');
  });

  it('strips a leading H1 equal to the title', () => {
    const { body } = bearTags('# The Landing\n\nText.', 'The Landing');
    expect(body).not.toContain('# The Landing');
    expect(body).toContain('Text.');
  });
});

describe('iA Writer Authorship', () => {
  it('strips the trailing Authorship block', () => {
    const { body, stripped } = iaAuthorship('Text.\n---\nauthor: Jane\n...');
    expect(stripped).toBe(true);
    expect(body).toBe('Text.');
  });

  it('leaves text without an Authorship block untouched', () => {
    const { body, stripped } = iaAuthorship('Just text.');
    expect(stripped).toBe(false);
    expect(body).toBe('Just text.');
  });
});

describe('readTextBundle', () => {
  it('reads a TextPack with info.json, text and an asset', async () => {
    const zip = textZip({
      'info.json': JSON.stringify({ version: 2, type: 'net.daringfireball.markdown', creatorIdentifier: 'com.ulyssesapp.mac', title: 'The Landing' }),
      'text.md': '# Chapter\n\nThe ferry came. %%a note\n\n![pier](assets/pier.png)',
      'assets/pier.png': 'fake-png',
    });
    const opened = await openZip(zip);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = await readTextBundle(opened.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.app).toBe('ulysses');
    expect(result.value.title).toBe('The Landing');
    expect(result.value.assetData.size).toBe(1);
  });

  it('refuses a bundle with no text', async () => {
    const opened = await openZip(textZip({ 'info.json': '{}' }));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = await readTextBundle(opened.value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-text');
  });

  it('routes a Fountain bundle to the Fountain importer', async () => {
    const opened = await openZip(textZip({ 'info.json': '{}', 'text.fountain': 'INT. HOUSE - DAY' }));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = await readTextBundle(opened.value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('fountain');
  });
});
