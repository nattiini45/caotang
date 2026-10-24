import { expect, test } from '@playwright/test';

import { fillSegments, fountainSegments, type Segment } from '../../apps/desktop/src/media/source-decor.js';
import { cueCompletion, cueNames, enterAfterCue, enterOnEmptyDialogue } from '../../apps/desktop/src/media/screenplay-keys.js';
import { chordLabel, chordPlatform, chordRange, elementChord, elementEntries, opensElementMenu, type ChordEvent, type ChordPlatform } from '../../apps/desktop/src/media/element-menu.js';

/** The text the segments draw, joined back together: a decoration must never change a character (screenplay.md §3). */
function textOf(source: string, segments: readonly Segment[]): string {
  return segments.map((segment) => source.slice(segment.from, segment.to)).join('');
}

/** The class of the first segment whose text starts with `needle`, or `undefined` when none does. */
function classOf(source: string, segments: readonly Segment[], needle: string): string | null | undefined {
  return segments.find((segment) => source.slice(segment.from, segment.to).includes(needle))?.cls;
}

const SCRIPT = [
  'INT. HOUSE - DAY',
  '= The first night.',
  '',
  'Action paragraph here.',
  '',
  'ELENA',
  '(quietly)',
  "I'm home.",
  '',
  'CUT TO:',
  '',
].join('\n');

test.describe('the decoration layer covers the text and changes none of it', () => {
  test('the segments of a Fountain body concatenate back to the body, with no gap or overlap', () => {
    const segments = fountainSegments(SCRIPT);
    expect(textOf(SCRIPT, segments)).toBe(SCRIPT);
    // Each segment starts where the one before it ended.
    segments.forEach((segment, index) => {
      if (index > 0) expect(segment.from).toBe(segments[index - 1]?.to);
    });
  });

  test('an empty body has no segments, and the layer has nothing to draw', () => {
    expect(fountainSegments('')).toEqual([]);
  });

  test('fillSegments clips a mark that starts inside an earlier one, so the outer class wins', () => {
    const segments = fillSegments(10, [
      { from: 0, to: 10, cls: 'outer' },
      { from: 2, to: 4, cls: 'inner' },
    ]);
    expect(segments).toEqual([{ from: 0, to: 10, cls: 'outer' }]);
  });
});

test.describe('the Source tab draws the parse', () => {
  test('a scene heading, a cue, a parenthetical, a transition and a synopsis each get their class', () => {
    const segments = fountainSegments(SCRIPT);
    expect(classOf(SCRIPT, segments, 'INT. HOUSE')).toBe('tok-heading');
    expect(classOf(SCRIPT, segments, 'The first night')).toBe('tok-synopsis');
    expect(classOf(SCRIPT, segments, 'ELENA')).toBe('tok-cue');
    expect(classOf(SCRIPT, segments, '(quietly)')).toBe('tok-paren');
    expect(classOf(SCRIPT, segments, 'CUT TO:')).toBe('tok-transition');
  });

  test('action and dialogue are drawn plain', () => {
    const segments = fountainSegments(SCRIPT);
    expect(classOf(SCRIPT, segments, 'Action paragraph')).toBeNull();
    expect(classOf(SCRIPT, segments, "I'm home")).toBeNull();
  });

  test('a note and a boneyard are drawn as annotations', () => {
    const source = 'INT. A - DAY\n\n[[a note]]\n\n/* a boneyard */\n';
    const segments = fountainSegments(source);
    expect(textOf(source, segments)).toBe(source);
    expect(classOf(source, segments, 'a note')).toBe('tok-note');
  });
});

test.describe('Enter after a cue and on empty dialogue', () => {
  test('Enter at the end of a cue moves the caret onto its dialogue, and makes no blank line between them', () => {
    const text = 'INT. HOUSE - DAY\n\nELENA\nHi.';
    const cueEnd = text.indexOf('\nHi.');
    expect(enterAfterCue(text, cueEnd)).toEqual({ text, caret: cueEnd + 1 });
  });

  test('a line that is not a cue, and the middle of a cue, keep the Enter key\'s meaning', () => {
    const text = 'INT. HOUSE - DAY\n\nELENA\nHi.';
    expect(enterAfterCue(text, 3)).toBeNull();
    expect(enterAfterCue(text, text.indexOf('Hi.') + 3)).toBeNull();
    // A line that the parser reads as action, even in capitals, is not a cue until dialogue follows it.
    expect(enterAfterCue('INT. HOUSE - DAY\n\nELENA', 'INT. HOUSE - DAY\n\nELENA'.length)).toBeNull();
  });

  test('Enter on an empty line after dialogue ends the block, and the caret starts action', () => {
    const text = 'ELENA\nI\'m home.\n';
    const edit = enterOnEmptyDialogue(text, text.length);
    expect(edit).toEqual({ text: "ELENA\nI'm home.\n\n", caret: text.length + 1 });
  });

  test('Enter on an empty line after action keeps its meaning', () => {
    const text = 'Action paragraph.\n';
    expect(enterOnEmptyDialogue(text, text.length)).toBeNull();
  });
});

test.describe('Tab completes a cue name', () => {
  // The codex holds a character with an alias, and a location and a lore entry whose names a cue must never complete to.
  const names = cueNames(
    ['ELENA'],
    [
      { name: 'Marcus', type: 'character', aliases: ['Marc'] },
      { name: 'Harbour House', type: 'location', aliases: ['Harbor'] },
      { name: 'Salt Lore', type: 'lore', aliases: ['Saltish'] },
    ],
  );

  test('the names are the cued characters and the codex characters, in capitals, once each, in order', () => {
    expect(names).toEqual(['ELENA', 'MARC', 'MARCUS']);
  });

  test('a location or lore entry, and its alias, never completes a cue', () => {
    const location = 'INT. HOUSE - DAY\n\nhar';
    expect(cueCompletion(location, location.length, names)).toBeNull();
    const lore = 'INT. HOUSE - DAY\n\nsal';
    expect(cueCompletion(lore, lore.length, names)).toBeNull();
  });

  test('a name typed in full keeps Tab\'s meaning, even when a longer name starts with it', () => {
    const pair = cueNames([], [
      { name: 'Anna', type: 'character', aliases: [] },
      { name: 'Annabel', type: 'character', aliases: [] },
    ]);
    const full = 'INT. HOUSE - DAY\n\nANNA';
    expect(cueCompletion(full, full.length, pair)).toBeNull();
    // What is typed is only the start of "ANNA", so it completes to the first name that starts with it.
    const partial = 'INT. HOUSE - DAY\n\nANN';
    expect(cueCompletion(partial, partial.length, pair)).toEqual({ text: 'INT. HOUSE - DAY\n\nANNA', caret: partial.length + 1 });
  });

  test('a half-typed cue completes to the first name that starts with it, in capitals', () => {
    const text = 'INT. HOUSE - DAY\n\nmar';
    // "MARC" is the first of "MARC" and "MARCUS" in alphabetical order, and the caret ends after it.
    expect(cueCompletion(text, text.length, names)).toEqual({ text: 'INT. HOUSE - DAY\n\nMARC', caret: text.length + 1 });
  });

  test('a name already typed in full has nothing to complete, and Tab keeps its meaning', () => {
    const text = 'INT. HOUSE - DAY\n\nELENA';
    expect(cueCompletion(text, text.length, names)).toBeNull();
  });

  test('a line under other text is not a cue position, so Tab does nothing there', () => {
    const text = 'The gulls wheel.\nmar';
    expect(cueCompletion(text, text.length, names)).toBeNull();
  });

  test('leading spaces the writer typed are kept, and only the name is replaced', () => {
    const text = 'INT. HOUSE - DAY\n\n  EL';
    // The name starts after the two spaces, so the caret is two spaces and the five letters of "ELENA" past the line start.
    expect(cueCompletion(text, text.length, names)).toEqual({ text: 'INT. HOUSE - DAY\n\n  ELENA', caret: text.length + 3 });
  });
});

test.describe('the element menu lists the elements and marks the line’s own', () => {
  const BLOCK = ['INT. HOUSE - DAY', '', 'ANNA', 'Hello.'].join('\n');

  test('lists the nine elements in order, each with its digit', () => {
    const entries = elementEntries(BLOCK, BLOCK.indexOf('Hello'));
    expect(entries.map((entry) => entry.label)).toEqual([
      'Scene heading',
      'Action',
      'Character',
      'Parenthetical',
      'Dialogue',
      'Transition',
      'Centered',
      'Note',
      'Page break',
    ]);
    expect(entries.map((entry) => entry.shortcut)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  test('marks the element of the caret’s line, and only that one', () => {
    const checked = (caret: number) => elementEntries(BLOCK, caret).filter((entry) => entry.checked).map((entry) => entry.type);
    expect(checked(BLOCK.indexOf('Hello'))).toEqual(['dialogue']);
    expect(checked(BLOCK.indexOf('ANNA'))).toEqual(['character']);
    expect(checked(0)).toEqual(['scene_heading']);
    // A blank line is no element yet.
    expect(checked(BLOCK.indexOf('\n\n') + 1)).toEqual([]);
  });

  test('offers dialogue and a parenthetical only under a cue', () => {
    const offered = (caret: number) => elementEntries(BLOCK, caret).filter((entry) => entry.edit !== null).map((entry) => entry.type);
    expect(offered(BLOCK.indexOf('Hello'))).toContain('parenthetical');
    expect(offered(0)).not.toContain('dialogue');
    expect(offered(0)).not.toContain('parenthetical');
  });

  test('each entry carries the edit the engine makes', () => {
    const paren = elementEntries(BLOCK, BLOCK.indexOf('Hello')).find((entry) => entry.type === 'parenthetical');
    expect(paren?.edit?.text).toBe(['INT. HOUSE - DAY', '', 'ANNA', '(Hello.)'].join('\n'));
  });

  test('Ctrl+E and Cmd+E open it, and no other chord does', () => {
    const key = (over: Partial<ChordEvent> = {}): boolean =>
      opensElementMenu({ key: 'e', code: 'KeyE', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...over });
    // The ordinary chord, on the printed letter and on the physical key the layout types it with.
    expect(key({ ctrlKey: true })).toBe(true);
    expect(key({ metaKey: true })).toBe(true);
    expect(key({ ctrlKey: true, key: 'E' })).toBe(true);
    expect(key({ ctrlKey: true, code: 'KeyE' })).toBe(true);
    expect(key({})).toBe(false);
    expect(key({ ctrlKey: true, shiftKey: true })).toBe(false);
    expect(key({ ctrlKey: true, altKey: true })).toBe(false);
    expect(key({ ctrlKey: true, key: 'r', code: 'KeyR' })).toBe(false);
    // ui-modules §2.5: a layout that prints another script is read through the physical key, so Ctrl+У (KeyE) opens it.
    expect(key({ key: 'у', code: 'KeyE', ctrlKey: true })).toBe(true);
    // A key typed with AltGraph is a character, a key held down is one press, and a composing key belongs to the input method.
    expect(key({ ctrlKey: true, altKey: true, getModifierState: (name) => name === 'AltGraph' })).toBe(false);
    expect(key({ ctrlKey: true, repeat: true })).toBe(false);
    expect(key({ ctrlKey: true, isComposing: true })).toBe(false);
  });
});

test.describe('the element chords', () => {
  const press = (over: Partial<ChordEvent> = {}): ChordEvent => ({
    key: '3',
    code: 'Digit3',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...over,
  });
  const WINDOWS = { ctrlKey: true, shiftKey: true };
  const MAC = { metaKey: true, altKey: true };

  test('Ctrl+Shift+digit on Windows and Linux, and Cmd+Alt+digit on a Mac, choose the element of that menu digit', () => {
    const types = ['scene_heading', 'action', 'character', 'parenthetical', 'dialogue', 'transition', 'centered', 'note', 'page_break'];
    types.forEach((type, index) => {
      expect(elementChord(press({ ...WINDOWS, code: `Digit${index + 1}` }), 'other')).toBe(type);
      expect(elementChord(press({ ...MAC, code: `Digit${index + 1}` }), 'mac')).toBe(type);
    });
    // The menu's digit and the chord's digit are the same number.
    for (const entry of elementEntries('INT. HOUSE - DAY', 0, 'other')) {
      expect(entry.chord).toBe(`Ctrl+Shift+${entry.shortcut}`);
      expect(chordLabel(entry.type, 'mac')).toBe(`Cmd+Alt+${entry.shortcut}`);
    }
  });

  test('reads the physical key, so a layout that types a symbol there, or a shifted digit, still chooses', () => {
    expect(elementChord(press({ ...WINDOWS, code: 'Digit3' }), 'other')).toBe('character');
    expect(elementChord(press({ ...MAC, code: 'Digit7' }), 'mac')).toBe('centered');
    expect(elementChord(press({ ...WINDOWS, code: 'Numpad3' }), 'other')).toBeNull();
    expect(elementChord(press({ ...WINDOWS, code: 'Digit0' }), 'other')).toBeNull();
    expect(elementChord(press({ ...WINDOWS, code: 'KeyE' }), 'other')).toBeNull();
  });

  test('wants exactly the platform’s modifiers: Ctrl+Alt (AltGr) on Windows and Cmd+Shift on a Mac are not chords', () => {
    expect(elementChord(press({ ctrlKey: true, altKey: true }), 'other')).toBeNull();
    expect(elementChord(press({ ctrlKey: true, altKey: true, shiftKey: true }), 'other')).toBeNull();
    expect(elementChord(press({ ctrlKey: true }), 'other')).toBeNull();
    expect(elementChord(press({ shiftKey: true }), 'other')).toBeNull();
    expect(elementChord(press({ metaKey: true, shiftKey: true }), 'mac')).toBeNull();
    expect(elementChord(press({ metaKey: true, altKey: true, shiftKey: true }), 'mac')).toBeNull();
    expect(elementChord(press({ metaKey: true }), 'mac')).toBeNull();
    // Each family belongs to its platform only.
    expect(elementChord(press(MAC), 'other')).toBeNull();
    expect(elementChord(press(WINDOWS), 'mac')).toBeNull();
  });

  test('is not a chord while AltGraph is down, on key repeat, or while an input method composes', () => {
    const altGraph = (key: string): boolean => key === 'AltGraph';
    expect(elementChord(press({ ...WINDOWS, getModifierState: altGraph }), 'other')).toBeNull();
    expect(elementChord(press({ ...MAC, getModifierState: altGraph }), 'mac')).toBeNull();
    expect(elementChord(press({ ...WINDOWS, getModifierState: () => false }), 'other')).toBe('character');
    expect(elementChord(press({ ...WINDOWS, repeat: true }), 'other')).toBeNull();
    expect(elementChord(press({ ...WINDOWS, isComposing: true }), 'other')).toBeNull();
  });

  test('the platform is read from userAgentData and then platform, and anything unknown gets Ctrl+Shift', () => {
    const platformOf = (source: Parameters<typeof chordPlatform>[0]): ChordPlatform => chordPlatform(source);
    expect(platformOf({ platform: 'MacIntel' })).toBe('mac');
    expect(platformOf({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })).toBe('mac');
    expect(platformOf({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe('other');
    expect(platformOf({ platform: 'Win32' })).toBe('other');
    expect(platformOf({ platform: 'Linux x86_64' })).toBe('other');
    expect(platformOf({})).toBe('other');
    expect(platformOf(undefined)).toBe('other');
    expect(chordRange('other')).toBe('Ctrl+Shift+1 to 9');
    expect(chordRange('mac')).toBe('Cmd+Alt+1 to 9');
  });

  test('entries carry no chord until a platform is given', () => {
    expect(elementEntries('INT. HOUSE - DAY', 0).every((entry) => entry.chord === undefined)).toBe(true);
  });
});
