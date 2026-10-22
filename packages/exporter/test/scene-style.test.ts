/**
 * Per-scene styling — exporter.md §2. A scene marked `section` prints its title as a heading in each prose format; a scene with no
 * style, or a stored value this build does not know, compiles exactly as it did before the field existed.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyManifest, validateManifest } from '@caotang/store';
import { flatten } from '../src/flatten.js';
import { renderMarkdown, renderText } from '../src/render-text.js';
import { droppedStyleNotes, SCENE_STYLE_ROWS } from '../src/scene-style.js';
import { SCENE_STYLES } from '@caotang/bus';
import { DEFAULT_TEMPLATE } from '../src/template.js';
import type { RenderInput } from '../src/render-input.js';
import { IDS, makeProject, PROJECT_NAME, withSceneStyle } from './fixture.js';

function inputOf(state = makeProject()): RenderInput {
  const flat = flatten(state, { includeRootIds: ['manuscript'] }, { titlePage: true });
  return { blocks: flat.blocks, title: PROJECT_NAME, author: 'M. Ortega', date: '2026-10-08', template: DEFAULT_TEMPLATE, toc: true };
}

describe('a scene with no style', () => {
  const plain = { md: renderMarkdown(inputOf()), txt: renderText(inputOf()) };

  it('has no heading of its own in Markdown or plain text', () => {
    expect(plain.md).not.toContain('###');
    expect(plain.txt).not.toContain('THE LANDING');
  });

  it('compiles byte for byte the same when the style is `normal` or one this build does not know', () => {
    for (const stored of ['normal', 'verse']) {
      const state = withSceneStyle(makeProject(), IDS.landing, stored);
      expect(renderMarkdown(inputOf(state))).toBe(plain.md);
      expect(renderText(inputOf(state))).toBe(plain.txt);
    }
  });

  it('carries no style on its flat block', () => {
    const state = withSceneStyle(makeProject(), IDS.landing, 'verse');
    const scenes = flatten(state, { includeRootIds: ['manuscript'] }, { titlePage: false }).blocks.filter((b) => b.kind === 'scene');
    expect(scenes.every((block) => block.kind === 'scene' && !('style' in block))).toBe(true);
  });
});

describe('a section scene', () => {
  const state = withSceneStyle(makeProject(), IDS.landing, 'section');

  it('prints `### {title}` above its body in Markdown', () => {
    const md = renderMarkdown(inputOf(state));
    expect(md).toContain('### The Landing\n\nThe ferry was late, as always.');
    expect(md.match(/^### /gm)).toHaveLength(1);
  });

  it('prints {TITLE} in upper case above its body in plain text', () => {
    const txt = renderText(inputOf(state));
    expect(txt).toContain('CHAPTER 1. CHAPTER ONE\n\nTHE LANDING\n\nThe ferry was late, as always.');
  });

  it('leaves the Markdown contents list as the chapter list', () => {
    expect(renderMarkdown(inputOf(state))).not.toContain('[The Landing]');
  });

  it('prints nothing for a blank title', () => {
    const blank = withSceneStyle(makeProject(), IDS.landing, 'section');
    blank.manifest.tree.find((node) => node.id === IDS.landing)!.title = '  ';
    expect(renderMarkdown(inputOf(blank))).not.toContain('###');
  });
});

describe('a stored style this build does not know', () => {
  it('loads as the string it is, and the load notice names the value once', () => {
    const manifest = createEmptyManifest('Styles');
    manifest.tree.push({
      id: 'n_3W8RN2TQ6C',
      parentId: 'manuscript',
      type: 'document',
      title: 'A',
      order: 10,
      status: null,
      label: null,
      keywords: [],
      synopsis: '',
      notes: '',
      style: 'verse',
    });
    const report = validateManifest(manifest, { docFiles: ['n_3W8RN2TQ6C.md'] });
    expect(report.ok).toBe(true);
    const notices = report.warnings.filter((warning) => warning.message.includes('"verse"'));
    expect(notices).toHaveLength(1);
    expect(manifest.tree.at(-1)?.style).toBe('verse');
  });

  it('is rendered as a normal scene', () => {
    const state = withSceneStyle(makeProject(), IDS.landing, 'verse');
    expect(renderMarkdown(inputOf(state))).not.toContain('###');
  });
});

describe('the vocabulary', () => {
  it('has a row for every style but `normal`, and no other', () => {
    expect(SCENE_STYLE_ROWS.map((row) => row.id)).toEqual(SCENE_STYLES.filter((style) => style !== 'normal'));
  });

  it('names a dropped style once, in words, and nothing for a style the format expresses', () => {
    const blocks = [
      { kind: 'scene', docId: 'a', title: 'A', body: 'x', number: 1, style: 'verse' },
      { kind: 'scene', docId: 'b', title: 'B', body: 'x', number: 2, style: 'verse' },
      { kind: 'scene', docId: 'c', title: 'C', body: 'x', number: 3, style: 'section' },
    ] as const;
    const rows = [...SCENE_STYLE_ROWS, { id: 'verse', formats: ['docx' as const] }];
    expect(droppedStyleNotes(blocks, 'txt', rows)).toEqual(['the `verse` style has no meaning in the plain-text format, so it was dropped']);
    expect(droppedStyleNotes(blocks, 'docx', rows)).toEqual([]);
  });
});
