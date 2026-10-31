/**
 * What an external call would send of the project (issue #54): a run of twelve words in a row that a document or a codex entry also holds
 * is a finding. The check reads words as the store counts them, ignores case and the punctuation around a word, and never refuses a call.
 */

import { describe, expect, it } from 'vitest';
import { addDocument } from '@caotang/store';

import { QUOTE_MIN_WORDS, quotedProjectText, wordsOfText } from '../../src/index.js';
import { CHAPTER_ONE, OPENED, makeState } from '../fixtures.js';

const TWELVE = 'one two three four five six seven eight nine ten eleven twelve';

function withBody(body: string) {
  const state = makeState();
  addDocument(state, { parentId: CHAPTER_ONE, title: 'Source', now: OPENED, id: 'n_SOURCE0001', body });
  return state;
}

describe('quotedProjectText', () => {
  it('finds twelve words in a row, names the document, counts the run and says where in the arguments', () => {
    const state = withBody(`Before it. ${TWELVE} thirteen. After it.`);
    expect(quotedProjectText({ note: { body: `Sent: ${TWELVE} thirteen!` } }, state)).toEqual([{ nodeId: 'n_SOURCE0001', title: 'Source', words: 13, argPath: 'args.note.body' }]);
  });

  it('does not find eleven', () => {
    const state = withBody(TWELVE);
    expect(quotedProjectText({ text: 'one two three four five six seven eight nine ten eleven' }, state)).toEqual([]);
  });

  it('matches through case, punctuation and quotation marks, and a line break between words', () => {
    const state = withBody('“One, two; three!” four five six\nseven eight nine ten eleven twelve.');
    expect(quotedProjectText({ text: 'ONE two three four five six seven eight nine ten eleven twelve' }, state)).toHaveLength(1);
  });

  it('finds a codex description, and a quote inside a list of arguments', () => {
    const state = makeState();
    state.manifest.codex?.push({
      id: 'c_QUOTE00001',
      name: 'Hanne',
      aliases: [],
      type: 'character',
      description: TWELVE,
      includePolicy: 'detected',
      caseSensitive: false,
      exclude: [],
      attachments: [],
      keywords: [],
      origin: 'manual',
      sources: [],
    });
    expect(quotedProjectText({ items: ['short', TWELVE] }, state)).toEqual([{ nodeId: 'c_QUOTE00001', title: 'Hanne', words: 12, argPath: 'args.items[1]' }]);
  });

  it('honours a different threshold', () => {
    const state = withBody('a b c d e f');
    expect(quotedProjectText({ text: 'a b c d e f' }, state)).toEqual([]);
    expect(quotedProjectText({ text: 'a b c d e f' }, state, 6)).toHaveLength(1);
  });

  it('counts an unspaced script one word for each character', () => {
    const han = '这是一个很长的句子需要被找到并且被报告出来';
    const state = withBody(han);
    expect(quotedProjectText({ text: han }, state)).toMatchObject([{ words: han.length }]);
    expect(wordsOfText('你好，世界')).toEqual(['你', '好', '世', '界']);
  });

  it('finds nothing in arguments that quote nothing, and reads a long repeated text in good time', () => {
    const state = withBody('word '.repeat(5000));
    expect(quotedProjectText({ text: 'a sentence of my own that is not in the project at all, however long it runs' }, state)).toEqual([]);
    const started = Date.now();
    quotedProjectText({ text: 'word '.repeat(5000) }, state);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('finds a quotation split across the items of an array, and says it is the arguments as a whole', () => {
    const state = withBody(`Before. ${TWELVE} After.`);
    const lines = TWELVE.split(' ');
    expect(quotedProjectText({ words: lines }, state)).toEqual([{ nodeId: 'n_SOURCE0001', title: 'Source', words: 12, argPath: 'args' }]);
    expect(quotedProjectText({ lines: [lines.slice(0, 6).join(' '), lines.slice(6).join(' ')] }, state)).toEqual([{ nodeId: 'n_SOURCE0001', title: 'Source', words: 12, argPath: 'args' }]);
  });

  it('finds a quotation used as an object key, and one split between a key and its value', () => {
    const state = withBody(TWELVE);
    const lines = TWELVE.split(' ');
    expect(quotedProjectText({ [TWELVE]: 1 }, state)).toEqual([{ nodeId: 'n_SOURCE0001', title: 'Source', words: 12, argPath: `args (key "${TWELVE.slice(0, 40)}…")` }]);
    expect(quotedProjectText({ [lines.slice(0, 5).join(' ')]: lines.slice(5).join(' ') }, state)).toMatchObject([{ words: 12, argPath: 'args' }]);
  });

  it('finds a quotation however deep in the arguments it is, and survives a very deep value', () => {
    const state = withBody(TWELVE);
    let nested: unknown = TWELVE;
    for (let level = 0; level < 20; level += 1) nested = { inner: nested };
    expect(quotedProjectText({ nested }, state)).toMatchObject([{ words: 12, argPath: `args.nested${'.inner'.repeat(20)}` }]);
    let deep: unknown = TWELVE;
    for (let level = 0; level < 50000; level += 1) deep = [deep];
    expect(quotedProjectText({ deep }, state)).toHaveLength(1);
  });

  it('does not add an arguments-wide finding for what one string already shows, and stops at a cycle', () => {
    const state = withBody(TWELVE);
    expect(quotedProjectText({ a: TWELVE, b: 'something else entirely' }, state)).toEqual([{ nodeId: 'n_SOURCE0001', title: 'Source', words: 12, argPath: 'args.a' }]);
    const loop: Record<string, unknown> = { text: TWELVE };
    loop.self = loop;
    expect(quotedProjectText(loop, state)).toHaveLength(1);
  });

  it('uses twelve words by default', () => {
    expect(QUOTE_MIN_WORDS).toBe(12);
  });
});
