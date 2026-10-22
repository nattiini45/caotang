/**
 * The whole-body reads an MCP resource serves. They look a node up as `doc.read`, `notes.read` and `codex.read` do, so a refusal
 * has the tool's words, and they return what the tool cuts to its cap.
 */

import { addDocument } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { readBody, readCodexEntry, readNotes } from '../src/index.js';
import { CHAPTER_ONE, ENTRY, LANDING, MISSING, OPENED, makeHarness, makeState, refusalOf, run, valueOf } from './fixtures.js';

describe('readBody', () => {
  it('returns the text doc.read returns when it fits', () => {
    const state = makeState();
    const read = readBody(state, LANDING);
    if (!read.ok) throw new Error(read.error.message);
    const tool = valueOf(run(makeHarness({}, state), 'doc.read', { doc: LANDING })).data as { text: string; words: number };
    expect(read.value.text).toBe(tool.text);
    expect(read.value.words).toBe(tool.words);
    expect(read.value.title).toBe('The Landing');
  });

  it('returns a body over the doc.read cap whole, where the tool returns it concise', () => {
    const state = makeState();
    const long = 'The ferry was late. '.repeat(7000);
    addDocument(state, { parentId: CHAPTER_ONE, title: 'Long', body: long, now: OPENED, id: 'n_L0NG000001' });
    const read = readBody(state, 'n_L0NG000001');
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.text).toBe(long);
    const tool = valueOf(run(makeHarness({}, state), 'doc.read', { doc: 'n_L0NG000001' })).data as { format: string };
    expect(tool.format).toBe('concise');
  });

  it('refuses a folder and an unknown id in the words doc.read uses', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    for (const ref of [CHAPTER_ONE, MISSING]) {
      const read = readBody(state, ref);
      if (read.ok) throw new Error('expected a refusal');
      expect(read.error).toEqual(refusalOf(run(harness, 'doc.read', { doc: ref })));
    }
  });
});

describe('readNotes', () => {
  it('returns the synopsis, notes and keywords notes.read returns', () => {
    const state = makeState();
    const read = readNotes(state, LANDING);
    if (!read.ok) throw new Error(read.error.message);
    const tool = valueOf(run(makeHarness({}, state), 'notes.read', { doc: LANDING })).data as {
      synopsis: string;
      notes: string;
      keywords: string[];
    };
    expect(read.value).toMatchObject({ synopsis: tool.synopsis, notes: tool.notes, keywords: tool.keywords });
  });

  it('refuses an unknown id', () => {
    const read = readNotes(makeState(), MISSING);
    expect(read.ok).toBe(false);
  });
});

describe('readCodexEntry', () => {
  it('returns the entry whole', () => {
    const read = readCodexEntry(makeState(), ENTRY);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.name).toBe('Elena');
  });

  it('refuses an unknown id in the words codex.read gives its note', () => {
    const read = readCodexEntry(makeState(), 'c_NOPE000001');
    if (read.ok) throw new Error('expected a refusal');
    expect(read.error.code).toBe('not-found');
    expect(read.error.message).toBe('no codex entry with id "c_NOPE000001"; use codex.read with a query to find it');
  });
});
