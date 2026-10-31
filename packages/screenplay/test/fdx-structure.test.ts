/**
 * Issue #265: the structure Final Draft already stores, taken instead of turned into action or dropped. Scene titles and
 * colours, outline elements and act breaks, Summary and Note paragraphs, the SmartType, cast and Cast List names as codex
 * seeds, and one notice per kind of production data with a count. The fixtures are hand-written in the shapes Final Draft
 * writes (see `fixtures/fdx/README.md`), and `TestFDX-FD.fdx` is a file Final Draft wrote.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  castListLine,
  colourName,
  describeFdxImport,
  fdxColour,
  importFdx,
  namingScene,
  nearestLabel,
  type ImportedNode,
} from '../src/index.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/fdx/${name}`, import.meta.url), 'utf8');
}

function doc(...paragraphs: string[]): string {
  return ['<FinalDraft DocumentType="Script" Version="6">', '  <Content>', ...paragraphs.map((p) => `    ${p}`), '  </Content>', '</FinalDraft>'].join('\n');
}

function scenes(nodes: readonly ImportedNode[]) {
  return nodes.flatMap((node) => (node.kind === 'scene' ? [node] : []));
}

function sections(nodes: readonly ImportedNode[]) {
  return nodes.flatMap((node) => (node.kind === 'section' ? [node] : []));
}

const unknownType = (notice: string): boolean => notice.startsWith('Paragraph type');

describe('outline elements (Send Outline to Script)', () => {
  const script = importFdx(fixture('outline-fd13.fdx'));

  it('makes Outline 1 to 3 sections at their depth, with the Summary under each as its synopsis', () => {
    expect(sections(script.nodes).map((s) => [s.depth, s.title, s.synopsis])).toEqual([
      [1, 'ACT ONE', 'Anna loses the map and finds a reason to stay.'],
      [2, 'The station', 'Night. The last train has gone.'],
      [3, 'Arrival', ''],
      [1, 'ACT TWO', ''],
      [3, 'A beat inside the act', ''],
    ]);
  });

  it('raises no unknown-type notice for outline, Summary, Note or Lyrics paragraphs', () => {
    expect(script.notices.filter(unknownType)).toEqual([]);
  });

  it('keeps a Note under a section as a note at the top of the next scene, not as an untitled scene', () => {
    const [station] = scenes(script.nodes);
    expect(scenes(script.nodes).some((scene) => scene.heading === null)).toBe(false);
    expect(station?.body).toContain('[[Keep this under a page.]]');
    expect(script.report.noteParagraphs).toBe(1);
  });

  it('makes a Summary right under a scene heading its synopsis, and one further down a note', () => {
    const library = scenes(script.nodes)[1];
    expect(library?.synopsis).toBe('The library is still lit.');
    expect(library?.body).toContain('[[Summary: Ben knows her name.]]');
    expect(script.report.outlineSummaries).toBe(3);
    expect(script.report.summaryNotes).toBe(1);
    expect(script.notices.some((n) => n.includes('kept as a note'))).toBe(true);
  });

  it('keeps Lyrics as printed action, and says Outline 4 is written at the third level', () => {
    expect(scenes(script.nodes)[1]?.body).toContain('Over the hills and far away');
    expect(script.report.lyrics).toBe(1);
    expect(script.report.deepOutlines).toBe(1);
    expect(script.notices.some((n) => n.includes('Outline 4'))).toBe(true);
  });

  it('takes the scene title for the node and the scene colour as #rrggbb, white meaning none', () => {
    const [station, library, inside] = scenes(script.nodes);
    expect(station).toMatchObject({ title: 'INT. STATION - NIGHT', nodeTitle: 'Anna arrives', colour: '#ff0000', synopsis: 'She steps off the train.' });
    expect(station?.body.startsWith('INT. STATION - NIGHT #1#')).toBe(true);
    expect(library).toMatchObject({ colour: '#00ff00', lengthEighths: 10 });
    expect(library && 'nodeTitle' in library).toBe(false);
    expect(inside && 'colour' in inside).toBe(false);
    expect(script.report).toMatchObject({ sceneTitles: 1, sceneColours: 2 });
  });

  it('describes what it makes before anything is written', () => {
    const lines = describeFdxImport(script).join('\n');
    expect(lines).toContain('5 outline elements and act breaks made sections, which become folders.');
    expect(lines).toContain('1 scene title used as binder title');
    expect(lines).toContain('2 scene colours kept as binder labels');
  });
});

describe('TV acts and the cast list', () => {
  const script = importFdx(fixture('tv-acts.fdx'));

  it('makes Cold Opening and New Act sections, and keeps End of Act centred at the end of the act', () => {
    expect(sections(script.nodes).map((s) => s.title)).toEqual(['COLD OPEN', 'ACT ONE', 'ACT TWO']);
    const [kitchen, station] = scenes(script.nodes);
    expect(kitchen?.body.endsWith('> END OF COLD OPEN <')).toBe(true);
    expect(station?.body.endsWith('> END OF ACT ONE <')).toBe(true);
    expect(script.report).toMatchObject({ outlineSections: 3, actEnds: 2 });
    expect(script.notices.filter(unknownType)).toEqual([]);
  });

  it('takes Cast List paragraphs out of the script and offers them as codex seeds with their descriptions', () => {
    const body = scenes(script.nodes).map((scene) => scene.body).join('\n');
    expect(body).not.toContain('runs the station');
    expect(script.report.castListLines).toBe(2);
    expect(script.seeds).toEqual([
      { name: 'CHIEF ROSA', type: 'character', description: 'runs the station', sources: ['cast', 'highlighting', 'cast-list'] },
      { name: 'TOM', type: 'character', description: 'her nephew', sources: ['cast-list'] },
    ]);
  });
});

describe('codex seeds from a file Final Draft wrote', () => {
  const script = importFdx(fixture('TestFDX-FD.fdx'));

  it('offers each SmartType character once, with every list it was seen in, then the SmartType locations', () => {
    const characters = script.seeds.filter((seed) => seed.type === 'character');
    expect(characters.map((seed) => seed.name)).toEqual(['DAVE', 'JIM', 'DJ', 'KAY']);
    expect(characters[0]?.sources).toEqual(['smarttype', 'cast', 'highlighting']);
    const places = script.seeds.filter((seed) => seed.type === 'location').map((seed) => seed.name);
    expect(places).toContain('OLYMPIA CIRCUS');
    expect(places).toContain('OuTSIDE the food store');
  });

  it('raises no production notice for the default revision sets, tag categories and empty boards Final Draft always writes', () => {
    expect(Object.values(script.report.production).filter((value) => typeof value === 'number' && value > 0)).toEqual([]);
    expect(script.notices.some((n) => /Revision|Tagger|Beat Board|alternate|arc beat|locked/.test(n))).toBe(false);
  });

  it('keeps the SmartType names out of the script text', () => {
    expect(scenes(script.nodes).map((scene) => scene.body).join('\n')).not.toContain('OLYMPIA');
  });
});

describe('production data: one notice per kind, with a count', () => {
  const script = importFdx(fixture('production.fdx'));

  it('counts each kind', () => {
    expect(script.report.production).toEqual({
      revisedRuns: 3,
      revisionSets: ['Blue', 'Pink'],
      lockedPages: 1,
      tags: 1,
      beats: 2,
      altDialogue: 1,
      arcBeats: 1,
    });
  });

  it('says each kind exactly once, and keeps the revised text', () => {
    const kinds = [/Revision marks on 3 runs \(Blue, Pink\)/, /1 locked page/, /1 Tagger breakdown tag/, /2 Beat Board items/, /1 set of alternate dialogue/, /1 character arc beat/];
    for (const kind of kinds) expect(script.notices.filter((n) => kind.test(n))).toHaveLength(1);
    expect(scenes(script.nodes)[0]?.body).toContain('Anna picks up the revolver.');
    expect(scenes(script.nodes)[0]?.body).toContain('She checks the chamber.');
  });
});

describe('the helpers', () => {
  it('reads Final Draft colours, short and long, and refuses anything else', () => {
    expect(fdxColour('#FFFF00000000')).toBe('#ff0000');
    expect(fdxColour('#C6C6EDEDFEFE')).toBe('#c6edfe');
    expect(fdxColour('#0F0')).toBe('#00ff00');
    expect(fdxColour('#12345')).toBeNull();
    expect(fdxColour('')).toBeNull();
    expect(fdxColour('red')).toBeNull();
  });

  it('names a colour by its nearest palette colour and finds a label only within the tolerance', () => {
    expect(colourName('#f01010')).toBe('Red');
    expect(colourName('#2060e0')).toBe('Blue');
    const labels = [{ id: 'a', color: '#ff0000' }, { id: 'b', color: '#0000ff' }];
    expect(nearestLabel('#f00a0a', labels)?.id).toBe('a');
    expect(nearestLabel('#00ff00', labels)).toBeUndefined();
  });

  it('splits a Cast List line into the name and its description', () => {
    expect(castListLine('ANNA - a pilot')).toEqual({ name: 'ANNA', description: 'a pilot' });
    expect(castListLine('ANNA, 30s')).toEqual({ name: 'ANNA', description: '30s' });
    expect(castListLine('MRS. SMITH: the landlady')).toEqual({ name: 'MRS. SMITH', description: 'the landlady' });
    expect(castListLine('BEN.....the librarian')).toEqual({ name: 'BEN', description: 'the librarian' });
    expect(castListLine('JEAN-PAUL')).toEqual({ name: 'JEAN-PAUL', description: '' });
  });

  it('finds the first scene naming a name as a whole word, ignoring case, and quotes its line', () => {
    const bodies = [{ body: 'INT. ROOM\n\nANNABEL sits.' }, { body: 'EXT. YARD\n\nAnna runs.' }];
    expect(namingScene(bodies, 'ANNA')).toEqual({ index: 1, quote: 'Anna runs.', from: 11, to: 15 });
    expect(namingScene(bodies, 'GHOST')).toBeNull();
  });

  it('caps the seeds one import offers and says how many were left out', () => {
    const names = Array.from({ length: 505 }, (_, i) => `<Character>EXTRA ${i}</Character>`).join('');
    const xml = `<FinalDraft>${doc('<Paragraph Type="Scene Heading"><Text>INT. ROOM</Text></Paragraph>').replace(/^<FinalDraft[^>]*>|<\/FinalDraft>$/g, '')}<SmartType><Characters>${names}</Characters></SmartType></FinalDraft>`;
    const script = importFdx(xml);
    expect(script.seeds).toHaveLength(500);
    expect(script.report.skippedSeeds).toBe(5);
    expect(script.notices.some((n) => n.includes('5 cast or location names were not offered'))).toBe(true);
  });
});
