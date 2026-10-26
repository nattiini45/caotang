import type { FlatBlock } from '../src/index.js';
import { describe, expect, it } from 'vitest';
import {
  createFdxRenderer,
  importFdx,
  importFountainScript,
  parseFdxParagraphs,
  parseFdxTitlePage,
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
    // Best of five runs per size. Four times the input takes a linear scan about four times as long and a quadratic one
    // sixteen times, so a ratio bound of 8 separates them with room for a slow runner; at a few milliseconds a doubling
    // was within a pause's noise of its bound.
    const timed = (count: number): number => {
      const source = truncated(count);
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const started = performance.now();
        expect(parseFdxParagraphs(source)).toEqual([]);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    parseFdxParagraphs(truncated(1000));
    const small = timed(50_000);
    const large = timed(200_000);
    const ratio = large / small;
    expect(ratio, `${Math.round(large)} ms for 200 000 paragraphs against ${Math.round(small)} ms for 50 000`).toBeLessThan(8);
    expect(large, `200 000 paragraphs took ${Math.round(large)} ms`).toBeLessThan(2000);
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

// Hand-written XML in the shape the community readers describe: it shows what Caotang reads, not what Final Draft writes.
const NUMBERED = [
  '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
  '<FinalDraft DocumentType="Script" Template="No" Version="3">',
  '  <Content>',
  '    <Paragraph Type="Scene Heading" Number="2A"><SceneProperties Length="8" Page="1"/><Text>INT. HALL - DAY</Text></Paragraph>',
  '    <Paragraph Type="Action"><Text>Rain.</Text></Paragraph>',
  '    <Paragraph Type="Scene Heading"><Text>EXT. YARD - NIGHT</Text></Paragraph>',
  '    <Paragraph Type="Scene Heading" Number=" "><Text>INT. CELLAR - NIGHT</Text></Paragraph>',
  '    <Paragraph Type="Scene Heading" Number="7"><Text>INT. ATTIC - DAY #7B#</Text></Paragraph>',
  '  </Content>',
  '</FinalDraft>',
  '',
].join('\n');

const TITLED = [
  '<FinalDraft DocumentType="Script">',
  '  <TitlePage>',
  '    <Content>',
  '      <Paragraph Alignment="Center"><Text>THE LIGHTHOUSE KEEPER</Text></Paragraph>',
  '      <Paragraph Alignment="Center"/>',
  '      <Paragraph Alignment="Center"><Text>Written by</Text></Paragraph>',
  '      <Paragraph Alignment="Center"><Text>N. Attini</Text></Paragraph>',
  '      <Paragraph Alignment="Center"><Text>Second draft</Text></Paragraph>',
  '      <Paragraph Alignment="Center"><Text>Contact: n@example.org</Text></Paragraph>',
  '      <Paragraph Alignment="Center"><Text>Based on a short story</Text></Paragraph>',
  '    </Content>',
  '  </TitlePage>',
  '  <Content>',
  '    <Paragraph Type="Scene Heading"><Text>INT. A - DAY</Text></Paragraph>',
  '  </Content>',
  '  <HeaderAndFooter HeaderVisible="Yes"><Header><Paragraph Alignment="Right"><DynamicLabel Type="Page #"/><Text>.</Text></Paragraph></Header></HeaderAndFooter>',
  '</FinalDraft>',
].join('\n');

/** The same file as a Windows editor saves it: a byte order mark and CRLF line ends. */
function windowsCopy(xml: string): string {
  return `\uFEFF${xml.replace(/\n/g, '\r\n')}`;
}

function scenesOf(xml: string) {
  return importFdx(xml).nodes.flatMap((node) => (node.kind === 'scene' ? [node] : []));
}

describe('importFdx — scene numbers', () => {
  it('reads Number into the heading, and leaves an unnumbered heading unnumbered', () => {
    expect(parseFdxParagraphs(NUMBERED).map((p) => p.number)).toEqual(['2A', null, null, null, '7']);
    const scenes = scenesOf(NUMBERED);
    expect(scenes.map((s) => [s.title, s.sceneNumber])).toEqual([
      ['INT. HALL - DAY', '2A'],
      ['EXT. YARD - NIGHT', null],
      ['INT. CELLAR - NIGHT', null],
      ['INT. ATTIC - DAY', '7B'],
    ]);
    expect(scenes[0]?.heading).toBe('INT. HALL - DAY #2A#');
    expect(scenes[0]?.body.startsWith('INT. HALL - DAY #2A#')).toBe(true);
    expect(scenes[0]?.lengthEighths).toBe(8);
  });

  it('does not write a Number that holds a hash, which Fountain could not carry', () => {
    const xml = '<Paragraph Type="Scene Heading" Number="1#2"><Text>INT. A - DAY</Text></Paragraph>';
    expect(scenesOf(xml).map((s) => s.heading)).toEqual(['INT. A - DAY']);
  });
});

describe('importFdx — the title page', () => {
  it('leaves the title page and the page header out of the script paragraphs', () => {
    expect(parseFdxParagraphs(TITLED).map((p) => p.text)).toEqual(['INT. A - DAY']);
  });

  it('names the lines it can and keeps the rest as Notes', () => {
    expect(parseFdxTitlePage(TITLED)).toEqual({
      Title: 'THE LIGHTHOUSE KEEPER',
      Credit: 'Written by',
      Author: 'N. Attini',
      'Draft date': 'Second draft',
      Contact: 'n@example.org',
      Notes: 'Based on a short story',
    });
    expect(importFdx(TITLED).titlePage).toEqual(parseFdxTitlePage(TITLED));
  });

  it('is null for a file with no title page or an empty one', () => {
    expect(parseFdxTitlePage(FDX_SAMPLE)).toBeNull();
    expect(importFdx(FDX_SAMPLE).titlePage).toBeNull();
    expect(parseFdxTitlePage('<TitlePage><Content><Paragraph/></Content></TitlePage>')).toBeNull();
  });

  it('reads a Written by: line as the credit and the author', () => {
    const xml = '<TitlePage><Content><Paragraph><Text>Written by: A. Writer</Text></Paragraph></Content></TitlePage>';
    expect(parseFdxTitlePage(xml)).toEqual({ Credit: 'Written by', Author: 'A. Writer' });
  });
});

describe('importFdx — a byte order mark and Windows line ends', () => {
  it('imports a BOM-prefixed CRLF file as the plain one', () => {
    for (const xml of [NUMBERED, TITLED, FDX_SAMPLE]) {
      expect(importFdx(windowsCopy(xml))).toEqual(importFdx(xml));
      expect(parseFdxParagraphs(windowsCopy(xml))).toEqual(parseFdxParagraphs(xml));
    }
    expect(importFdx(windowsCopy(TITLED)).titlePage?.Author).toBe('N. Attini');
    expect(scenesOf(windowsCopy(NUMBERED))).toHaveLength(4);
  });

  it('folds a line end inside a text run to a line feed', () => {
    const xml = '<Paragraph Type="Action"><Text>one\r\ntwo\rthree</Text></Paragraph>';
    expect(parseFdxParagraphs(xml)[0]?.text).toBe('one\ntwo\nthree');
  });
});

describe('renderFdx then importFdx — what Caotang writes, it reads back', () => {
  const blocks: FlatBlock[] = [
    { kind: 'frontmatter', fmKind: 'titlepage' },
    { kind: 'scene', docId: 'a', body: 'INT. HALL - DAY #2A#\n\nRain falls.\n\nELENA\nHome.', title: 'INT. HALL - DAY', number: 1 },
    { kind: 'scene', docId: 'b', body: 'EXT. YARD - NIGHT\n\nWind.', title: 'EXT. YARD - NIGHT', number: 2 },
    { kind: 'scene', docId: 'c', body: 'INT. CELLAR - DAY #3#\n\nDamp.', title: 'INT. CELLAR - DAY', number: 3 },
  ];
  const { xml } = renderFdx(blocks, { title: 'Keeper', author: 'N. Attini' });

  it('keeps the scene numbers, 2A among them, and the scene text', () => {
    const scenes = scenesOf(xml);
    expect(scenes.map((s) => [s.title, s.sceneNumber])).toEqual([
      ['INT. HALL - DAY', '2A'],
      ['EXT. YARD - NIGHT', null],
      ['INT. CELLAR - DAY', '3'],
    ]);
    expect(scenes[0]?.body).toBe('INT. HALL - DAY #2A#\n\nRain falls.\n\nELENA\nHome.');
    expect(scenes[1]?.body).toBe('EXT. YARD - NIGHT\n\nWind.');
  });

  it('keeps the title page, and does not turn its lines into script text', () => {
    const script = importFdx(xml);
    expect(script.titlePage).toMatchObject({ Title: 'Keeper', Author: 'N. Attini' });
    expect(script.titlePage).toEqual(parseFdxTitlePage(xml));
    expect(script.nodes.map((n) => n.kind)).toEqual(['scene', 'scene', 'scene']);
    expect(parseFdxParagraphs(xml).map((p) => p.text)).not.toContain('Title: Keeper');
  });

  it('reads the file the same with a byte order mark and Windows line ends', () => {
    expect(importFdx(windowsCopy(xml))).toEqual(importFdx(xml));
  });
});
