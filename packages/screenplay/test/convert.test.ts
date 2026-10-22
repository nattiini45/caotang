import { describe, expect, it } from 'vitest';
import { LINE_ELEMENT_TYPES, convertLine, lineElementAt, parseFountain, type LineElementType } from '../src/index.js';

/** The text without its caret mark, and the caret's offset. `|` marks the caret. */
function caretOf(marked: string): { text: string; caret: number } {
  const caret = marked.indexOf('|');
  expect(caret, 'the text marks its caret with |').toBeGreaterThanOrEqual(0);
  return { text: marked.slice(0, caret) + marked.slice(caret + 1), caret };
}

/** The conversion of the marked line, with `|` where the caret lands, or `null`. */
function convert(lines: readonly string[], target: LineElementType): string | null {
  const { text, caret } = caretOf(lines.join('\n'));
  const result = convertLine(text, caret, target);
  return result === null ? null : `${result.text.slice(0, result.caret)}|${result.text.slice(result.caret)}`;
}

/** The element the parser reads at the line holding `needle`. */
function typeOfLine(source: string, needle: string): string | null {
  const at = source.indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  return lineElementAt(source, at);
}

const join = (...lines: string[]): string => lines.join('\n');

describe('lineElementAt — the element of the caret’s line', () => {
  const SCENE = join('INT. HOUSE - DAY', '', 'Anna waits.', '', 'ANNA', '(quietly)', 'Hello.', '', 'CUT TO:', '', '> THE END <', '', '[[fix this]]', '', '===');

  it('reads each line as the parser reads it', () => {
    expect(typeOfLine(SCENE, 'INT. HOUSE')).toBe('scene_heading');
    expect(typeOfLine(SCENE, 'Anna waits')).toBe('action');
    expect(typeOfLine(SCENE, 'ANNA\n')).toBe('character');
    expect(typeOfLine(SCENE, '(quietly)')).toBe('parenthetical');
    expect(typeOfLine(SCENE, 'Hello.')).toBe('dialogue');
    expect(typeOfLine(SCENE, 'CUT TO:')).toBe('transition');
    expect(typeOfLine(SCENE, '> THE END')).toBe('centered');
    expect(typeOfLine(SCENE, '[[fix')).toBe('note');
    expect(typeOfLine(SCENE, '===')).toBe('page_break');
  });

  it('has no element on a blank line', () => {
    expect(lineElementAt(SCENE, SCENE.indexOf('\n\n') + 1)).toBeNull();
    expect(lineElementAt('', 0)).toBeNull();
  });

  it('reads an action line with a note in it as action', () => {
    expect(lineElementAt('Anna waits. [[later]]', 3)).toBe('action');
  });

  it('reads a note line inside a paragraph as the note', () => {
    expect(lineElementAt(join('Anna waits.', '[[later]]', 'She sits.'), 14)).toBe('note');
  });
});

describe('convertLine — each element in its Fountain syntax', () => {
  it('lists the elements in the menu order', () => {
    expect(LINE_ELEMENT_TYPES).toEqual([
      'scene_heading',
      'action',
      'character',
      'parenthetical',
      'dialogue',
      'transition',
      'centered',
      'note',
      'page_break',
    ]);
  });

  it('writes a heading plain when it starts with INT. or EXT., and forces it with a full stop otherwise', () => {
    expect(convert(['Anna waits.', '', '!INT. HALL - NIGHT|'], 'scene_heading')).toBe(join('Anna waits.', '', 'INT. HALL - NIGHT|'));
    expect(convert(['Anna waits.', '', 'int. hall - night|'], 'scene_heading')).toBe(join('Anna waits.', '', 'int. hall - night|'));
    expect(convert(['Anna waits.', '', 'THE ROOF|'], 'scene_heading')).toBe(join('Anna waits.', '', '.THE ROOF|'));
  });

  it('forces action with ! only where the parser would read the line as something else', () => {
    expect(convert(['INT. HALL - NIGHT', '', '.she wa|its'], 'action')).toBe(join('INT. HALL - NIGHT', '', 'she waits|'));
    // An uppercase line over text is a cue, so it needs the !.
    expect(convert(['ANNA|', 'Hello.'], 'action')).toBe(join('!ANNA|', 'Hello.'));
  });

  it('writes a cue plain when it is uppercase over text, and forces it with @ otherwise', () => {
    expect(convert(['Anna waits.', '', '!MARCUS|', 'Hello.'], 'character')).toBe(join('Anna waits.', '', 'MARCUS|', 'Hello.'));
    // Lower-case letters are kept as typed, so the cue is forced.
    expect(convert(['Anna waits.', '', 'McClane|', 'Hello.'], 'character')).toBe(join('Anna waits.', '', '@McClane|', 'Hello.'));
    // A cue with nothing under it yet is forced, or it would read as action.
    expect(convert(['Anna waits.', '', 'MARCUS|'], 'character')).toBe(join('Anna waits.', '', '@MARCUS|'));
  });

  it('keeps the dual marker of a cue that stays a cue, and drops it from one that does not', () => {
    expect(convert(['@bob ^|', 'Hi.'], 'character')).toBe(join('@bob ^|', 'Hi.'));
    expect(convert(['BOB ^|', 'Hi.'], 'action')).toBe(join('!BOB|', 'Hi.'));
  });

  it('wraps a parenthetical in round brackets with the caret inside, under a cue', () => {
    expect(convert(['ANNA', 'quietly|', 'Hello.'], 'parenthetical')).toBe(join('ANNA', '(quietly|)', 'Hello.'));
  });

  it('takes a parenthetical’s brackets off when it becomes dialogue', () => {
    expect(convert(['ANNA', '(quie|tly)', 'Hello.'], 'dialogue')).toBe(join('ANNA', 'quietly|', 'Hello.'));
  });

  it('refuses dialogue and a parenthetical away from a cue', () => {
    expect(convert(['INT. HALL - NIGHT', '', 'Anna waits.|'], 'dialogue')).toBeNull();
    expect(convert(['INT. HALL - NIGHT', '', 'Anna waits.|'], 'parenthetical')).toBeNull();
  });

  it('writes a transition plain when it ends TO:, and forces it with > otherwise', () => {
    expect(convert(['Anna waits.', '', 'CUT TO:|'], 'transition')).toBe(join('Anna waits.', '', 'CUT TO:|'));
    expect(convert(['Anna waits.', '', 'FADE OUT.|'], 'transition')).toBe(join('Anna waits.', '', '>FADE OUT.|'));
  });

  it('writes a centered line between > and <, with the caret before the <', () => {
    expect(convert(['Anna waits.', '', 'THE END|'], 'centered')).toBe(join('Anna waits.', '', '> THE END| <'));
  });

  it('writes a note in double brackets, and takes them off again', () => {
    expect(convert(['Anna waits.', '', 'fix this|'], 'note')).toBe(join('Anna waits.', '', '[[fix this|]]'));
    expect(convert(['Anna waits.', '', '[[fix this|]]'], 'action')).toBe(join('Anna waits.', '', 'fix this|'));
  });

  it('turns an empty line into a page break, and puts the break above a line with words', () => {
    expect(convert(['Anna waits.', '', '|'], 'page_break')).toBe(join('Anna waits.', '', '===|'));
    expect(convert(['Anna waits.', '', 'She s|its.'], 'page_break')).toBe(join('Anna waits.', '', '===', 'She s|its.'));
  });

  it('turns a page break back into an empty line of the chosen element', () => {
    expect(convert(['Anna waits.', '', '===|'], 'action')).toBe(join('Anna waits.', '', '!|'));
  });

  it('leaves a line that already is the element unchanged, caret and all', () => {
    expect(convert(['ANNA', 'Hel|lo.'], 'dialogue')).toBe(join('ANNA', 'Hel|lo.'));
    expect(convert(['INT. HALL|'], 'scene_heading')).toBe('INT. HALL|');
  });
});

describe('convertLine — blank lines around a block', () => {
  it('puts a blank line above a heading, a cue or a transition that sits under text', () => {
    expect(convert(['Anna waits.', 'INT. HALL - NIGHT|'], 'scene_heading')).toBe(join('Anna waits.', '', 'INT. HALL - NIGHT|'));
    expect(convert(['Anna waits.', 'MARCUS|', 'Hello.'], 'character')).toBe(join('Anna waits.', '', 'MARCUS|', 'Hello.'));
    expect(convert(['Anna waits.', 'CUT TO:|'], 'transition')).toBe(join('Anna waits.', '', 'CUT TO:|'));
  });

  it('puts a blank line above action under a dialogue block, or the block would read it as dialogue', () => {
    expect(convert(['ANNA', 'Hello.', 'She lea|ves.'], 'action')).toBe(join('ANNA', 'Hello.', '', 'She leaves.|'));
  });

  it('adds no blank line above action under action, nor above a note', () => {
    expect(convert(['Anna waits.', '[[x]]|'], 'action')).toBe(join('Anna waits.', 'x|'));
    expect(convert(['ANNA', 'Hello.', 'later|'], 'note')).toBe(join('ANNA', 'Hello.', '[[later|]]'));
  });

  it('marks an empty line for a heading or a cue, so the words typed next are that element', () => {
    expect(convert(['Anna waits.', '', '|'], 'scene_heading')).toBe(join('Anna waits.', '', '.|'));
    expect(convert(['Anna waits.', '', '|'], 'character')).toBe(join('Anna waits.', '', '@|'));
    expect(convert(['ANNA', '|'], 'parenthetical')).toBe(join('ANNA', '(|)'));
  });
});

describe('convertLine — what it never does', () => {
  const SCENE = join('INT. HOUSE - DAY', '', 'Anna waits.', '', 'ANNA', '(quietly)', 'Hello there.', '', 'CUT TO:');
  const lineStarts = [...SCENE.matchAll(/^/gm)].map((match) => match.index);

  it('keeps every word of the scene, for every line and every element', () => {
    const words = (source: string): string[] => source.match(/[A-Za-z]+/g) ?? [];
    for (const start of lineStarts) {
      for (const target of LINE_ELEMENT_TYPES) {
        const result = convertLine(SCENE, start, target);
        if (result === null) continue;
        expect(words(result.text), `line at ${start} as ${target}`).toEqual(words(SCENE));
      }
    }
  });

  it('gives a line the parser reads as the chosen element, whenever it converts', () => {
    for (const start of lineStarts) {
      for (const target of LINE_ELEMENT_TYPES) {
        const result = convertLine(SCENE, start, target);
        if (result === null || SCENE.slice(start, SCENE.indexOf('\n', start)).trim() === '') continue;
        const at = target === 'page_break' ? result.text.lastIndexOf('===', result.caret) : result.caret;
        expect(lineElementAt(result.text, at), `line at ${start} as ${target}`).toBe(target);
      }
    }
  });

  it('changes no line but the one it converts, apart from a blank line or a break above it', () => {
    const result = convertLine(SCENE, SCENE.indexOf('Anna waits.'), 'centered');
    expect(result?.text).toBe(SCENE.replace('Anna waits.', '> Anna waits. <'));
    expect(parseFountain(result?.text ?? '').elements.map((element) => element.type)).toEqual([
      'scene_heading',
      'centered',
      'character',
      'parenthetical',
      'dialogue',
      'transition',
    ]);
  });

  it('does not touch the title page or a line inside a note that runs over lines', () => {
    expect(convertLine(join('Title: Night', 'Author: A', '', 'INT. HALL'), 2, 'action')).toBeNull();
    const note = join('Anna waits.', '', '[[a long', 'note]]');
    expect(convertLine(note, note.indexOf('note]]'), 'action')).toBeNull();
  });
});

describe('convertLine — every element the menu lists is handled', () => {
  const SCENE = join('INT. HOUSE - DAY', '', 'ANNA', 'Hello there.', '', 'Anna waits.');

  it('converts to each of LINE_ELEMENT_TYPES without reaching an unhandled case', () => {
    expect(LINE_ELEMENT_TYPES).toHaveLength(9);
    for (const target of LINE_ELEMENT_TYPES) {
      // The first line has nothing above it, the last has action above it, and the dialogue line has a cue above it.
      for (const caret of [0, SCENE.indexOf('Hello'), SCENE.indexOf('Anna waits.')]) {
        expect(() => convertLine(SCENE, caret, target), `${target} at ${caret}`).not.toThrow();
      }
    }
  });

  it('throws on an element it does not know, rather than treating it as some other element', () => {
    const unknown = 'section' as unknown as LineElementType;
    expect(() => convertLine(SCENE, 0, unknown)).toThrow('Unhandled line element: section');
    expect(() => convertLine(SCENE, SCENE.indexOf('Anna waits.'), unknown)).toThrow('Unhandled line element: section');
  });
});
