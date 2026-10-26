/**
 * F1 (I5 round 2): the footer reset sentence and the delete/folder-change sentences carry their
 * inflected parts inside one ICU message. These assertions pin the rendered English, so folding a
 * translated fragment into the sentence cannot change what a writer reads.
 */
import { i18n } from '@lingui/core';
import { msg, plural, select } from '@lingui/core/macro';
import { describe, expect, it } from 'vitest';

import { resetSentence } from '../apps/desktop/src/app/footer-model.js';

describe('folded sentences keep their English', () => {
  it('names the reset day and ordinal inside the sentence', () => {
    expect(resetSentence({ kind: 'weekly', resetDay: 6 }, 0)).toBe('The week starts on Saturday.');
    expect(resetSentence({ kind: 'weekly' }, 0)).toBe('The week starts on Sunday.');
    expect(resetSentence({ kind: 'weekly' }, 1)).toBe('The week starts on Monday.');
    expect(resetSentence({ kind: 'monthly' }, 1)).toBe('The month starts on the 1st.');
    expect(resetSentence({ kind: 'monthly', resetDay: 22 }, 1)).toBe('The month starts on the 22nd.');
    expect(resetSentence({ kind: 'monthly', resetDay: 'last' }, 1)).toBe('The month starts on its last day.');
    expect(resetSentence({ kind: 'project' }, 1)).toBeUndefined();
  });

  it('counts words inside the delete sentence', () => {
    const words = 2_000;
    const one = msg`This removes the item and its ${plural(words, { one: '# word', other: '# words' })} from the project. You can undo it right after with Ctrl+Z.`;
    expect(i18n._(one, { words })).toBe(
      'This removes the item and its 2,000 words from the project. You can undo it right after with Ctrl+Z.',
    );

    const descendants = 2;
    const documents = 2;
    const many = msg`This removes the item, the ${plural(descendants, { one: '# item', other: '# items' })} inside it, and ${plural(words, { one: '# word', other: '# words' })} across ${plural(documents, { one: '# document', other: '# documents' })}. You can undo it right after with Ctrl+Z.`;
    expect(i18n._(many, { descendants, documents, words })).toBe(
      'This removes the item, the 2 items inside it, and 2,000 words across 2 documents. You can undo it right after with Ctrl+Z.',
    );
  });

  it('names the folder change kind inside the line', () => {
    const file = '\u2068caotang.json\u2069';
    const kind = 'changed';
    const line = msg`${{ file }}: ${select(kind, { changed: 'changed', removed: 'removed', added: 'added', other: 'changed' })}`;
    expect(i18n._(line, { file, kind })).toBe('\u2068caotang.json\u2069: changed');
  });
});
