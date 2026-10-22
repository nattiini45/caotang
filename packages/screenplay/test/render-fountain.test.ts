import type { FlatBlock } from '../src/index.js';
import { describe, expect, it } from 'vitest';
import { createFountainRenderer, importFdx, importFountainScript, renderFountain } from '../src/index.js';
import {
  SCENE_FILE,
  SCRIPT_NON_CANONICAL,
  SCRIPT_NON_CANONICAL_CANONICAL,
  SCRIPT_ONE_ACT,
  SCRIPT_SECTION_SYNOPSIS,
  SCRIPT_TWO_DEPTHS,
  SCRIPT_WITH_TITLE_PAGE,
  text,
} from './fixtures/corpus.js';

/**
 * The flattened blocks a compile would hand the renderer (exporter.md §2, stage 2), built from an
 * import: each section is a chapter (with its synopsis, when it has one), each scene a document with
 * its own body. Document ids are positional, so the synopsis map below keys on the same ids.
 */
function blocksOf(source: string): FlatBlock[] {
  return importFountainScript(source).nodes.map((node, i): FlatBlock => {
    if (node.kind === 'section') {
      return {
        kind: 'chapter',
        title: node.title,
        level: node.depth,
        number: i + 1,
        ...(node.synopsis === '' ? {} : { synopsis: node.synopsis }),
      };
    }
    return { kind: 'scene', docId: `d${i}`, body: node.body, title: node.title, number: i + 1 };
  });
}

function synopsesOf(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  importFountainScript(source).nodes.forEach((node, i) => {
    if (node.kind === 'scene') out[`d${i}`] = node.synopsis;
  });
  return out;
}

describe('renderFountain — byte-identical round trip (screenplay.md §5.1)', () => {
  it('reproduces a one-act script exactly, with its synopses regenerated from the manifest', () => {
    const { text: out, notes } = renderFountain(blocksOf(SCRIPT_ONE_ACT), {
      title: 'The Lighthouse Keeper',
      synopses: synopsesOf(SCRIPT_ONE_ACT),
    });
    expect(out).toBe(SCRIPT_ONE_ACT);
    expect(notes).toEqual([]);
  });

  it('reproduces a standalone scene file exactly', () => {
    const { text: out } = renderFountain(blocksOf(SCENE_FILE), {
      title: 'Scene',
      synopses: synopsesOf(SCENE_FILE),
    });
    expect(out).toBe(SCENE_FILE);
  });

  it('reproduces a section that carries a synopsis, writing it as the = line under its # line', () => {
    const { text: out, notes } = renderFountain(blocksOf(SCRIPT_SECTION_SYNOPSIS), {
      title: 'The Lighthouse Keeper',
      synopses: synopsesOf(SCRIPT_SECTION_SYNOPSIS),
    });
    expect(out).toBe(SCRIPT_SECTION_SYNOPSIS);
    expect(notes).toEqual([]);
  });

  it('writes a section with no synopsis exactly as it did before the synopsis field existed', () => {
    const block: FlatBlock = { kind: 'chapter', title: 'ACT TWO', level: 1, number: 1 };
    expect(renderFountain([block], { title: 'T' }).text).toBe('# ACT TWO\n');
  });

  it('normalises a non-canonical script to its canonical form, and the canonical form is a fixed point', () => {
    const { text: out } = renderFountain(blocksOf(SCRIPT_NON_CANONICAL), {
      title: 'The Lighthouse Keeper',
      synopses: synopsesOf(SCRIPT_NON_CANONICAL),
    });
    expect(out).toBe(SCRIPT_NON_CANONICAL_CANONICAL);
    const again = renderFountain(blocksOf(out), { title: 'The Lighthouse Keeper', synopses: synopsesOf(out) });
    expect(again.text).toBe(SCRIPT_NON_CANONICAL_CANONICAL);
  });

  it('joins a manifest synopsis that spans lines into one, because a Fountain synopsis is one line', () => {
    const { text: out } = renderFountain(
      [{ kind: 'scene', docId: 'd0', body: 'INT. A - DAY\n\nAction.', title: 'INT. A - DAY', number: 1 }],
      { title: 'T', synopses: { d0: 'Elena\nreturns\n  home.' } },
    );
    expect(out).toBe('INT. A - DAY\n= Elena returns home.\n\nAction.\n');
  });

  it('writes every section as a # line, the documented synthesis for deeper sections', () => {
    const { text: out } = renderFountain(blocksOf(SCRIPT_TWO_DEPTHS), {
      title: 'Two depths',
      synopses: synopsesOf(SCRIPT_TWO_DEPTHS),
    });
    expect(out).toBe(SCRIPT_TWO_DEPTHS.replace('## Sequence A', '# Sequence A'));
  });

  it('writes a scene body as stored when no synopsis map is passed', () => {
    const { text: out } = renderFountain(blocksOf(SCRIPT_ONE_ACT), { title: 'The Lighthouse Keeper' });
    expect(out).toContain('INT. HOUSE - DAY\n\nAction paragraph here.');
    expect(out).not.toContain('= Elena');
  });

  it('regenerates the = line under the heading and drops residue lines from the body', () => {
    const { text: out } = renderFountain(
      [{ kind: 'scene', docId: 'd0', body: 'INT. A - DAY\n\nAction.\n= stray\n\nMore.', title: 'INT. A - DAY', number: 1 }],
      { title: 'T', synopses: { d0: 'The point.' } },
    );
    expect(out).toBe('INT. A - DAY\n= The point.\n\nAction.\n\nMore.\n');
  });
});

describe('renderFountain — title page, front matter and back matter', () => {
  it('writes the title page from the template variables, then the blocks', () => {
    const blocks: FlatBlock[] = [
      { kind: 'frontmatter', fmKind: 'titlepage' },
      { kind: 'scene', docId: 'd0', body: 'INT. A - DAY\n\nAction.', title: 'INT. A - DAY', number: 1 },
    ];
    const { text: out } = renderFountain(blocks, { title: 'Keeper', author: 'N. Attini', date: '2026-10-08' });
    expect(out).toBe(
      'Title: Keeper\nCredit: Written by\nAuthor: N. Attini\nDraft date: 2026-10-08\n\nINT. A - DAY\n\nAction.\n',
    );
  });

  it('keeps the title page the source had, through the import and the renderer', () => {
    const script = importFountainScript(SCRIPT_WITH_TITLE_PAGE);
    const blocks = blocksOf(SCRIPT_WITH_TITLE_PAGE);
    const withPage: FlatBlock[] = [{ kind: 'frontmatter', fmKind: 'titlepage' }, ...blocks];
    const { text: out } = renderFountain(withPage, {
      title: script.titlePage?.Title ?? '',
      author: script.titlePage?.Author,
      date: script.titlePage?.['Draft date'],
    });
    expect(out.startsWith('Title: The Lighthouse Keeper\nCredit: Written by\nAuthor: N. Attini\nDraft date: 2026-10-08\n\nINT. LIGHTHOUSE')).toBe(true);
  });

  it('skips copyright and back matter with a note, because a screenplay has neither', () => {
    const blocks: FlatBlock[] = [
      { kind: 'frontmatter', fmKind: 'copyright' },
      { kind: 'backmatter', bmKind: 'about-author' },
    ];
    const { text: out, notes } = renderFountain(blocks, { title: 'T' });
    expect(out).toBe('');
    expect(notes).toEqual([
      'Front matter "copyright" skipped: a screenplay has no copyright page.',
      'Back matter skipped: a screenplay has no back matter.',
    ]);
  });

  it('writes nothing for a separator, because every block already ends with a blank line', () => {
    const blocks: FlatBlock[] = [
      { kind: 'scene', docId: 'd0', body: 'INT. A - DAY', title: 'A', number: 1 },
      { kind: 'separator' },
      { kind: 'scene', docId: 'd1', body: 'INT. B - DAY', title: 'B', number: 2 },
    ];
    expect(renderFountain(blocks, { title: 'T' }).text).toBe('INT. A - DAY\n\nINT. B - DAY\n');
  });
});

describe('renderFountain — line endings and forced headings (screenplay.md §5.1, §2.2)', () => {
  it('reproduces a CRLF one-act script as LF text, the line ending a Fountain export writes', () => {
    const crlf = SCRIPT_ONE_ACT.replace(/\n/g, '\r\n');
    const { text: out, notes } = renderFountain(blocksOf(crlf), {
      title: 'The Lighthouse Keeper',
      synopses: synopsesOf(crlf),
    });
    expect(out).toBe(SCRIPT_ONE_ACT);
    expect(out).not.toContain('\r');
    expect(notes).toEqual([]);
  });

  it('reproduces a CRLF standalone scene file as LF text', () => {
    const crlf = SCENE_FILE.replace(/\n/g, '\r\n');
    const { text: out } = renderFountain(blocksOf(crlf), { title: 'Scene', synopses: synopsesOf(crlf) });
    expect(out).toBe(SCENE_FILE);
  });

  it('keeps a dialogue line that starts with = when it regenerates the synopses', () => {
    const { text: out } = renderFountain(
      [{ kind: 'scene', docId: 'd0', body: 'INT. A - DAY\n\nANNA\n= nothing\n\nMore.', title: 'INT. A - DAY', number: 1 }],
      { title: 'T', synopses: { d0: 'The point.' } },
    );
    expect(out).toBe('INT. A - DAY\n= The point.\n\nANNA\n= nothing\n\nMore.\n');
  });

  it('writes a synopsis under a forced heading, so it stays with its own scene', () => {
    const { text: out } = renderFountain(
      [{ kind: 'scene', docId: 'd0', body: '.HOUSE\n\nAction.', title: 'HOUSE', number: 1 }],
      { title: 'T', synopses: { d0: 'The point.' } },
    );
    expect(out).toBe('.HOUSE\n= The point.\n\nAction.\n');
  });

  it('keeps each synopsis with its own scene through an FDX import and a Fountain export', () => {
    const xml = [
      '<FinalDraft DocumentType="Script">',
      '  <Content>',
      '    <Paragraph Type="Scene Heading"><Text>INT. HOUSE - DAY</Text></Paragraph>',
      '    <Paragraph Type="Action"><Text>Elena enters.</Text></Paragraph>',
      '    <Paragraph Type="Scene Heading"><Text>The hall at dusk</Text></Paragraph>',
      '    <Paragraph Type="Action"><Text>Rain.</Text></Paragraph>',
      '  </Content>',
      '</FinalDraft>',
    ].join('\n');
    const blocks: FlatBlock[] = importFdx(xml).nodes.map((node, i): FlatBlock => {
      if (node.kind === 'section') return { kind: 'chapter', title: node.title, level: node.depth, number: i + 1 };
      return { kind: 'scene', docId: `d${i}`, body: node.body, title: node.title, number: i + 1 };
    });
    const { text: out } = renderFountain(blocks, { title: 'T', synopses: { d0: 'First scene.', d1: 'Second scene.' } });
    const scenes = importFountainScript(out).nodes.filter((node) => node.kind === 'scene');
    expect(scenes.map((scene) => [scene.heading, scene.synopsis])).toEqual([
      ['INT. HOUSE - DAY', 'First scene.'],
      ['The hall at dusk', 'Second scene.'],
    ]);
  });
});

describe('createFountainRenderer', () => {
  it('emits a Blob of the rendered text with a plain-text type', async () => {
    const blob = await createFountainRenderer().emit(blocksOf(SCENE_FILE), {
      title: 'Scene',
      synopses: synopsesOf(SCENE_FILE),
    });
    expect(blob.type).toBe('text/plain; charset=utf-8');
    expect(await blob.text()).toBe(SCENE_FILE);
  });

  it('renders no text for no blocks', () => {
    expect(renderFountain([], { title: 'T' })).toEqual({ text: '', notes: [] });
    expect(text('x')).toBe('x\n');
  });
});

describe('renderFountain — line and trailing white space (linear scans)', () => {
  /** The expressions the renderer used before the single-pass scans; the new code must agree with them. */
  const oneLineBefore = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();
  const titleOf = (title: string): string => renderFountain([{ kind: 'frontmatter', fmKind: 'titlepage' }], { title }).text;
  const SAMPLES = [
    '',
    ' ',
    '\n',
    ' \n ',
    'a\nb',
    'a \n \n b',
    'a\r\nb',
    '\r\n\r\n',
    '  a  b  ',
    'a\u00a0\n\u2003b',
    'a \u2028 b',
    'Élan\n日本語\n',
    '\n\na\n\n',
  ];

  it('joins a title across line breaks as the expression did', () => {
    for (const s of SAMPLES) expect(titleOf(s)).toBe(`Title: ${oneLineBefore(s)}\n`);
    expect(titleOf('A\n  B')).toBe('Title: A B\n');
    expect(titleOf('  \n  ')).toBe('Title: \n');
  });

  it('keeps white space with no line break in it, and turns one that has a break into a single space', () => {
    expect(titleOf('a  b')).toBe('Title: a  b\n');
    expect(titleOf('a \t\r\n \t b')).toBe('Title: a b\n');
  });

  it('strips the trailing white space of a scene body and collapses trailing breaks of the document', () => {
    const scene = (body: string): FlatBlock => ({ kind: 'scene', docId: 'd0', body, title: 'S', number: 1 });
    expect(renderFountain([scene('INT. A - DAY \n\t\r\n')], { title: 'T' }).text).toBe('INT. A - DAY\n');
    expect(renderFountain([scene('')], { title: 'T' }).text).toBe('\n');
    expect(renderFountain([scene('  \n ')], { title: 'T' }).text).toBe('\n');
    expect(renderFountain([scene('Action.\u00a0\u3000')], { title: 'T' }).text).toBe('Action.\n');
  });

  it('stays linear on long runs of white space and line breaks', () => {
    const big = 50_000;
    const start = performance.now();
    titleOf(' '.repeat(big));
    titleOf(`a${'\n'.repeat(big)}b`);
    titleOf(`a${' '.repeat(big)}b`);
    renderFountain([{ kind: 'scene', docId: 'd0', body: `A${' '.repeat(big)}x`, title: 'S', number: 1 }], { title: 'T' });
    renderFountain([{ kind: 'scene', docId: 'd0', body: `A${'\n'.repeat(big)}x\n\n`, title: 'S', number: 1 }], { title: 'T' });
    expect(performance.now() - start).toBeLessThan(500);
  });
});
