import { expect, test } from '@playwright/test';

import { dialogueModelOf } from '../../apps/desktop/src/media/dialogue-model.js';
import type { CodexEntry } from '../../packages/store/src/index.js';
import { loadInkCompiler } from '../../packages/dialogue/src/index.js';

const DOC = 'n_DLG0000001';

/** Four knots and the top of the body. `stay` runs off its end, and `forgotten` is named by nothing. */
const INK = [
  '-> start',
  '=== start ===',
  'Ana: Shall we go?',
  '* [Yes] -> outside',
  '* [No] -> stay',
  '=== outside ===',
  'Outside it is cold.',
  '-> END',
  '=== stay ===',
  'Ana: Fine, we stay.',
  '=== forgotten ===',
  'Nobody is here.',
  '-> END',
].join('\n');

/** A codex character, with every field the store's entry has, so the speaker check can match `Ana`. */
function character(name: string): CodexEntry {
  return {
    id: 'c_ANA0000001',
    name,
    aliases: [],
    type: 'character',
    description: '',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
  };
}

// The Ink compiler loads on demand, as it does in the app (dialogue ink-loader.ts); these specs read the Ink with it.
test.beforeAll(async () => {
  await loadInkCompiler();
});

test.describe('the outline and the graph', () => {
  test('the outline lists the top of the body and every knot, with each choice and its target', () => {
    const model = dialogueModelOf(DOC, INK, [character('Ana')]);
    expect(model.outline.map((node) => node.name)).toEqual(['Top of the body', 'start', 'outside', 'stay', 'forgotten']);
    const start = model.outline.find((node) => node.id === 'start');
    expect(start?.choices.map((choice) => [choice.label, choice.target])).toEqual([
      ['Yes', 'outside'],
      ['No', 'stay'],
    ]);
    // A choice label is a speakable row of its own (dialogue-narrative §6), so it sits in the node's lines too.
    expect(start?.lines.map((line) => [line.kind, line.speaker, line.text])).toEqual([
      ['line', 'Ana', 'Shall we go?'],
      ['choice', null, 'Yes'],
      ['choice', null, 'No'],
    ]);
  });

  test('the graph has one arrow per choice between knots, and no arrow to END', () => {
    const model = dialogueModelOf(DOC, INK, [character('Ana')]);
    expect(model.edges).toContainEqual({ from: 'start', to: 'outside', kind: 'choice', label: 'Yes' });
    expect(model.edges).toContainEqual({ from: 'start', to: 'stay', kind: 'choice', label: 'No' });
    expect(model.edges.some((edge) => edge.to === 'END')).toBe(false);
  });

  test('the layout puts each reached knot one row below the knot that leads to it, and the unreached knot in the last row', () => {
    const { layout } = dialogueModelOf(DOC, INK, [character('Ana')]);
    const placement = (id: string) => layout.placements.find((item) => item.id === id);
    expect(placement('start')?.layer).toBe(1);
    expect(placement('outside')?.layer).toBe(2);
    expect(placement('stay')?.layer).toBe(2);
    expect(placement('forgotten')).toMatchObject({ layer: 3, reached: false });
  });

  test('the layout is the same for the same body', () => {
    const first = dialogueModelOf(DOC, INK, [character('Ana')]).layout;
    const second = dialogueModelOf(DOC, INK, [character('Ana')]).layout;
    expect(second).toEqual(first);
  });
});

test.describe('the findings', () => {
  test('a knot whose flow runs off its end is a loose end, placed on that knot', () => {
    const model = dialogueModelOf(DOC, INK, [character('Ana')]);
    const looseEnds = model.findings.filter((finding) => finding.checkId === 'branch.loose-end');
    expect(looseEnds).toHaveLength(1);
    expect(looseEnds[0]?.severity).toBe('warning');
    const stay = model.outline.find((node) => node.id === 'stay');
    expect(stay?.findings.map((finding) => finding.checkId)).toEqual(['branch.loose-end']);
  });

  test('a knot nothing names is a dead end: it is marked unreached on the outline, and carries an info finding', () => {
    const model = dialogueModelOf(DOC, INK, [character('Ana')]);
    const forgotten = model.outline.find((node) => node.id === 'forgotten');
    expect(forgotten?.reached).toBe(false);
    expect(forgotten?.findings.map((finding) => [finding.checkId, finding.severity])).toEqual([['branch.dead-end', 'info']]);
    expect(model.outline.find((node) => node.id === 'start')?.reached).toBe(true);
  });

  test('a speaker that matches no codex character is an info finding, placed on the knot of its first line', () => {
    const model = dialogueModelOf(DOC, INK, []);
    const speaker = model.findings.filter((finding) => finding.checkId === 'dialogue.speaker-unknown');
    expect(speaker).toHaveLength(1);
    expect(speaker[0]?.severity).toBe('info');
    expect(model.outline.find((node) => node.id === 'start')?.findings.map((finding) => finding.checkId)).toContain('dialogue.speaker-unknown');
  });

  test('a codex character named by the cue clears the speaker finding', () => {
    const model = dialogueModelOf(DOC, INK, [character('Ana')]);
    expect(model.findings.some((finding) => finding.checkId === 'dialogue.speaker-unknown')).toBe(false);
  });

  test('the model resolves a speaker through a codex alias, by the same resolution the Findings scan uses', () => {
    const model = dialogueModelOf(DOC, INK, [{ ...character('Ana Marsh'), aliases: ['Ana'] }]);
    expect(model.findings.some((finding) => finding.checkId === 'dialogue.speaker-unknown')).toBe(false);
  });

  test('a body with nothing in it has an outline of its top alone, and no finding', () => {
    const model = dialogueModelOf(DOC, '', [character('Ana')]);
    expect(model.outline.map((node) => node.name)).toEqual(['Top of the body']);
    expect(model.findings).toEqual([]);
    expect(model.errors).toEqual([]);
  });
});

test.describe('the compile and the declarations', () => {
  test('a divert to a knot that does not exist is a compile error, reported with its line, and counted in the stats', () => {
    const model = dialogueModelOf(DOC, ['-> start', '=== start ===', 'Ana: Hello.', '-> nowhere'].join('\n'), [character('Ana')]);
    expect(model.errors.length).toBeGreaterThan(0);
    expect(model.errors.some((error) => error.includes('nowhere'))).toBe(true);
    expect(model.stats.errors).toBe(model.errors.length);
  });

  test('a compile error names its line once, in the writer’s words', () => {
    const body = ['-> start', '=== start ===', 'Ana: Hello.', '-> nowhere'].join('\n');
    const [error] = dialogueModelOf(DOC, body, [character('Ana')]).errors;
    expect(error).toMatch(/^line \d+: /);
    expect(error).not.toContain('ERROR');
    expect(error?.match(/line \d+/g)).toHaveLength(1);
  });

  test('a declared variable is listed with its default', () => {
    const model = dialogueModelOf(DOC, ['VAR gold = 10', '-> start', '=== start ===', 'Done.', '-> END'].join('\n'), [character('Ana')]);
    expect(model.variables).toEqual(['VAR gold = 10']);
  });

  test('the stats count the knots, the stitches and the choices of the parse', () => {
    const model = dialogueModelOf(DOC, INK, [character('Ana')]);
    expect(model.stats).toMatchObject({ knots: 4, choices: 2 });
  });
});
