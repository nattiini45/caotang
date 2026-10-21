import type { FlatBlock } from '../src/index.js';
import { describe, expect, it } from 'vitest';
import {
  createFdxRenderer,
  importFdx,
  importFountainScript,
  parseFdxParagraphs,
  renderFdx,
} from '../src/index.js';
import { FDX_SAMPLE, SCRIPT_ONE_ACT, text } from './fixtures/corpus.js';

function blocksOf(source: string): FlatBlock[] {
  return importFountainScript(source).nodes.map((node, i): FlatBlock => {
    if (node.kind === 'section') return { kind: 'chapter', title: node.title, level: node.depth, number: i + 1 };
    return { kind: 'scene', docId: `d${i}`, body: node.body, title: node.title, number: i + 1 };
  });
}

describe('parseFdxParagraphs — the typed paragraphs of an FDX file', () => {
  it('reads every paragraph in order, with its type, its text and its container', () => {
    const paragraphs = parseFdxParagraphs(FDX_SAMPLE);
    expect(paragraphs.map((p) => p.type)).toEqual([
      'Scene Heading',
      'Action',
      'Character',
      'Parenthetical',
      'Dialogue',
      'Transition',
      'Scene Heading',
      'Action',
      'General',
      'General',
      'Character',
      'Dialogue',
      'Character',
      'Dialogue',
    ]);
    expect(paragraphs[1]?.text).toBe('Elena & Marcus enter. "Quiet," she says.');
    expect(paragraphs[9]?.alignment).toBe('Center');
    expect(paragraphs[0]).toMatchObject({ lengthEighths: 8, container: null });
    expect(paragraphs[10]).toMatchObject({ container: 0 });
  });

  it('drops a paragraph whose closing tag is missing, as it always has', () => {
    const xml = [
      '<Paragraph Type="Scene Heading"><Text>INT. A - DAY</Text></Paragraph>',
      '<Paragraph Type="Action"><Text>Never closed',
    ].join('');
    expect(parseFdxParagraphs(xml).map((p) => p.type)).toEqual(['Scene Heading']);
  });

  it('reads a file whose closing tags are missing in linear time', () => {
    const truncated = (count: number): string => '<Paragraph Type="Action">'.repeat(count);
    // The best of three runs: the minimum is the measurement a GC pause or a busy CI runner distorted least, so the
    // bounds below fail on a real complexity regression, not on wall-clock noise.
    //
    // **The bound is measured, not asserted.** Measured on this machine, on 2026-10-21: the linear scan costs 2.6 ms
    // for 20 000 paragraphs and 4.8 ms for 40 000 — a ratio of 2 (2.15 was the worst of twenty rounds with every core
    // of the machine busy). The scan this PR replaced, the regex that looked for a closing tag from every opening tag,
    // cost 493 ms and 2 545 ms on the same two files — a ratio of 5. The relative bound is 3: loose enough that a
    // loaded machine passes it, tight enough that the quadratic fails it. The bound is a ratio and carries no absolute
    // term, so a scan that turned quadratic again is caught however fast the machine ran it; the absolute bound beside
    // it catches a scan that is slow in itself.
    const timed = (count: number): number => {
      const source = truncated(count);
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = performance.now();
        expect(parseFdxParagraphs(source)).toEqual([]);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    parseFdxParagraphs(truncated(1000));
    const small = timed(20_000);
    const large = timed(40_000);
    const ratio = large / small;
    expect(large, `40 000 paragraphs took ${Math.round(large)} ms`).toBeLessThan(1000);
    expect(ratio, `${Math.round(large)} ms for 40 000 paragraphs against ${Math.round(small)} ms for 20 000`).toBeLessThan(3);
    // The timeout is generous, so a scan that turned quadratic again reports the ratio above instead of timing out.
  }, 30_000);
});

describe('importFdx — the characters a numeric reference may name', () => {
  it('reads a reference to a character XML allows', () => {
    const xml = '<Paragraph Type="Action"><Text>a&#x41;b&#9;c</Text></Paragraph>';
    expect(parseFdxParagraphs(xml)[0]?.text).toBe('aAb\tc');
  });

  it('keeps a reference to a surrogate or a control character as it was written', () => {
    const xml = '<Paragraph Type="Action"><Text>a&#xD800;b&#x0;c</Text></Paragraph>';
    expect(parseFdxParagraphs(xml)[0]?.text).toBe('a&#xD800;b&#x0;c');
  });

  it('imports no lone surrogate and no control character into a scene body', () => {
    const xml = '<Paragraph Type="Scene Heading"><Text>INT. A - DAY</Text></Paragraph><Paragraph Type="Action"><Text>a&#xD800;b&#x0;c</Text></Paragraph>';
    const body = importFdx(xml).nodes.map((node) => (node.kind === 'scene' ? node.body : '')).join('\n');
    const codes = [...body].map((ch) => ch.codePointAt(0) ?? 0);
    expect(codes.filter((code) => code >= 0xd800 && code <= 0xdfff)).toEqual([]);
    expect(codes.filter((code) => code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd)).toEqual([]);
  });
});

describe('importFdx — FDX to scenes (screenplay.md §5.2)', () => {
  it('maps each Scene Heading to a scene, with its SceneProperties length, and keeps the body in order', () => {
    const script = importFdx(FDX_SAMPLE);
    const scenes = script.nodes.filter((node) => node.kind === 'scene');
    expect(scenes.map((scene) => [scene.heading, scene.lengthEighths])).toEqual([
      ['INT. HOUSE - DAY', 8],
      ['EXT. STREET - NIGHT', null],
    ]);
    const [first, second] = scenes;
    expect(first?.kind === 'scene' ? first.body : '').toBe(
      [
        'INT. HOUSE - DAY',
        '',
        'Elena & Marcus enter. "Quiet," she says.',
        '',
        'ELENA',
        '(whispering)',
        "I'm home.",
        '',
        'CUT TO:',
      ].join('\n'),
    );
    expect(second?.kind === 'scene' ? second.body : '').toContain('THE END');
  });

  it('writes the second cue of a DualDialogue container with the dual marker', () => {
    const body = importFdx(FDX_SAMPLE).nodes.map((node) => (node.kind === 'scene' ? node.body : '')).join('\n');
    expect(body).toContain('ELENA\nLeft.');
    expect(body).toContain('MARCUS ^\nRight.');
    expect(body).toContain('> FIN <');
  });

  it('reports an unknown paragraph type as an action, with a notice', () => {
    const xml = [
      '<FinalDraft DocumentType="Script">',
      '  <Content>',
      '    <Paragraph Type="Scene Heading"><Text>INT. A - DAY</Text></Paragraph>',
      '    <Paragraph Type="Lyric"><Text>Sing.</Text></Paragraph>',
      '  </Content>',
      '</FinalDraft>',
    ].join('\n');
    const script = importFdx(xml);
    expect(script.notices).toContain('Paragraph type "Lyric" imported as action.');
  });
});

describe('renderFdx — emit to the D11 set', () => {
  it('writes typed paragraphs, the SceneProperties from pagination, and never sections or synopses', () => {
    const { xml, notes } = renderFdx(blocksOf(SCRIPT_ONE_ACT), { title: 'The Lighthouse Keeper' });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true);
    expect(xml).toContain('<FinalDraft DocumentType="Script"');
    expect(xml).toContain('<Paragraph Type="Scene Heading"><SceneProperties Length="');
    expect(xml).toContain('Page="1"/><Text>INT. HOUSE - DAY</Text>');
    expect(xml).toContain('<Paragraph Type="Character"><Text>ELENA</Text></Paragraph>');
    expect(xml).toContain('<Paragraph Type="Transition"><Text>FADE OUT.</Text></Paragraph>');
    expect(xml).not.toContain('ACT ONE');
    expect(xml).not.toContain('Elena returns');
    expect(notes).toContain('Dual dialogue written as sequential paragraphs: the DualDialogue container is not emitted.');
  });

  it('escapes the XML-significant characters in text', () => {
    const blocks: FlatBlock[] = [
      { kind: 'scene', docId: 'd0', body: 'INT. A - DAY\n\nTom & Jerry <3 run.', title: 'INT. A - DAY', number: 1 },
    ];
    const { xml } = renderFdx(blocks, { title: 'T' });
    expect(xml).toContain('<Text>Tom &amp; Jerry &lt;3 run.</Text>');
  });

  it('writes the title page as a TitlePage element, and each scene number verbatim from its heading', () => {
    const blocks: FlatBlock[] = [
      { kind: 'frontmatter', fmKind: 'titlepage' },
      { kind: 'scene', docId: 'd0', body: 'INT. HALL - DAY #24A#\n\nAction.', title: 'INT. HALL - DAY', number: 1 },
    ];
    const { xml, notes } = renderFdx(blocks, { title: 'Keeper', author: 'N. Attini' });
    expect(xml).toContain('<TitlePage>');
    expect(xml).toContain('Title: Keeper');
    expect(xml).toContain('<Paragraph Type="Scene Heading" Number="24A">');
    expect(xml).toContain('<Text>INT. HALL - DAY</Text>');
    expect(xml).not.toContain('#24A#');
    expect(notes).toEqual([]);
  });

  it('emits the page-number header from the paginator, numbered from page 2 (D11)', () => {
    const { xml } = renderFdx(blocksOf(SCRIPT_ONE_ACT), { title: 'T' });
    expect(xml).toContain('<HeaderAndFooter FirstPage="2">');
    expect(xml).toContain('<DynamicLabel Type="Page"/>');
  });

  it('prints a note or boneyard out of an action paragraph, and the text around it', () => {
    const { xml } = renderFdx(blocksOf(text('INT. A - DAY', '', 'She [[check this]] waits.', '', '/* cut */ Action here.')), {
      title: 'T',
    });
    expect(xml).toContain('<Text>She waits.</Text>');
    expect(xml).toContain('<Text>Action here.</Text>');
    expect(xml).not.toContain('check this');
    expect(xml).not.toContain('cut');
  });

  it('keeps a dialogue paragraph that begins with a forcing character as dialogue on import', () => {
    const xml = [
      '<FinalDraft DocumentType="Script">',
      '  <Content>',
      '    <Paragraph Type="Scene Heading"><Text>INT. A - DAY</Text></Paragraph>',
      '    <Paragraph Type="Character"><Text>ANNA</Text></Paragraph>',
      '    <Paragraph Type="Dialogue"><Text>!Get down!</Text></Paragraph>',
      '  </Content>',
      '</FinalDraft>',
    ].join('\n');
    const [scene] = importFdx(xml).nodes.filter((node) => node.kind === 'scene');
    expect(scene?.kind === 'scene' ? scene.body : '').toBe(['INT. A - DAY', '', 'ANNA', '!Get down!'].join('\n'));
  });

  it('reads back, through the importer, to the same scene headings', () => {
    const { xml } = renderFdx(blocksOf(SCRIPT_ONE_ACT), { title: 'T' });
    const headings = importFdx(xml).nodes.flatMap((node) => (node.kind === 'scene' && node.heading !== null ? [node.heading] : []));
    expect(headings).toEqual(['INT. HOUSE - DAY', 'EXT. STREET - NIGHT', 'INT. ROOM - CONTINUOUS']);
  });

  it('emits a Blob with the XML media type', async () => {
    const blob = await createFdxRenderer().emit(blocksOf(text('INT. A - DAY', '', 'Action.')), { title: 'T' });
    expect(blob.type).toBe('application/xml');
    expect(await blob.text()).toContain('<FinalDraft');
  });
});
