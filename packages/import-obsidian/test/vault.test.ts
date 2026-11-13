import { describe, expect, it } from 'vitest';

import { classifyCodexNote, resolveAttachment } from '../src/vault.js';

describe('the Obsidian vault helpers (#281)', () => {
  it('classifies by folder', () => {
    expect(classifyCodexNote('Characters/Elena.md', {}, [])).toBe('character');
    expect(classifyCodexNote('World/Locations/The Ferry.md', {}, [])).toBe('location');
    expect(classifyCodexNote('Items/The Letter.md', {}, [])).toBe('object');
  });

  it('classifies by type property then by tag', () => {
    expect(classifyCodexNote('Notes/Elena.md', { type: 'Character' }, [])).toBe('character');
    expect(classifyCodexNote('Notes/Elena.md', {}, ['character'])).toBe('character');
    expect(classifyCodexNote('Notes/Random.md', {}, ['sea'])).toBeNull();
  });

  it('resolves a unique attachment by name', () => {
    const paths = ['Manuscript/Chapter 1.md', 'assets/cover.png'];
    expect(resolveAttachment('cover.png', 'Manuscript/Chapter 1.md', paths, '')).toBe('assets/cover.png');
    expect(resolveAttachment('missing.png', 'Manuscript/Chapter 1.md', paths, '')).toBeNull();
  });

  it('prefers the configured attachment folder among several matches', () => {
    const paths = ['assets/cover.png', 'Manuscript/attachments/cover.png', 'other/cover.png'];
    expect(resolveAttachment('cover.png', 'Manuscript/Chapter 1.md', paths, 'assets')).toBe('assets/cover.png');
  });

  it('honours ./ as the note’s own folder', () => {
    const paths = ['Manuscript/cover.png', 'assets/cover.png'];
    expect(resolveAttachment('cover.png', 'Manuscript/Chapter 1.md', paths, './')).toBe('Manuscript/cover.png');
  });

  it('falls back to the shortest path when no folder matches', () => {
    const paths = ['a/b/cover.png', 'x/cover.png'];
    expect(resolveAttachment('cover.png', 'Note.md', paths, 'nowhere')).toBe('x/cover.png');
  });
});
