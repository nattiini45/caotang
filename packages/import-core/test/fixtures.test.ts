/**
 * Golden tests: one reader-independent block-list fixture per shape a manuscript arrives in (import-core.md §6), each asserting the
 * proposed tree (titles, levels, scene counts), the front/back matter, the flags and the notices. The fixtures are JSON in
 * `fixtures/`, so a reader's own tests can feed the same shapes.
 */
import { describe, expect, it } from 'vitest';
import { splitImport } from '../src/index.js';
import { fixture, outline } from './helpers.js';

const codes = (r: ReturnType<typeof splitImport>, key: 'flags' | 'notices'): string[] => r[key].map((x) => x.code);

describe('golden fixtures', () => {
  it('a Word manuscript with Title and Heading 1/2 styles: title, chapters at Heading 1, scenes at Heading 2', () => {
    const r = splitImport(fixture('heading-styled'));
    expect(r.title).toEqual({ text: 'The Lighthouse Keeper', blockIndex: 0, source: 'style' });
    expect(r.detected.chapterRule).toEqual({ kind: 'heading', level: 1 });
    expect(r.detected.sceneHeadingLevel).toBe(2);
    expect(outline(r.tree)).toEqual(
      ['Chapter 1: The Landing', 'Chapter 2: Salt', 'Chapter 3: The Lamp', 'Chapter 4: Fog'].flatMap((c) => [
        `chapter: ${c}`,
        '  scene: Scene 1',
        '  scene: Scene 2',
      ]),
    );
    expect(r.frontMatter).toBeUndefined();
    expect(r.flags).toEqual([]);
    expect(codes(r, 'notices')).toEqual(['title-detected']);
    expect(r.stats).toMatchObject({ parts: 0, chapters: 4, scenes: 8 });
    // The scene headings are titles, not body text.
    const scene = r.tree[0]!.kind === 'folder' ? r.tree[0]!.children[0]! : undefined;
    expect(scene?.kind === 'doc' && scene.body).not.toContain('Scene 1');
  });

  it('Shunn format: centred unstyled "Chapter One" after page breaks, "#" breaks, title page as front matter', () => {
    const r = splitImport(fixture('shunn'));
    expect(r.detected.chapterRule).toEqual({ kind: 'pattern' });
    expect(r.detected.families).toEqual([{ family: 'chapter-word', count: 4, accepted: true }]);
    expect(r.detected.markers).toEqual([{ marker: '#', count: 4 }]);
    expect(outline(r.tree)).toEqual(
      ['One', 'Two', 'Three', 'Four'].flatMap((n) => [`chapter: Chapter ${n}`, `  scene: Chapter ${n} · 1`, `  scene: Chapter ${n} · 2`]),
    );
    expect(r.frontMatter).toMatchObject({ kind: 'front', title: 'Before chapter 1', destination: 'research' });
    expect(r.frontMatter?.body).toContain('THE LIGHTHOUSE KEEPER');
    expect(r.frontMatter?.body).toContain('About 4,000 words');
    expect(codes(r, 'notices')).toEqual(['front-matter']);
    // The "#" marker is removed: the scene boundary replaces it.
    for (const ch of r.tree) if (ch.kind === 'folder') for (const s of ch.children) expect(s.kind === 'doc' && s.body).not.toMatch(/^#$/mu);
  });

  it('Parts → Chapters → Scenes: Part folders hold chapter folders; prologue before, epilogue after, at the top level', () => {
    const r = splitImport(fixture('parts'));
    expect(r.title?.text).toBe('The Long Tide');
    expect(r.detected.chapterRule).toEqual({ kind: 'heading', level: 2 });
    expect(r.detected.parts).toEqual({ level: 1 });
    const chapters = (from: number) =>
      [from, from + 1, from + 2].flatMap((c) => [`    chapter: Chapter ${c}`, `      scene: Chapter ${c} · 1`, `      scene: Chapter ${c} · 2`].map((l) => l.slice(2)));
    expect(outline(r.tree)).toEqual([
      'chapter: Prologue [prologue]',
      '  scene: Prologue · 1',
      'part: Part One: Arrival',
      '  text: Part One: Arrival',
      ...chapters(1),
      'part: Part Two: Winter',
      '  text: Part Two: Winter',
      ...chapters(4),
      'chapter: Epilogue [epilogue]',
      '  scene: Epilogue · 1',
    ]);
    expect(r.stats).toMatchObject({ parts: 2, chapters: 8, scenes: 14 });
    const part = r.tree[1]!;
    expect(part.kind === 'folder' && part.children[0]?.kind === 'doc' && part.children[0].body).toBe('An epigraph for the part, kept as its own text.');
    expect(codes(r, 'flags')).toEqual(['chapter-short', 'chapter-short']);
  });

  it('German "Kapitel 1" lines with blank lines around them, and a Danksagung as back matter', () => {
    const r = splitImport(fixture('german'));
    expect(r.detected.chapterRule).toEqual({ kind: 'pattern' });
    expect(outline(r.tree)).toEqual(
      [1, 2, 3].flatMap((c) => [`chapter: Kapitel ${c}`, `  scene: Kapitel ${c} · 1`, `  scene: Kapitel ${c} · 2`]),
    );
    expect(r.backMatter).toHaveLength(1);
    expect(r.backMatter[0]).toMatchObject({ title: 'Danksagung', destination: 'research', body: 'Ich danke meiner Familie für die Geduld.' });
  });

  it('Chinese "第一章" lines: chapters, scenes at ***, words counted per character', () => {
    const r = splitImport(fixture('chinese'));
    expect(r.detected.families).toEqual([{ family: 'cjk-chapter', count: 3, accepted: true }]);
    expect(outline(r.tree)).toEqual(
      ['第一章 风起', '第二章 潮落', '第三章 灯塔'].flatMap((c) => [`chapter: ${c}`, `  scene: ${c} · 1`, `  scene: ${c} · 2`]),
    );
    expect(r.tree[0]!.words).toBeGreaterThan(150);
  });

  it('a table of contents at the start is skipped with a notice and kept in the result', () => {
    const r = splitImport(fixture('toc'));
    expect(outline(r.tree).filter((l) => l.startsWith('chapter'))).toEqual([
      'chapter: Chapter One',
      'chapter: Chapter Two',
      'chapter: Chapter Three',
      'chapter: Chapter Four',
    ]);
    expect(r.toc?.lines).toEqual(['Contents', 'Chapter One\t3', 'Chapter Two\t12', 'Chapter Three\t21', 'Chapter Four\t30']);
    expect(r.notices).toContainEqual({ code: 'toc-skipped', lines: 5 });
    expect(r.frontMatter).toBeUndefined();
    // With the skip off, the TOC lines are front matter, still never chapter boundaries.
    const kept = splitImport(fixture('toc'), { skipToc: false });
    expect(kept.frontMatter?.body).toContain('Chapter Two\t12');
    expect(kept.stats.chapters).toBe(4);
  });

  it('front matter goes to one "Before chapter 1" chunk; Acknowledgements and About the Author to back matter', () => {
    const r = splitImport(fixture('front-back'));
    expect(outline(r.tree)).toEqual([1, 2, 3].flatMap((c) => [`chapter: Chapter ${c}`, `  scene: Chapter ${c} · 1`]));
    expect(r.frontMatter?.body).toBe('The Lighthouse Keeper\n\nCopyright 2026 Jane Writer. All rights reserved.\n\nFor my mother.');
    expect(r.backMatter.map((b) => [b.title, b.body])).toEqual([
      ['Acknowledgements', 'Thanks to everyone at the harbour.'],
      ['About the Author', 'Jane Writer lives by the sea.'],
    ]);
    expect(r.splits.filter((s) => s.kind === 'back-matter').map((s) => s.blockIndex)).toEqual([12, 14]);
    // Nothing is lost when the writer chooses skip: the chunks are still in the result, marked skip.
    const skipped = splitImport(fixture('front-back'), { frontMatter: 'skip', backMatter: 'skip' });
    expect(skipped.frontMatter?.destination).toBe('skip');
    expect(skipped.backMatter.every((b) => b.destination === 'skip')).toBe(true);
  });

  it('mixed chapter families: a strongly signalled "3" joins, and the gap, duplicate and mixed families are flagged', () => {
    const r = splitImport(fixture('mixed-families'));
    expect(outline(r.tree).filter((l) => l.startsWith('chapter'))).toEqual([
      'chapter: Chapter 1',
      'chapter: Chapter 2',
      'chapter: 3',
      'chapter: Chapter 5',
      'chapter: Chapter 5',
    ]);
    expect(r.flags).toEqual([
      { code: 'number-gap', nodeId: 'chapter-9', expected: 4, found: 5 },
      { code: 'number-duplicate', nodeId: 'chapter-12', found: 5 },
      { code: 'mixed-families', families: ['chapter-word', 'number'] },
    ]);
  });

  it('empty "#" headings from a Markdown reader are scene breaks', () => {
    const r = splitImport(fixture('empty-hash-breaks'));
    expect(r.detected.markers).toEqual([{ marker: '#', count: 4 }]);
    expect(outline(r.tree)).toEqual([1, 2].flatMap((c) => [`chapter: Chapter ${c}`, ...[1, 2, 3].map((s) => `  scene: Chapter ${c} · ${s}`)]));
  });

  it('a setext "---" heading is a heading and a thematic "---" is a break', () => {
    const r = splitImport(fixture('setext'));
    expect(r.detected.headingLevels).toEqual([
      { level: 1, count: 2 },
      { level: 2, count: 4 },
    ]);
    expect(r.detected.markers).toEqual([{ marker: '---', count: 2 }]);
    expect(outline(r.tree)).toEqual(
      [1, 2].flatMap((c) => [`chapter: Chapter ${c}`, '  scene: A setext heading', `  scene: Chapter ${c} · 2`, '  scene: Another setext heading']),
    );
  });

  it('a stray "Chapter 3" in a letter and in dialogue does not split the book (repeat rule)', () => {
    const r = splitImport(fixture('stray-chapter'));
    expect(r.detected.families).toEqual([{ family: 'chapter-word', count: 1, accepted: false }]);
    expect(r.detected.chapterRule).toEqual({ kind: 'none' });
    expect(outline(r.tree)).toEqual(['chapter: Manuscript', '  scene: Manuscript · 1', '  scene: Manuscript · 2']);
    const first = r.tree[0]!.kind === 'folder' ? r.tree[0]!.children[0]! : undefined;
    expect(first?.kind === 'doc' && first.body).toContain('\n\nChapter 3\n\n');
    expect(r.notices).toContainEqual({ code: 'no-chapters' });
  });
});
