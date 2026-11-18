/**
 * The Inklewriter reader (issue #286), on synthetic story exports: the vendored converter runs, the Ink reaches the
 * shared planner, images are listed by URL, the editor data is named as a loss, and bad input is refused, never thrown.
 */
import { describe, expect, it } from 'vitest';
import { readInklewriter } from '../src/index.js';

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const editorData = { playPoint: 'start', textSize: 1, authorName: 'A. Writer', libraryVisible: false };

/** A story with choices, diverts, a stitch image and a flag. */
const door = {
  title: 'The Door',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  url_key: 'the-door',
  data: {
    allowCheckpoints: false,
    optionMirroring: true,
    initial: 'start',
    stitches: {
      start: {
        content: [
          'You stand before a door.',
          { option: 'Open it', linkPath: 'open', ifConditions: null, notIfConditions: null },
          { option: 'Walk away', linkPath: 'away', ifConditions: null, notIfConditions: null },
        ],
      },
      open: {
        content: ['The door opens onto a hall.', { image: 'https://example.com/door.png' }, { flagName: 'opened' }, { divert: 'end' }],
      },
      away: { content: ['You walk away.', { divert: 'end' }] },
      end: { content: ['The end.'] },
    },
    editorData,
  },
};

describe('readInklewriter', () => {
  it('reads a story into an Ink plan with choices and diverts intact', () => {
    const result = readInklewriter(bytes(door));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { plan, ink, title } = result.value;
    expect(title).toBe('The Door');
    expect(ink).toContain('# title: The Door');
    expect(ink).toContain('# author: A. Writer');
    expect(ink).toContain('-> ');
    expect(plan.containers.length).toBeGreaterThan(0);
    expect(plan.containers[0]?.body).toContain('You stand before a door.');
    expect(plan.entryDiverts.length).toBeGreaterThan(0);
  });

  it('keeps a flag as a VAR and lists the stitch image by URL', () => {
    const result = readInklewriter(bytes(door));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ink).toContain('VAR opened = false');
    expect(result.value.ink).toContain('# IMAGE: https://example.com/door.png');
    expect(result.value.images).toEqual([{ url: 'https://example.com/door.png', stitch: 'open' }]);
    // The reader reports images as data; the preview says they are listed and not downloaded. It makes no claim of its own.
    expect(result.value.notices).toEqual([]);
  });

  it('names the editor data as a loss, never dropping it silently', () => {
    const result = readInklewriter(bytes(door));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.losses.join(' ')).toMatch(/editor data/i);
  });

  it('reads conditions and flags into conditional Ink', () => {
    const conditional = {
      title: 'The Flag',
      created_at: '',
      updated_at: '',
      url_key: 'the-flag',
      data: {
        allowCheckpoints: false,
        optionMirroring: true,
        initial: 'start',
        stitches: {
          start: { content: ['Start.', { flagName: 'ready' }, { divert: 'gate' }] },
          gate: { content: [{ ifCondition: 'ready' }, 'You may pass.', { divert: 'end' }] },
          end: { content: ['Done.'] },
        },
        editorData,
      },
    };
    const result = readInklewriter(bytes(conditional));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ink).toContain('VAR ready = false');
    expect(result.value.ink).toContain('{ ready:');
    expect(result.value.images).toEqual([]);
  });

  it('falls back to the file name, then Untitled, for an empty title', () => {
    const untitled = { ...door, title: '' };
    const named = readInklewriter(bytes(untitled), 'my-story.json');
    expect(named.ok).toBe(true);
    if (named.ok) expect(named.value.title).toBe('my-story');
    const bare = readInklewriter(bytes(untitled));
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.value.title).toBe('Untitled');
  });

  it('refuses input that is not JSON', () => {
    const result = readInklewriter(new TextEncoder().encode('this is not json'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-json');
  });

  it('refuses JSON that is not an Inklewriter story', () => {
    const result = readInklewriter(bytes({ hello: 'world' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-inklewriter');
  });

  it('refuses a story the converter cannot convert, without throwing', () => {
    // A stitch with both a choice and a divert is impossible in inklewriter; the converter throws on it.
    const bad = {
      title: 'Bad',
      created_at: '',
      updated_at: '',
      url_key: 'bad',
      data: {
        allowCheckpoints: false,
        optionMirroring: true,
        initial: 's',
        stitches: {
          s: { content: ['x', { option: 'o', linkPath: 's', ifConditions: null, notIfConditions: null }, { divert: 's' }] },
        },
        editorData,
      },
    };
    const result = readInklewriter(bytes(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('convert-failed');
  });
});

/** A story whose one section label, or one flag, is written in characters the converter's name rule drops. */
const withContent = (stitches: Record<string, { content: unknown[] }>, initial = 'start') => ({
  title: 'Named',
  data: { initial, stitches, editorData },
});

describe('names the converter cannot make', () => {
  it('gives a section label with no Latin letters a name, and diverts to that name', () => {
    const story = withContent({
      start: { content: [{ pageLabel: '第一章' }, 'You stand before a door.', { divert: 'end' }] },
      end: { content: ['The end.'] },
    });
    const result = readInklewriter(bytes(story));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ink).toContain('==== section_1 ====');
    expect(result.value.ink).toContain('-> section_1');
    expect(result.value.ink).not.toContain('====  ====');
    expect(result.value.renames).toEqual([{ kind: 'section', from: '第一章', to: 'section_1' }]);
    // A real knot, so the planner makes a container of the section rather than of the whole file.
    expect(result.value.plan.containers[0]?.body).toContain('==== section_1 ====');
    expect(result.value.plan.containers[0]?.body).not.toContain('// Converted from original inklewriter URL');
  });

  it('gives two unusable section labels different names', () => {
    const story = withContent({
      start: { content: [{ pageLabel: '第一章' }, 'One.', { divert: 'two' }] },
      two: { content: [{ pageLabel: '第二章' }, 'Two.'] },
    });
    const result = readInklewriter(bytes(story));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ink).toContain('==== section_1 ====');
    expect(result.value.ink).toContain('==== section_2 ====');
    expect(result.value.renames.map((r) => r.to)).toEqual(['section_1', 'section_2']);
  });

  it('renames a flag where it is declared and everywhere it is tested', () => {
    const story = withContent({
      start: {
        content: [
          'Start.',
          { flagName: '开关' },
          { option: 'Go', linkPath: 'gate', ifConditions: [{ ifCondition: '开关' }], notIfConditions: [{ notIfCondition: '开关' }] },
        ],
      },
      gate: { content: [{ ifCondition: '开关' }, 'Open.', { notIfCondition: '开关' }, 'Shut.'] },
    });
    const result = readInklewriter(bytes(story));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ink).toContain('VAR flag_1 = false');
    expect(result.value.ink).toContain('~ flag_1 = true');
    expect(result.value.ink).toContain('{flag_1} {not flag_1}');
    expect(result.value.ink).toContain('{ flag_1 and not flag_1:');
    expect(result.value.ink).not.toContain('VAR  =');
    expect(result.value.renames).toEqual([{ kind: 'flag', from: '开关', to: 'flag_1' }]);
  });

  it('leaves a label the converter can name alone', () => {
    const story = withContent({
      start: { content: [{ pageLabel: 'The Hall' }, 'One.', { flagName: 'ready' }, { divert: 'end' }] },
      end: { content: ['Two.'] },
    });
    const result = readInklewriter(bytes(story));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ink).toContain('==== The_Hall ====');
    expect(result.value.ink).toContain('VAR ready = false');
    expect(result.value.renames).toEqual([]);
  });
});

describe('names that are also Object members', () => {
  /** Written as JSON text, since an object literal's `__proto__:` sets a prototype rather than a key. */
  const protoStory =
    '{"title":"Proto","data":{"initial":"__proto__","stitches":{"__proto__":{"content":["A door.",{"divert":"end"}]},"end":{"content":["The end."]}},"editorData":{"playPoint":"__proto__","textSize":1,"authorName":"A. Writer","libraryVisible":false}}}';

  it('imports a stitch called __proto__ as an ordinary stitch, and pollutes nothing', () => {
    const result = readInklewriter(new TextEncoder().encode(protoStory));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ink).toContain('A door.');
    expect(result.value.ink).toContain('The end.');
    expect(result.value.plan.containers.length).toBeGreaterThan(0);
    expect(({} as Record<string, unknown>)['content']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'divert')).toBe(false);
  });

  it('does not skip a stitch called toString', () => {
    const story = withContent({
      start: { content: ['A door.', { divert: 'toString' }] },
      toString: { content: ['The end.'] },
    });
    const result = readInklewriter(bytes(story));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ink).toContain('The end.');
  });

  it('declares a flag called constructor as a variable of its own', () => {
    const story = withContent({ start: { content: ['A door.', { flagName: 'constructor' }] } });
    const result = readInklewriter(bytes(story));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ink).toContain('VAR constructor = false');
    expect(result.value.ink).toContain('~ constructor = true');
    expect(result.value.ink).not.toContain('native code');
  });
});

describe('a story that cannot be converted', () => {
  it('refuses an empty stitch map instead of importing a divert to undefined', () => {
    const result = readInklewriter(bytes(withContent({})));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('no-stitches');
  });

  it('refuses a story whose first stitch is not in the file', () => {
    const result = readInklewriter(bytes(withContent({ other: { content: ['Elsewhere.'] } })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('initial-missing');
  });

  it('refuses a first stitch with no content array', () => {
    const result = readInklewriter(bytes({ title: 'Broken', data: { initial: 'start', stitches: { start: {} }, editorData } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('initial-missing');
  });
});
