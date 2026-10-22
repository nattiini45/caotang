import { expect, test } from '@playwright/test';

import { paginate, parseFountain } from '../../packages/screenplay/src/index.js';

import {
  printedOf,
  saveLineOf,
  screenplayModelOf,
  sceneOffset,
  unwrittenFlushOf,
  type ScreenplayUnit,
} from '../../apps/desktop/src/media/screenplay-model.js';
import { previewRowsOf } from '../../apps/desktop/src/media/preview-rows.js';

/** A scene with every element the formatted view draws: a heading, action, a block, a transition and a second heading. */
const SCENE = [
  'INT. KITCHEN - NIGHT',
  '',
  'Rain on the window. ANNA looks up.',
  '',
  'ANNA',
  '(quietly)',
  'Did you hear that?',
  '',
  'BEN (V.O.)',
  'Hear what?',
  '',
  'CUT TO:',
  '',
  'EXT. STREET - CONTINUOUS',
  '',
  'Headlights.',
].join('\n');

/** The printed text of one unit, so a test reads the script the way the writer does. */
function describe(unit: ScreenplayUnit): string {
  if (unit.kind === 'element') return `${unit.element.type}:${printedOf(unit.element)}`;
  if (unit.kind === 'block') return `block:${printedOf(unit.block.cue)}:${unit.block.lines.map((line) => printedOf(line)).join('|')}`;
  return `dual:${printedOf(unit.left.cue)}+${printedOf(unit.right.cue)}`;
}

test.describe('the formatted script', () => {
  test('draws the elements in source order, with each character block under its cue', () => {
    const { units } = screenplayModelOf(SCENE);
    expect(units.map(describe)).toEqual([
      'scene_heading:INT. KITCHEN - NIGHT',
      'action:Rain on the window. ANNA looks up.',
      'block:ANNA:(quietly)|Did you hear that?',
      'block:BEN (V.O.):Hear what?',
      'transition:CUT TO:',
      'scene_heading:EXT. STREET - CONTINUOUS',
      'action:Headlights.',
    ]);
  });

  test('a dual cue pairs with the block just before it, and the two draw side by side', () => {
    const { units } = screenplayModelOf(['ANNA', 'Hello.', '', 'BEN ^', 'Hi.'].join('\n'));
    expect(units).toHaveLength(1);
    const [unit] = units;
    expect(unit?.kind).toBe('dual');
    if (unit?.kind !== 'dual') return;
    expect(printedOf(unit.left.cue)).toBe('ANNA');
    expect(unit.left.lines.map((line) => printedOf(line))).toEqual(['Hello.']);
    expect(printedOf(unit.right.cue)).toBe('BEN');
    expect(unit.right.cue.type === 'character' && unit.right.cue.dual).toBe(true);
    expect(unit.right.lines.map((line) => printedOf(line))).toEqual(['Hi.']);
  });

  test('a dual cue with nothing before it draws as a block of its own', () => {
    const { units } = screenplayModelOf(['BEN ^', 'Hi.'].join('\n'));
    expect(units.map((unit) => unit.kind)).toEqual(['block']);
  });

  test('notes and boneyards are read but never drawn, and the white space they sat in prints as one space', () => {
    const { units } = screenplayModelOf(['INT. HALL - DAY', '', '[[Fix this scene]]', '', 'A door opens. /* old line */ It creaks.'].join('\n'));
    expect(units.map(describe)).toEqual(['scene_heading:INT. HALL - DAY', 'action:A door opens. It creaks.']);
  });

  test('the title page is read on its own, above the script', () => {
    const model = screenplayModelOf(['Title: The Kitchen', 'Author: Ana', '', 'INT. KITCHEN - NIGHT', '', 'Rain.'].join('\n'));
    expect(model.titlePage).toEqual({ Title: 'The Kitchen', Author: 'Ana' });
    expect(model.units.map(describe)).toEqual(['scene_heading:INT. KITCHEN - NIGHT', 'action:Rain.']);
  });

  test('an empty body draws nothing and reads zero pages', () => {
    const model = screenplayModelOf('');
    expect(model.units).toEqual([]);
    expect(model.scenes).toEqual([]);
    expect(model.readout).toEqual({ pages: 0, minutes: 0, scenes: 0, characters: 0 });
  });
});

test.describe('the page-count readout', () => {
  test('the pages come from the paginator, one minute of screen time per page', () => {
    const short = screenplayModelOf(SCENE).readout;
    expect(short.pages).toBeGreaterThan(0);
    expect(short.minutes).toBe(short.pages);
    expect(short.scenes).toBe(2);
    expect(short.characters).toBe(2);
  });

  test('the readout follows the body: a longer scene reads more pages', () => {
    const body = ['INT. HALL - DAY', ''];
    for (let i = 0; i < 80; i += 1) body.push(`Line ${i} of action that runs on for a while.`, '');
    expect(screenplayModelOf(body.join('\n')).readout.pages).toBeGreaterThan(screenplayModelOf(SCENE).readout.pages);
  });
});

test.describe('the scene navigator and the cue checks', () => {
  test('each scene heading offset lands on the start of its heading in the source', () => {
    const model = screenplayModelOf(SCENE);
    expect(sceneOffset(model, 0)).toBe(SCENE.indexOf('INT. KITCHEN'));
    expect(sceneOffset(model, 1)).toBe(SCENE.indexOf('EXT. STREET'));
    expect(sceneOffset(model, 2)).toBeNull();
  });

  test('the same character cued two ways is one spelling group, named in full', () => {
    const model = screenplayModelOf(['MR. SMITH', 'Hello.', '', 'MR SMITH', 'Hi.'].join('\n'));
    expect(model.spellingGroups).toHaveLength(1);
    expect(model.spellingGroups[0]?.spellings).toEqual(['MR. SMITH', 'MR SMITH']);
  });

  test('a character cued once is in the cue list, without its extension, and raises no spelling group', () => {
    const model = screenplayModelOf(SCENE);
    expect(model.cues).toEqual(['ANNA', 'BEN']);
    expect(model.spellingGroups).toEqual([]);
  });
});

test.describe('the body is the source of truth', () => {
  test('an edit to the body changes the units, and the model holds nothing from the last read', () => {
    const before = screenplayModelOf(SCENE);
    const after = screenplayModelOf(SCENE.replace('Headlights.', 'Headlights. A car stops.'));
    expect(before.units.at(-1)).toEqual({ kind: 'element', element: expect.objectContaining({ type: 'action' }) });
    expect(after.units.map(describe).at(-1)).toBe('action:Headlights. A car stops.');
    expect(before.units.map(describe).at(-1)).toBe('action:Headlights.');
  });
});

test.describe('the save line and the write that did not land', () => {
  test('the footer says what the prose editor says: saved, saving, or not saved yet with the words still in the tab', () => {
    expect(saveLineOf({ state: 'clean', dirty: false, revision: 3, lastError: null })).toBe('Saved');
    expect(saveLineOf({ state: 'pending', dirty: true, revision: 3, lastError: null })).toBe('Saving…');
    expect(saveLineOf({ state: 'saving', dirty: true, revision: 3, lastError: null })).toBe('Saving…');
    expect(saveLineOf({ state: 'error', dirty: true, revision: 3, lastError: new Error('disk full') })).toBe(
      'Not saved yet. Your words are in this tab; they will be written again on the next change.',
    );
  });

  test('a flush that did not write is named when the view goes, and a flush that saved or had nothing to save is not', () => {
    expect(unwrittenFlushOf([{ docId: 'n_SCENE00001', outcome: 'saved', revision: 4 }])).toBeNull();
    expect(unwrittenFlushOf([{ docId: 'n_SCENE00001', outcome: 'unchanged' }])).toBeNull();
    expect(unwrittenFlushOf([{ docId: 'n_SCENE00001', outcome: 'skipped' }])).toBeNull();
    expect(unwrittenFlushOf([])).toBeNull();
    expect(unwrittenFlushOf([{ docId: 'n_SCENE00001', outcome: 'failed', error: new Error('disk full') }])).toContain('did not save');
    expect(unwrittenFlushOf([{ docId: 'n_SCENE00001', outcome: 'conflict' }])).toContain('did not save');
  });
});

test.describe('the preview rows of a script page', () => {
  const pageOf = (source: string, options: Parameters<typeof paginate>[1] = {}) => {
    const page = paginate(parseFountain(source).elements, options).find((candidate) => candidate.kind === 'script');
    if (page === undefined) throw new Error('no script page');
    return page;
  };

  test('stack the occupied rows and put the two sides of a dual pair on the same rows', () => {
    const page = pageOf(['INT. HALL - DAY', '', 'ANNA', 'I go left.', '', 'BEN ^', '(quietly)', 'I go right.'].join('\n'));
    const rows = previewRowsOf(page.lines);
    const rowOf = (text: string) => rows[page.lines.findIndex((line) => line.text === text)];
    expect(rowOf('INT. HALL - DAY')).toBe(0);
    // The blank row between the heading and the pair is collapsed.
    expect(rowOf('ANNA')).toBe(1);
    expect(rowOf('BEN')).toBe(1);
    expect(rowOf('I go left.')).toBe(2);
    expect(rowOf('(quietly)')).toBe(2);
    expect(rowOf('I go right.')).toBe(3);
  });

  test('give a page without a pair one row to each line, in order', () => {
    const page = pageOf(['INT. HALL - DAY', '', 'Rain falls.', '', 'ANNA', 'Hello.'].join('\n'));
    expect(previewRowsOf(page.lines)).toEqual(page.lines.map((_, index) => index));
  });

  test('put a scene number on its heading\'s row, and the page number after the last row', () => {
    const body = Array.from({ length: 70 }, (_, i) => `Line ${i}.`).join('\n\n');
    const pages = paginate(parseFountain(`INT. HALL - DAY\n\n${body}`).elements, { sceneNumbers: 'both' });
    const first = pages[0];
    const second = pages[1];
    if (first === undefined || second === undefined) throw new Error('expected two pages');
    const rows = previewRowsOf(first.lines);
    const heading = first.lines.findIndex((line) => line.kind === 'scene');
    expect(first.lines.filter((line) => line.kind === 'sceneNumber')).toHaveLength(2);
    expect(rows[heading + 1]).toBe(rows[heading]);
    expect(rows[heading + 2]).toBe(rows[heading]);
    const numbered = previewRowsOf(second.lines);
    const last = second.lines.length - 1;
    expect(second.lines[last]?.kind).toBe('pageNumber');
    expect(numbered[last]).toBe(Math.max(...numbered.slice(0, last)) + 1);
  });

  test('keep a pair taller than a page as two blocks, one after the other', () => {
    const speech = Array.from({ length: 400 }, (_, i) => `Word${i}`).join(' ');
    const pages = paginate(parseFountain(['ANNA', speech, '', 'BEN ^', speech].join('\n')).elements);
    for (const page of pages.filter((candidate) => candidate.kind === 'script')) {
      const rows = previewRowsOf(page.lines);
      const cues = page.lines.flatMap((line, index) => (line.kind === 'character' ? [rows[index]] : []));
      expect(new Set(cues).size).toBe(cues.length);
    }
  });
});
