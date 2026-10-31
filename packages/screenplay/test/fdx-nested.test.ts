/**
 * Issue #264: the FDX reader used to pair each `<Paragraph>` with the next `</Paragraph>`, so a nested paragraph cut
 * or replaced text. Each case below is a shape Final Draft (or another FDX writer) produces; each failed on the old
 * reader and is pinned here.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { describeFdxImport, importFdx, lengthInEighths, parseFdxParagraphs, parseFdxTitlePage, parseFountain, printedText } from '../src/index.js';

function doc(...paragraphs: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<FinalDraft DocumentType="Script" Template="No" Version="5">',
    '  <Content>',
    ...paragraphs.map((p) => `    ${p}`),
    '  </Content>',
    '</FinalDraft>',
  ].join('\n');
}

function scenesOf(xml: string) {
  return importFdx(xml).nodes.flatMap((node) => (node.kind === 'scene' ? [node] : []));
}

function bodyOf(xml: string): string {
  return scenesOf(xml)
    .map((scene) => scene.body)
    .join('\n\n');
}

const SUMMARY = doc(
  '<Paragraph Number="1" Type="Scene Heading">',
  '  <SceneProperties Length="2/8" Page="1" Title="">',
  '    <Summary><Paragraph Alignment="Left"><Text>She arrives.</Text></Paragraph></Summary>',
  '    <SceneArcBeats><CharacterArcBeat Name="ANNA"><Paragraph Alignment="Left"><Text>Anna is tired.</Text></Paragraph></CharacterArcBeat></SceneArcBeats>',
  '  </SceneProperties>',
  '  <Text>INT. STATION - NIGHT</Text>',
  '</Paragraph>',
  '<Paragraph Type="Action"><Text>Rain.</Text></Paragraph>',
);

describe('case 1: a scene summary does not replace the heading', () => {
  it('keeps the heading and its number, and makes the summary the synopsis', () => {
    const [scene] = scenesOf(SUMMARY);
    expect(scene?.heading).toBe('INT. STATION - NIGHT #1#');
    expect(scene?.synopsis).toBe('She arrives.');
    expect(scene?.lengthEighths).toBe(2);
    expect(scene?.body).toBe('INT. STATION - NIGHT #1#\n\nRain.');
  });

  it('reads the summary and arc beats as no script paragraphs', () => {
    const paragraphs = parseFdxParagraphs(SUMMARY);
    expect(paragraphs.map((p) => [p.type, p.text])).toEqual([
      ['Scene Heading', 'INT. STATION - NIGHT'],
      ['Action', 'Rain.'],
    ]);
    expect(paragraphs[0]?.summary).toBe('She arrives.');
    expect(bodyOf(SUMMARY)).not.toContain('Anna is tired');
    expect(importFdx(SUMMARY).report.summaries).toBe(1);
  });
});

const INLINE_NOTE = doc(
  '<Paragraph Type="Scene Heading"><Text>INT. HALL - DAY</Text></Paragraph>',
  '<Paragraph Type="Action">',
  '  <ScriptNote Name="Check" Color="#FFFF00000000"><Paragraph><Text>Is this too loud?</Text></Paragraph></ScriptNote>',
  '  <Text>The door slams. A </Text><Text Style="Bold">BIG</Text><Text> moment.</Text>',
  '</Paragraph>',
  '<Paragraph Type="Character"><Text>ANNA</Text></Paragraph>',
  '<Paragraph Type="Dialogue"><Text>Who is there?</Text></Paragraph>',
);

describe('case 2: an inline script note does not eat its paragraph', () => {
  it('keeps every run of the paragraph and the note as a Fountain note', () => {
    const body = bodyOf(INLINE_NOTE);
    expect(body).toContain('INT. HALL - DAY\n\nThe door slams. A **BIG** moment. [[Check: Is this too loud?]]\n\nANNA');
    expect(printedText('The door slams. A **BIG** moment. [[Check: Is this too loud?]]')).toBe('The door slams. A **BIG** moment.');
    expect(body).toContain('ANNA\nWho is there?');
    expect(importFdx(INLINE_NOTE).report.notes).toBe(1);
  });

  it('reads the note as a segment of the paragraph, not as a paragraph', () => {
    const paragraphs = parseFdxParagraphs(INLINE_NOTE);
    expect(paragraphs.map((p) => p.type)).toEqual(['Scene Heading', 'Action', 'Character', 'Dialogue']);
    expect(paragraphs[1]?.text).toBe('The door slams. A BIG moment.');
    expect(paragraphs[1]?.segments[0]).toEqual({ kind: 'note', text: 'Check: Is this too loud?' });
  });

  it('puts a note on a cue on a line of its own, so the cue stays a cue', () => {
    const xml = doc(
      '<Paragraph Type="Scene Heading"><Text>INT. HALL - DAY</Text></Paragraph>',
      '<Paragraph Type="Character"><ScriptNote><Paragraph><Text>Recast?</Text></Paragraph></ScriptNote><Text>ANNA</Text></Paragraph>',
      '<Paragraph Type="Dialogue"><Text>Hello.</Text></Paragraph>',
    );
    expect(bodyOf(xml)).toBe('INT. HALL - DAY\n\nANNA\n[[Recast?]]\nHello.');
  });
});

const LISTED_NOTES = [
  '<FinalDraft DocumentType="Script" Template="No" Version="5">',
  '  <Content>',
  '    <Paragraph Type="Scene Heading"><Text>INT. HALL - DAY</Text></Paragraph>',
  '    <Paragraph Type="Action"><Text>Rain.</Text></Paragraph>',
  '    <Paragraph Type="Scene Heading"><Text>EXT. YARD - NIGHT</Text></Paragraph>',
  '    <Paragraph Type="Action"><Text>Wind.</Text></Paragraph>',
  '  </Content>',
  '  <ScriptNotes>',
  // "INT. HALL - DAY" is 15 characters and one between paragraphs, so offset 16 is the start of "Rain.".
  '    <ScriptNote Color="#FFFF00000000" Name="" Range="17,20" Type="Note"><Paragraph><Text>Heavier rain.</Text></Paragraph></ScriptNote>',
  '    <ScriptNote Name="General"><Paragraph><Text>Tighten act one.</Text></Paragraph></ScriptNote>',
  '  </ScriptNotes>',
  '  <UnanchoredScriptNotes><ScriptNote><Paragraph><Text>Old note.</Text></Paragraph></ScriptNote></UnanchoredScriptNotes>',
  '</FinalDraft>',
].join('\n');

describe('case 3: the ScriptNotes list is not prose', () => {
  it('places a listed note at its Range as a note, and puts notes with no place at the end, as notes', () => {
    const [first, second] = scenesOf(LISTED_NOTES);
    expect(first?.body).toBe('INT. HALL - DAY\n\nRain. [[Heavier rain.]]');
    expect(second?.body).toBe('EXT. YARD - NIGHT\n\nWind.\n\n[[General: Tighten act one.]]\n\n[[Old note.]]');
    expect(printedText(second?.body ?? '')).not.toContain('Tighten');
  });

  it('counts the notes and says which had no place', () => {
    const script = importFdx(LISTED_NOTES);
    expect(script.report).toMatchObject({ notes: 3, unanchoredNotes: 2 });
    expect(script.notices).toContain('3 script notes were kept as Fountain notes ([[…]]), which do not print.');
    expect(script.notices).toContain('2 script notes have no place in the script and went to the end of the last scene.');
    expect(parseFdxParagraphs(LISTED_NOTES).map((p) => p.text)).toEqual(['INT. HALL - DAY', 'Rain.', 'EXT. YARD - NIGHT', 'Wind.']);
  });
});

const WRAPPED_DUAL = doc(
  '<Paragraph Type="Scene Heading"><Text>INT. KITCHEN - DAY</Text></Paragraph>',
  '<Paragraph Type="Character">',
  '  <DualDialogue>',
  '    <Paragraph Type="Character"><Text>ANNA</Text></Paragraph>',
  '    <Paragraph Type="Dialogue"><Text>Left.</Text></Paragraph>',
  '    <Paragraph Type="Character"><Text>BEN</Text></Paragraph>',
  '    <Paragraph Type="Parenthetical"><Text>(quietly)</Text></Paragraph>',
  '    <Paragraph Type="Dialogue"><Text>Right.</Text></Paragraph>',
  '  </DualDialogue>',
  '</Paragraph>',
  '<Paragraph Type="Action"><Text>They stop.</Text></Paragraph>',
);

describe('case 4: dual dialogue wrapped in a paragraph', () => {
  it('writes the pair with the dual marker on the second cue, as for a bare container', () => {
    expect(bodyOf(WRAPPED_DUAL)).toBe('INT. KITCHEN - DAY\n\nANNA\nLeft.\n\nBEN ^\n(quietly)\nRight.\n\nThey stop.');
    expect(importFdx(WRAPPED_DUAL).report.dualDialogues).toBe(1);
  });

  it('reads the wrapper as no paragraph of its own, and the pair as one container', () => {
    const paragraphs = parseFdxParagraphs(WRAPPED_DUAL);
    expect(paragraphs.map((p) => [p.type, p.text, p.container])).toEqual([
      ['Scene Heading', 'INT. KITCHEN - DAY', null],
      ['Character', 'ANNA', 0],
      ['Dialogue', 'Left.', 0],
      ['Character', 'BEN', 0],
      ['Parenthetical', '(quietly)', 0],
      ['Dialogue', 'Right.', 0],
      ['Action', 'They stop.', null],
    ]);
  });
});

describe('case 5: SceneProperties Length in eighths', () => {
  it('reads n/8, whole pages and a fraction, and a whole number in a file that writes fractions as pages', () => {
    const xml = doc(
      '<Paragraph Type="Scene Heading"><SceneProperties Length="1 3/8"/><Text>INT. A - DAY</Text></Paragraph>',
      '<Paragraph Type="Scene Heading"><SceneProperties Length="3/8"/><Text>INT. B - DAY</Text></Paragraph>',
      '<Paragraph Type="Scene Heading"><SceneProperties Length="1"/><Text>INT. C - DAY</Text></Paragraph>',
      '<Paragraph Type="Scene Heading"><SceneProperties Length="0/8"/><Text>OMITTED</Text></Paragraph>',
      '<Paragraph Type="Scene Heading"><SceneProperties Length="soon"/><Text>INT. D - DAY</Text></Paragraph>',
    );
    expect(parseFdxParagraphs(xml).map((p) => p.lengthEighths)).toEqual([11, 3, 8, 0, null]);
  });

  it('reads a whole number as eighths in a file with no fraction, as Caotang writes it', () => {
    const xml = doc('<Paragraph Type="Scene Heading"><SceneProperties Length="12" Page="1"/><Text>INT. A - DAY</Text></Paragraph>');
    expect(scenesOf(xml)[0]?.lengthEighths).toBe(12);
  });

  it('parses the forms on their own', () => {
    expect(lengthInEighths('2/8', false)).toBe(2);
    expect(lengthInEighths('1 3/8', false)).toBe(11);
    expect(lengthInEighths('2 1/4', true)).toBe(18);
    expect(lengthInEighths('1', true)).toBe(8);
    expect(lengthInEighths('8', false)).toBe(8);
    expect(lengthInEighths('1/0', false)).toBeNull();
    expect(lengthInEighths('', false)).toBeNull();
  });
});

const STYLED = doc(
  '<Paragraph Type="Scene Heading"><Text Style="Bold+Underline+AllCaps">INT. VAULT - NIGHT</Text></Paragraph>',
  '<Paragraph Type="Action">',
  '  <Text>She reads </Text><Text Style="Italic">the letter</Text><Text>. It says </Text>',
  '  <Text Style="Bold">STOP</Text><Text> and </Text><Text Style="Underline">now</Text><Text>, </Text>',
  '  <Text Style="Bold+Underline+AllCaps">at once</Text><Text>, </Text><Text Style="Strikeout">later</Text><Text>.</Text>',
  '  <Text Style="Italic+HiddenText">Check the prop list.</Text>',
  '</Paragraph>',
  '<Paragraph Type="Character"><Text>ANNA</Text></Paragraph>',
  '<Paragraph Type="Dialogue"><Text Style="Bold+Italic">Run!</Text></Paragraph>',
  '<Paragraph Type="Outline 1"><Text Style="Bold+HiddenText">Act one</Text></Paragraph>',
);

describe('case 6: run styles', () => {
  it('writes bold, italic and underline as Fountain emphasis, and keeps the text as written', () => {
    const body = bodyOf(STYLED);
    expect(body).toContain('She reads *the letter*. It says **STOP** and _now_, _**at once**_, later.');
    expect(body).toContain('ANNA\n***Run!***');
  });

  it('keeps hidden text as a note, never as printed text', () => {
    const body = bodyOf(STYLED);
    expect(body).toContain('later. [[Check the prop list.]]');
    expect(body).toContain('[[Act one]]');
    expect(printedText(body)).not.toContain('Check the prop list');
    expect(parseFdxParagraphs(STYLED)[1]?.text).not.toContain('Check the prop list');
  });

  it('leaves a heading plain so it stays a heading, and counts what it dropped', () => {
    const script = importFdx(STYLED);
    expect(scenesOf(STYLED)[0]?.heading).toBe('INT. VAULT - NIGHT');
    expect(script.report).toMatchObject({ hiddenRuns: 2, strikeouts: 1, plainedRuns: 1 });
    expect(script.notices).toContain('Strikeout on 1 run was not kept: Fountain has no strikeout. The text was kept.');
    expect(script.notices).toContain('2 runs of hidden text were kept as Fountain notes, not as printed text.');
  });
});

describe('a file Final Draft wrote (TestFDX-FD.fdx, wildwinter/screenplay-tools, MIT)', () => {
  const xml = readFileSync(new URL('./fixtures/fdx/TestFDX-FD.fdx', import.meta.url), 'utf8');

  /** The words of every `<Text>` run directly in a script paragraph, read with a pattern independent of the reader. */
  function sourceWords(): string[] {
    const content = /<Content>([\s\S]*?)<\/Content>/.exec(xml)?.[1] ?? '';
    // Every paragraph in this file's Content that holds text is a script paragraph: its nested ones are empty arc beats.
    const runs = [...content.matchAll(/<Text[^>]*>([^<]*)<\/Text>/g)].map((m) => m[1] ?? '');
    return runs.join(' ').split(/\s+/).filter((w) => w !== '');
  }

  it('imports every run of every script paragraph, with no word lost', () => {
    const script = importFdx(xml);
    // The elements' own text: the forcing characters Fountain needs (`>FADE TO BLACK`) and the scene numbers are not words.
    const words = script.nodes
      .flatMap((node) => (node.kind === 'scene' ? parseFountain(node.body).elements : []))
      .map((el) => ('text' in el ? printedText(el.text.replace(/ #\d+#$/, '')) : ''))
      .join(' ')
      .split(/\s+/)
      .filter((w) => w !== '');
    expect(words).toEqual(sourceWords());
  });

  it('reads both scenes with their numbers and lengths, and the title page', () => {
    const scenes = scenesOf(xml);
    expect(scenes.map((s) => [s.title, s.sceneNumber, s.lengthEighths])).toEqual([
      ['INT. RADIO STUDIO', '1', 3],
      ['EXT. OUTSIDE THE FOOD STORE', '2', 2],
    ]);
    expect(parseFdxTitlePage(xml)).toMatchObject({ Title: 'FDX Test Script', Credit: 'Written by', Author: 'Ian' });
    expect(importFdx(xml).notices).toEqual([]);
  });
});

describe('linear time on deep nesting', () => {
  /** A file of `count` scene headings, each nesting a summary, a note and a dual pair, plus a run of deep nesting. */
  function nested(count: number): string {
    const one = [
      '<Paragraph Type="Scene Heading"><SceneProperties Length="1 3/8"><Summary><Paragraph><Text>s</Text></Paragraph></Summary></SceneProperties><Text>INT. A - DAY</Text></Paragraph>',
      '<Paragraph Type="Action"><ScriptNote><Paragraph><Text>n</Text></Paragraph></ScriptNote><Text>x</Text></Paragraph>',
      '<Paragraph><DualDialogue><Paragraph Type="Character"><Text>A</Text></Paragraph><Paragraph Type="Dialogue"><Text>l</Text></Paragraph><Paragraph Type="Character"><Text>B</Text></Paragraph><Paragraph Type="Dialogue"><Text>r</Text></Paragraph></DualDialogue></Paragraph>',
    ].join('');
    const depth = Math.floor(count / 4);
    return `<FinalDraft><Content>${one.repeat(count)}</Content><Junk>${'<Paragraph><Summary>'.repeat(depth)}${'</Summary></Paragraph>'.repeat(depth)}</Junk></FinalDraft>`;
  }

  it('reads a 5 MB file with nested paragraphs in time linear in its size', () => {
    const timed = (count: number): number => {
      const source = nested(count);
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = performance.now();
        expect(parseFdxParagraphs(source)).toHaveLength(count * 6);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const large = nested(10_000);
    expect(large.length).toBeGreaterThan(5_000_000);
    parseFdxParagraphs(nested(500));
    const small = timed(2_500);
    const big = timed(10_000);
    const ratio = big / small;
    expect(ratio, `${Math.round(big)} ms for 10 000 scenes against ${Math.round(small)} ms for 2 500`).toBeLessThan(8);
    expect(big, `10 000 scenes took ${Math.round(big)} ms`).toBeLessThan(4000);
  }, 60_000);

  it('reads a closing tag whose name is not open as nothing, however many there are', () => {
    const xml = `<Content><Paragraph Type="Action"><Text>kept</Text>${'</Summary>'.repeat(10_000)}</Paragraph></Content>`;
    expect(parseFdxParagraphs(xml).map((p) => p.text)).toEqual(['kept']);
  });
});

describe('describeFdxImport — what the Import script dialog lists', () => {
  it('counts the scenes, the notes and the dual-dialogue pairs, zero included', () => {
    expect(describeFdxImport(importFdx(WRAPPED_DUAL))).toEqual([
      '1 scene and 0 sections will be made, in one undo step.',
      '0 script notes kept as Fountain notes ([[…]]), which do not print.',
      "1 dual-dialogue pair kept side by side (Fountain's ^).",
    ]);
    expect(describeFdxImport(importFdx(STYLED))).toContain('2 runs of hidden text kept as notes, not printed.');
    expect(describeFdxImport(importFdx(SUMMARY))).toContain('1 scene summary kept as a scene synopsis.');
  });
});
