import { expect, test } from '@playwright/test';

import { caretOfNode, dialogueModelOf } from '../../apps/desktop/src/media/dialogue-model.js';
import { knotCompletion } from '../../apps/desktop/src/media/ink-keys.js';
import { inkSegments, type Segment } from '../../apps/desktop/src/media/source-decor.js';
import { loadInkCompiler } from '../../packages/dialogue/src/index.js';

const INK = '=== start ===\nAlice: Hello.\n* [Wave] -> wave\n* [Leave] -> END\n\n=== wave ===\nAlice: Bye. # lineId: l_0000000001\n-> END\n';

function textOf(source: string, segments: readonly Segment[]): string {
  return segments.map((segment) => source.slice(segment.from, segment.to)).join('');
}

/** The class of the first segment whose text is exactly `exact`, or `undefined` when there is none. */
function classOf(source: string, segments: readonly Segment[], exact: string): string | null | undefined {
  return segments.find((segment) => source.slice(segment.from, segment.to) === exact)?.cls;
}

// The Ink compiler loads on demand, as it does in the app (dialogue ink-loader.ts); these specs read the Ink with it.
test.beforeAll(async () => {
  await loadInkCompiler();
});

test.describe('the Ink source decorations', () => {
  test('the segments of an Ink body concatenate back to the body', () => {
    expect(textOf(INK, inkSegments(INK))).toBe(INK);
  });

  test('a knot header, a choice bullet, a divert, a speaker and a line-id tag each get their class', () => {
    const segments = inkSegments(INK);
    expect(classOf(INK, segments, '=== start ===')).toBe('tok-knot');
    expect(classOf(INK, segments, '*')).toBe('tok-choice');
    expect(classOf(INK, segments, '-> wave')).toBe('tok-divert');
    expect(classOf(INK, segments, 'Alice')).toBe('tok-speaker');
    expect(classOf(INK, segments, '# lineId: l_0000000001')).toBe('tok-tag');
  });

  test('a stitch header is drawn as a stitch, and a comment as a comment', () => {
    const source = '=== start ===\n= stitch\n// a note for the writer\nText.\n';
    const segments = inkSegments(source);
    expect(classOf(source, segments, '= stitch')).toBe('tok-stitch');
    expect(classOf(source, segments, '// a note for the writer')).toBe('tok-comment');
  });

  test('a declaration is drawn as one, and plain text is left plain', () => {
    const source = 'VAR gold = 3\nThe innkeeper looks up.\n';
    const segments = inkSegments(source);
    expect(classOf(source, segments, 'VAR gold = 3')).toBe('tok-decl');
    // Plain text is a run that carries no class: the one segment that covers its first character is drawn plain.
    const at = source.indexOf('The innkeeper');
    expect(segments.find((segment) => segment.from <= at && at < segment.to)?.cls).toBeNull();
  });
});

test.describe('Tab completes a knot name after a divert', () => {
  test('a divert target started in the text completes to the knot it starts', () => {
    const text = 'Go on. -> wa';
    expect(knotCompletion(text, text.length, ['start', 'wave'])).toEqual({ text: 'Go on. -> wave', caret: 'Go on. -> wave'.length });
  });

  test('a name typed in full, or a caret that is not after a divert, has nothing to complete', () => {
    expect(knotCompletion('Go on. -> wave', 'Go on. -> wave'.length, ['wave'])).toBeNull();
    expect(knotCompletion('wa', 2, ['wave'])).toBeNull();
  });

  test('a target typed in full keeps its meaning, even when a longer knot starts with it', () => {
    // Tab on "-> wave" must not retarget the divert to "wave_two", and on "-> start" must not give "start_again".
    expect(knotCompletion('-> wave', 7, ['wave', 'wave_two'])).toBeNull();
    expect(knotCompletion('-> start', 8, ['start', 'start_again'])).toBeNull();
    // A target that is only the start of a name still completes, to the first name that starts with it.
    expect(knotCompletion('-> wa', 5, ['wave', 'wave_two'])).toEqual({ text: '-> wave', caret: 7 });
  });

  test('with several names, the first in alphabetical order is taken, so the same completion is offered each time', () => {
    const text = '-> s';
    expect(knotCompletion(text, text.length, ['second', 'stitch', 'start'])).toEqual({ text: '-> second', caret: 9 });
  });
});

test.describe('the graph and the caret agree', () => {
  test('a node reports the offset of its header line, and the root starts at the top of the body', () => {
    const model = dialogueModelOf('d_TEST', INK, []);
    expect(model.targets).toEqual(['start', 'wave']);
    const wave = model.outline.find((item) => item.id === 'wave');
    expect(wave?.from).toBe(INK.indexOf('=== wave ==='));
    expect(caretOfNode('d_TEST', INK, [], 'wave')).toBe(INK.indexOf('=== wave ==='));
    expect(caretOfNode('d_TEST', INK, [], 'start')).toBe(INK.indexOf('=== start ==='));
  });

  test('a node the text no longer has has no caret position', () => {
    expect(caretOfNode('d_TEST', INK, [], 'gone')).toBeNull();
  });
});
