import { describe, expect, it } from 'vitest';

import { TWEE_HARLOWE, TWEE_SUGARCUBE } from './fixtures.js';
import { printedOnAnyPath } from './play.js';
import { compileInk, describeTweeReport, parseInk, planTweeImport } from '../src/index.js';

function bodyOf(source: string): string {
  const { container } = planTweeImport(source);
  if (container === null) throw new Error('no container');
  return container.body;
}

function expectCompiles(body: string): void {
  const result = compileInk(body);
  expect(result.errors, body).toEqual([]);
  expect(result.ok).toBe(true);
}

const sugarcube = (...passages: string[]): string => [':: StoryData', '{"format":"SugarCube","format-version":"2.36.1"}', '', ...passages].join('\n');

describe('a SugarCube 2 story', () => {
  const plan = planTweeImport(TWEE_SUGARCUBE);

  it('is one container named by StoryTitle, with one knot per ordinary passage, and its body compiles', () => {
    expect(plan.container?.title).toBe('The Lantern');
    expect(plan.container?.knots).toEqual(['Start', 'Gate', 'The_Hall', 'Road']);
    expectCompiles(plan.container?.body ?? '');
    expect(plan.report.passages).toBe(4);
  });

  it('reads the links as choices, leaves a link-only line out of the prose, and ends a passage with no link', () => {
    const body = plan.container?.body ?? '';
    expect(body).toContain('+ [Enter the hall] -> The_Hall');
    expect(body).toContain('+ [Walk away] -> Road');
    expect(body).toContain('The story opens here. Gate\n+ [Gate] -> Gate');
    expect(body).not.toContain('[[');
    expect(body).toMatch(/=== The_Hall ===\n\/\/ Twee passage: The Hall\nA cold hall\.\n-> END/);
    expect(plan.report.choices).toBe(3);
  });

  it('counts the macros it strips, the setter on a link included, and the script passage it skips', () => {
    expect(plan.report.strippedMacros).toBe(2);
    expect(plan.report.skippedSpecial).toEqual(['Story JavaScript']);
    expect(plan.report.reading).toBe('sugarcube-2');
    expect(plan.report.strippedLinks).toBe(0);
    expect(describeTweeReport(plan.report)).toContain('2 logic blocks stripped — Twine story formats are programming environments.');
  });

  it('starts at the passage StoryData names, not the first in the file', () => {
    expect(plan.container?.body.startsWith('-> Gate\n')).toBe(true);
  });

  it('writes nothing and gives the same plan twice', () => {
    expect(planTweeImport(TWEE_SUGARCUBE)).toEqual(plan);
  });

  it('keeps the passage name and tags in a comment when the knot name differs or the passage has tags', () => {
    const body = plan.container?.body ?? '';
    expect(body).toContain('=== Gate ===\n// Twee passage: Gate [outdoor]');
    expect(body).not.toContain('// Twee passage: Road');
  });

  it('keeps prose that Ink would read as syntax, escaped, and parses as the same four knots', () => {
    const road = (plan.container?.body ?? '').split('=== Road ===')[1] ?? '';
    expect(road).toContain('You walk on. \\// not a comment * not a choice');
    const knots = parseInk(plan.container?.body ?? '').graph.nodes.filter((node) => node.kind === 'knot');
    expect(knots.map((node) => node.id)).toEqual(['Start', 'Gate', 'The_Hall', 'Road']);
  });
});

describe('macro count honesty', () => {
  it('is 0 for a story with no macros', () => {
    const plan = planTweeImport(sugarcube(':: A', 'Plain. [[B]]', '', ':: B', 'Plain.'));
    expect(plan.report.strippedMacros).toBe(0);
    expect(describeTweeReport(plan.report).join(' ')).toContain('0 logic blocks stripped');
  });

  it('counts every opening or standalone tag once and no closing tag', () => {
    const plan = planTweeImport(sugarcube(':: A', '<<if $a>>one<<elseif $b>>two<<else>>three<</if>> <<set $c to 1>><<print $c>>'));
    expect(plan.report.strippedMacros).toBe(5);
    expect(plan.container?.body).toContain('onetwothree');
    expect(plan.report.warnings.join('\n')).toContain('3 conditional tags');
  });

  it('drops the body of a script macro and counts the macros in a silent body', () => {
    const plan = planTweeImport(sugarcube(':: A', 'Hi', '<<script>>var a = "<<b>>";<</script>>', '<<silently>><<set $x to 1>><<set $y to 2>><</silently>>'));
    expect(plan.container?.body).not.toContain('var a');
    expect(plan.container?.body).not.toContain('set');
    expect(plan.report.strippedMacros).toBe(4);
  });

  it('drops a line that held only macros and keeps the text around a macro', () => {
    const body = bodyOf(sugarcube(':: A', '<<set $a to 1>>', 'Before <<print $a>> after.'));
    expect(body).toContain('Before  after.');
    expect(body).not.toMatch(/\n\n\n/);
    expectCompiles(body);
  });
});

describe('the Twee 3 headers', () => {
  it('decodes escaped brackets to one passage, not three', () => {
    const plan = planTweeImport(':: Hall \\[East\\] \\{x\\}\nText.\n');
    expect(plan.report.passages).toBe(1);
    expect(plan.container?.body).toContain('// Twee passage: Hall [East] {x}');
    expect(plan.report.warnings.join('\n')).not.toContain('not escaped');
    expectCompiles(plan.container?.body ?? '');
  });

  it('reads tags and metadata when the header is well formed', () => {
    const plan = planTweeImport(':: Cave [dark cold] {"position":"1,1"}\nText.\n');
    expect(plan.container?.body).toContain('// Twee passage: Cave [dark cold]');
    expect(plan.report.warnings.join('\n')).toContain('metadata were not kept');
  });

  it('warns on an unescaped bracket that is not a tag block, and does not split the name', () => {
    for (const header of [':: Hall [East', ':: Hall [East] Wing', ':: Hall East]']) {
      const plan = planTweeImport(`${header}\nText.\n`);
      expect(plan.report.warnings.join('\n'), header).toContain('has a bracket that is not escaped');
      expect(plan.report.passages).toBe(1);
      expect(plan.container?.body).toContain(`// Twee passage: ${header.slice(3)}`);
      expectCompiles(plan.container?.body ?? '');
    }
  });

  it('tolerates CRLF, a byte order mark and trailing blank lines, and warns about text above the first header', () => {
    const plan = planTweeImport('﻿stray\r\n:: A\r\nOne.\r\n\r\n\r\n:: B\r\nTwo.\r\n');
    expect(plan.report.passages).toBe(2);
    expect(plan.container?.body).toContain('One.\n-> END\n\n=== B');
    expect(plan.report.warnings.join('\n')).toContain('Text above the first passage header was not imported.');
  });

  it('warns about StoryData that is not JSON, and falls back to the first passage as the entry', () => {
    const plan = planTweeImport(':: StoryData\nnot json\n\n:: First\nHi\n\n:: Second\nYo\n');
    expect(plan.report.warnings[0]).toContain('not valid JSON');
    expect(plan.container?.body.startsWith('-> First\n')).toBe(true);
  });

  it('starts at Start when StoryData names no start, and warns when the named start does not exist', () => {
    expect(bodyOf(':: A\nx\n\n:: Start\ny\n').startsWith('-> Start\n')).toBe(true);
    const plan = planTweeImport(':: StoryData\n{"start":"Nowhere"}\n\n:: A\nx\n\n:: Start\ny\n');
    expect(plan.report.warnings.join('\n')).toContain('"Nowhere"');
    expect(plan.container?.body.startsWith('-> Start\n')).toBe(true);
  });

  it('has no container when there is no passage to import', () => {
    expect(planTweeImport('').container).toBeNull();
    expect(planTweeImport(':: StoryTitle\nOnly a title\n').container).toBeNull();
  });
});

describe('a story in a format the reader does not know', () => {
  const plan = planTweeImport(TWEE_HARLOWE);

  it('imports structure and prose, strips links and macros, and says so', () => {
    expect(plan.report.reading).toBe('structure-only');
    expect(plan.report.format).toBe('Harlowe');
    expect(plan.report.formatVersion).toBe('3.3.8');
    expect(plan.report.choices).toBe(0);
    expect(plan.report.strippedLinks).toBe(2);
    expect(plan.report.strippedMacros).toBe(1);
    expect(plan.container?.body).toContain('Go to the cellar or Attic.');
    expect(plan.container?.body).not.toContain('+ [');
    expectCompiles(plan.container?.body ?? '');
    const lines = describeTweeReport(plan.report);
    expect(lines[0]).toBe('Story format: Harlowe 3.3.8 (structure only).');
    expect(lines.join('\n')).toContain('2 links stripped to their text');
    expect(plan.report.warnings.join('\n')).toContain('This story uses Harlowe 3.3.8.');
  });

  it('treats a story that names no format, or SugarCube 1, the same way', () => {
    expect(planTweeImport(':: A\n[[B]]\n\n:: B\nx\n').report.reading).toBe('structure-only');
    expect(planTweeImport(':: A\nx\n').report.warnings.join('\n')).toContain('names no story format');
    expect(planTweeImport(':: StoryData\n{"format":"SugarCube","format-version":"1.0.35"}\n\n:: A\n[[B]]\n').report.reading).toBe('structure-only');
  });
});

describe('knot names and links that need care', () => {
  it('mints a valid unique knot name from any passage name', () => {
    const names = ['END', '7th Gate', 'Hall of Mirrors!', 'hall of mirrors?', '???', 'Café', '広間', 'function'];
    const plan = planTweeImport(sugarcube(...names.flatMap((name) => [`:: ${name}`, 'x', ''])));
    const knots = plan.container?.knots ?? [];
    expect(knots).toEqual(['p_END', 'p_7th_Gate', 'Hall_of_Mirrors', 'hall_of_mirrors', 'passage', 'Cafe', '広間', 'p_function']);
    expect(new Set(knots).size).toBe(names.length);
    expectCompiles(plan.container?.body ?? '');
  });

  it('de-duplicates two passages with one name and sends links to the first', () => {
    const plan = planTweeImport(sugarcube(':: A', '[[Next]]', '', ':: Next', 'one', '', ':: Next', 'two'));
    expect(plan.container?.knots).toEqual(['A', 'Next', 'Next_2']);
    expect(plan.container?.body).toContain('+ [Next] -> Next\n');
    expect(plan.report.warnings.join('\n')).toContain('Two passages are named "Next"');
    expectCompiles(plan.container?.body ?? '');
  });

  it('warns about a link to a passage that is not there and sends the choice to END', () => {
    const plan = planTweeImport(sugarcube(':: A', '[[Ghost]] [[Back<-Home]]'));
    expect(plan.container?.body).toContain('+ [Ghost] -> END');
    expect(plan.report.warnings.filter((warning) => warning.includes('which is not a passage'))).toHaveLength(2);
    expectCompiles(plan.container?.body ?? '');
  });

  it('reads the four link forms', () => {
    const plan = planTweeImport(sugarcube(':: A', '[[one|B]] [[two->B]] [[B<-three]] [[B]]', '', ':: B', 'x'));
    expect(plan.container?.body).toContain('+ [one] -> B\n+ [two] -> B\n+ [three] -> B\n+ [B] -> B');
    expect(plan.report.choices).toBe(4);
  });

  it('escapes what Ink would read as syntax, in prose and in a choice label', () => {
    const plan = planTweeImport(
      sugarcube(
        ':: A',
        '* a bullet',
        '- a dash',
        '=== not a knot ===',
        '~ not logic',
        'VAR x = 1',
        'TODO: later',
        '{braces} and #tags and -> arrows <- and <> glue',
        '[[Say {hi} [loudly]|B]]',
        '',
        ':: B',
        'x',
      ),
    );
    expectCompiles(plan.container?.body ?? '');
    const graph = parseInk(plan.container?.body ?? '').graph;
    expect(graph.nodes.filter((node) => node.kind === 'knot')).toHaveLength(2);
    expect(graph.variables).toEqual([]);
    const printed = printedOnAnyPath(plan.container?.body ?? '');
    for (const line of ['* a bullet', '- a dash', '=== not a knot ===', '~ not logic', 'VAR x = 1', 'TODO: later', '{braces} and #tags and -> arrows <- and <> glue']) {
      expect(printed.has(line), line).toBe(true);
    }
  });

  it('survives hostile input', () => {
    const hostile = ':: A\n' + '<<'.repeat(5000) + '[['.repeat(5000) + '\\'.repeat(5000) + '\n';
    expect(planTweeImport(hostile).report.passages).toBe(1);
  });
});
